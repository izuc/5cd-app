"""
5cd image worker — FLUX.2-klein-4B (Apache-2.0, ungated).

One model does everything: text-to-image, image-to-image (edits, via image=
conditioning) and AI upscaling. Job API: POST /api/generate/async + /api/edit/async
-> {job_id}; GET /api/jobs/{id} -> status + result.images[]; POST /api/upscale ->
super-resolved image. Quantised to fit a single <24GB card: GGUF transformer
(from_single_file) + Qwen3 text encoder in 4-bit nf4.

If the weights / deps aren't present the worker still runs and returns placeholder
swatches so the wiring can be exercised without a model.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import random
import sys
import threading
import time
import uuid
import warnings
from collections import OrderedDict
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

warnings.filterwarnings("ignore")

try:
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
except Exception:
    pass

# Pin which physical GPU this worker uses BEFORE torch initialises CUDA.
# Empty = all visible (cuda:0).
_gpu_index = os.getenv("GPU_INDEX", "").strip()
if _gpu_index != "" and "CUDA_VISIBLE_DEVICES" not in os.environ:
    os.environ["CUDA_VISIBLE_DEVICES"] = _gpu_index
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

import numpy as np
from PIL import Image, ImageDraw
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Config — FLUX.2-klein-4B, quantised to fit a single <24GB card.
# Transformer: GGUF via from_single_file. Text encoder: Qwen3 in 4-bit (nf4).
# Validated peak ~13.5GB at 1024px (t2i + i2i).
# ---------------------------------------------------------------------------
ENGINE = "flux"           # sole engine (kept for /status + job-result labelling)
SUPPORTS_EDIT = True      # FLUX.2-klein does image-to-image via image=

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(HERE, "models"))
# Base diffusers repo — supplies VAE, scheduler, tokenizer, text-encoder weights + configs.
BASE_REPO = os.getenv("BASE_REPO", "black-forest-labs/FLUX.2-klein-4B")
# Prefer a plain local copy of the base components (download_model.py writes them to
# this dir via local_dir — avoids the Windows HF-cache symlink error and 2x storage).
_LOCAL_BASE = os.path.join(MODELS_DIR, "flux2-klein-base")
BASE = _LOCAL_BASE if os.path.isdir(_LOCAL_BASE) else BASE_REPO
# GGUF transformer (relative to MODELS_DIR, or an absolute path).
GGUF_FILE = os.getenv("GGUF_FILE", "flux2-gguf/flux-2-klein-4b-Q4_K_M.gguf")
# Quantise the Qwen3 text encoder to 4-bit (nf4) — ~2.5GB instead of ~8GB bf16.
TEXT_ENCODER_4BIT = os.getenv("TEXT_ENCODER_4BIT", "1").strip().lower() in ("1", "true", "yes", "on")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
DEVICE = os.getenv("DEVICE", "cuda")
DTYPE_NAME = os.getenv("DTYPE", "bfloat16")
DEFAULT_STEPS = int(os.getenv("DEFAULT_STEPS", "4"))      # klein is step-distilled
DEFAULT_GUIDANCE = float(os.getenv("GUIDANCE_SCALE", "4.0"))
DEFAULT_WIDTH = int(os.getenv("DEFAULT_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("DEFAULT_HEIGHT", "1024"))
# klein is tuned for ~1MP; cap the long side. Requests above are scaled down.
MAX_SIDE = int(os.getenv("MAX_SIDE", "1024"))
ENABLE_CPU_OFFLOAD = os.getenv("ENABLE_CPU_OFFLOAD", "0").strip().lower() in ("1", "true", "yes", "on")
# AI upscaler (Real-ESRGAN-class via spandrel) — used to clean up an image before
# vectorising. 4x model; output capped to UPSCALE_MAX_DIM to keep tracing manageable.
UPSCALER_FILE = os.getenv("UPSCALER_FILE", "upscaler/4x-UltraSharp.safetensors")
UPSCALE_MAX_DIM = int(os.getenv("UPSCALE_MAX_DIM", "2048"))
UPSCALE_TILE = int(os.getenv("UPSCALE_TILE", "512"))  # tile size to bound VRAM (0 = no tiling)
MAX_QUEUE = int(os.getenv("MAX_QUEUE", "20"))
JOB_TTL = int(os.getenv("JOB_TTL", "600"))
MAX_JOBS = 200
PATCH_FACTOR = 16

MAX_REF_IMAGES = 4
MAX_REF_BYTES = 12 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 50_000_000

# ---------------------------------------------------------------------------
# Model state
# ---------------------------------------------------------------------------
_pipe = None
_pipe_error: str = ""
_torch = None
_upscaler = None
_upscaler_error: str = ""
# Serializes all GPU model work (generate / edit / upscale / expand) across the
# executor threads so two CUDA ops never run on the card at once.
_gpu_lock = threading.Lock()


def _round_to_grid(value: int, factor: int = PATCH_FACTOR) -> int:
    if value < factor:
        return factor
    rem = value % factor
    return value if rem == 0 else value + (factor - rem)


def _clamp_side(w: int, h: int) -> tuple[int, int]:
    """Scale (w, h) down so the long side <= MAX_SIDE (preserve aspect), then snap
    to the patch grid. Keeps FLUX at its ~1MP native resolution regardless of what
    the caller requests."""
    w = max(1, int(w))
    h = max(1, int(h))
    longest = max(w, h)
    if longest > MAX_SIDE:
        scale = MAX_SIDE / longest
        w = int(round(w * scale))
        h = int(round(h * scale))
    return _round_to_grid(w), _round_to_grid(h)


def _load_pipeline() -> bool:
    """Load the configured engine's diffusers pipeline. Returns True on success."""
    global _pipe, _pipe_error, _torch

    if _pipe is not None:
        return True

    try:
        import torch
        _torch = torch
    except Exception as e:  # noqa: BLE001
        _pipe_error = f"torch not available: {e}"
        print(f"[alt] {_pipe_error}")
        return False

    dtype = {"bfloat16": torch.bfloat16, "float16": torch.float16, "float32": torch.float32}.get(
        DTYPE_NAME, torch.bfloat16
    )

    try:
        from diffusers import Flux2KleinPipeline, Flux2Transformer2DModel, GGUFQuantizationConfig
        from transformers import Qwen3ForCausalLM, BitsAndBytesConfig
    except Exception as e:  # noqa: BLE001
        _pipe_error = (
            f"FLUX.2 deps not importable: {e}. Need diffusers (main), transformers, "
            f"bitsandbytes and gguf in the venv."
        )
        print(f"[flux] {_pipe_error}")
        return False

    try:
        gguf_path = GGUF_FILE if os.path.isabs(GGUF_FILE) else os.path.join(MODELS_DIR, GGUF_FILE)
        if not os.path.isfile(gguf_path):
            _pipe_error = f"GGUF transformer not found: {gguf_path}. Run download_model.py."
            print(f"[flux] {_pipe_error}")
            return False

        print(f"[flux] loading GGUF transformer: {gguf_path}")
        transformer = Flux2Transformer2DModel.from_single_file(
            gguf_path,
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            torch_dtype=dtype,
            config=BASE, subfolder="transformer",
            cache_dir=MODELS_DIR, token=HF_TOKEN,
        )

        print(f"[flux] loading Qwen3 text encoder ({'4-bit nf4' if TEXT_ENCODER_4BIT else 'bf16'})")
        te_kwargs = dict(subfolder="text_encoder", cache_dir=MODELS_DIR, torch_dtype=dtype, token=HF_TOKEN)
        if TEXT_ENCODER_4BIT:
            te_kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype,
            )
        text_encoder = Qwen3ForCausalLM.from_pretrained(BASE, **te_kwargs)

        print("[flux] assembling Flux2KleinPipeline")
        pipe = Flux2KleinPipeline.from_pretrained(
            BASE, transformer=transformer, text_encoder=text_encoder,
            torch_dtype=dtype, cache_dir=MODELS_DIR, token=HF_TOKEN,
        )
        if ENABLE_CPU_OFFLOAD:
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(DEVICE)
        # Tile/slice the VAE decode to cut the peak-VRAM spike (no quality loss).
        try:
            pipe.vae.enable_tiling()
            pipe.vae.enable_slicing()
        except Exception:
            pass

        try:
            free, total = torch.cuda.mem_get_info()
            print(f"[flux]   VRAM used={(total - free) / 1e9:.1f}GB / {total / 1e9:.1f}GB")
        except Exception:
            pass

        _pipe = {"pipe": pipe, "device": DEVICE, "dtype": dtype}
        _pipe_error = ""
        print("[flux] Model ready (FLUX.2-klein-4B: GGUF transformer + 4-bit text encoder)")
        return True
    except Exception as e:  # noqa: BLE001
        _pipe_error = f"FLUX load failed: {e}"
        print(f"[flux] {_pipe_error}")
        _pipe = None
        return False


