# ===============================================================
# InvestDojo - Supabase Lite Stack - Windows PowerShell starter
# ===============================================================
# Usage:
#   cd investdojo\infra\supabase-lite
#   .\scripts\up.ps1
#
# This script is intentionally ASCII-only to stay compatible with
# Windows PowerShell 5.1 which reads .ps1 as system codepage (GBK on CN).
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

    LogOk "Generated POSTGRES_PASSWORD and JWT_SECRET"
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

# --- 4. Sign ANON / SERVICE_ROLE JWT if still placeholder -------
if ($envMap["ANON_KEY"] -eq "<CHANGE_ME_ANON_JWT>" -or [string]::IsNullOrEmpty($envMap["ANON_KEY"])) {
    LogWarn "ANON_KEY is placeholder, signing new JWTs with python"
    try { python --version 2>&1 | Out-Null }
    catch { LogErr "python not found (install Python 3.10+ and add to PATH)"; exit 1 }

    $keys = & python "$ScriptDir\generate-keys.py" $envMap["JWT_SECRET"]
    $anonLine    = ($keys | Select-String '^ANON_KEY=').Line
    $serviceLine = ($keys | Select-String '^SERVICE_ROLE_KEY=').Line

    if (-not $anonLine -or -not $serviceLine) {
        LogErr "generate-keys.py failed, output was:"
        Write-Host $keys
        exit 1
    }

    $newAnon    = $anonLine.Substring("ANON_KEY=".Length)
    $newService = $serviceLine.Substring("SERVICE_ROLE_KEY=".Length)

    (Get-Content ".env") `
        -replace '^ANON_KEY=.*',         "ANON_KEY=$newAnon" `
        -replace '^SERVICE_ROLE_KEY=.*', "SERVICE_ROLE_KEY=$newService" |
        Set-Content ".env"

    $envMap["ANON_KEY"]         = $newAnon
    $envMap["SERVICE_ROLE_KEY"] = $newService
    [System.Environment]::SetEnvironmentVariable("ANON_KEY", $newAnon, "Process")
    [System.Environment]::SetEnvironmentVariable("SERVICE_ROLE_KEY", $newService, "Process")

    LogOk "JWT keys generated and written to .env"
}

# --- 5. Create data dirs -----------------------------------------
LogStep "3. Create data dirs"
$dataDir = if ($envMap["DATA_DIR"]) { $envMap["DATA_DIR"] } else { ".\data" }
New-Item -ItemType Directory -Force -Path "$dataDir\db"        | Out-Null
New-Item -ItemType Directory -Force -Path "$dataDir\db-backup" | Out-Null
LogOk "DATA_DIR = $dataDir"

# --- 6. docker compose up ----------------------------------------
LogStep "4. docker compose up -d"
docker compose up -d
if ($LASTEXITCODE -ne 0) { LogErr "docker compose up failed"; exit 2 }
LogOk "Containers started"

# --- 7. Wait for postgres healthy --------------------------------
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

# --- 8. Inject role passwords ------------------------------------
LogStep "6. Inject authenticator / supabase_auth_admin passwords"
$pgPassword = $envMap["POSTGRES_PASSWORD"]
$sql = "ALTER ROLE authenticator       WITH PASSWORD '$pgPassword';`n" +
       "ALTER ROLE supabase_auth_admin WITH PASSWORD '$pgPassword';"

$sql | docker compose exec -T -e PGPASSWORD=$pgPassword db psql -U postgres -d postgres | Out-Null
if ($LASTEXITCODE -ne 0) {
    LogWarn "Role ALTER may have failed, continuing anyway"
} else {
    LogOk "Role passwords set"
}

# --- 9. Restart rest / auth to pick up passwords -----------------
LogStep "7. Restart rest / auth"
docker compose restart rest auth
Start-Sleep -Seconds 3
LogOk "Restarted"

# --- 10. Health probes -------------------------------------------
LogStep "8. Health probes"
$kongPort = if ($envMap["KONG_HTTP_PORT"]) { $envMap["KONG_HTTP_PORT"] } else { "8000" }
Start-Sleep -Seconds 2

try {
    Invoke-WebRequest -Uri "http://localhost:$kongPort/rest/v1/" `
        -Headers @{ "apikey" = $envMap["ANON_KEY"] } `
        -UseBasicParsing -TimeoutSec 5 | Out-Null
    LogOk "PostgREST reachable through Kong"
} catch {
    LogWarn "PostgREST probe failed (service may still be starting up)"
}

try {
    Invoke-WebRequest -Uri "http://localhost:$kongPort/auth/v1/health" `
        -UseBasicParsing -TimeoutSec 5 | Out-Null
    LogOk "GoTrue reachable through Kong"
} catch {
    LogWarn "GoTrue probe failed (may still be running migrations)"
}

# --- 11. Summary -------------------------------------------------
LogStep "DONE"

# Figure out LAN IP (for Mac clients)
$localIP = $null
try {
    $localIP = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL|Docker" -and
            $_.IPAddress -match "^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)"
        } | Select-Object -First 1).IPAddress
} catch { $localIP = $null }

$pgPort = if ($envMap["POSTGRES_PORT"]) { $envMap["POSTGRES_PORT"] } else { "5432" }

Write-Host ""
Write-Host "  API Gateway      http://localhost:$kongPort"
Write-Host "  PostgREST        http://localhost:$kongPort/rest/v1/"
Write-Host "  GoTrue Auth      http://localhost:$kongPort/auth/v1/"
Write-Host "  Postgres         localhost:$pgPort  (user: postgres)"
Write-Host ""
Write-Host "  SUPABASE_URL              = http://localhost:$kongPort"
Write-Host "  SUPABASE_ANON_KEY         = $($envMap['ANON_KEY'])"
Write-Host "  SUPABASE_SERVICE_ROLE_KEY = $($envMap['SERVICE_ROLE_KEY'])"
Write-Host ""

if ($localIP) {
    Write-Host "  For Mac clients, replace 'localhost' with:" -ForegroundColor Yellow
    Write-Host "    http://investdojo.local:$kongPort   (mDNS, preferred)"
    Write-Host "    http://${localIP}:${kongPort}   (LAN IP)"
    Write-Host ""
}

Write-Host "  Stop:      docker compose down"
Write-Host "  Logs:      docker compose logs -f [service]"
Write-Host "  Psql:      docker compose exec db psql -U postgres"
Write-Host ""
