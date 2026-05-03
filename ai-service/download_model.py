"""
Download everything needed to run the SenseNova-U1 GGUF locally.

This grabs three sets of files into MODELS_DIR:
  1. The GGUF weights themselves   (smthem/SenseNova-U1-8B-MoT-Merger-gguf)
  2. The tokenizer + model config  (sensenova/SenseNova-U1-8B-MoT)
  3. layer_streaming.py            (helper from the GGUF repo for VRAM-efficient inference)

Usage:
    python download_model.py                # pull the Q6_K GGUF + config + tokenizer
    python download_model.py --gguf-only    # just the GGUF
    python download_model.py --config-only  # just the config + tokenizer
    python download_model.py --list         # list available files in both repos
"""

import argparse
import os
import shutil
import sys

from dotenv import load_dotenv
from huggingface_hub import hf_hub_download, list_repo_files

load_dotenv()

MODELS_DIR = os.getenv("MODELS_DIR", os.path.join(os.path.dirname(__file__), "models"))
TOKENIZER_REPO = os.getenv("TOKENIZER_REPO", "sensenova/SenseNova-U1-8B-MoT")
GGUF_REPO = os.getenv("GGUF_REPO", "smthem/SenseNova-U1-8B-MoT-Merger-gguf")
GGUF_FILE = os.getenv("GGUF_FILE", "SenseNova-U1-8B-MoT-Q6_K.gguf")

# Files to pull from the SenseNova "official" repo so AutoConfig / AutoTokenizer
# and the custom sensenova_u1 module find what they need.
TOKENIZER_FILES = [
    "config.json",
    "configuration.py",                  # custom config class registration
    "modeling.py",                        # custom model class registration (if present)
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "vocab.json",
    "merges.txt",
    "preprocessor_config.json",
    "processor_config.json",
    "generation_config.json",
    "chat_template.jinja",
]

# Helpers shipped in the GGUF repo
HELPER_FILES = [
    "layer_streaming.py",
]


def _ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def _download(repo: str, filename: str, dest_dir: str, *, optional: bool = False) -> str | None:
    local_path = os.path.join(dest_dir, os.path.basename(filename))
    if os.path.exists(local_path):
        size_mb = os.path.getsize(local_path) / (1024 * 1024)
        print(f"  [skip] {os.path.basename(filename)} already present ({size_mb:.1f} MB)")
        return local_path

    print(f"  [pull] {repo}::{filename}")
    try:
        downloaded = hf_hub_download(repo_id=repo, filename=filename, local_dir=dest_dir)
        # If the hub stored it at a nested path, flatten it.
        if downloaded != local_path and os.path.exists(downloaded):
            _ensure_dir(os.path.dirname(local_path))
            shutil.move(downloaded, local_path)
        size_mb = os.path.getsize(local_path) / (1024 * 1024)
        print(f"         done ({size_mb:.1f} MB)")
        return local_path
    except Exception as e:  # noqa: BLE001 — we want to keep going for optional files
        if optional:
            print(f"         skipped (optional, not in repo): {e}")
            return None
        print(f"         FAILED: {e}")
        return None


def fetch_gguf() -> bool:
    print(f"\n[gguf] {GGUF_REPO} :: {GGUF_FILE}")
    return _download(GGUF_REPO, GGUF_FILE, MODELS_DIR) is not None


def fetch_helpers() -> None:
    print(f"\n[helpers] from {GGUF_REPO}")
    for filename in HELPER_FILES:
        _download(GGUF_REPO, filename, MODELS_DIR, optional=False)


def fetch_tokenizer_and_config() -> bool:
    print(f"\n[tokenizer/config] from {TOKENIZER_REPO}")
    pulled_any = False
    for filename in TOKENIZER_FILES:
        path = _download(TOKENIZER_REPO, filename, MODELS_DIR, optional=True)
        if path:
            pulled_any = True
    if not pulled_any:
        print(f"  WARNING: no tokenizer/config files found in {TOKENIZER_REPO}.")
    return pulled_any


def list_repos() -> None:
    for repo in (GGUF_REPO, TOKENIZER_REPO):
        print(f"\n=== {repo} ===")
        try:
            for f in list_repo_files(repo):
                print(f"  {f}")
        except Exception as e:  # noqa: BLE001
            print(f"  ERROR: {e}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Download SenseNova-U1 GGUF + config locally.")
    ap.add_argument("--gguf-only", action="store_true", help="Only the GGUF weights.")
    ap.add_argument("--config-only", action="store_true", help="Only tokenizer + config files.")
    ap.add_argument("--list", action="store_true", help="List files in both repos and exit.")
    args = ap.parse_args()

    if args.list:
        list_repos()
        return 0

    _ensure_dir(MODELS_DIR)
    print(f"Destination: {os.path.abspath(MODELS_DIR)}")

    ok = True
    if args.config_only:
        ok = fetch_tokenizer_and_config() and ok
    elif args.gguf_only:
        ok = fetch_gguf() and ok
    else:
        ok = fetch_gguf() and ok
        fetch_helpers()
        ok = fetch_tokenizer_and_config() and ok

    print("\nDone." if ok else "\nFinished with errors.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
