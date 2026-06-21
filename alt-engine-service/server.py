"""
Optional alternate image-engine worker for 5cd-single.

Runs ONE diffusers-based engine, chosen by the ENGINE env var, as a drop-in for
the SenseNova worker's job API (POST /api/generate/async + /api/edit/async ->
{job_id}; GET /api/jobs/{id} -> status + result.images[]). The backend routes
pure text-to-image here when ALT_ENGINE_ENABLED=true, and (optionally) edits too
when the engine supports image-to-image.

Engines
-------
  ENGINE=flux      black-forest-labs/FLUX.2-klein (Apache-2.0, ungated). 4-step,
                   does BOTH text-to-image and image editing (image= conditioning).
  ENGINE=ideogram  ideogram-ai/ideogram-4-nf4-diffusers + TurboTime 8-step LoRA.
                   GATED + Non-Commercial; text-to-image only (no edit).

If the weights / deps aren't present the worker still runs and returns placeholder
swatches (like the SenseNova worker) so the wiring can be exercised without a model.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import random
import sys
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

# Pin which physical GPU this worker uses BEFORE torch initialises CUDA. Default
# GPU 1 keeps it off the SenseNova worker (GPU 0).
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
# Engine config
# ---------------------------------------------------------------------------
ENGINE = os.getenv("ENGINE", "flux").strip().lower()

# Per-engine defaults; any can be overridden by the matching env var.
_ENGINE_DEFAULTS = {
    "flux": {
        "pipeline": "Flux2KleinPipeline",
        # bf16 diffusers pipeline (has model_index.json). The -fp8 repo is a
        # single-file checkpoint with no model_index.json, so from_pretrained can't
        # load it; bf16 klein-4B fits comfortably on a 32GB card.
        "model": "black-forest-labs/FLUX.2-klein-4B",
        "lora": "",
        "steps": 4,
        "guidance": 4.0,
        "pass_guidance": True,
        "supports_edit": True,
        "gated": False,
        # FLUX.2-klein is tuned for ~1MP; cap the long side at 1024 (2048 is slower
        # and degrades). Requests above this are scaled down preserving aspect ratio.
        "max_side": 1024,
        "repo_url": "https://github.com/black-forest-labs/flux2.git",
    },
    "ideogram": {
        "pipeline": "Ideogram4Pipeline",
        "model": "ideogram-ai/ideogram-4-nf4-diffusers",
        "lora": "ostris/ideogram_4_turbotime_lora",
        "steps": 8,
        # Needs real CFG even with the TurboTime LoRA — at 1.0 output is noisy;
        # ~4.0 gives clean logos (verified). Becomes the per-step guidance_schedule.
        "guidance": 4.0,
        # Ideogram4Pipeline sets a guidance_schedule internally and rejects an
        # explicit guidance_scale ("Only one of ... may be set"), so don't pass it.
        "pass_guidance": False,
        "supports_edit": False,
        "gated": True,
        "max_side": 2048,  # Ideogram 4's native quality resolution
        "repo_url": "https://github.com/ideogram-oss/ideogram4.git",
    },
}
if ENGINE not in _ENGINE_DEFAULTS:
    print(f"[alt] WARNING: unknown ENGINE={ENGINE!r}; falling back to 'flux'")
    ENGINE = "flux"
_DEF = _ENGINE_DEFAULTS[ENGINE]

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(HERE, "models"))
MODEL_REPO = os.getenv("MODEL_REPO", "").strip() or _DEF["model"]
LORA_REPO = os.getenv("LORA_REPO", _DEF["lora"]).strip()
LORA_WEIGHT = float(os.getenv("LORA_WEIGHT", "1.0"))
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
DEVICE = os.getenv("DEVICE", "cuda")
DTYPE_NAME = os.getenv("DTYPE", "bfloat16")
DEFAULT_STEPS = int(os.getenv("DEFAULT_STEPS", str(_DEF["steps"])))
DEFAULT_GUIDANCE = float(os.getenv("GUIDANCE_SCALE", str(_DEF["guidance"])))
DEFAULT_WIDTH = int(os.getenv("DEFAULT_WIDTH", "1024"))
DEFAULT_HEIGHT = int(os.getenv("DEFAULT_HEIGHT", "1024"))
SUPPORTS_EDIT = _DEF["supports_edit"]
PASS_GUIDANCE = _DEF.get("pass_guidance", True)
MAX_SIDE = int(os.getenv("MAX_SIDE", str(_DEF.get("max_side", 1024))))
ENABLE_CPU_OFFLOAD = os.getenv("ENABLE_CPU_OFFLOAD", "0").strip().lower() in ("1", "true", "yes", "on")
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


def _round_to_grid(value: int, factor: int = PATCH_FACTOR) -> int:
    if value < factor:
        return factor
    rem = value % factor
    return value if rem == 0 else value + (factor - rem)


def _clamp_side(w: int, h: int) -> tuple[int, int]:
    """Scale (w, h) down so the long side <= MAX_SIDE (preserve aspect), then snap
    to the patch grid. Keeps each engine at its native resolution regardless of
    what the caller requests (e.g. the 2048 the UI sends for SenseNova)."""
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
        if ENGINE == "flux":
            from diffusers import Flux2KleinPipeline as _Pipe
        else:
            from diffusers import Ideogram4Pipeline as _Pipe
    except Exception as e:  # noqa: BLE001
        _pipe_error = (
            f"{_DEF['pipeline']} not importable from diffusers: {e}. "
            f"Install diffusers from main (pip install git+https://github.com/huggingface/diffusers.git)."
        )
        print(f"[alt] {_pipe_error}")
        return False

    try:
        print(f"[alt] ENGINE={ENGINE} loading {MODEL_REPO} (cache: {MODELS_DIR}) ...")
        kwargs = dict(torch_dtype=dtype, cache_dir=MODELS_DIR)
        if HF_TOKEN:
            kwargs["token"] = HF_TOKEN
        pipe = _Pipe.from_pretrained(MODEL_REPO, **kwargs)

        if ENABLE_CPU_OFFLOAD:
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(DEVICE)

        if LORA_REPO:
            print(f"[alt] Applying LoRA: {LORA_REPO}")
            lkw = dict(cache_dir=MODELS_DIR)
            if HF_TOKEN:
                lkw["token"] = HF_TOKEN
            pipe.load_lora_weights(LORA_REPO, **lkw)
            try:
                pipe.fuse_lora(lora_scale=LORA_WEIGHT)
                pipe.unload_lora_weights()
            except Exception as e:  # noqa: BLE001
                print(f"[alt] LoRA fuse skipped ({e}); using attached adapter.")

        try:
            free, total = torch.cuda.mem_get_info()
            print(f"[alt]   VRAM free={free/1e9:.1f}GB / total={total/1e9:.1f}GB")
        except Exception:
            pass

        _pipe = {"pipe": pipe, "device": DEVICE, "dtype": dtype}
        _pipe_error = ""
        print(f"[alt] Model ready (engine={ENGINE})")
        return True
    except Exception as e:  # noqa: BLE001
        _pipe_error = f"{ENGINE} load failed: {e}"
        print(f"[alt] {_pipe_error}")
        _pipe = None
        return False


def _free_vram() -> None:
    try:
        gc.collect()
        if _torch is not None and _torch.cuda.is_available():
            _torch.cuda.empty_cache()
    except Exception:
        pass


def _run(prompt: str, width: int, height: int, steps: int, guidance: float,
         seed: int, ref_pils: Optional[list] = None) -> Image.Image:
    pipe = _pipe["pipe"]
    gen = _torch.Generator(device=_pipe["device"] if not ENABLE_CPU_OFFLOAD else "cpu").manual_seed(int(seed) % (2**63 - 1))
    call_kwargs = dict(
        prompt=prompt,
        num_inference_steps=steps,
        height=height,
        width=width,
        generator=gen,
    )
    if PASS_GUIDANCE:
        call_kwargs["guidance_scale"] = guidance
    elif ENGINE == "ideogram":
        # The TurboTime LoRA is guidance-distilled (few-step, no CFG). Ideogram4Pipeline
        # wants a per-step guidance_schedule whose length == num_inference_steps; 1.0
        # disables classifier-free guidance.
        call_kwargs["guidance_schedule"] = [guidance] * steps
    if ref_pils:
        # FLUX.2 conditions on reference image(s) via image=; multi-image supported.
        call_kwargs["image"] = ref_pils if len(ref_pils) > 1 else ref_pils[0]
    with _torch.inference_mode():
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
    # Use an explicit guidance_scale if the caller set one, else the engine default.
    # We intentionally ignore cfg_scale here — that's SenseNova's knob (the backend
    # sends 1.0), which is wrong for these engines.
    _g = p.get("guidance_scale")
    guidance = float(_g) if _g is not None else DEFAULT_GUIDANCE
    base_seed = p.get("seed")
    if base_seed is None:
        base_seed = random.randint(0, 2**31 - 1)

    have_model = _load_pipeline()
    images_b64: list[str] = []
    placeholder_flags: list[bool] = []
    real_count = 0
    last_error = ""

    try:
        for i in range(num):
            seed = int(base_seed) + i
            is_ph = True
            if have_model:
                try:
                    img = _run(raw_prompt, width, height, steps, guidance, seed)
                    real_count += 1
                    is_ph = False
                except Exception as e:  # noqa: BLE001
                    last_error = f"Inference failed: {e}"
                    print(f"[alt] {job.id} concept {i} failed: {e}")
                    img = _placeholder_image(raw_prompt, width, height, seed)
            else:
                img = _placeholder_image(raw_prompt, width, height, seed)
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
    guidance = float(_g) if _g is not None else DEFAULT_GUIDANCE
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
        except Exception:  # noqa: BLE001
            pass


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
    cfg_scale: Optional[float] = None  # SenseNova payload compatibility -> mapped to guidance
    seed: Optional[int] = None
    enhance: bool = False
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


app = FastAPI(title="5cd-single Alt Engine Worker", version="1.0.0")
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
    # Reject up-front when this engine can't edit, so the backend falls back to SenseNova.
    if not SUPPORTS_EDIT:
        return JSONResponse({"error": f"engine '{ENGINE}' does not support editing"}, status_code=400)
    job = Job("edit", req.model_dump())
    if not await _enqueue(job):
        return JSONResponse({"error": "queue full"}, status_code=503)
    return JSONResponse({"job_id": job.id, "status": "queued", "queue_position": _queue_position(job.id)})


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
        "service": "5cd-single Alt Engine Worker",
        "engine": ENGINE,
        "supports_edit": SUPPORTS_EDIT,
        "device": DEVICE,
        "dtype": DTYPE_NAME,
        "model_repo": MODEL_REPO,
        "lora_repo": LORA_REPO,
        "model_loaded": _pipe is not None,
        "model_error": _pipe_error,
        "models_dir": os.path.abspath(MODELS_DIR),
        "defaults": {"steps": DEFAULT_STEPS, "guidance_scale": DEFAULT_GUIDANCE,
                     "width": DEFAULT_WIDTH, "height": DEFAULT_HEIGHT},
    }
