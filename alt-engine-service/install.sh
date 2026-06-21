#!/usr/bin/env bash
# Installer for the OPTIONAL alternate image-engine worker (Linux/macOS).
# Isolated venv so diffusers-from-main here doesn't clash with SenseNova's pin.
#
#   ./install.sh                       # ENGINE=flux (Apache-2.0, ungated)
#   ./install.sh --engine ideogram     # gated + Non-Commercial; set HF_TOKEN first
#   ./install.sh --skip-models         # env only
#   ./install.sh --skip-torch | --recreate
#   TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124 ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

ENGINE="flux"; SKIP_MODELS=0; SKIP_TORCH=0; RECREATE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) ENGINE="${2:-flux}"; shift 2 ;;
    --skip-models) SKIP_MODELS=1; shift ;;
    --skip-torch)  SKIP_TORCH=1; shift ;;
    --recreate)    RECREATE=1; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
case "$ENGINE" in flux|ideogram) ;; *) echo "engine must be flux|ideogram" >&2; exit 2 ;; esac

TORCH_INDEX_URL="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}"
TORCH_SPEC=(torch==2.11.0 torchvision==0.26.0)
VENV_PY="./.venv/bin/python"
if [ "$ENGINE" = "flux" ]; then
  REPO_URL="https://github.com/black-forest-labs/flux2.git"; REPO_DIR="flux2"; PIPE="Flux2KleinPipeline"
else
  REPO_URL="https://github.com/ideogram-oss/ideogram4.git"; REPO_DIR="ideogram4"; PIPE="Ideogram4Pipeline"
fi

step() { printf '\n=== %s ===\n' "$1"; }
ok()   { printf '  [ok] %s\n' "$1"; }
note() { printf '  [!]  %s\n' "$1"; }

echo "========================================================"
echo "  5cd alt engine installer (ENGINE=$ENGINE)"
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
ok "dependencies installed (incl. diffusers from main)"

step "Environment file (.env)"
[ -f .env ] || { cp .env.example .env; ok "created .env from .env.example"; }
# Set ENGINE in .env (portable sed -i for GNU and BSD).
if grep -q '^ENGINE=' .env; then
  sed -i.bak "s/^ENGINE=.*/ENGINE=$ENGINE/" .env && rm -f .env.bak
else
  printf '\nENGINE=%s\n' "$ENGINE" >> .env
fi
ok "ENGINE=$ENGINE set in .env"

step "Cloning associated source repo ($REPO_DIR)"
if [ -d "$REPO_DIR/.git" ]; then ok "$REPO_DIR already cloned"
elif ! command -v git >/dev/null 2>&1; then note "git not found - skipping (reference only)."
else git clone --depth 1 "$REPO_URL" "$REPO_DIR" && ok "cloned $REPO_URL" || note "clone failed (reference only)."
fi

if [ "$SKIP_MODELS" = 1 ]; then
  step "Model download - skipped (--skip-models)"
  [ "$ENGINE" = "ideogram" ] && note "Set HF_TOKEN in .env (accept the license), then: $VENV_PY download_model.py"
else
  step "Downloading $ENGINE weights"
  [ "$ENGINE" = "ideogram" ] && note "Ideogram is gated; needs an accepted license + HF_TOKEN in .env."
  "$VENV_PY" download_model.py
  ok "weights downloaded"
fi

step "Verifying install"
"$VENV_PY" -X utf8 - "$PIPE" <<'PYEOF'
import warnings
warnings.filterwarnings("ignore")
import importlib.util, sys, torch
print('torch', torch.__version__, '| cuda available', torch.cuda.is_available())
if torch.cuda.is_available():
    print('gpu', torch.cuda.get_device_name(0))
import diffusers
pipe_name = sys.argv[1] if len(sys.argv) > 1 else 'Flux2KleinPipeline'
has_pipe = hasattr(diffusers, pipe_name)
print('diffusers', diffusers.__version__, '|', pipe_name, 'OK' if has_pipe else 'MISSING (need diffusers main)')
print('bitsandbytes', 'present' if importlib.util.find_spec('bitsandbytes') else 'MISSING')
sys.exit(0 if has_pipe else 3)
PYEOF

echo
echo "========================================================"
echo "  Alt engine ($ENGINE) install complete."
echo "========================================================"
echo "Start it with:  ./.venv/bin/python run.py"
echo "Then in backend/.env set:  ALT_ENGINE_ENABLED=true"
[ "$ENGINE" = "flux" ] && echo "  (FLUX supports edits: ALT_ENGINE_EDITS=true to route edits here too.)"
