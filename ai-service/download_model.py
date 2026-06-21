"""
Download everything the FLUX.2-klein-4B worker needs into MODELS_DIR:

  1. GGUF transformer        unsloth/FLUX.2-klein-4B-GGUF :: <GGUF_FILE>
  2. Base diffusers repo     black-forest-labs/FLUX.2-klein-4B — only the bits we
                             use: text encoder (Qwen3) + VAE + tokenizer + scheduler
                             + configs. The bf16 transformer .safetensors (~8GB) is
                             skipped because we load the GGUF transformer instead.
  3. AI upscaler             Kim2091/UltraSharp :: 4x-UltraSharp.safetensors

FLUX.2-klein is Apache-2.0 and ungated; no HF token required (set HF_TOKEN only if
you hit anonymous rate limits).

Usage:  python download_model.py
"""

import os
import sys

from dotenv import load_dotenv
from huggingface_hub import hf_hub_download, snapshot_download

load_dotenv()

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(HERE, "models"))
BASE_REPO = os.getenv("BASE_REPO", "black-forest-labs/FLUX.2-klein-4B")
GGUF_REPO = os.getenv("GGUF_REPO", "unsloth/FLUX.2-klein-4B-GGUF")
GGUF_FILE = os.getenv("GGUF_FILE", "flux2-gguf/flux-2-klein-4b-Q4_K_M.gguf")
UPSCALER_REPO = os.getenv("UPSCALER_REPO", "Kim2091/UltraSharp")
UPSCALER_FILE = os.getenv("UPSCALER_FILE", "upscaler/4x-UltraSharp.safetensors")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None


def _file(repo: str, rel: str) -> bool:
    name = os.path.basename(rel)
    dest = os.path.join(MODELS_DIR, os.path.dirname(rel) or ".")
    print(f"\n[file] {repo} :: {name}  ->  {dest}")
    try:
        hf_hub_download(repo_id=repo, filename=name, local_dir=dest, token=HF_TOKEN)
        print("       done")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"       FAILED: {e}")
        return False


def main() -> int:
    os.makedirs(MODELS_DIR, exist_ok=True)
    print(f"Destination: {os.path.abspath(MODELS_DIR)}")
    ok = True

    print("\n[1/3] GGUF transformer")
    ok = _file(GGUF_REPO, GGUF_FILE) and ok

    print("\n[2/3] Base diffusers components (skipping the unused bf16 transformer)")
    try:
        # local_dir (not cache_dir): plain copies — no Windows symlink error, no 2x blobs.
        path = snapshot_download(
            repo_id=BASE_REPO, local_dir=os.path.join(MODELS_DIR, "flux2-klein-base"), token=HF_TOKEN,
            allow_patterns=[
                "model_index.json",
                "text_encoder/*",
                "vae/*",
                "tokenizer/*",
                "scheduler/*",
                "transformer/config.json",  # needed by from_single_file (config only)
            ],
        )
        print(f"       done -> {path}")
    except Exception as e:  # noqa: BLE001
        print(f"       FAILED: {e}")
        ok = False

    print("\n[3/3] AI upscaler")
    ok = _file(UPSCALER_REPO, UPSCALER_FILE) and ok

    print("\nDone." if ok else "\nFinished with errors.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
