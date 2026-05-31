#!/usr/bin/env powershell
<#
.SYNOPSIS
    InvestDojo 一键启动前后端开发环境
.DESCRIPTION
    按顺序启动：Docker 基础设施 → 6 个 Python 微服务 → Next.js 前端
    并做健康检查。
.PARAMETER SkipDocker
    跳过 Docker 容器启动（已运行时使用）
.PARAMETER SkipPython
    跳过 Python 微服务启动
.PARAMETER SkipFrontend
    跳过前端启动
.EXAMPLE
    .\start-dev.ps1                 # 启动全部
    .\start-dev.ps1 -SkipDocker     # Docker 已在跑，只起 Python + 前端
    .\start-dev.ps1 -SkipFrontend   # 只起后端
#>
param(
    [switch]$SkipDocker,
    [switch]$SkipPython,
    [switch]$SkipFrontend
)

# ── 路径配置 ──
$INVESTDOJO = Join-Path $PSScriptRoot "investdojo"
$PY_SERVICES = Join-Path $INVESTDOJO "python-services"
$VENV_PY = Join-Path $PY_SERVICES ".venv\Scripts\python.exe"
if (-not (Test-Path $VENV_PY)) { $VENV_PY = "python" }  # fallback

# ── 数据库密码（PG_PASSWORD，data-svc SQL 工具需要）──
$PG_PASSWORD = "x5bVrnMv9g3cpKUDPtfGX1mJ"

Write-Host "`n====== InvestDojo 开发环境启动 ======" -ForegroundColor Cyan
Write-Host "项目目录: $INVESTDOJO`n" -ForegroundColor DarkGray

# ── Step 1: Docker 基础设施 ──
if (-not $SkipDocker) {
    Write-Host "[1/3] 启动 Docker 基础设施..." -ForegroundColor Yellow

    $supabaseLite = Join-Path $INVESTDOJO "infra\supabase-lite"
    if (Test-Path (Join-Path $supabaseLite "docker-compose.yml")) {
        Push-Location $supabaseLite
        docker compose up -d 2>&1 | Out-Null
        Pop-Location
        Write-Host "  Supabase Lite 已启动" -ForegroundColor Green
    }

    $infraDir = Join-Path $INVESTDOJO "infra"
    if (Test-Path (Join-Path $infraDir "docker-compose.yml")) {
        Push-Location $infraDir
        docker compose up -d 2>&1 | Out-Null
        Pop-Location
        Write-Host "  Redis + MinIO 已启动" -ForegroundColor Green
    }

    # 等 Postgres healthy
    Write-Host "  等待 PostgreSQL..." -ForegroundColor DarkGray
    $retries = 0
    while ($retries -lt 30) {
        $status = docker inspect --format '{{.State.Health.Status}}' investdojo-db 2>$null
        if ($status -eq "healthy") { break }
        Start-Sleep -Seconds 1
        $retries++
    }
    if ($retries -ge 30) {
        Write-Host "  [WARN] PostgreSQL 30s 内未就绪" -ForegroundColor Red
    } else {
        Write-Host "  PostgreSQL 已就绪" -ForegroundColor Green
    }
} else {
    Write-Host "[1/3] 跳过 Docker (-SkipDocker)" -ForegroundColor DarkGray
}

# ── Step 2: Python 微服务 ──
if (-not $SkipPython) {
    Write-Host "`n[2/3] 启动 Python 微服务..." -ForegroundColor Yellow

    if (Test-Path $PY_SERVICES) {
        $env:PG_PASSWORD = $PG_PASSWORD
        $env:PYTHONPATH = $PY_SERVICES

        $svcList = @(
            @{ Dir = "data-svc";     Port = 8006 },
            @{ Dir = "feature-svc";  Port = 8001 },
            @{ Dir = "train-svc";    Port = 8002 },
            @{ Dir = "infer-svc";    Port = 8003 },
            @{ Dir = "backtest-svc"; Port = 8004 },
            @{ Dir = "monitor-svc";  Port = 8005 }
        )

        foreach ($svc in $svcList) {
            $workdir = Join-Path $PY_SERVICES $svc.Dir
            $proc = Start-Process -WindowStyle Hidden -PassThru `
                -FilePath $VENV_PY `
                -ArgumentList "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", $svc.Port, "--reload" `
                -WorkingDirectory $workdir
            Write-Host "  启动 $($svc.Dir) :$($svc.Port) (PID: $($proc.Id))" -ForegroundColor Green
        }
    } else {
        Write-Host "  [WARN] 找不到 python-services 目录" -ForegroundColor Red
    }
} else {
    Write-Host "`n[2/3] 跳过 Python 服务 (-SkipPython)" -ForegroundColor DarkGray
}

# ── Step 3: 前端 ──
if (-not $SkipFrontend) {
    Write-Host "`n[3/3] 启动 Next.js 前端..." -ForegroundColor Yellow
    # 注意：pnpm 是 .cmd 脚本，不能直接用 Start-Process -FilePath "pnpm"（会报 "%1 不是有效的 Win32 应用程序"）
    # 必须通过 cmd.exe /c 启动；日志写到项目根目录 fe.log
    $feLog = Join-Path $PSScriptRoot "fe.log"
    $proc = Start-Process -WindowStyle Hidden -PassThru `
        -FilePath "cmd.exe" -ArgumentList "/c", "pnpm dev > `"$feLog`" 2>&1" `
        -WorkingDirectory $INVESTDOJO
    Write-Host "  Next.js 启动中 (PID: $($proc.Id))，日志: $feLog" -ForegroundColor Green
} else {
    Write-Host "`n[3/3] 跳过前端 (-SkipFrontend)" -ForegroundColor DarkGray
}

# ── 健康检查 ──
Write-Host "`n等待服务就绪并做健康检查..." -ForegroundColor DarkGray
Start-Sleep -Seconds 10

$checks = @(
    @{ Name = "feature-svc";  Url = "http://localhost:8001/health" },
    @{ Name = "train-svc";    Url = "http://localhost:8002/health" },
    @{ Name = "infer-svc";    Url = "http://localhost:8003/health" },
    @{ Name = "backtest-svc"; Url = "http://localhost:8004/health" },
    @{ Name = "monitor-svc";  Url = "http://localhost:8005/health" },
    @{ Name = "data-svc";     Url = "http://localhost:8006/health" }
)

Write-Host "`n====== 健康检查 ======" -ForegroundColor Cyan
foreach ($c in $checks) {
    try {
        Invoke-WebRequest -Uri $c.Url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop | Out-Null
        Write-Host "  [OK]   $($c.Name)" -ForegroundColor Green
    } catch {
        Write-Host "  [DOWN] $($c.Name)" -ForegroundColor Red
    }
}

Write-Host "`n====== 启动完成 ======" -ForegroundColor Cyan
Write-Host "  前端:      http://localhost:3000  (Next.js 冷启动约需 20s)" -ForegroundColor White
Write-Host "  Kong 网关: http://localhost:8000" -ForegroundColor White
Write-Host "  Python:    :8001-8006" -ForegroundColor White
Write-Host ""
