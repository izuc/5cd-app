"""
Pre-download the configured engine's weights into MODELS_DIR so the first request
doesn't pay the download cost (and gate/token issues surface now).

  ENGINE=flux      -> black-forest-labs/FLUX.2-klein-* (Apache-2.0, ungated)
  ENGINE=ideogram  -> ideogram-ai/ideogram-4-nf4-diffusers + TurboTime LoRA
                      (GATED + Non-Commercial: accept the license on the HF model
                       page while logged in and set HF_TOKEN in .env first.)

Usage:
    python download_model.py            # model (+ LoRA, for ideogram)
    python download_model.py --model-only
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from huggingface_hub import snapshot_download

load_dotenv()

ENGINE = os.getenv("ENGINE", "flux").strip().lower()

_DEFAULT_MODEL = {
    # bf16 diffusers pipeline (the -fp8 repo has no model_index.json -> not from_pretrained-able).
    "flux": "black-forest-labs/FLUX.2-klein-4B",
    "ideogram": "ideogram-ai/ideogram-4-nf4-diffusers",
}
_DEFAULT_LORA = {
    "flux": "",
    "ideogram": "ostris/ideogram_4_turbotime_lora",
}

MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(os.path.dirname(__file__), "models"))
MODEL_REPO = os.getenv("MODEL_REPO", "").strip() or _DEFAULT_MODEL.get(ENGINE, _DEFAULT_MODEL["flux"])
LORA_REPO = os.getenv("LORA_REPO", _DEFAULT_LORA.get(ENGINE, "")).strip()
HF_TOKEN = os.getenv("HF_TOKEN", "").strip() or None
GATED = ENGINE == "ideogram"


def _pull(repo: str) -> bool:
    print(f"\n[pull] {repo}")
    try:
        path = snapshot_download(repo_id=repo, cache_dir=MODELS_DIR, token=HF_TOKEN)
        print(f"       done -> {path}")
        return True
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if any(s in msg for s in ("401", "403", "gated", "Access to model")):
            print(f"       FAILED (gated/auth): {e}")
            print("       -> Accept the license on the model page AND set HF_TOKEN in .env.")
        else:
            print(f"       FAILED: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Download the alt engine's weights.")
    ap.add_argument("--model-only", action="store_true")
    args = ap.parse_args()

    os.makedirs(MODELS_DIR, exist_ok=True)
    print(f"Engine: {ENGINE}")
    print(f"Destination (HF cache): {os.path.abspath(MODELS_DIR)}")
    if GATED and not HF_TOKEN:
        print("WARNING: ideogram is gated and HF_TOKEN is not set; the download will likely 401/403.")

    ok = _pull(MODEL_REPO)
    if not args.model_only and LORA_REPO:
        ok = _pull(LORA_REPO) and ok

    print("\nDone." if ok else "\nFinished with errors.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
