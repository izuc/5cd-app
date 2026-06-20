#!/usr/bin/env bash
# One-shot installer for the 5cd AI worker (SenseNova-U1 GGUF + Infographic 8-step LoRA).
# Linux/macOS parity for install.ps1. Safe to re-run.
#
# Usage:
#   ./install.sh                 # full install (env + ~17 GB models)
#   ./install.sh --skip-models   # env only; run `python download_model.py` later
#   ./install.sh --skip-torch    # don't (re)install CUDA torch
#   ./install.sh --recreate      # rebuild .venv from scratch
#   TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124 ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

SKIP_MODELS=0; SKIP_TORCH=0; RECREATE=0
for arg in "$@"; do
  case "$arg" in
    --skip-models) SKIP_MODELS=1 ;;
    --skip-torch)  SKIP_TORCH=1 ;;
    --recreate)    RECREATE=1 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# cu128 wheels for RTX 50-series / Blackwell. Override via TORCH_INDEX_URL.
TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
TORCH_SPEC=(torch==2.11.0 torchvision==0.26.0)
SENSENOVA_REPO="https://github.com/OpenSenseNova/SenseNova-U1.git"
VENV_PY="./.venv/bin/python"

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok] %s\n' "$1"; }

echo "========================================================"
echo "  5cd AI worker installer (SenseNova-U1)"
echo "========================================================"

# ---- 1. Python 3.11 ----
step "Locating Python 3.11"
PY311=""
for c in python3.11 python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" --version 2>&1 | grep -q "3\.11\."; then
    PY311="$c"; break
  fi
done
[ -n "$PY311" ] || { echo "Python 3.11 not found (SenseNova-U1 needs >=3.11,<3.12)." >&2; exit 1; }
ok "Using $($PY311 --version) ($PY311)"

# ---- 2. venv ----
step "Virtual environment (.venv)"
[ "$RECREATE" = 1 ] && [ -d .venv ] && { echo "  removing .venv (--recreate)"; rm -rf .venv; }
[ -x "$VENV_PY" ] || { "$PY311" -m venv .venv; ok "created .venv"; }
"$VENV_PY" -m pip install --upgrade pip --quiet
ok "pip up to date"

# ---- 3. torch ----
if [ "$SKIP_TORCH" = 1 ]; then
  step "PyTorch — skipped (--skip-torch)"
else
  step "Installing CUDA PyTorch from $TORCH_INDEX_URL"
  "$VENV_PY" -m pip install "${TORCH_SPEC[@]}" --index-url "$TORCH_INDEX_URL"
  ok "torch + torchvision installed"
fi

# ---- 4. deps ----
step "Installing Python dependencies (requirements.txt)"
"$VENV_PY" -m pip install -r requirements.txt
ok "dependencies installed"

# ---- 5. SenseNova-U1 (editable, --no-deps so its torch==2.8.0 pin doesn't clobber cu128) ----
step "SenseNova-U1 package (custom NEO-Unify AutoModel)"
if [ ! -f SenseNova-U1/pyproject.toml ]; then
  command -v git >/dev/null 2>&1 || { echo "git not found — needed to clone $SENSENOVA_REPO" >&2; exit 1; }
  git clone --depth 1 "$SENSENOVA_REPO" SenseNova-U1
fi
"$VENV_PY" -m pip install -e ./SenseNova-U1 --no-deps
ok "sensenova_u1 installed (editable, --no-deps)"

# ---- 6. .env ----
step "Environment file (.env)"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }
[ -f .env ] && ok ".env ready"

# ---- 7. models ----
if [ "$SKIP_MODELS" = 1 ]; then
  step "Model download — skipped (--skip-models)"
  echo "  Run '$VENV_PY download_model.py' before starting the worker."
else
  step "Downloading model + LoRA + tokenizer/config (~17 GB, one-time)"
  "$VENV_PY" download_model.py
  ok "model files downloaded"
fi

# ---- 8. verify ----
# -X utf8: importing sensenova_u1 triggers transformers' auto_docstring, which
# prints emoji warnings; UTF-8 mode keeps the verify subprocess from choking.
step "Verifying install"
"$VENV_PY" -X utf8 - "$PWD" <<'PYEOF'
import warnings
warnings.filterwarnings("ignore")
import importlib, os, sys, torch
print('torch', torch.__version__, '| cuda build', torch.version.cuda, '| cuda available', torch.cuda.is_available())
if torch.cuda.is_available():
    print('gpu', torch.cuda.get_device_name(0))
importlib.import_module('sensenova_u1')
print('sensenova_u1 import OK')
base = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
from dotenv import load_dotenv; load_dotenv(os.path.join(base, '.env'))
md = os.getenv('MODELS_DIR', './models')
if not os.path.isabs(md):
    md = os.path.join(base, md)
missing = False
for key in ('GGUF_FILE', 'LORA_FILE'):
    fn = os.getenv(key, '')
    p = os.path.join(md, fn) if fn else ''
    ok = bool(fn) and os.path.exists(p)
    print(f'{key}={fn or "(unset)"} ->', 'present' if ok else ('MISSING' if fn else 'skipped'))
    if fn and not ok:
        missing = True
sys.exit(2 if missing else 0)
PYEOF

echo
echo "========================================================"
echo "  Install complete."
echo "========================================================"
echo "Start the worker with:  ./.venv/bin/python run.py"
echo "Health check at:        http://127.0.0.1:8090/api/health"
