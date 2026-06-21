#!/usr/bin/env bash
# One-command installer for the 5cd AI image worker (FLUX.2-klein-4B) — Linux/macOS.
# Single model for everything: text-to-image, image-to-image (edits) and AI upscaling,
# quantised to fit one <24GB card (GGUF transformer + 4-bit text encoder).
#
#   ./install.sh                 # full install (env + ~13GB weights)
#   ./install.sh --skip-models   # env only; run `python download_model.py` later
#   ./install.sh --skip-torch | --recreate
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

TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
TORCH_SPEC=(torch==2.11.0 torchvision==0.26.0)
VENV_PY="./.venv/bin/python"
REPO_URL="https://github.com/black-forest-labs/flux2.git"

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok] %s\n' "$1"; }
note() { printf '  [!]  %s\n' "$1"; }

echo "========================================================"
echo "  5cd AI image worker installer (FLUX.2-klein-4B)"
echo "========================================================"

step "Locating Python 3.11"
PY311=""
for c in python3.11 python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" --version 2>&1 | grep -q "3\.11\."; then PY311="$c"; break; fi
done
[ -n "$PY311" ] || { echo "Python 3.11 not found." >&2; exit 1; }
ok "Using $($PY311 --version) ($PY311)"

step "Virtual environment (.venv)"
[ "$RECREATE" = 1 ] && [ -d .venv ] && { echo "  removing .venv (--recreate)"; rm -rf .venv; }
[ -x "$VENV_PY" ] || { "$PY311" -m venv .venv; ok "created .venv"; }
"$VENV_PY" -m pip install --upgrade pip --quiet
ok "pip up to date"

if [ "$SKIP_TORCH" = 1 ]; then step "PyTorch - skipped (--skip-torch)"; else
  step "Installing CUDA PyTorch from $TORCH_INDEX_URL"
  "$VENV_PY" -m pip install "${TORCH_SPEC[@]}" --index-url "$TORCH_INDEX_URL"; ok "torch installed"
fi

step "Installing Python dependencies (requirements.txt)"
"$VENV_PY" -m pip install -r requirements.txt
ok "dependencies installed (diffusers main + bitsandbytes + gguf + spandrel)"

step "Environment file (.env)"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }
[ -f .env ] && ok ".env ready"

step "Cloning FLUX.2 reference repo (flux2)"
if [ -d "flux2/.git" ]; then ok "flux2 already cloned"
elif ! command -v git >/dev/null 2>&1; then note "git not found - skipping (reference only)."
else git clone --depth 1 "$REPO_URL" flux2 && ok "cloned $REPO_URL" || note "clone failed (reference only)."
fi

if [ "$SKIP_MODELS" = 1 ]; then
  step "Model download - skipped (--skip-models)"
  echo "  Download later with: $VENV_PY download_model.py"
else
  step "Downloading weights (GGUF transformer + base components + upscaler, ~13GB)"
  "$VENV_PY" download_model.py
  ok "weights downloaded"
fi

step "Verifying install"
"$VENV_PY" -X utf8 - <<'PYEOF'
import warnings
warnings.filterwarnings("ignore")
import importlib.util, sys, torch
print('torch', torch.__version__, '| cuda available', torch.cuda.is_available())
if torch.cuda.is_available():
    print('gpu', torch.cuda.get_device_name(0))
import diffusers
ok = hasattr(diffusers, 'Flux2KleinPipeline')
print('diffusers', diffusers.__version__, '| Flux2KleinPipeline', 'OK' if ok else 'MISSING (need diffusers main)')
for m in ('gguf', 'bitsandbytes', 'spandrel'):
    print(m, 'present' if importlib.util.find_spec(m) else 'MISSING')
sys.exit(0 if ok else 3)
PYEOF

echo
echo "========================================================"
echo "  Install complete."
echo "========================================================"
echo "Start it with:  ./.venv/bin/python run.py"
echo "It serves t2i + i2i + upscale on http://127.0.0.1:8090"
