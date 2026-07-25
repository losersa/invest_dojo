#!/usr/bin/env powershell
<#
.SYNOPSIS
    InvestDojo 自动化测试运行器
.DESCRIPTION
    按层级运行测试：Python 单元测试 → Python 集成测试 → 前端测试 → API 冒烟测试
.PARAMETER Scope
    测试范围：all | python | frontend | api | smoke
.PARAMETER Verbose
    显示详细输出
#>
param(
    [ValidateSet("all", "python", "frontend", "api", "smoke")]
    [string]$Scope = "all",
    [switch]$Verbose
)

$ROOT = $PSScriptRoot
# Navigate up to find investdojo root
$INVESTDOJO = (Get-Item $ROOT).Parent.Parent.Parent.Parent.FullName
$INVESTDOJO_INNER = Join-Path $INVESTDOJO "investdojo"
if (-not (Test-Path (Join-Path $INVESTDOJO_INNER "package.json"))) {
    $INVESTDOJO_INNER = $INVESTDOJO
}

$PY_SVC = Join-Path $INVESTDOJO_INNER "python-services"
$passed = 0
$failed = 0
$skipped = 0
$results = @()

function Add-Result($category, $name, $status, $detail) {
    $script:results += [PSCustomObject]@{
        Category = $category
        Test     = $name
        Status   = $status
        Detail   = $detail
    }
    if ($status -eq "PASS") { $script:passed++ }
    elseif ($status -eq "FAIL") { $script:failed++ }
    else { $script:skipped++ }
}

Write-Host "`n====== InvestDojo Test Runner ======" -ForegroundColor Cyan
Write-Host "Scope: $Scope`n" -ForegroundColor DarkGray

# ── Python 单元测试 ──
if ($Scope -in @("all", "python")) {
    Write-Host "[Python Unit Tests]" -ForegroundColor Yellow
    if (Test-Path $PY_SVC) {
        Push-Location $PY_SVC
        $env:PYTHONPATH = "."
        $output = python -m pytest tests/ -v -m "unit or not integration" --tb=short 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Add-Result "Python" "Unit Tests" "PASS" "All passed"
            Write-Host "  [PASS] Python unit tests" -ForegroundColor Green
        } else {
            Add-Result "Python" "Unit Tests" "FAIL" $output.Substring([Math]::Max(0, $output.Length - 500))
            Write-Host "  [FAIL] Python unit tests" -ForegroundColor Red
        }
        if ($Verbose) { Write-Host $output -ForegroundColor DarkGray }
        Pop-Location
    } else {
        Add-Result "Python" "Unit Tests" "SKIP" "python-services not found"
        Write-Host "  [SKIP] python-services not found" -ForegroundColor DarkYellow
    }
}

# ── 前端测试 ──
if ($Scope -in @("all", "frontend")) {
    Write-Host "`n[Frontend Tests]" -ForegroundColor Yellow
    $webDir = Join-Path $INVESTDOJO_INNER "apps\web"
    if (Test-Path $webDir) {
        Push-Location $INVESTDOJO_INNER
        $output = pnpm --filter @investdojo/web test -- --run 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Add-Result "Frontend" "Vitest" "PASS" "All passed"
            Write-Host "  [PASS] Frontend vitest" -ForegroundColor Green
        } elseif ($output -match "no test files") {
            Add-Result "Frontend" "Vitest" "SKIP" "No test files found"
            Write-Host "  [SKIP] No test files found" -ForegroundColor DarkYellow
        } else {
            Add-Result "Frontend" "Vitest" "FAIL" $output.Substring([Math]::Max(0, $output.Length - 500))
            Write-Host "  [FAIL] Frontend vitest" -ForegroundColor Red
        }
        if ($Verbose) { Write-Host $output -ForegroundColor DarkGray }
        Pop-Location
    } else {
        Add-Result "Frontend" "Vitest" "SKIP" "apps/web not found"
        Write-Host "  [SKIP] apps/web not found" -ForegroundColor DarkYellow
    }
}

# ── API 冒烟测试 ──
if ($Scope -in @("all", "api", "smoke")) {
    Write-Host "`n[API Smoke Tests]" -ForegroundColor Yellow

    $endpoints = @(
        @{ Name = "Kong Gateway";       URL = "http://localhost:8000/rest/v1/" },
        @{ Name = "feature-svc health"; URL = "http://localhost:8001/health" },
        @{ Name = "data-svc health";    URL = "http://localhost:8006/health" },
        @{ Name = "Factor list";        URL = "http://localhost:8001/api/v1/factors?page_size=1" },
        @{ Name = "Categories";         URL = "http://localhost:8001/api/v1/factors/categories" },
        @{ Name = "Symbols";            URL = "http://localhost:8006/api/v1/symbols?limit=1" }
    )

    foreach ($ep in $endpoints) {
        try {
            $resp = Invoke-WebRequest -Uri $ep.URL -TimeoutSec 5 -UseBasicParsing
            if ($resp.StatusCode -eq 200) {
                Add-Result "API" $ep.Name "PASS" "HTTP 200"
                Write-Host "  [PASS] $($ep.Name)" -ForegroundColor Green
            } else {
                Add-Result "API" $ep.Name "FAIL" "HTTP $($resp.StatusCode)"
                Write-Host "  [FAIL] $($ep.Name) - HTTP $($resp.StatusCode)" -ForegroundColor Red
            }
        } catch {
            Add-Result "API" $ep.Name "FAIL" "Unreachable"
            Write-Host "  [FAIL] $($ep.Name) - UNREACHABLE" -ForegroundColor Red
        }
    }
}

# ── 汇总 ──
Write-Host "`n====== Test Summary ======" -ForegroundColor Cyan
Write-Host "  Passed:  $passed" -ForegroundColor Green
Write-Host "  Failed:  $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Green" })
Write-Host "  Skipped: $skipped" -ForegroundColor DarkYellow

if ($failed -gt 0) {
    Write-Host "`n[Failed Tests Detail]" -ForegroundColor Red
    $results | Where-Object { $_.Status -eq "FAIL" } | ForEach-Object {
        Write-Host "  [$($_.Category)] $($_.Test)" -ForegroundColor Red
        Write-Host "    $($_.Detail)" -ForegroundColor DarkGray
    }
}

Write-Host ""
exit $failed
