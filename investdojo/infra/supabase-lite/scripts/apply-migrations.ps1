# ===============================================================
# InvestDojo - Apply business migrations to Supabase Lite
# ===============================================================
# Runs investdojo/migrations/*.sql in order against the local
# Postgres running in docker-compose.
#
# Usage:
#   cd investdojo\infra\supabase-lite
#   .\scripts\apply-migrations.ps1
#
# What it does:
#   1. Discovers all *.sql files in ..\..\migrations\ (sorted)
#   2. Applies each via psql as postgres superuser
#   3. Logs success/failure and summary
#
# Idempotency:
#   All migrations use CREATE TABLE IF NOT EXISTS / DO $$ blocks,
#   so re-running is safe.
# ===============================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $PSCommandPath
$StackDir  = Split-Path -Parent $ScriptDir
$RepoDir   = Split-Path -Parent (Split-Path -Parent $StackDir)  # back to investdojo/
$MigDir    = Join-Path $RepoDir "migrations"
Set-Location $StackDir

function LogStep($msg) {
    Write-Host ""
    Write-Host "===============================================" -ForegroundColor Blue
    Write-Host "  $msg" -ForegroundColor Blue
    Write-Host "===============================================" -ForegroundColor Blue
}
function LogOk($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function LogWarn($msg) { Write-Host "[!!] $msg" -ForegroundColor Yellow }
function LogErr($msg)  { Write-Host "[XX] $msg" -ForegroundColor Red }

# --- 1. Sanity checks --------------------------------------------
LogStep "1. Pre-flight checks"

if (-not (Test-Path ".env")) {
    LogErr ".env not found in $StackDir. Run .\scripts\up.ps1 first."
    exit 1
}

if (-not (Test-Path $MigDir)) {
    LogErr "Migrations dir not found: $MigDir"
    exit 1
}

# Make sure db container is up
try {
    docker compose exec -T db pg_isready -U postgres -d postgres 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "not ready" }
} catch {
    LogErr "Postgres container is not healthy. Run .\scripts\up.ps1 first."
    exit 2
}
LogOk "Postgres is reachable"

# Load POSTGRES_PASSWORD
$pgPwd = (Select-String -Path .env -Pattern '^POSTGRES_PASSWORD=').Line.Substring(18)

# --- 2. Discover SQL files ---------------------------------------
LogStep "2. Discover migrations"

$sqlFiles = Get-ChildItem -Path $MigDir -Filter "*.sql" | Sort-Object Name
if ($sqlFiles.Count -eq 0) {
    LogErr "No .sql files found in $MigDir"
    exit 3
}

Write-Host "Found $($sqlFiles.Count) migration files:"
foreach ($f in $sqlFiles) {
    Write-Host "  - $($f.Name)"
}

# --- 3. Apply each migration -------------------------------------
LogStep "3. Apply migrations"

$ok = 0
$fail = 0
$results = @()

foreach ($f in $sqlFiles) {
    $name = $f.Name
    Write-Host ""
    Write-Host ">>> $name" -ForegroundColor Cyan
    $start = Get-Date

    # Strategy: docker cp the file into the container, then psql -f inside.
    # This bypasses PowerShell's stdin encoding entirely (which mangles UTF-8
    # Chinese comments into '?' and breaks SQL parsing).
    $containerPath = "/tmp/_migration_$name"
    docker cp $f.FullName "investdojo-db:$containerPath" 2>&1 | Out-Null

    if ($LASTEXITCODE -ne 0) {
        LogErr "docker cp failed for $name"
        $fail++
        break
    }

    $output = docker compose exec -T -e PGPASSWORD=$pgPwd -e PGCLIENTENCODING=UTF8 db `
        psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f $containerPath 2>&1
    $exitCode = $LASTEXITCODE

    # Clean up inside container
    docker compose exec -T db rm -f $containerPath 2>&1 | Out-Null

    $elapsed = [math]::Round(((Get-Date) - $start).TotalSeconds, 1)

    if ($exitCode -eq 0) {
        LogOk "$name  (${elapsed}s)"
        $ok++
        $results += [pscustomobject]@{ File = $name; Status = "OK"; Seconds = $elapsed }
    } else {
        LogErr "$name FAILED  (${elapsed}s)"
        Write-Host $output -ForegroundColor DarkYellow
        $fail++
        $results += [pscustomobject]@{ File = $name; Status = "FAIL"; Seconds = $elapsed }
        # Stop immediately on failure (non-interactive mode)
        break
    }
}

# --- 4. Summary --------------------------------------------------
LogStep "Summary"

$results | Format-Table -AutoSize

if ($fail -eq 0) {
    LogOk "All $ok migrations applied successfully"
} else {
    LogErr "$fail failed, $ok succeeded"
    exit 4
}

# --- 5. Verify table count ---------------------------------------
LogStep "Verify"

$pubTables = docker compose exec -T -e PGPASSWORD=$pgPwd db `
    psql -U postgres -d postgres -Atc `
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>$null

$rlsTables = docker compose exec -T -e PGPASSWORD=$pgPwd db `
    psql -U postgres -d postgres -Atc `
    "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity=true" 2>$null

Write-Host "  public.* tables:      $pubTables  (expected ~42 + 17 partitions)"
Write-Host "  with RLS enabled:     $rlsTables  (expected ~14)"

Write-Host ""
LogOk "Done. Next: transfer data from Supabase Cloud (see README)"