def _free_vram() -> None:
    try:
        gc.collect()
        if _torch is not None and _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    except Exception:
        pass


def _load_upscaler() -> bool:
    """Lazy-load the SR model (spandrel). Returns True on success."""
    global _upscaler, _upscaler_error, _torch
    if _upscaler is not None:
        return True
    try:
        import torch
        _torch = torch
        from spandrel import ModelLoader
    except Exception as e:  # noqa: BLE001
        _upscaler_error = f"spandrel/torch not available: {e}"
        print(f"[up] {_upscaler_error}")
        return False
    path = UPSCALER_FILE if os.path.isabs(UPSCALER_FILE) else os.path.join(MODELS_DIR, UPSCALER_FILE)
    if not os.path.isfile(path):
        _upscaler_error = f"upscaler model not found: {path}. Run download_model.py."
        print(f"[up] {_upscaler_error}")
        return False
    try:
        model = ModelLoader().load_from_file(path)
        model.to(DEVICE).eval()
        _upscaler = model
        _upscaler_error = ""
        print(f"[up] upscaler ready (x{getattr(model, 'scale', '?')})")
        return True
    except Exception as e:  # noqa: BLE001
        _upscaler_error = f"upscaler load failed: {e}"
        print(f"[up] {_upscaler_error}")
        _upscaler = None
        return False


