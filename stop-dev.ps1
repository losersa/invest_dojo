#!/usr/bin/env powershell
<#
.SYNOPSIS
    停止 InvestDojo 开发环境（前端 + Python 微服务）
.DESCRIPTION
    杀掉占用 3000 / 8001-8006 端口的进程。
    默认不停 Docker 容器（数据库保持运行）；加 -StopDocker 才停。
.EXAMPLE
    .\stop-dev.ps1               # 停前端 + Python 服务
    .\stop-dev.ps1 -StopDocker   # 同时停 Docker 容器
#>
param(
    [switch]$StopDocker
)

Write-Host "`n====== 停止 InvestDojo 开发环境 ======" -ForegroundColor Cyan

# ── 停掉端口上的进程 ──
$ports = @(3000, 8001, 8002, 8003, 8004, 8005, 8006)
foreach ($port in $ports) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
        foreach ($c in $conns) {
            try {
                Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop
                Write-Host "  停止 :$port (PID: $($c.OwningProcess))" -ForegroundColor Green
            } catch {
                Write-Host "  [WARN] :$port PID $($c.OwningProcess) 无法停止" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "  :$port 未运行" -ForegroundColor DarkGray
    }
}

# ── 可选：停 Docker ──
if ($StopDocker) {
    Write-Host "`n停止 Docker 容器..." -ForegroundColor Yellow
    $INVESTDOJO = Join-Path $PSScriptRoot "investdojo"
    Push-Location (Join-Path $INVESTDOJO "infra")
    docker compose down 2>&1 | Out-Null
    Pop-Location
    Push-Location (Join-Path $INVESTDOJO "infra\supabase-lite")
    docker compose down 2>&1 | Out-Null
    Pop-Location
    Write-Host "  Docker 容器已停止" -ForegroundColor Green
} else {
    Write-Host "`n  Docker 容器保持运行（加 -StopDocker 可一并停止）" -ForegroundColor DarkGray
}

Write-Host "`n====== 已停止 ======`n" -ForegroundColor Cyan
