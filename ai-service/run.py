"""Entry point for the 5cd AI image worker (FLUX.2-klein-4B)."""

from __future__ import annotations

import argparse
import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()


def main() -> None:
    p = argparse.ArgumentParser(description="5cd AI image worker (FLUX.2-klein-4B: t2i + i2i + upscale)")
    p.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("PORT", "8090")))
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()

    print(f"\n{'=' * 56}\n  5cd AI image worker — FLUX.2-klein-4B\n{'=' * 56}")
    print(f"  Base repo : {os.getenv('BASE_REPO', 'black-forest-labs/FLUX.2-klein-4B')}")
    print(f"  GGUF      : {os.getenv('GGUF_FILE', 'flux2-gguf/flux-2-klein-4b-Q6_K.gguf')}")
    print(f"  Text enc. : Qwen3 ({'4-bit nf4' if os.getenv('TEXT_ENCODER_4BIT', '1') not in ('0', 'false') else 'bf16'})")
    print(f"  GPU index : {os.getenv('GPU_INDEX', '(default / all visible)')}")
    print(f"  Device    : {os.getenv('DEVICE', 'cuda')} ({os.getenv('DTYPE', 'bfloat16')})")
    print(f"  Listening : http://{args.host}:{args.port}")
    print(f"{'=' * 56}\n")

    uvicorn.run("server:app", host=args.host, port=args.port, reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
