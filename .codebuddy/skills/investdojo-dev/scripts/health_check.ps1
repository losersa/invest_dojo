#!/usr/bin/env powershell
<#
.SYNOPSIS
    InvestDojo 基础设施健康检查
.DESCRIPTION
    检查所有 Docker 容器、Python 服务、前端是否正常运行
#>

$ErrorActionPreference = "SilentlyContinue"

Write-Host "`n====== InvestDojo Health Check ======`n" -ForegroundColor Cyan

# ── Docker 容器 ──
Write-Host "[Docker Containers]" -ForegroundColor Yellow
$containers = @(
    @{ Name = "investdojo-db";    Port = 5432; Desc = "PostgreSQL" },
    @{ Name = "investdojo-kong";  Port = 8000; Desc = "Kong API Gateway" },
    @{ Name = "investdojo-rest";  Port = $null; Desc = "PostgREST" },
    @{ Name = "investdojo-auth";  Port = $null; Desc = "GoTrue Auth" },
    @{ Name = "investdojo-redis"; Port = 6379; Desc = "Redis" },
    @{ Name = "investdojo-minio"; Port = 9000; Desc = "MinIO" }
)

foreach ($c in $containers) {
    $status = docker inspect --format '{{.State.Status}}' $c.Name 2>$null
    if ($status -eq "running") {
        Write-Host "  [OK] $($c.Desc) ($($c.Name))" -ForegroundColor Green
    } else {
        Write-Host "  [!!] $($c.Desc) ($($c.Name)) - NOT RUNNING" -ForegroundColor Red
    }
}

# ── Python 微服务 ──
Write-Host "`n[Python Microservices]" -ForegroundColor Yellow
$services = @(
    @{ Port = 8001; Name = "feature-svc" },
    @{ Port = 8002; Name = "train-svc" },
    @{ Port = 8003; Name = "infer-svc" },
    @{ Port = 8004; Name = "backtest-svc" },
    @{ Port = 8005; Name = "monitor-svc" },
    @{ Port = 8006; Name = "data-svc" }
)

foreach ($s in $services) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$($s.Port)/health" -TimeoutSec 3 -UseBasicParsing
        if ($resp.StatusCode -eq 200) {
            Write-Host "  [OK] $($s.Name) :$($s.Port)" -ForegroundColor Green
        } else {
            Write-Host "  [!!] $($s.Name) :$($s.Port) - Status $($resp.StatusCode)" -ForegroundColor Red
        }
    } catch {
        # Try root path if /health not available
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$($s.Port)/" -TimeoutSec 3 -UseBasicParsing
            Write-Host "  [OK] $($s.Name) :$($s.Port) (no /health)" -ForegroundColor Green
        } catch {
            Write-Host "  [!!] $($s.Name) :$($s.Port) - UNREACHABLE" -ForegroundColor Red
        }
    }
}

# ── Frontend ──
Write-Host "`n[Frontend]" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 3 -UseBasicParsing
    Write-Host "  [OK] Next.js :3000" -ForegroundColor Green
} catch {
    Write-Host "  [!!] Next.js :3000 - UNREACHABLE" -ForegroundColor Red
}

# ── Supabase API ──
Write-Host "`n[Supabase API]" -ForegroundColor Yellow
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8000/rest/v1/" -TimeoutSec 3 -UseBasicParsing
    Write-Host "  [OK] PostgREST via Kong :8000" -ForegroundColor Green
} catch {
    Write-Host "  [!!] PostgREST via Kong :8000 - UNREACHABLE" -ForegroundColor Red
}

Write-Host "`n====== Done ======`n" -ForegroundColor Cyan