def _upscale_pil(img: Image.Image, max_dim: int = 0) -> Optional[Image.Image]:
    """Upscale with the SR model, tiled to bound VRAM, then cap the long side to
    max_dim (Lanczos). Returns None if the model isn't available."""
    import numpy as np
    if not _load_upscaler():
        return None
    torch = _torch
    model = _upscaler
    scale = int(getattr(model, "scale", 4) or 4)
    src = img.convert("RGB")
    W, H = src.width, src.height
    arr = np.asarray(src, dtype=np.float32) / 255.0
    t = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).to(DEVICE)
    out = torch.zeros((1, 3, H * scale, W * scale), dtype=t.dtype, device=DEVICE)
    tile = UPSCALE_TILE if UPSCALE_TILE > 0 else max(W, H)
    pad = 16  # overlap to hide tile seams
    try:
        with _gpu_lock, torch.inference_mode():
            for y in range(0, H, tile):
                for x in range(0, W, tile):
                    x0, y0 = max(0, x - pad), max(0, y - pad)
                    x1, y1 = min(W, x + tile + pad), min(H, y + tile + pad)
                    up = model(t[:, :, y0:y1, x0:x1]).clamp(0, 1)
                    cl, ct = (x - x0) * scale, (y - y0) * scale
                    cw, ch = min(tile, W - x) * scale, min(tile, H - y) * scale
                    out[:, :, y * scale:y * scale + ch, x * scale:x * scale + cw] = up[:, :, ct:ct + ch, cl:cl + cw]
        res_arr = (out.clamp(0, 1).squeeze(0).permute(1, 2, 0).float().cpu().numpy() * 255.0).round().astype(np.uint8)
        res = Image.fromarray(res_arr)
    finally:
        del t, out
        _free_vram()
    if max_dim and max(res.size) > max_dim:
        s = max_dim / max(res.size)
        res = res.resize((max(1, round(res.width * s)), max(1, round(res.height * s))), Image.LANCZOS)
    return res


