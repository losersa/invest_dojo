# ===============================================================
# InvestDojo - Infrastructure - Windows PowerShell starter
# ===============================================================
# Usage:
#   cd investdojo\infra\supabase-lite
#   .\scripts\up.ps1
#
# This script is intentionally ASCII-only to stay compatible with
# Windows PowerShell 5.1 which reads .ps1 as system codepage (GBK on CN).
#
# Auth is now self-hosted (data-svc /api/v1/auth + httpOnly Cookie),
# so PostgREST / GoTrue / Kong are no longer started.
# ===============================================================

$ErrorActionPreference = "Stop"

# Switch to stack root (parent of this script)
$ScriptDir = Split-Path -Parent $PSCommandPath
$StackDir  = Split-Path -Parent $ScriptDir
Set-Location $StackDir

# --- helpers ----------------------------------------------------
function LogStep($msg) {
    Write-Host ""
    Write-Host "===============================================" -ForegroundColor Blue
    Write-Host "  $msg" -ForegroundColor Blue
    Write-Host "===============================================" -ForegroundColor Blue
}
function LogOk($msg)   { Write-Host "[OK] $msg"   -ForegroundColor Green }
function LogWarn($msg) { Write-Host "[!!] $msg"   -ForegroundColor Yellow }
function LogErr($msg)  { Write-Host "[XX] $msg"   -ForegroundColor Red }
function LogInfo($msg) { Write-Host "[..] $msg"   -ForegroundColor Cyan }

# --- 1. Environment check --------------------------------------
LogStep "1. Environment check"

try { docker --version | Out-Null }
catch { LogErr "docker not found on PATH"; exit 1 }

try { docker info 2>&1 | Out-Null }
catch { LogErr "Docker daemon is not running. Please open Docker Desktop."; exit 1 }
LogOk "Docker is ready"

# --- 2. .env -----------------------------------------------------
LogStep "2. Check .env"

if (-not (Test-Path ".env")) {
    LogWarn ".env not found, copying from .env.example and generating random secrets"
    Copy-Item ".env.example" ".env"

    # Random alphanumeric password (24 chars)
    $pgPwd = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })

    # 48-byte JWT secret, base64
    $bytes = New-Object byte[] 48
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $jwtSec = [Convert]::ToBase64String($bytes)

    (Get-Content ".env") `
        -replace '<CHANGE_ME_STRONG_PASSWORD>', $pgPwd `
        -replace '<CHANGE_ME_AT_LEAST_32_BYTES>', $jwtSec |
        Set-Content ".env"

    LogOk "Generated POSTGRES_PASSWORD and AUTH_JWT_SECRET"
} else {
    LogOk "Found existing .env"
}

# --- 3. Load .env ------------------------------------------------
$envMap = @{}
Get-Content ".env" | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object {
    $kv = $_ -split '=', 2
    $envMap[$kv[0]] = $kv[1]
    [System.Environment]::SetEnvironmentVariable($kv[0], $kv[1], "Process")
}

# --- 4. Create data dirs -----------------------------------------
LogStep "3. Create data dirs"
$dataDir = if ($envMap["DATA_DIR"]) { $envMap["DATA_DIR"] } else { ".\data" }
New-Item -ItemType Directory -Force -Path "$dataDir\db"        | Out-Null
New-Item -ItemType Directory -Force -Path "$dataDir\db-backup" | Out-Null
LogOk "DATA_DIR = $dataDir"

# --- 5. docker compose up ----------------------------------------
LogStep "4. docker compose up -d"
docker compose up -d
if ($LASTEXITCODE -ne 0) { LogErr "docker compose up failed"; exit 2 }
LogOk "Containers started"

# --- 6. Wait for postgres healthy --------------------------------
LogStep "5. Wait for Postgres"
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    docker compose exec -T db pg_isready -U postgres -d postgres 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Write-Host "." -NoNewline
    Start-Sleep -Seconds 2
}
Write-Host ""
if (-not $ready) {
    LogErr "Postgres did not become ready in 60s. Check: docker compose logs db"
    exit 3
}
LogOk "Postgres is healthy"

# --- 7. Summary -------------------------------------------------
LogStep "DONE"

$pgPort = if ($envMap["POSTGRES_PORT"]) { $envMap["POSTGRES_PORT"] } else { "5432" }

Write-Host ""
Write-Host "  Postgres         localhost:$pgPort  (user: postgres)"
Write-Host "  Redis            localhost:6379"
Write-Host "  MinIO S3         localhost:9000"
Write-Host "  MinIO Console    localhost:9001"
Write-Host ""
Write-Host "  Auth (self-hosted)  data-svc :8006 /api/v1/auth (httpOnly Cookie: id_session)"
Write-Host ""
Write-Host "  Apply migrations:  .\scripts\apply-migrations.ps1"
Write-Host "  Stop:              docker compose down"
Write-Host "  Logs:              docker compose logs -f [service]"
Write-Host "  Psql:              docker compose exec db psql -U postgres"
Write-Host ""
