#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot installer for the 5cd AI worker (SenseNova-U1 GGUF + Infographic 8-step LoRA).

.DESCRIPTION
  Reproduces the verified-working AI backend from scratch:
    1. Locates Python 3.11 and creates the .venv
    2. Installs CUDA 12.8 PyTorch (RTX 50-series / Blackwell) + the pinned deps
    3. Clones + editable-installs the SenseNova-U1 package (registers the custom AutoModel)
    4. Seeds .env from .env.example
    5. Downloads the GGUF weights, the 8-step Infographic LoRA, and tokenizer/config
       (~17 GB total) into .\models
    6. Verifies the install (CUDA visible, package imports, model files present)

  Safe to re-run: existing venv / files / downloads are reused, not clobbered.

.PARAMETER SkipModels
  Set up the environment but skip the (large) model + LoRA download.

.PARAMETER SkipTorch
  Don't (re)install CUDA PyTorch - use whatever is already in the venv.

.PARAMETER Recreate
  Delete and rebuild the .venv from scratch.

.PARAMETER TorchIndexUrl
  PyTorch wheel index. Defaults to CUDA 12.8 (cu128) for RTX 50-series.
  Use https://download.pytorch.org/whl/cu124 for older GPUs, or
  https://download.pytorch.org/whl/cpu for a CPU-only (placeholder) install.

.EXAMPLE
  .\install.ps1                 # full install (env + models)

.EXAMPLE
  .\install.ps1 -SkipModels     # env only; run `python download_model.py` later

.EXAMPLE
  .\install.ps1 -Recreate       # nuke .venv and rebuild
#>
[CmdletBinding()]
param(
  [switch]$SkipModels,
  [switch]$SkipTorch,
  [switch]$Recreate,
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# Pinned to match the verified-working environment. Drop the ==version to grab the
# newest cu128 build if these wheels ever age out of the index.
$TorchSpec = @("torch==2.11.0", "torchvision==0.26.0")
$SenseNovaRepo = "https://github.com/OpenSenseNova/SenseNova-U1.git"
$SenseNovaDir = Join-Path $PSScriptRoot "SenseNova-U1"
$VenvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

# Run a native command and abort if it returns a non-zero exit code.
function Invoke-Native {
  param([Parameter(Mandatory)][scriptblock]$Cmd, [string]$What = "command")
  & $Cmd
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  5cd AI worker installer (SenseNova-U1)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# ---- 1. Find Python 3.11 -------------------------------------------------
Write-Step "Locating Python 3.11"
$pyExe = $null
$pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3.11 --version *> $null
  if ($LASTEXITCODE -eq 0) { $pyExe = "py"; $pyArgs = @("-3.11") }
}
if (-not $pyExe) {
  $cand = Get-Command python -ErrorAction SilentlyContinue
  if ($cand) {
    $v = (& python --version 2>&1)
    if ($v -match "3\.11\.") { $pyExe = "python"; $pyArgs = @() }
  }
}
if (-not $pyExe) {
  throw "Python 3.11 not found. SenseNova-U1 requires Python 3.11.x. Install it from https://www.python.org/downloads/release/python-3119/ and re-run."
}
$pyVer = (& $pyExe @pyArgs --version)
Write-Ok "Using $pyVer ($pyExe $($pyArgs -join ' '))"

# ---- 2. Virtual environment ---------------------------------------------
Write-Step "Virtual environment (.venv)"
if ($Recreate -and (Test-Path ".venv")) {
  Write-Note "Removing existing .venv (-Recreate)"
  Remove-Item -Recurse -Force ".venv"
}
if (-not (Test-Path $VenvPy)) {
  Invoke-Native { & $pyExe @pyArgs -m venv .venv } "venv creation"
  Write-Ok "Created .venv"
} else {
  Write-Ok ".venv already present"
}
Invoke-Native { & $VenvPy -m pip install --upgrade pip --quiet } "pip upgrade"
Write-Ok "pip up to date"

# ---- 3. PyTorch (CUDA) ---------------------------------------------------
if ($SkipTorch) {
  Write-Step "PyTorch - skipped (-SkipTorch)"
} else {
  Write-Step "Installing CUDA PyTorch from $TorchIndexUrl"
  Invoke-Native { & $VenvPy -m pip install @TorchSpec --index-url $TorchIndexUrl } "torch install"
  Write-Ok "torch + torchvision installed"
}

# ---- 4. Python dependencies ---------------------------------------------
Write-Step "Installing Python dependencies (requirements.txt)"
Invoke-Native { & $VenvPy -m pip install -r requirements.txt } "requirements install"
Write-Ok "Dependencies installed"

# ---- 5. SenseNova-U1 package (editable) ---------------------------------
Write-Step "SenseNova-U1 package (custom NEO-Unify AutoModel)"
if (-not (Test-Path (Join-Path $SenseNovaDir "pyproject.toml"))) {
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git not found - needed to clone $SenseNovaRepo. Install Git and re-run, or clone it manually into .\SenseNova-U1."
  }
  Write-Host "  Cloning $SenseNovaRepo ..."
  Invoke-Native { & git clone --depth 1 $SenseNovaRepo $SenseNovaDir } "git clone SenseNova-U1"
}
# --no-deps: its pyproject pins torch==2.8.0 which would clobber our cu128 build.
Invoke-Native { & $VenvPy -m pip install -e $SenseNovaDir --no-deps } "sensenova_u1 editable install"
Write-Ok "sensenova_u1 installed (editable, --no-deps)"