_EXPAND_SYS = (
    "You are a prompt engineer for a text-to-image model that designs logos, posters and "
    "graphics. Rewrite the user's short description into ONE vivid, detailed image prompt of "
    "1-3 sentences. Preserve any exact words or phrases they want rendered as text (keep them "
    "in quotes). Describe the subject, art style, colour palette, composition and background. "
    "Do not add commentary or options — output ONLY the rewritten prompt."
)


def _expand_prompt(prompt: str, design_type: Optional[str]) -> str:
    """Rewrite a short prompt into a detailed brief using the already-loaded Qwen3
    text encoder (no extra VRAM). Returns the original prompt if the model isn't ready."""
    if not _load_pipeline() or _pipe is None:
        return prompt
    torch = _torch
    pipe = _pipe["pipe"]
    tok = getattr(pipe, "tokenizer", None)
    te = getattr(pipe, "text_encoder", None)
    if tok is None or te is None or not hasattr(te, "generate"):
        return prompt
    kind = (design_type or "design").strip() or "design"
    user = f"Design type: {kind}\nDescription: {prompt}"
    try:
        if getattr(tok, "chat_template", None):
            # enable_thinking=False: Qwen3 is a reasoning model and would otherwise burn
            # the whole budget inside <think>...</think> and never emit the prompt.
            inputs = tok.apply_chat_template(
                [{"role": "system", "content": _EXPAND_SYS}, {"role": "user", "content": user}],
                add_generation_prompt=True, return_tensors="pt", return_dict=True,
                enable_thinking=False,
            ).to(te.device)
        else:
            inputs = tok(f"{_EXPAND_SYS}\n\n{user}\n\nPrompt:", return_tensors="pt").to(te.device)
        in_len = inputs["input_ids"].shape[1]
        with _gpu_lock, torch.inference_mode():
            out = te.generate(
                **inputs, max_new_tokens=200, do_sample=True, temperature=0.7,
                top_p=0.9, repetition_penalty=1.05, pad_token_id=tok.eos_token_id,
            )
        gen = tok.decode(out[0, in_len:], skip_special_tokens=True).strip()
        if "</think>" in gen:  # belt-and-braces if a think block slips through
            gen = gen.split("</think>")[-1]
        gen = gen.strip().strip('"').strip()
        # Guard only against an empty/near-empty result (model echoed nothing); a valid
        # expansion can occasionally be about the same length as a longer input prompt.
        return gen if len(gen) >= 8 else prompt
    except Exception as e:  # noqa: BLE001
        print(f"[expand] failed: {type(e).__name__}: {e}")
        return prompt
    finally:
        _free_vram()


def _run(prompt: str, width: int, height: int, steps: int, guidance: float,
         seed: int, ref_pils: Optional[list] = None) -> Image.Image:
    pipe = _pipe["pipe"]
    gen = _torch.Generator(device=_pipe["device"] if not ENABLE_CPU_OFFLOAD else "cpu").manual_seed(int(seed) % (2**63 - 1))
    call_kwargs = dict(
        prompt=prompt,
        num_inference_steps=steps,
        guidance_scale=guidance,
        height=height,
        width=width,
        generator=gen,
    )
    if ref_pils:
        # FLUX.2 conditions on reference image(s) via image=; multi-image supported.
        call_kwargs["image"] = ref_pils if len(ref_pils) > 1 else ref_pils[0]
    # Serialize GPU work so generate / edit / upscale / expand never overlap on the card.
    with _gpu_lock, _torch.inference_mode():
        out = pipe(**call_kwargs)
    return out.images[0]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _placeholder_image(prompt: str, width: int, height: int, seed: int) -> Image.Image:
    rnd = random.Random(seed)
    c1 = (rnd.randint(40, 120), rnd.randint(40, 120), rnd.randint(80, 160))
    img = Image.new("RGB", (width, height), c1)
    d = ImageDraw.Draw(img)
    d.rectangle((0, height - 60, width, height), fill=(0, 0, 0))
    d.text((14, height - 44), f"[{ENGINE} placeholder] {prompt[:80]}", fill=(255, 255, 255))
    return img


