"""
FastAPI worker for 5cd-single.

One model, one job: SenseNova-U1-8B-MoT (GGUF) for both text-to-image and
image editing. No layered decomposition.

Endpoints
---------
  POST /api/generate         — synchronous T2I; returns one or more concept images.
  POST /api/generate/async   — returns a job_id immediately, poll /api/jobs/{id}.
  POST /api/edit             — synchronous image edit (concept image + instruction).
  POST /api/edit/async       — async variant.
  GET  /api/jobs/{id}        — poll a job.
  POST /api/health           — quick liveness + queue depth.
  GET  /status               — what model is loaded, what's in the queue.

If the GGUF or its dependencies aren't available we drop into placeholder
mode — the API still responds, but with a generated swatch image so the
frontend can be developed without a GPU box.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import json
import os
import random
import sys
import time
import uuid
import warnings
from collections import OrderedDict
from typing import Optional

warnings.filterwarnings("ignore")

# Windows console: transformers' auto_docstring prints emojis (e.g. ðŸš¨) which
# crash on cp1252. Switch the std streams to utf-8 before any heavy imports.
try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(HERE, "models"))
GGUF_FILE = os.getenv("GGUF_FILE", "SenseNova-U1-8B-MoT-8step-Q4_K_S.gguf")
DEVICE = os.getenv("DEVICE", "cuda")
DTYPE_NAME = os.getenv("DTYPE", "bfloat16")
DEFAULT_STEPS = int(os.getenv("DEFAULT_STEPS", "8"))
DEFAULT_CFG_SCALE = float(os.getenv("DEFAULT_CFG_SCALE", "1.0"))  # 8-step model's official cfg (4.0 is the base model)
DEFAULT_CFG_NORM = os.getenv("CFG_NORM", "none")  # none | global | channel | cfg_zero_star
DEFAULT_TIMESTEP_SHIFT = float(os.getenv("DEFAULT_TIMESTEP_SHIFT", "3.0"))
DEFAULT_WIDTH = int(os.getenv("DEFAULT_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("DEFAULT_HEIGHT", "1024"))
# Reasoning ("think") pass before image generation. Off by default — it roughly
# triples latency. A per-request `think` field overrides this server default.
DEFAULT_THINK = os.getenv("THINK_MODE", "0").strip().lower() in ("1", "true", "yes", "on")
PREFETCH_COUNT = int(os.getenv("PREFETCH_COUNT", "2"))
MAX_QUEUE = int(os.getenv("MAX_QUEUE", "20"))
JOB_TTL = int(os.getenv("JOB_TTL", "600"))
NORM_MEAN = (0.5, 0.5, 0.5)
NORM_STD = (0.5, 0.5, 0.5)
PATCH_FACTOR = 32  # SenseNova-U1 wants W/H divisible by patch*merge size; safe fallback

# Make sure the GGUF helper script and tokenizer files live next to this server
# so `import layer_streaming` and HF AutoTokenizer resolve correctly.
import sys

if os.path.isdir(MODELS_DIR) and MODELS_DIR not in sys.path:
    sys.path.insert(0, MODELS_DIR)

# ---------------------------------------------------------------------------
# Model state
# ---------------------------------------------------------------------------
_pipeline = None             # holds the loaded model (or None)
_pipeline_error: str = ""
_torch = None                # lazy import — keeps the placeholder path lightweight
_tokenizer = None
_LayerStreamingWrapper = None


def _round_to_grid(value: int, factor: int = PATCH_FACTOR) -> int:
    if value < factor:
        return factor
    rem = value % factor
    return value if rem == 0 else value + (factor - rem)


def _denorm_to_pil(batch) -> list[Image.Image]:
    """Convert a [B, 3, H, W] tensor (mean/std normalized) to a list of PIL images."""
    import torch  # local — safe inside this branch

    mean = torch.tensor(NORM_MEAN, dtype=batch.dtype, device=batch.device).view(1, 3, 1, 1)
    std = torch.tensor(NORM_STD, dtype=batch.dtype, device=batch.device).view(1, 3, 1, 1)
    arr = (batch * std + mean).clamp(0, 1).float().permute(0, 2, 3, 1).cpu().numpy()
    arr = (arr * 255.0).round().astype(np.uint8)
    return [Image.fromarray(a) for a in arr]


def _load_pipeline() -> bool:
    """Try to load the SenseNova-U1 GGUF + config. Returns True on success."""
    global _pipeline, _pipeline_error, _torch, _tokenizer, _LayerStreamingWrapper

    if _pipeline is not None:
        return True

    gguf_path = os.path.join(MODELS_DIR, GGUF_FILE)
    if not os.path.isfile(gguf_path):
        _pipeline_error = f"GGUF not found: {gguf_path}. Run download_model.py."
        print(f"[ai] {_pipeline_error}")
        return False

    try:
        import torch
        from transformers import AutoConfig, AutoModel, AutoTokenizer
        from accelerate import init_empty_weights
    except Exception as e:  # noqa: BLE001
        _pipeline_error = f"Missing Python deps: {e}"
        print(f"[ai] {_pipeline_error}")
        return False

    try:
        # The custom layer_streaming.py was downloaded into MODELS_DIR.
        from layer_streaming import LayerStreamingWrapper  # type: ignore
    except Exception as e:  # noqa: BLE001
        _pipeline_error = f"layer_streaming.py not importable from {MODELS_DIR}: {e}"
        print(f"[ai] {_pipeline_error}")
        return False

    # The custom Auto* classes for SenseNova-U1's NEO-Unify architecture must be
    # available — `pip install -e .` from the OpenSenseNova/SenseNova-U1 repo
    # registers them. If that hasn't been done we fail loudly.
    try:
        import sensenova_u1  # noqa: F401
    except Exception as e:  # noqa: BLE001
        _pipeline_error = (
            f"sensenova_u1 package not installed: {e}. "
            f"Clone https://github.com/OpenSenseNova/SenseNova-U1 and `pip install -e .`."
        )
        print(f"[ai] {_pipeline_error}")
        return False

    dtype = {
        "bfloat16": torch.bfloat16,
        "float16": torch.float16,
        "float32": torch.float32,
    }.get(DTYPE_NAME, torch.bfloat16)

    device = DEVICE if (DEVICE == "cpu" or torch.cuda.is_available()) else "cpu"
    if device != DEVICE:
        print(f"[ai] CUDA unavailable, falling back to {device}")

    print(f"[ai] Loading config + tokenizer from {MODELS_DIR}")
    try:
        config = AutoConfig.from_pretrained(MODELS_DIR, trust_remote_code=False)
        tokenizer = AutoTokenizer.from_pretrained(MODELS_DIR, trust_remote_code=False)
        with init_empty_weights():
            model = AutoModel.from_config(config, trust_remote_code=False)
    except Exception as e:  # noqa: BLE001
        _pipeline_error = f"Failed to instantiate model from config: {e}"
        print(f"[ai] {_pipeline_error}")
        return False

    print(f"[ai] Loading GGUF weights: {gguf_path}")
    try:
        sd = _load_gguf_state_dict(gguf_path)
        _set_gguf_into_meta_model(model, sd, dtype, torch.device("cpu"))
        del sd
        gc.collect()
    except Exception as e:  # noqa: BLE001
        _pipeline_error = f"Failed to load GGUF weights: {e}"
        print(f"[ai] {_pipeline_error}")
        return False

    if device != "cpu":
        try:
            print(f"[ai] Moving model to {device}...")
            model = model.to(device)
            if torch.cuda.is_available():
                free, total = torch.cuda.mem_get_info()
                print(f"[ai]   VRAM free={free / 1e9:.1f}GB / total={total / 1e9:.1f}GB")
        except Exception as e:  # noqa: BLE001
            _pipeline_error = f"Failed to move model to {device}: {e}"
            print(f"[ai] {_pipeline_error}")
            return False

    model.eval()
    print(f"[ai] Model ready (device={device}, dtype={DTYPE_NAME})")
    _torch = torch
    _tokenizer = tokenizer
    _LayerStreamingWrapper = LayerStreamingWrapper
    _pipeline = {"model": model, "device": device, "dtype": dtype}
    _pipeline_error = ""
    return True


def _load_gguf_state_dict(path: str) -> dict:
    """Pull a GGUF file into a {tensor_name: GGUFParameter|Tensor} dict."""
    import torch
    import gguf
    from gguf import GGUFReader
    from diffusers.quantizers.gguf.utils import (
        SUPPORTED_GGUF_QUANT_TYPES,
        GGUFParameter,
    )

    reader = GGUFReader(path)
    out: dict = {}
    for tensor in reader.tensors:
        name = tensor.name
        qtype = tensor.tensor_type
        is_quant = qtype not in (
            gguf.GGMLQuantizationType.F32,
            gguf.GGMLQuantizationType.F16,
        )
        if is_quant and qtype not in SUPPORTED_GGUF_QUANT_TYPES:
            raise ValueError(
                f"{name}: unsupported quantization type {qtype}. "
                f"Supported: {sorted(str(t) for t in SUPPORTED_GGUF_QUANT_TYPES)}"
            )
        weights = torch.from_numpy(tensor.data.copy())
        out[name] = GGUFParameter(weights, quant_type=qtype) if is_quant else weights
    del reader
    gc.collect()
    return out


def _set_gguf_into_meta_model(meta_model, state_dict, dtype, device) -> None:
    """Wire a GGUF state_dict into a meta-instantiated transformer."""
    from diffusers import GGUFQuantizationConfig
    from diffusers.quantizers.gguf import GGUFQuantizer
    from diffusers.models.model_loading_utils import load_model_dict_into_meta

    quantizer = GGUFQuantizer(
        quantization_config=GGUFQuantizationConfig(compute_dtype=dtype)
    )
    quantizer.pre_quantized = True
    quantizer._process_model_before_weight_loading(
        meta_model,
        device_map={"": device} if device else None,
        state_dict=state_dict,
    )
    load_model_dict_into_meta(
        meta_model,
        state_dict,
        hf_quantizer=quantizer,
        device_map={"": device} if device else None,
        dtype=dtype,
    )
    quantizer._process_model_after_weight_loading(meta_model)


# ---------------------------------------------------------------------------
# Prompt enhancement (uses the local model — no external API)
# ---------------------------------------------------------------------------
# Deterministic prompt enhancement: append design-type style guidance. SenseNova-U1's
# direct language-model text path produces degenerate output under GGUF quantization
# (its image path is fine), so we use a fast, reliable template instead of an LLM
# rewrite — instant and never garbage.
# Visual style cues appended for enhancement. ONLY for design types where this
# model won't paint the cues as literal text. Text-heavy types (flyer/social/
# banner) are deliberately excluded — there the model renders appended words onto
# the design, so those use the user's prompt as-is.
_ENHANCE_STYLE: dict[str, str] = {
    "logo": "flat vector logo, minimal, clean geometric shapes, solid background, high contrast",
    "custom": "clean balanced composition, rich colour, soft lighting, detailed",
}


def _run_enhance(prompt: str, design_type: str | None = None) -> str:
    """Augment a short prompt with design-type style guidance.

    Deterministic and instant. SenseNova-U1's direct language-model text path
    produces degenerate output under GGUF quantization (its image path is fine),
    so we append curated style keywords rather than a slow, unreliable LLM rewrite.
    """
    base = (prompt or "").strip().rstrip(" .,")
    if not base:
        return prompt
    # No entry (flyer/social/banner) => leave the prompt untouched so style cues
    # aren't rendered as literal text on text-heavy designs.
    style = _ENHANCE_STYLE.get((design_type or "custom").lower())
    return f"{base}, {style}" if style else base


# ---------------------------------------------------------------------------
# Diffusion calls (real model path)
# ---------------------------------------------------------------------------
def _run_t2i(prompt: str, width: int, height: int, *, steps: int, cfg_scale: float,
             seed: int, batch_size: int, think_mode: bool = True,
             cfg_norm: str = "none", timestep_shift: float = DEFAULT_TIMESTEP_SHIFT) -> tuple[list[Image.Image], str]:
    model = _pipeline["model"]
    with _torch.inference_mode():
        out = model.t2i_generate(
            _tokenizer,
            prompt,
            image_size=(width, height),
            cfg_scale=cfg_scale,
            cfg_norm=cfg_norm,
            timestep_shift=timestep_shift,
            cfg_interval=(0.0, 1.0),
            num_steps=steps,
            batch_size=batch_size,
            seed=seed,
            think_mode=think_mode,
        )
    # think_mode=True returns (tensor, think_text); otherwise just tensor.
    tensor, think_text = out if (think_mode and isinstance(out, tuple)) else (out, "")
    return _denorm_to_pil(tensor), think_text


def _run_edit(prompt: str, ref_images: list[Image.Image], width: int, height: int, *,
              steps: int, cfg_scale: float, img_cfg_scale: float, seed: int,
              think_mode: bool = True, cfg_norm: str = "none",
              timestep_shift: float = DEFAULT_TIMESTEP_SHIFT) -> tuple[list[Image.Image], str]:
    model = _pipeline["model"]
    with _torch.inference_mode():
        out = model.it2i_generate(
            _tokenizer,
            prompt,
            ref_images,
            image_size=(width, height),
            cfg_scale=cfg_scale,
            img_cfg_scale=img_cfg_scale,
            cfg_norm=cfg_norm,
            timestep_shift=timestep_shift,
            cfg_interval=(0.0, 1.0),
            num_steps=steps,
            batch_size=1,
            seed=seed,
            think_mode=think_mode,
        )
    tensor, think_text = out if (think_mode and isinstance(out, tuple)) else (out, "")
    return _denorm_to_pil(tensor), think_text


# ---------------------------------------------------------------------------
# Placeholder fallback (used when the model can't load — keeps the FE working)
# ---------------------------------------------------------------------------
_PALETTE = [
    (4, 120, 87), (15, 118, 110), (124, 58, 237), (225, 29, 72),
    (217, 119, 6), (71, 85, 105), (220, 38, 38), (37, 99, 235),
]


def _placeholder_image(prompt: str, width: int, height: int, seed: int) -> Image.Image:
    rng = random.Random(seed)
    fg = rng.choice(_PALETTE)
    bg = (250, 250, 247)
    img = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(img)
    # A simple radial-style swatch so the placeholder isn't visually empty.
    for i in range(40):
        t = i / 40
        r = int(min(width, height) * (0.5 - t / 2.5))
        cx = width // 2 + rng.randint(-12, 12)
        cy = height // 2 + rng.randint(-12, 12)
        col = (
            int(fg[0] * (1 - t * 0.7) + bg[0] * (t * 0.7)),
            int(fg[1] * (1 - t * 0.7) + bg[1] * (t * 0.7)),
            int(fg[2] * (1 - t * 0.7) + bg[2] * (t * 0.7)),
        )
        draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)

    label = (prompt or "5cd").strip()[:60]
    try:
        font = ImageFont.truetype("arial.ttf", max(20, height // 22))
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), label, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad = 14
    box = (
        (width - tw) // 2 - pad,
        height - th - 60 - pad,
        (width + tw) // 2 + pad,
        height - 60 + pad,
    )
    draw.rounded_rectangle(box, radius=14, fill=(255, 255, 255, 230))
    draw.text(((width - tw) // 2, height - th - 60), label, fill=(30, 30, 30), font=font)
    draw.text(
        (16, height - 30),
        "[placeholder — SenseNova-U1 not loaded]",
        fill=(120, 120, 120),
        font=ImageFont.load_default(),
    )
    return img


# ---------------------------------------------------------------------------
# Job queue
# ---------------------------------------------------------------------------
class Job:
    __slots__ = ("id", "type", "params", "status", "progress", "result",
                 "error", "created_at", "completed_at")

    def __init__(self, job_type: str, params: dict):
        self.id = uuid.uuid4().hex[:12]
        self.type = job_type
        self.params = params
        self.status = "queued"
        self.progress = 0
        self.result: Optional[dict] = None
        self.error: Optional[str] = None
        self.created_at = time.time()
        self.completed_at: Optional[float] = None

    def to_dict(self) -> dict:
        d = {
            "job_id": self.id,
            "type": self.type,
            "status": self.status,
            "progress": self.progress,
            "created_at": self.created_at,
        }
        if self.error:
            d["error"] = self.error
        if self.completed_at:
            d["completed_at"] = self.completed_at
            d["duration"] = round(self.completed_at - self.created_at, 2)
        if self.result is not None:
            d["result"] = self.result
        return d


_jobs: "OrderedDict[str, Job]" = OrderedDict()
_queue: Optional[asyncio.Queue] = None


MAX_JOBS = 200  # hard cap on retained job records (LRU eviction beyond this)


def _cleanup_jobs() -> None:
    now = time.time()
    # TTL eviction for finished jobs.
    expired = [j for j, job in _jobs.items()
               if job.completed_at and now - job.completed_at > JOB_TTL]
    for j in expired:
        _jobs.pop(j, None)
    # Hard cap so abandoned/queued jobs can't leak memory unbounded — drop the
    # oldest finished jobs first, falling back to the oldest record overall.
    while len(_jobs) > MAX_JOBS:
        victim = next((j for j, job in _jobs.items()
                       if job.status in ("completed", "failed")), None)
        if victim is None:
            victim = next(iter(_jobs), None)
        if victim is None:
            break
        _jobs.pop(victim, None)


def _queue_position(job_id: str) -> int:
    pos = 0
    for jid, job in _jobs.items():
        if job.status == "queued":
            pos += 1
            if jid == job_id:
                return pos
    return 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# Bound untrusted ref-image inputs to avoid OOM / decompression-bomb DoS.
MAX_REF_IMAGES = 4
MAX_REF_BYTES = 12 * 1024 * 1024  # 12 MB decoded per ref image
Image.MAX_IMAGE_PIXELS = 50_000_000  # ~50 MP ceiling


def _b64_to_pil(b64: str) -> Image.Image:
    if not isinstance(b64, str):
        raise ValueError("ref image must be a base64 string")
    if b64.startswith("data:"):  # tolerate data-URL prefixes
        b64 = b64.split(",", 1)[-1]
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"invalid base64 ref image: {e}")
    if len(raw) > MAX_REF_BYTES:
        raise ValueError("ref image too large")
    Image.open(io.BytesIO(raw)).verify()  # reject truncated/corrupt data
    return Image.open(io.BytesIO(raw)).convert("RGB")


# ---------------------------------------------------------------------------
# Job processing
# ---------------------------------------------------------------------------
def _process_generate(job: Job) -> None:
    p = job.params
    raw_prompt = (p.get("prompt") or "").strip() or "Untitled design"
    num = max(1, min(int(p.get("num_concepts", 1)), 6))
    width = _round_to_grid(int(p.get("width", DEFAULT_WIDTH)))
    height = _round_to_grid(int(p.get("height", DEFAULT_HEIGHT)))
    steps = max(1, min(int(p.get("steps", DEFAULT_STEPS)), 100))
    cfg = float(p.get("cfg_scale", DEFAULT_CFG_SCALE))
    cfg_norm = str(p.get("cfg_norm") or DEFAULT_CFG_NORM)
    ts_shift = float(p.get("timestep_shift") or DEFAULT_TIMESTEP_SHIFT)
    enhance = bool(p.get("enhance"))
    think_flag = DEFAULT_THINK if p.get("think") is None else bool(p.get("think"))
    design_type = p.get("design_type")
    base_seed = p.get("seed")
    if base_seed is None:
        base_seed = random.randint(0, 2**31 - 1)

    have_model = _load_pipeline()

    # Optionally expand the short user prompt into a full design brief first.
    enhanced_prompt = ""
    prompt = raw_prompt
    if enhance and have_model:
        try:
            enhanced_prompt = _run_enhance(raw_prompt, design_type)
            prompt = enhanced_prompt
            print(f"[ai] {job.id} enhanced: {raw_prompt!r} -> {enhanced_prompt[:120]!r}")
        except Exception as e:  # noqa: BLE001
            print(f"[ai] {job.id} enhance failed, falling back: {e}")
            enhanced_prompt = ""

    images_b64: list[str] = []
    think_texts: list[str] = []
    placeholder_flags: list[bool] = []
    real_count = 0
    last_error = ""

    for i in range(num):
        seed = int(base_seed) + i
        is_ph = True
        if have_model:
            try:
                pil, think_text = _run_t2i(prompt, width, height,
                                           steps=steps, cfg_scale=cfg, seed=seed,
                                           batch_size=1, think_mode=think_flag, cfg_norm=cfg_norm,
                                           timestep_shift=ts_shift)
                img = pil[0]
                real_count += 1
                is_ph = False
            except Exception as e:  # noqa: BLE001
                # Fall back to a placeholder for THIS concept only; keep the model
                # loaded so the rest of the batch (and future jobs) still use it.
                last_error = f"Inference failed: {e}"
                print(f"[ai] {job.id} concept {i} failed: {e}")
                img = _placeholder_image(prompt, width, height, seed)
                think_text = ""
        else:
            img = _placeholder_image(prompt, width, height, seed)
            think_text = ""
        images_b64.append(_pil_to_b64(img))
        think_texts.append(think_text)
        placeholder_flags.append(is_ph)
        job.progress = int(((i + 1) / num) * 100)

    # The whole job is "placeholder" only if NO real concept was produced.
    placeholder = real_count == 0
    job.result = {
        "images": images_b64,
        "think": think_texts,
        "enhanced_prompt": enhanced_prompt,
        "placeholder_flags": placeholder_flags,  # per-concept: True where a placeholder was used
        "model": "placeholder" if placeholder else "sensenova-u1",
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": cfg,
        "placeholder": placeholder,
        "error": (_pipeline_error or last_error) if placeholder else "",
    }


def _process_edit(job: Job) -> None:
    p = job.params
    prompt = (p.get("prompt") or "").strip() or "Refine the image."
    refs_b64 = p.get("ref_images") or []
    if not refs_b64:
        raise ValueError("edit job requires at least one ref image")
    if len(refs_b64) > MAX_REF_IMAGES:
        raise ValueError(f"too many ref images (max {MAX_REF_IMAGES})")
    refs = [_b64_to_pil(b) for b in refs_b64]
    # Use `or` rather than dict.get default — pydantic sends Optional[int] fields
    # as explicit None, which dict.get will happily return.
    width = _round_to_grid(int(p.get("width") or refs[0].width))
    height = _round_to_grid(int(p.get("height") or refs[0].height))
    steps = max(1, min(int(p.get("steps") or DEFAULT_STEPS), 100))
    cfg = float(p.get("cfg_scale", DEFAULT_CFG_SCALE) or DEFAULT_CFG_SCALE)
    img_cfg = float(p.get("img_cfg_scale") or 1.0)
    cfg_norm = str(p.get("cfg_norm") or DEFAULT_CFG_NORM)
    ts_shift = float(p.get("timestep_shift") or DEFAULT_TIMESTEP_SHIFT)
    think_flag = DEFAULT_THINK if p.get("think") is None else bool(p.get("think"))
    seed = p.get("seed")
    if seed is None:
        seed = random.randint(0, 2**31 - 1)

    have_model = _load_pipeline()
    think_text = ""
    edit_error = ""
    if have_model:
        try:
            pil, think_text = _run_edit(prompt, refs, width, height,
                                        steps=steps, cfg_scale=cfg, img_cfg_scale=img_cfg,
                                        seed=int(seed), think_mode=think_flag, cfg_norm=cfg_norm,
                                        timestep_shift=ts_shift)
            img = pil[0]
        except Exception as e:  # noqa: BLE001
            # Fall back to a placeholder for THIS job only; keep the model loaded so a
            # single bad edit doesn't brick all future jobs. Use a LOCAL error — do NOT
            # write the load-error global (_pipeline_error); it never clears and would
            # poison /status, /api/health, and later jobs.
            edit_error = f"Edit inference failed: {e}"
            print(f"[ai] {job.id} edit failed: {e}")
            have_model = False
            img = _placeholder_image(prompt, width, height, int(seed))
    else:
        # Composite the edit prompt onto the first ref so the FE shows something.
        img = refs[0].copy()
        d = ImageDraw.Draw(img)
        d.rectangle((0, img.height - 50, img.width, img.height), fill=(0, 0, 0))
        d.text((12, img.height - 38), f"placeholder edit: {prompt[:80]}",
               fill=(255, 255, 255))

    job.progress = 100
    job.result = {
        "images": [_pil_to_b64(img)],
        "think": [think_text],
        "model": "sensenova-u1" if have_model else "placeholder",
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": cfg,
        "placeholder": not have_model,
        "error": (edit_error or _pipeline_error) if not have_model else "",
    }


def _process_chat(job: Job) -> None:
    """Generate a text response. If a reference image is supplied the model uses
    visual understanding (image + question -> text); otherwise it runs the
    underlying language model standalone (pure text-to-text)."""
    p = job.params
    prompt = (p.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("chat job requires a prompt")
    ref_b64 = p.get("ref_image")
    # Cap default at 512 tokens — a chat reply, not an essay. Users can opt into more.
    max_new = max(1, min(int(p.get("max_new_tokens") or 512), 8192))
    temperature = float(p.get("temperature") or 0.6)
    top_p = float(p.get("top_p") or 0.95)
    top_k = int(p.get("top_k") or 20)
    rep_pen = float(p.get("repetition_penalty") or 1.05)

    have_model = _load_pipeline()
    if not have_model:
        job.result = {
            "text": "Model is not available right now. Try again shortly.",
            "model": "placeholder",
            "placeholder": True,
            "error": _pipeline_error,
        }
        return

    model = _pipeline["model"]
    device = _pipeline["device"]

    gen_kwargs = dict(
        max_new_tokens=max_new,
        do_sample=True,
        temperature=temperature,
        top_p=top_p,
        top_k=top_k,
        repetition_penalty=rep_pen,
    )

    try:
        with _torch.inference_mode():
            if ref_b64:
                # Visual understanding path — give the model the image as context.
                from sensenova_u1.models.neo_unify.utils import load_image_native
                img = _b64_to_pil(ref_b64)
                pixel_values, grid_hw = load_image_native(img)
                pixel_values = pixel_values.to(device, dtype=_pipeline["dtype"])
                grid_hw = grid_hw.to(device)
                response, _hist = model.chat(
                    _tokenizer, pixel_values, prompt, gen_kwargs,
                    return_history=True, grid_hw=grid_hw,
                )
            else:
                # Pure text-to-text — call the underlying Qwen3 LLM directly.
                # Pass attention_mask explicitly and use a distinct pad_token so the
                # generation can stop on EOS instead of running to max_new_tokens.
                messages = [{"role": "user", "content": prompt}]
                text = _tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
                inputs = _tokenizer(text, return_tensors="pt").to(device)
                eos_id = _tokenizer.eos_token_id
                pad_id = _tokenizer.pad_token_id if _tokenizer.pad_token_id is not None else eos_id
                output = model.language_model.generate(
                    input_ids=inputs.input_ids,
                    attention_mask=inputs.attention_mask,
                    eos_token_id=eos_id,
                    pad_token_id=pad_id,
                    **gen_kwargs,
                )
                response = _tokenizer.decode(output[0][inputs.input_ids.shape[1]:], skip_special_tokens=True).strip()
    except Exception as e:  # noqa: BLE001
        job.result = {
            "text": "",
            "model": "sensenova-u1",
            "placeholder": False,
            "error": f"Chat failed: {e}",
        }
        return

    job.result = {
        "text": response,
        "model": "sensenova-u1",
        "with_image": bool(ref_b64),
        "placeholder": False,
        "error": "",
    }


async def _worker() -> None:
    print("[ai] Worker started")
    while True:
        job = await _queue.get()  # type: ignore[union-attr]
        try:
            job.status = "processing"
            job.progress = 0
            t0 = time.time()
            print(f"[ai] {job.id} ({job.type}) start")
            loop = asyncio.get_event_loop()
            if job.type == "generate":
                await loop.run_in_executor(None, _process_generate, job)
            elif job.type == "edit":
                await loop.run_in_executor(None, _process_edit, job)
            elif job.type == "chat":
                await loop.run_in_executor(None, _process_chat, job)
            else:
                raise ValueError(f"unknown job type: {job.type}")
            job.status = "completed"
            job.progress = 100
            job.completed_at = time.time()
            print(f"[ai] {job.id} done in {time.time() - t0:.1f}s")
        except Exception as e:  # noqa: BLE001
            job.status = "failed"
            job.error = str(e)
            job.completed_at = time.time()
            print(f"[ai] {job.id} failed: {e}")
        finally:
            _queue.task_done()  # type: ignore[union-attr]
            _cleanup_jobs()


async def _periodic_cleanup() -> None:
    # Evict expired/old jobs even when no new job arrives to trigger cleanup.
    while True:
        await asyncio.sleep(60)
        try:
            _cleanup_jobs()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    prompt: str
    num_concepts: int = Field(1, ge=1, le=6)
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    steps: int = Field(DEFAULT_STEPS, ge=1, le=100)
    cfg_scale: float = DEFAULT_CFG_SCALE
    cfg_norm: Optional[str] = None     # none|global|channel|cfg_zero_star; None = server default
    timestep_shift: Optional[float] = None  # None = server default
    seed: Optional[int] = None
    enhance: bool = False
    think: Optional[bool] = None       # override THINK_MODE per request; None = server default
    design_type: Optional[str] = None  # "logo" | "social" | "banner" | "flyer" | "custom"


class EditRequest(BaseModel):
    prompt: str
    ref_images: list[str]              # base64-encoded PNGs
    width: Optional[int] = None
    height: Optional[int] = None
    steps: int = Field(DEFAULT_STEPS, ge=1, le=100)
    cfg_scale: float = DEFAULT_CFG_SCALE
    img_cfg_scale: float = 1.0
    cfg_norm: Optional[str] = None     # none|global|channel|cfg_zero_star; None = server default
    timestep_shift: Optional[float] = None  # None = server default
    seed: Optional[int] = None
    think: Optional[bool] = None       # override THINK_MODE per request; None = server default


class ChatRequest(BaseModel):
    prompt: str
    ref_image: Optional[str] = None    # base64-encoded PNG; when supplied the model uses VQA
    max_new_tokens: int = Field(512, ge=1, le=8192)
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 20
    repetition_penalty: float = 1.05


# ---------------------------------------------------------------------------
# App + endpoints
# ---------------------------------------------------------------------------
app = FastAPI(title="5cd-single AI Worker", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # worker is called server-to-server; no cookies/credentials, and '*' + credentials is invalid
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def _startup() -> None:
    global _queue
    _queue = asyncio.Queue(maxsize=MAX_QUEUE)
    asyncio.create_task(_worker())
    asyncio.create_task(_periodic_cleanup())
    # Try once at startup so the first request doesn't pay the load cost.
    _load_pipeline()


async def _enqueue(job: Job) -> bool:
    if _queue is None:
        return False
    if _queue.full():
        return False
    _jobs[job.id] = job
    await _queue.put(job)
    return True


async def _wait_for_job(job: Job) -> None:
    while job.status in ("queued", "processing"):
        await asyncio.sleep(0.4)


@app.post("/api/generate")
async def api_generate(req: GenerateRequest):
    job = Job("generate", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    await _wait_for_job(job)
    if job.status == "failed":
        return JSONResponse({"error": job.error}, status_code=500)
    return JSONResponse({"job_id": job.id, **(job.result or {})})


@app.post("/api/generate/async")
async def api_generate_async(req: GenerateRequest):
    job = Job("generate", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    return JSONResponse({
        "job_id": job.id,
        "status": "queued",
        "queue_position": _queue_position(job.id),
    })


@app.post("/api/edit")
async def api_edit(req: EditRequest):
    job = Job("edit", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    await _wait_for_job(job)
    if job.status == "failed":
        return JSONResponse({"error": job.error}, status_code=500)
    return JSONResponse({"job_id": job.id, **(job.result or {})})


@app.post("/api/edit/async")
async def api_edit_async(req: EditRequest):
    job = Job("edit", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    return JSONResponse({
        "job_id": job.id,
        "status": "queued",
        "queue_position": _queue_position(job.id),
    })


@app.post("/api/chat")
async def api_chat(req: ChatRequest):
    """Synchronous text chat. With ref_image: visual understanding (image + question -> text).
    Without: pure text-to-text via the underlying language model."""
    job = Job("chat", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    await _wait_for_job(job)
    if job.status == "failed":
        return JSONResponse({"error": job.error}, status_code=500)
    return JSONResponse({"job_id": job.id, **(job.result or {})})


@app.get("/api/jobs/{job_id}")
async def api_job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "job not found"}, status_code=404)
    body = job.to_dict()
    if job.status == "queued":
        body["queue_position"] = _queue_position(job_id)
    return JSONResponse(body)


@app.post("/api/health")
@app.get("/api/health")
async def api_health():
    return {
        "status": "ok",
        "model_loaded": _pipeline is not None,
        "model_error": _pipeline_error,
        "queue": {
            "queued": sum(1 for j in _jobs.values() if j.status == "queued"),
            "processing": sum(1 for j in _jobs.values() if j.status == "processing"),
            "max": MAX_QUEUE,
        },
    }


@app.get("/status")
async def api_status():
    return {
        "service": "5cd-single AI Worker",
        "device": DEVICE,
        "dtype": DTYPE_NAME,
        "model_loaded": _pipeline is not None,
        "model_error": _pipeline_error,
        "gguf_present": os.path.isfile(os.path.join(MODELS_DIR, GGUF_FILE)),
        "models_dir": os.path.abspath(MODELS_DIR),
        "defaults": {
            "steps": DEFAULT_STEPS,
            "cfg_scale": DEFAULT_CFG_SCALE,
            "width": DEFAULT_WIDTH,
            "height": DEFAULT_HEIGHT,
            "patch_factor": PATCH_FACTOR,
            "think": DEFAULT_THINK,
            "cfg_norm": DEFAULT_CFG_NORM,
        },
        "queue": {
            "queued": sum(1 for j in _jobs.values() if j.status == "queued"),
            "processing": sum(1 for j in _jobs.values() if j.status == "processing"),
            "max": MAX_QUEUE,
        },
    }
