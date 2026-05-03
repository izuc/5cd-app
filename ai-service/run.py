"""Entry point for the 5cd-single AI worker."""

from __future__ import annotations

import argparse
import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()


def main() -> None:
    p = argparse.ArgumentParser(description="5cd-single AI Worker (SenseNova-U1)")
    p.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("PORT", "8090")))
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()

    print(f"\n{'=' * 56}\n  5cd-single AI Worker\n{'=' * 56}")
    print(f"  Models dir: {os.getenv('MODELS_DIR', './models')}")
    print(f"  GGUF file : {os.getenv('GGUF_FILE', 'SenseNova-U1-8B-MoT-Q6_K.gguf')}")
    print(f"  Device    : {os.getenv('DEVICE', 'cuda')} ({os.getenv('DTYPE', 'bfloat16')})")
    print(f"  Listening : http://{args.host}:{args.port}")
    print(f"  Docs      : http://{args.host}:{args.port}/docs")
    print(f"{'=' * 56}\n")

    uvicorn.run("server:app", host=args.host, port=args.port, reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