def _pil_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _b64_to_pil(b64: str) -> Image.Image:
    if not isinstance(b64, str):
        raise ValueError("ref image must be a base64 string")
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"invalid base64 ref image: {e}")
    if len(raw) > MAX_REF_BYTES:
        raise ValueError("ref image too large")
    Image.open(io.BytesIO(raw)).verify()
    return Image.open(io.BytesIO(raw)).convert("RGB")


# ---------------------------------------------------------------------------
# Jobs
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
        d = {"job_id": self.id, "type": self.type, "status": self.status,
             "progress": self.progress, "created_at": self.created_at}
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


def _cleanup_jobs() -> None:
    now = time.time()
    for j in [j for j, job in _jobs.items() if job.completed_at and now - job.completed_at > JOB_TTL]:
        _jobs.pop(j, None)
    while len(_jobs) > MAX_JOBS:
        victim = next((j for j, job in _jobs.items() if job.status in ("completed", "failed")), None) or next(iter(_jobs), None)
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


def _process_generate(job: Job) -> None:
    p = job.params
    raw_prompt = (p.get("prompt") or "").strip() or "Untitled design"
    num = max(1, min(int(p.get("num_concepts", 1)), 6))
    width, height = _clamp_side(int(p.get("width", DEFAULT_WIDTH)), int(p.get("height", DEFAULT_HEIGHT)))
    steps = max(1, min(int(p.get("steps", DEFAULT_STEPS)), 50))
    # Use an explicit guidance_scale if the caller set one, else the FLUX default.
    # The legacy cfg_scale field is ignored (it was the old SenseNova knob, sent as 1.0).
    _g = p.get("guidance_scale")
    guidance = max(1.0, min(float(_g), 12.0)) if _g is not None else DEFAULT_GUIDANCE
    base_seed = p.get("seed")
    if base_seed is None:
        base_seed = random.randint(0, 2**31 - 1)
    # "Unique concepts": rewrite the prompt per concept via the Qwen3 text encoder
    # (sampling makes each rewrite distinct) so the concepts genuinely differ, not
    # just by seed. Only meaningful for >1 concept.
    vary = bool(p.get("vary_concepts")) and num > 1
    design_type = p.get("design_type")

    have_model = _load_pipeline()
    images_b64: list[str] = []
    placeholder_flags: list[bool] = []
    real_count = 0
    last_error = ""

    try:
        for i in range(num):
            seed = int(base_seed) + i
            cprompt = raw_prompt
            if vary and have_model:
                try:
                    cprompt = _expand_prompt(raw_prompt, design_type)
                except Exception:  # noqa: BLE001
                    cprompt = raw_prompt
            is_ph = True
            if have_model:
                try:
                    img = _run(cprompt, width, height, steps, guidance, seed)
                    real_count += 1
                    is_ph = False
                except Exception as e:  # noqa: BLE001
                    last_error = f"Inference failed: {e}"
                    print(f"[flux] {job.id} concept {i} failed: {e}")
                    img = _placeholder_image(cprompt, width, height, seed)
            else:
                img = _placeholder_image(cprompt, width, height, seed)
            images_b64.append(_pil_to_b64(img))
            placeholder_flags.append(is_ph)
            job.progress = int(((i + 1) / num) * 100)
    finally:
        _free_vram()

    placeholder = real_count == 0
    job.result = {
        "images": images_b64,
        "enhanced_prompt": "",
        "placeholder_flags": placeholder_flags,
        "model": "placeholder" if placeholder else ENGINE,
        "width": width,
        "height": height,
        "steps": steps,
        "guidance_scale": guidance,
        "placeholder": placeholder,
        "error": (_pipe_error or last_error) if placeholder else "",
    }


