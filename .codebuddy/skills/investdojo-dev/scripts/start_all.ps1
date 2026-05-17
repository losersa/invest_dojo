#!/usr/bin/env powershell
<#
.SYNOPSIS
    启动 InvestDojo 全栈开发环境
.DESCRIPTION
    按顺序启动：Docker 基础设施 → Python 微服务 → Next.js 前端
.PARAMETER SkipDocker
    跳过 Docker 容器启动（容器已在运行时使用）
.PARAMETER SkipPython
    跳过 Python 微服务启动
.PARAMETER SkipFrontend
    跳过前端启动
#>
param(
    [switch]$SkipDocker,
    [switch]$SkipPython,
    [switch]$SkipFrontend
)

$ROOT = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
# $ROOT should be e:\project\ownproject\invest_dojo\investdojo
# Adjust if skill is under .codebuddy at project root level
$INVESTDOJO = Join-Path $ROOT "investdojo"
if (-not (Test-Path (Join-Path $INVESTDOJO "package.json"))) {
    $INVESTDOJO = $ROOT
}

Write-Host "`n====== InvestDojo Dev Startup ======" -ForegroundColor Cyan
Write-Host "Root: $INVESTDOJO`n" -ForegroundColor DarkGray

# ── Step 1: Docker 基础设施 ──
if (-not $SkipDocker) {
    Write-Host "[1/3] Starting Docker infrastructure..." -ForegroundColor Yellow

    # Supabase Lite
    $supabaseLite = Join-Path $INVESTDOJO "infra\supabase-lite"
    if (Test-Path (Join-Path $supabaseLite "docker-compose.yml")) {
        Write-Host "  Starting Supabase Lite..." -ForegroundColor DarkGray
        Push-Location $supabaseLite
        docker compose up -d 2>&1 | Out-Null
        Pop-Location
        Write-Host "  Supabase Lite started" -ForegroundColor Green
    }

    # Redis + MinIO
    $infraDir = Join-Path $INVESTDOJO "infra"
    if (Test-Path (Join-Path $infraDir "docker-compose.yml")) {
        Write-Host "  Starting Redis + MinIO..." -ForegroundColor DarkGray
        Push-Location $infraDir
        docker compose up -d 2>&1 | Out-Null
        Pop-Location
        Write-Host "  Redis + MinIO started" -ForegroundColor Green
    }

    # Wait for Postgres
    Write-Host "  Waiting for PostgreSQL..." -ForegroundColor DarkGray
    $retries = 0
    while ($retries -lt 30) {
        $status = docker inspect --format '{{.State.Health.Status}}' investdojo-db 2>$null
        if ($status -eq "healthy") { break }
        Start-Sleep -Seconds 1
        $retries++
    }
    if ($retries -ge 30) {
        Write-Host "  [WARN] PostgreSQL not healthy after 30s" -ForegroundColor Red
    } else {
        Write-Host "  PostgreSQL is healthy" -ForegroundColor Green
    }
} else {
    Write-Host "[1/3] Skipping Docker (--SkipDocker)" -ForegroundColor DarkGray
}

# ── Step 2: Python 微服务 ──
if (-not $SkipPython) {
    Write-Host "`n[2/3] Starting Python microservices..." -ForegroundColor Yellow
    $pySvc = Join-Path $INVESTDOJO "python-services"
    if (Test-Path $pySvc) {
        Push-Location $pySvc
        $env:PYTHONPATH = "."

        $svcList = @(
            @{ Dir = "data-svc";     Port = 8006 },
            @{ Dir = "feature-svc";  Port = 8001 },
            @{ Dir = "train-svc";    Port = 8002 },
            @{ Dir = "infer-svc";    Port = 8003 },
            @{ Dir = "backtest-svc"; Port = 8004 },
            @{ Dir = "monitor-svc";  Port = 8005 }
        )

        foreach ($svc in $svcList) {
            $proc = Start-Process -FilePath "python" -ArgumentList "-m", "uvicorn", "main:app", "--app-dir", $svc.Dir, "--host", "0.0.0.0", "--port", $svc.Port, "--reload" -PassThru -WindowStyle Hidden
            Write-Host "  Started $($svc.Dir) :$($svc.Port) (PID: $($proc.Id))" -ForegroundColor Green
        }

        Pop-Location
    } else {
        Write-Host "  [WARN] python-services directory not found" -ForegroundColor Red
    }
} else {
    Write-Host "`n[2/3] Skipping Python services (--SkipPython)" -ForegroundColor DarkGray
}

# ── Step 3: Frontend ──
if (-not $SkipFrontend) {
    Write-Host "`n[3/3] Starting Next.js frontend..." -ForegroundColor Yellow
    Push-Location $INVESTDOJO
    $proc = Start-Process -FilePath "pnpm" -ArgumentList "dev" -PassThru -WindowStyle Minimized
    Write-Host "  Next.js started (PID: $($proc.Id))" -ForegroundColor Green
    Pop-Location
} else {
    Write-Host "`n[3/3] Skipping frontend (--SkipFrontend)" -ForegroundColor DarkGray
}

Write-Host "`n====== All services started ======" -ForegroundColor Cyan
Write-Host "  Frontend:  http://localhost:3000" -ForegroundColor White
Write-Host "  Kong:      http://localhost:8000" -ForegroundColor White
Write-Host "  Services:  :8001-8006" -ForegroundColor White
Write-Host ""