# ---- 6. .env -------------------------------------------------------------
Write-Step "Environment file (.env)"
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Ok "Created .env from .env.example"
} else {
  Write-Ok ".env already present (left untouched)"
}

# ---- 7. Models + LoRA ----------------------------------------------------
if ($SkipModels) {
  Write-Step "Model download - skipped (-SkipModels)"
  Write-Note "Run '$VenvPy download_model.py' before starting the worker."
} else {
  Write-Step "Downloading model + LoRA + tokenizer/config (~17 GB, one-time)"
  Write-Host "  This pulls:"
  Write-Host "    GGUF : smthem/SenseNova-U1-8B-MoT-Merger-gguf :: SenseNova-U1-8B-MoT-Infographic-Q6_K.gguf"
  Write-Host "    LoRA : sensenova/SenseNova-U1-8B-MoT-LoRAs :: ...Infographic-LoRA-8step-V1.0.safetensors"
  Write-Host "    + tokenizer/config from sensenova/SenseNova-U1-8B-MoT"
  Invoke-Native { & $VenvPy download_model.py } "model download"
  Write-Ok "Model files downloaded"
}

# ---- 8. Verify -----------------------------------------------------------
Write-Step "Verifying install"
$verifyPy = @'
import warnings
warnings.filterwarnings("ignore")
import importlib, os, sys
import torch
print('torch', torch.__version__, '| cuda build', torch.version.cuda, '| cuda available', torch.cuda.is_available())
if torch.cuda.is_available():
    print('gpu', torch.cuda.get_device_name(0))
importlib.import_module('sensenova_u1')
print('sensenova_u1 import OK')
# Resolve .env / models against the service dir (argv[1]) - this script runs from %TEMP%.
base = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
from dotenv import load_dotenv
load_dotenv(os.path.join(base, '.env'))
md = os.getenv('MODELS_DIR', './models')
if not os.path.isabs(md):
    md = os.path.join(base, md)
missing = False
for key in ('GGUF_FILE', 'LORA_FILE'):
    fn = os.getenv(key, '')
    p = os.path.join(md, fn) if fn else ''
    ok = bool(fn) and os.path.exists(p)
    state = 'present' if ok else ('MISSING' if fn else 'skipped')
    print(key + '=' + (fn or '(unset)') + ' -> ' + state)
    if fn and not ok:
        missing = True
sys.exit(2 if missing else 0)
'@
$tmp = Join-Path $env:TEMP ("5cd_verify_" + $PID + ".py")
Set-Content -Path $tmp -Value $verifyPy -Encoding UTF8
try {
  # -X utf8: importing sensenova_u1 triggers transformers' auto_docstring, which
  # prints emoji warnings that crash a cp1252 console (the worker handles this in
  # server.py). UTF-8 mode keeps the verify subprocess from choking on them.
  & $VenvPy -X utf8 $tmp $PSScriptRoot
  if ($LASTEXITCODE -ne 0) { throw "Verification step failed (model files missing? exit $LASTEXITCODE)." }
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  Install complete." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Start the worker with:" -ForegroundColor Green
Write-Host "  .\.venv\Scripts\python.exe run.py" -ForegroundColor White
Write-Host "Then check health at http://127.0.0.1:8090/api/health" -ForegroundColor White
