#Requires -Version 5.1
<#
.SYNOPSIS
  Installer for the OPTIONAL alternate image-engine worker (FLUX.2-klein or Ideogram 4).

.DESCRIPTION
  Isolated venv (diffusers-from-main here must not clash with SenseNova's pinned
  diffusers). Builds Python 3.11 venv + CUDA 12.8 PyTorch + deps, sets ENGINE in
  .env, clones the engine's associated source repo (black-forest-labs/flux2 or
  ideogram-oss/ideogram4), downloads the weights, then verifies.

  -Engine flux      FLUX.2-klein (Apache-2.0, ungated). Default.
  -Engine ideogram  Ideogram 4 nf4 + TurboTime LoRA (GATED + Non-Commercial:
                    set HF_TOKEN in .env first, or use -SkipModels and do it later).

.PARAMETER Engine       flux | ideogram (written into .env). Default: flux.
.PARAMETER SkipModels   Set up the env but skip the weight download.
.PARAMETER SkipTorch    Don't (re)install CUDA PyTorch.
.PARAMETER Recreate     Delete and rebuild the .venv.
.PARAMETER TorchIndexUrl  PyTorch wheel index (default cu128 for RTX 50-series).

.EXAMPLE
  .\install.ps1 -Engine flux
.EXAMPLE
  .\install.ps1 -Engine ideogram -SkipModels   # then set HF_TOKEN, python download_model.py
#>
[CmdletBinding()]
param(
  [ValidateSet("flux", "ideogram")]
  [string]$Engine = "flux",
  [switch]$SkipModels,
  [switch]$SkipTorch,
  [switch]$Recreate,
  [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128"
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$TorchSpec = @("torch==2.11.0", "torchvision==0.26.0")
$VenvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$RepoUrl = @{ flux = "https://github.com/black-forest-labs/flux2.git"; ideogram = "https://github.com/ideogram-oss/ideogram4.git" }[$Engine]
$RepoDir = @{ flux = "flux2"; ideogram = "ideogram4" }[$Engine]
$PipeName = @{ flux = "Flux2KleinPipeline"; ideogram = "Ideogram4Pipeline" }[$Engine]

function Write-Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Write-Note($msg) { Write-Host "  [!]  $msg" -ForegroundColor Yellow }

function Invoke-Native {
  param([Parameter(Mandatory)][scriptblock]$Cmd, [string]$What = "command")
  & $Cmd
  if ($LASTEXITCODE -ne 0) { throw "$What failed (exit $LASTEXITCODE)." }
}

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  5cd alt engine installer (ENGINE=$Engine)" -ForegroundColor Cyan
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
Write-Ok "Dependencies installed (incl. diffusers from main)"

# ---- 5. .env (+ set ENGINE) ---------------------------------------------
Write-Step "Environment file (.env)"
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Ok "Created .env from .env.example" }
(Get-Content ".env") -replace '^ENGINE=.*', "ENGINE=$Engine" | Set-Content ".env"
Write-Ok "ENGINE=$Engine set in .env"

# ---- 6. Associated source repo (reference / official inference code) ------
Write-Step "Cloning associated source repo ($RepoDir)"
if (Test-Path (Join-Path $RepoDir ".git")) {
  Write-Ok "$RepoDir already cloned"
} elseif (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Note "git not found - skipping $RepoUrl (the worker uses diffusers; this repo is reference only)."
} else {
  try { Invoke-Native { & git clone --depth 1 $RepoUrl $RepoDir } "git clone $RepoDir"; Write-Ok "Cloned $RepoUrl" }
  catch { Write-Note "Clone failed ($_); continuing (reference only, not required at runtime)." }
}

# ---- 7. Weights ----------------------------------------------------------
if ($SkipModels) {
  Write-Step "Model download - skipped (-SkipModels)"
  if ($Engine -eq "ideogram") { Write-Note "Set HF_TOKEN in .env (accept the license first), then: $VenvPy download_model.py" }
  else { Write-Note "Download later with: $VenvPy download_model.py" }
} else {
  Write-Step "Downloading $Engine weights"
  if ($Engine -eq "ideogram") { Write-Note "Ideogram is gated; needs an accepted license + HF_TOKEN in .env." }
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
pipe_name = sys.argv[1] if len(sys.argv) > 1 else 'Flux2KleinPipeline'
has_pipe = hasattr(diffusers, pipe_name)
print('diffusers', diffusers.__version__, '|', pipe_name, 'OK' if has_pipe else 'MISSING (need diffusers main)')
print('bitsandbytes', 'present' if importlib.util.find_spec('bitsandbytes') else 'MISSING')
sys.exit(0 if has_pipe else 3)
'@
$tmp = Join-Path $env:TEMP ("alt_verify_" + $PID + ".py")
Set-Content -Path $tmp -Value $verifyPy -Encoding UTF8
try {
  & $VenvPy -X utf8 $tmp $PipeName
  if ($LASTEXITCODE -ne 0) { throw "Verification failed ($PipeName missing? exit $LASTEXITCODE)." }
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
}

Write-Host "`n========================================================" -ForegroundColor Green
Write-Host "  Alt engine ($Engine) install complete." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Green
Write-Host "Start it with:  .\.venv\Scripts\python.exe run.py" -ForegroundColor White
Write-Host "Then in backend/.env set:  ALT_ENGINE_ENABLED=true" -ForegroundColor White
if ($Engine -eq "flux") { Write-Host "  (FLUX supports edits: ALT_ENGINE_EDITS=true to route edits here too.)" -ForegroundColor White }
