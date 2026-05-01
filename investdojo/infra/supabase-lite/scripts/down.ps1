$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $PSCommandPath
Set-Location (Split-Path -Parent $ScriptDir)
Write-Host "Stopping Supabase Lite stack..."
docker compose down
Write-Host "[OK] Stopped. Data is still kept under DATA_DIR." -ForegroundColor Green
Write-Host "     To wipe data: Remove-Item -Recurse -Force .\data  (IRREVERSIBLE)" -ForegroundColor Yellow
