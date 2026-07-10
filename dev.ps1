# Convenience launcher for local development.
# Starts the PHP backend and Vite frontend in separate PowerShell windows.
# Run the AI service (`python ai-service/run.py`) in its own window — it owns the GPU.

$root = $PSScriptRoot

Write-Host "Starting backend on http://127.0.0.1:8082 ..."
# Port 8082 matches the vite proxy (8081 was lost to another local process).
# Raised limits: the layered editor PUTs multi-MB base64 layer bitmaps; the PHP
# default post_max_size (8M) would silently truncate those bodies.
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\backend'; if (-not (Test-Path .env)) { Copy-Item .env.example .env }; if (-not (Test-Path vendor)) { composer install }; php -d post_max_size=64M -d memory_limit=512M -S 127.0.0.1:8082 -t public"

Start-Sleep -Seconds 2

Write-Host "Starting frontend on http://127.0.0.1:5180 ..."
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\frontend'; if (-not (Test-Path node_modules)) { npm install }; npm run dev"

Write-Host ""
Write-Host "Backend  -> http://127.0.0.1:8082"
Write-Host "Frontend -> http://127.0.0.1:5180"
Write-Host "AI       -> run 'python ai-service\run.py' in another shell (port 8090)"
