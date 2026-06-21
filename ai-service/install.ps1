#Requires -Version 5.1
<#
.SYNOPSIS
  One-command installer for the 5cd AI image worker (FLUX.2-klein-4B).

.DESCRIPTION
  Single model for everything — text-to-image, image-to-image (edits) and AI
  upscaling — quantised to fit one <24GB card (GGUF transformer + 4-bit text
  encoder, ~8GB resident). Builds a Python 3.11 venv, installs CUDA 12.8 PyTorch +
  deps (diffusers main, bitsandbytes, gguf, spandrel), seeds .env, downloads the
  weights (GGUF transformer + base components + upscaler), then verifies.

.PARAMETER SkipModels   Set up the env but skip the (large) weight download.
.PARAMETER SkipTorch    Don't (re)install CUDA PyTorch.
.PARAMETER Recreate     Delete and rebuild the .venv.
.PARAMETER TorchIndexUrl  PyTorch wheel index (default cu128 for RTX 50-series).

.EXAMPLE
  .\install.ps1
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

$TorchSpec = @("torch==2.11.0", "torchvision==0.26.0")
$VenvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$RepoUrl = "https://github.com/black-forest-labs/flux2.git"

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }
function Invoke-Native {
  param([Parameter(Mandatory)][scriptblock]$Cmd, [string]$What = "command")
  & $Cmd
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  5cd AI image worker installer (FLUX.2-klein-4B)" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# ---- 1. Python 3.11 ------------------------------------------------------
Write-Step "Locating Python 3.11"
$pyExe = $null; $pyArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) {
  & py -3.11 --version *> $null
  if ($LASTEXITCODE -eq 0) { $pyExe = "py"; $pyArgs = @("-3.11") }
}
if (-not $pyExe) {
  $cand = Get-Command python -ErrorAction SilentlyContinue
  if ($cand) { $v = (& python --version 2>&1); if ($v -match "3\.11\.") { $pyExe = "python"; $pyArgs = @() } }
}
if (-not $pyExe) { throw "Python 3.11 not found. Install it from https://www.python.org/downloads/release/python-3119/ and re-run." }
Write-Ok "Using $(& $pyExe @pyArgs --version) ($pyExe $($pyArgs -join ' '))"

# ---- 2. venv -------------------------------------------------------------
Write-Step "Virtual environment (.venv)"
if ($Recreate -and (Test-Path ".venv")) { Write-Note "Removing existing .venv (-Recreate)"; Remove-Item -Recurse -Force ".venv" }
if (-not (Test-Path $VenvPy)) { Invoke-Native { & $pyExe @pyArgs -m venv .venv } "venv creation"; Write-Ok "Created .venv" }
else { Write-Ok ".venv already present" }
Invoke-Native { & $VenvPy -m pip install --upgrade pip --quiet } "pip upgrade"
Write-Ok "pip up to date"

# ---- 3. PyTorch (CUDA) ---------------------------------------------------
if ($SkipTorch) { Write-Step "PyTorch - skipped (-SkipTorch)" }
else {
  Write-Step "Installing CUDA PyTorch from $TorchIndexUrl"
  Invoke-Native { & $VenvPy -m pip install @TorchSpec --index-url $TorchIndexUrl } "torch install"
  Write-Ok "torch + torchvision installed"
}

# ---- 4. Dependencies -----------------------------------------------------
Write-Step "Installing Python dependencies (requirements.txt)"
Invoke-Native { & $VenvPy -m pip install -r requirements.txt } "requirements install"
Write-Ok "Dependencies installed (diffusers main + bitsandbytes + gguf + spandrel)"

# ---- 5. .env -------------------------------------------------------------
Write-Step "Environment file (.env)"
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Ok "Created .env from .env.example" }
else { Write-Ok ".env already present (left untouched)" }

# ---- 6. FLUX.2 reference repo (optional; runtime uses diffusers) ---------
Write-Step "Cloning FLUX.2 reference repo (flux2)"
if (Test-Path "flux2/.git") { Write-Ok "flux2 already cloned" }
elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Note "git not found - skipping (reference only)." }
else {
  try { Invoke-Native { & git clone --depth 1 $RepoUrl flux2 } "git clone flux2"; Write-Ok "Cloned $RepoUrl" }
  catch { Write-Note "Clone failed ($_); continuing (reference only, not required at runtime)." }
}

# ---- 7. Weights ----------------------------------------------------------
if ($SkipModels) {
  Write-Step "Model download - skipped (-SkipModels)"
  Write-Note "Download later with: $VenvPy download_model.py"
} else {
  Write-Step "Downloading weights (GGUF transformer + base components + upscaler, ~13GB)"
  Invoke-Native { & $VenvPy download_model.py } "model download"
  Write-Ok "Weights downloaded"
}

# ---- 8. Verify -----------------------------------------------------------
Write-Step "Verifying install"
$verifyPy = @'
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
'@
$tmp = Join-Path $env:TEMP ("flux_verify_" + $PID + ".py")
Set-Content -Path $tmp -Value $verifyPy -Encoding UTF8
try {
  & $VenvPy -X utf8 $tmp
  if ($LASTEXITCODE -ne 0) { throw "Verification failed (Flux2KleinPipeline missing? exit $LASTEXITCODE)." }
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  Install complete." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Start it with:  .\.venv\Scripts\python.exe run.py" -ForegroundColor White
Write-Host "It serves t2i + i2i + upscale on http://127.0.0.1:8090" -ForegroundColor White
