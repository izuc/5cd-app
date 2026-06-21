"""Entry point for the optional 5cd-single alternate image-engine worker."""

from __future__ import annotations

import argparse
import os

import uvicorn
from dotenv import load_dotenv

load_dotenv()


def main() -> None:
    p = argparse.ArgumentParser(description="5cd-single Alt Engine Worker (FLUX.2-klein / Ideogram 4)")
    p.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.getenv("PORT", "8091")))
    p.add_argument("--reload", action="store_true")
    args = p.parse_args()

    engine = os.getenv("ENGINE", "flux")
    print(f"\n{'=' * 56}\n  5cd-single Alt Engine Worker\n{'=' * 56}")
    print(f"  Engine    : {engine}")
    print(f"  Model repo: {os.getenv('MODEL_REPO', '(engine default)')}")
    print(f"  GPU index : {os.getenv('GPU_INDEX', '(default / all visible)')}")
    print(f"  Device    : {os.getenv('DEVICE', 'cuda')} ({os.getenv('DTYPE', 'bfloat16')})")
    print(f"  Listening : http://{args.host}:{args.port}")
    print(f"{'=' * 56}\n")

    uvicorn.run("server:app", host=args.host, port=args.port, reload=args.reload, log_level="info")


if __name__ == "__main__":
    main()
