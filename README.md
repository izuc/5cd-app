# 5cd

AI design studio for **5cd.com** ("5 cent designs"). One unified model handles both
text-to-image generation and image editing — "prompt → image → chat to refine → export".

```
.
├── ai-service/          # FastAPI worker — FLUX.2-klein-4B (t2i + i2i + AI upscale)
├── backend/             # PHP Slim API (auth, projects, generations, exports, credits)
├── frontend/            # Vite + React + TypeScript + Tailwind
├── uploads/             # User-uploaded refs and generated outputs
├── database.sql         # MySQL schema (run once)
└── README.md
```

## Stack
- **AI service**: Python 3.11, PyTorch (CUDA), `diffusers` (main), `transformers`, `bitsandbytes`,
  `gguf`, `spandrel`. Runs **FLUX.2-klein-4B** (GGUF transformer + 4-bit Qwen3 text encoder) for
  text-to-image, image-to-image and AI upscaling on a single <24 GB GPU.
- **Backend**: PHP 8.1+ with Slim 4, PDO/MySQL.
- **Frontend**: React 18 + Vite 6 + Tailwind 3.
- **Database**: MySQL 8.4.7 — root user, no password (matches the local dev setup).
- **Default ports**: backend `8081`, AI service `8090`, Vite dev server `5180`.

## Setup

### 1. Database
```powershell
# from the project root
mysql -u root --execute "source database.sql"
```

This drops/creates a fresh `5cd_single` database.

### 2. Backend (PHP Slim)
```powershell
cd backend
composer install
copy .env.example .env
# adjust JWT_SECRET if you want
php -S 127.0.0.1:8081 -t public
```

### 3. AI service (FLUX.2-klein-4B)

One model does everything — **text-to-image, image-to-image (edits) and AI upscaling** —
quantised to fit a single **<24 GB** card (in practice ~8 GB resident, ~10–13 GB peak):
the transformer loads as **GGUF** (`from_single_file`) and the **Qwen3 text encoder in
4-bit (nf4)**. FLUX.2-klein is **Apache-2.0 and ungated** (no token needed).

**One-command installer (recommended).** Builds the Python 3.11 venv, installs CUDA 12.8
PyTorch (RTX 50-series / Blackwell) + deps (diffusers main, bitsandbytes, gguf, spandrel),
seeds `.env`, downloads the weights (GGUF transformer + base components + upscaler, ~13 GB),
and verifies:

```powershell
cd ai-service
.\install.ps1                 # -SkipModels for env only, -Recreate to rebuild .venv
.\.venv\Scripts\python.exe run.py
```
On Linux/macOS: `./install.sh` (flags `--skip-models`, `--recreate`, `--skip-torch`).

#### About the model
- **One worker, three jobs**: `POST /api/generate/async` (t2i), `POST /api/edit/async`
  (i2i — the source is the reference), `POST /api/upscale` (Real-ESRGAN via spandrel).
- **Quantisation**: GGUF transformer (default `Q4_K_M`, ~2.6 GB — bump to `Q5_K_M`/`Q6_K`
  in `.env` for more fidelity) + Qwen3 text encoder quantised to 4-bit at load. The bf16
  text encoder lives on disk (~8 GB) because diffusers can't load a GGUF text encoder
  (transformers has no Qwen3-GGUF support); on the GPU it's only ~2.5 GB.
- **Defaults**: 1024×1024, 4 steps (klein is step-distilled), guidance 4.0. VAE tiling is
  on to trim the decode peak. Set `ENABLE_CPU_OFFLOAD=1` to fit in ~6 GB (slower).
- Only the **GGUF transformer** + the base repo's **text encoder + VAE + configs** are
  downloaded — the unused bf16 transformer (~16 GB) is skipped. If `cuda` is unavailable
  the service still runs and returns placeholder swatches so the UI can be exercised.

### 4. Frontend
```powershell
cd frontend
npm install
npm run dev
```
Open `http://localhost:5180`.

#### Vectorise (raster → SVG)
The studio has a **Vectorise** button (next to Export) that converts the chosen design
to a scalable **SVG**. The engine (`frontend/src/vectorize/`, vendored from the
`raster2vector` project) runs in a browser Web Worker: quantise → trace → SVG. It
upscales the source before tracing (quality: fast 1× / balanced 2× / high 3× / detailed 4×)
so even a 1024px generation produces crisp curves, with a colour-count control and an
optional "auto-remove background". An **AI upscale** toggle first super-resolves the image
via the worker's `/api/upscale` (Real-ESRGAN) for an even cleaner, finer-detail trace.

After tracing it opens a **Vector-Magic-style editor**: click / rectangle selection,
a **paint** (bucket) tool + **eyedropper**, and a colour list to select / recolour /
remove every shape of a colour (e.g. click the background colour's trash to drop it).
Plus apply-colour-to-selection, delete, select-all/invert, and undo. Output is the
edited `.svg` download.

## API surface (backend)

| Method | Path                                            | Notes                                    |
|--------|-------------------------------------------------|------------------------------------------|
| POST   | `/api/auth/register` / `/login` / `/logout`     | JWT auth                                 |
| GET    | `/api/auth/me`                                  | current user                             |
| GET    | `/api/projects`                                 | list (paginated, thumbnails)             |
| POST   | `/api/projects`                                 | create                                   |
| GET    | `/api/projects/{id}`                            | full record + generations                |
| PATCH  | `/api/projects/{id}`                            | update title/status/config               |
| DELETE | `/api/projects/{id}`                            | archive                                  |
| POST   | `/api/projects/{id}/generate`                   | kick T2I (returns `job_id`)              |
| POST   | `/api/projects/{id}/edit`                       | kick image edit                          |
| GET    | `/api/projects/{id}/generations`                | list + auto-save completed jobs          |
| POST   | `/api/projects/{id}/generations/{genId}/choose` | promote a concept                        |
| GET    | `/api/jobs/{jobId}/status`                      | proxied AI job poll                      |
| GET    | `/api/ai-config`                                | engine + size/steps policy for the UI    |
| POST   | `/api/upscale`                                  | AI super-resolution (proxied to worker)  |
| POST   | `/api/projects/{id}/export`                     | export PNG/JPG/transparent_png/PDF       |
| GET    | `/api/credits/balance` / `/history`             | credit account                           |
| POST   | `/api/credits/purchase`                         | dev: instant top-up                      |