def _process_edit(job: Job) -> None:
    p = job.params
    prompt = (p.get("prompt") or "").strip() or "Refine the image."
    refs_b64 = p.get("ref_images") or []
    if not refs_b64:
        raise ValueError("edit job requires at least one ref image")
    refs = [_b64_to_pil(b) for b in refs_b64[:MAX_REF_IMAGES]]
    width, height = _clamp_side(int(p.get("width") or refs[0].width), int(p.get("height") or refs[0].height))
    steps = max(1, min(int(p.get("steps") or DEFAULT_STEPS), 50))
    _g = p.get("guidance_scale")
    guidance = max(1.0, min(float(_g), 12.0)) if _g is not None else DEFAULT_GUIDANCE
    seed = p.get("seed")
    if seed is None:
        seed = random.randint(0, 2**31 - 1)

    have_model = _load_pipeline()
    edit_error = ""
    if have_model:
        try:
            img = _run(prompt, width, height, steps, guidance, int(seed), ref_pils=refs)
        except Exception as e:  # noqa: BLE001
            edit_error = f"Edit inference failed: {e}"
            print(f"[alt] {job.id} edit failed: {e}")
            have_model = False
            img = _placeholder_image(prompt, width, height, int(seed))
    else:
        img = _placeholder_image(prompt, width, height, int(seed))

    _free_vram()
    job.progress = 100
    job.result = {
        "images": [_pil_to_b64(img)],
        "model": ENGINE if have_model else "placeholder",
        "width": width,
        "height": height,
        "steps": steps,
        "guidance_scale": guidance,
        "placeholder": not have_model,
        "error": (edit_error or _pipe_error) if not have_model else "",
    }


async def _worker() -> None:
    print(f"[alt] Worker started (engine={ENGINE}, edit={'yes' if SUPPORTS_EDIT else 'no'})")
    while True:
        job = await _queue.get()  # type: ignore[union-attr]
        try:
            job.status = "processing"
            job.progress = 0
            t0 = time.time()
            print(f"[alt] {job.id} ({job.type}) start")
            loop = asyncio.get_event_loop()
            if job.type == "generate":
                await loop.run_in_executor(None, _process_generate, job)
            elif job.type == "edit":
                await loop.run_in_executor(None, _process_edit, job)
            else:
                raise ValueError(f"unknown job type: {job.type}")
            job.status = "completed"
            job.progress = 100
            job.completed_at = time.time()
            print(f"[alt] {job.id} done in {time.time() - t0:.1f}s")
        except Exception as e:  # noqa: BLE001
            job.status = "failed"
            job.error = str(e)
            job.completed_at = time.time()
            print(f"[alt] {job.id} failed: {e}")
        finally:
            _queue.task_done()  # type: ignore[union-attr]
            _cleanup_jobs()


async def _periodic_cleanup() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            _cleanup_jobs()
        except Exception as e:  # noqa: BLE001
            print(f"[cleanup] failed: {e}")


# ---------------------------------------------------------------------------
# Request models + app
# ---------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    prompt: str
    num_concepts: int = Field(1, ge=1, le=6)
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    steps: int = Field(DEFAULT_STEPS, ge=1, le=50)
    guidance_scale: Optional[float] = None
    cfg_scale: Optional[float] = None  # legacy field, ignored (FLUX uses guidance_scale)
    seed: Optional[int] = None
    enhance: bool = False
    vary_concepts: bool = False  # rewrite the prompt per concept for unique results
    design_type: Optional[str] = None
    ref_images: Optional[list[str]] = None
    img_cfg_scale: Optional[float] = None
    cfg_norm: Optional[str] = None
    timestep_shift: Optional[float] = None
    think: Optional[bool] = None


class EditRequest(BaseModel):
    prompt: str
    ref_images: list[str]
    width: Optional[int] = Field(None, ge=256, le=4096)
    height: Optional[int] = Field(None, ge=256, le=4096)
    steps: int = Field(DEFAULT_STEPS, ge=1, le=50)
    guidance_scale: Optional[float] = None
    cfg_scale: Optional[float] = None
    img_cfg_scale: Optional[float] = None
    seed: Optional[int] = None
    cfg_norm: Optional[str] = None
    timestep_shift: Optional[float] = None
    think: Optional[bool] = None


