# 5cd

AI design studio for **5cd.com** ("5 cent designs"). One unified model handles both
text-to-image generation and image editing — "prompt → image → chat to refine → export".

```
.
├── ai-service/          # FastAPI worker that wraps the image model (Python + PyTorch + diffusers)
├── backend/             # PHP Slim API (auth, projects, generations, exports, credits)
├── frontend/            # Vite + React + TypeScript + Tailwind
├── uploads/             # User-uploaded refs and generated outputs
├── database.sql         # MySQL schema (run once)
└── README.md
```

## Stack
- **AI service**: Python 3.10+, PyTorch (CUDA preferred), `transformers`, `diffusers`, `accelerate`,
  `gguf`, plus a small custom harness that registers the unified multimodal model's Auto* classes
  and (optionally) streams transformer layers in/out of the GPU for low-VRAM machines.
- **Backend**: PHP 8.1+ with Slim 4, PDO/MySQL.
- **Frontend**: React 18 + Vite 6 + Tailwind 3.
- **Database**: MySQL 8.4.7 — root user, no password (matches the local dev setup).
- **Default ports**: backend `8080`, AI service `8090`, Vite dev server `5180`.

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
php -S 127.0.0.1:8080 -t public
```

### 3. AI service (Python + image model)

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Install the upstream model package so the custom AutoModel registers.
git clone https://github.com/OpenSenseNova/SenseNova-U1
pip install -e .\SenseNova-U1

# Pull the GGUF weights, helper script, and tokenizer/config files.
copy .env.example .env
python download_model.py
```

Then run it:
```powershell
python run.py
```

The first generation pays the model load cost (a minute or so on disk + RAM). If `cuda` is not
available the service stays alive but returns placeholder swatches so the frontend can still be
exercised end-to-end.

#### About the model
- The GGUF can't be loaded by plain llama.cpp — it uses diffusion sampling
  (`cfg_scale`, `num_steps`, `timestep_shift`, …) via `model.t2i_generate(...)` and
  `model.it2i_generate(...)` defined in the upstream package.
- Defaults are **1024×1024**, **25 steps**, `cfg_scale=4.0`. Trained sweet spot is 2048×2048.
  Width/height must be a multiple of the patch grid (32 by default — the worker auto-rounds up).
- On a 24 GB+ GPU the model just loads to CUDA. On lower-VRAM machines, an optional
  layer-streaming wrapper keeps most weights on CPU pinned memory and prefetches the next
  layer to the GPU during forward.

### 4. Frontend
```powershell
cd frontend
npm install
npm run dev
```
Open `http://localhost:5180`.

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
| POST   | `/api/projects/{id}/export`                     | export PNG/JPG/transparent_png/PDF       |
| GET    | `/api/credits/balance` / `/history`             | credit account                           |
| POST   | `/api/credits/purchase`                         | dev: instant top-up                      |