class UpscaleRequest(BaseModel):
    image: str                       # base64 PNG/JPEG
    max_dim: Optional[int] = None    # cap the long side of the result (default UPSCALE_MAX_DIM)


class ExpandRequest(BaseModel):
    prompt: str
    design_type: Optional[str] = None


app = FastAPI(title="5cd image worker (FLUX.2-klein-4B)", version="2.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])


@app.on_event("startup")
async def _startup() -> None:
    global _queue
    _queue = asyncio.Queue(maxsize=MAX_QUEUE)
    asyncio.create_task(_worker())
    asyncio.create_task(_periodic_cleanup())
    _load_pipeline()


async def _enqueue(job: Job) -> bool:
    if _queue is None or _queue.full():
        return False
    _jobs[job.id] = job
    await _queue.put(job)
    return True


@app.post("/api/generate/async")
async def api_generate_async(req: GenerateRequest):
    job = Job("generate", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    return JSONResponse({"job_id": job.id, "status": "queued", "queue_position": _queue_position(job.id)})


@app.post("/api/edit/async")
async def api_edit_async(req: EditRequest):
    # FLUX.2-klein always supports i2i; this guard is just defensive.
    if not SUPPORTS_EDIT:
        return JSONResponse({"error": f"engine '{ENGINE}' does not support editing"}, status_code=400)
    job = Job("edit", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    return JSONResponse({"job_id": job.id, "status": "queued", "queue_position": _queue_position(job.id)})


@app.post("/api/upscale")
async def api_upscale(req: UpscaleRequest):
    """AI super-resolution (4x model), tiled. Synchronous — upscale is fast.
    Used to produce a cleaner, higher-res image to vectorise."""
    try:
        img = _b64_to_pil(req.image)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": f"bad image: {e}"}, status_code=400)
    max_dim = int(req.max_dim) if req.max_dim is not None else UPSCALE_MAX_DIM
    loop = asyncio.get_event_loop()
    res = await loop.run_in_executor(None, _upscale_pil, img, max_dim)
    if res is None:
        return JSONResponse({"error": _upscaler_error or "upscaler unavailable"}, status_code=503)
    return JSONResponse({"image": _pil_to_b64(res), "width": res.width, "height": res.height})


@app.post("/api/expand")
async def api_expand(req: ExpandRequest):
    """Rewrite a short prompt into a detailed brief using the loaded Qwen3 text encoder."""
    p = (req.prompt or "").strip()
    if not p:
        return JSONResponse({"error": "prompt is required"}, status_code=400)
    loop = asyncio.get_event_loop()
    expanded = await loop.run_in_executor(None, _expand_prompt, p, req.design_type)
    return JSONResponse({"prompt": p, "expanded": expanded})


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
        "model_loaded": _pipe is not None,
        "model_error": _pipe_error,
        "engine": ENGINE,
        "supports_edit": SUPPORTS_EDIT,
        "supports_upscale": True,
        "max_side": MAX_SIDE,
        "steps": DEFAULT_STEPS,
        "queue": {
            "queued": sum(1 for j in _jobs.values() if j.status == "queued"),
            "processing": sum(1 for j in _jobs.values() if j.status == "processing"),
            "max": MAX_QUEUE,
        },
    }


@app.get("/status")
async def api_status():
    return {
        "service": "5cd image worker (FLUX.2-klein-4B)",
        "engine": ENGINE,
        "supports_edit": SUPPORTS_EDIT,
        "device": DEVICE,
        "dtype": DTYPE_NAME,
        "base_repo": BASE,
        "gguf_file": GGUF_FILE,
        "text_encoder_4bit": TEXT_ENCODER_4BIT,
        "max_side": MAX_SIDE,
        "model_loaded": _pipe is not None,
        "model_error": _pipe_error,
        "models_dir": os.path.abspath(MODELS_DIR),
        "defaults": {"steps": DEFAULT_STEPS, "guidance_scale": DEFAULT_GUIDANCE,
                     "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT},
    }
