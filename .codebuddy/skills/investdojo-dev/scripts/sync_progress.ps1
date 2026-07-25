<#
.SYNOPSIS
  同步项目进度数据到 progress-data.json
.DESCRIPTION
  从 progress-data.json 读取当前数据，追加今天的进展条目
  用法: powershell -File sync_progress.ps1 -Title "标题" -Items "项1,项2,项3" -Status "状态描述"
.EXAMPLE
  powershell -File sync_progress.ps1 -Title "因子库优化" -Items "新增批量删除,修复排序bug" -Status "因子库趋于完善"
#>

param(
    [string]$Title = "",
    [string]$Items = "",
    [string]$Status = "",
    [string]$Files = "",
    [string]$DataFile = "",
    [string]$Backlog = "",
    $BacklogEpic = $null,
    [string]$BacklogPriority = "P2",
    [string]$BacklogOwner = ""
)

# 定位 progress-data.json（向上查找，避免硬编码布局）
function Find-ProgressData {
    param([string]$StartDir)
    $dir = $StartDir
    while ($dir) {
        $candidate = Join-Path $dir "investdojo\apps\web\src\app\admin\progress\progress-data.json"
        if (Test-Path $candidate) { return $candidate }
        $dir = Split-Path -Parent $dir
    }
    return $null
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $DataFile) {
    $DataFile = Find-ProgressData $scriptDir
}

if (-not (Test-Path $DataFile)) {
    Write-Error "找不到 progress-data.json: $DataFile"
    exit 1
}

Write-Host "=== InvestDojo 进度同步 ===" -ForegroundColor Cyan
Write-Host "数据文件: $DataFile"

# 读取当前数据
$data = Get-Content $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json

$today = Get-Date -Format "yyyy-MM-dd"

if ($Backlog) {
    # 登记排单（backlog）+ 写入今日进展
    $reqNum = if ($data.backlog) { $data.backlog.Count + 1 } else { 1 }
    $reqId = "REQ-" + $reqNum.ToString("D3")
    $bl = @{
        id = $reqId
        title = $Backlog
        epic = if ($BacklogEpic -ne $null -and $BacklogEpic -ne "") { $BacklogEpic } else { $null }
        priority = if ($BacklogPriority) { $BacklogPriority } else { "P2" }
        status = "todo"
        owner = if ($BacklogOwner) { $BacklogOwner } else { "-" }
        created = $today
        done = ""
        note = ""
    }
    if (-not $data.backlog) { $data.backlog = @() }
    $blList = [System.Collections.ArrayList]@($data.backlog)
    $blList.Add($bl) | Out-Null
    $data.backlog = $blList.ToArray()
    Write-Host "[OK] 已登记排单 $reqId : $Backlog" -ForegroundColor Green
    $newEntry = @{
        date = $today
        highlights = @(@{
            title = "新增需求/任务（登记排单）"
            items = @($Backlog, "ID: $reqId", "优先级: $($bl.priority)", "负责人: $($bl.owner)")
        })
        status = "进展更新"
    }
} elseif ($Title -and $Items) {
    # 自动模式：命令行传参
    $itemList = $Items -split "," | ForEach-Object { $_.Trim() }
    $fileList = if ($Files) { $Files -split "," | ForEach-Object { $_.Trim() } } else { @() }

    $newEntry = @{
        date = $today
        highlights = @(@{
            title = $Title
            items = $itemList
        })
        status = if ($Status) { $Status } else { "进展更新" }
    }
    if ($fileList.Count -gt 0) {
        $newEntry.files = $fileList
    }
} else {
    # 交互模式
    Write-Host ""
    Write-Host "日期: $today" -ForegroundColor Yellow

    $title = Read-Host "标题（如：因子库优化）"
    if (-not $title) { Write-Host "取消。"; exit 0 }

    $itemsInput = Read-Host "进展项（逗号分隔）"
    $itemList = $itemsInput -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ }

    $statusInput = Read-Host "状态总结（可选，回车跳过）"
    $filesInput = Read-Host "涉及文件（逗号分隔，可选）"
    $fileList = if ($filesInput) { $filesInput -split "," | ForEach-Object { $_.Trim() } } else { @() }

    $newEntry = @{
        date = $today
        highlights = @(@{
            title = $title
            items = $itemList
        })
        status = if ($statusInput) { $statusInput } else { "进展更新" }
    }
    if ($fileList.Count -gt 0) {
        $newEntry.files = $fileList
    }
}

# 检查今天是否已有条目
$existingIdx = -1
for ($i = 0; $i -lt $data.log.Count; $i++) {
    if ($data.log[$i].date -eq $today) {
        $existingIdx = $i
        break
    }
}

if ($existingIdx -ge 0) {
    # 今天已有条目，追加 highlight
    Write-Host "今天已有条目，追加新 highlight..." -ForegroundColor Yellow
    $existing = $data.log[$existingIdx]
    $highlights = [System.Collections.ArrayList]@($existing.highlights)
    $highlights.Add($newEntry.highlights[0]) | Out-Null
    $existing.highlights = $highlights.ToArray()
    if ($newEntry.status -ne "进展更新") {
        $existing.status = $newEntry.status
    }
    if ($newEntry.files) {
        $existingFiles = if ($existing.files) { [System.Collections.ArrayList]@($existing.files) } else { [System.Collections.ArrayList]::new() }
        foreach ($f in $newEntry.files) {
            if ($existingFiles -notcontains $f) { $existingFiles.Add($f) | Out-Null }
        }
        $existing.files = $existingFiles.ToArray()
    }
} else {
    # 新日期，插入到最前面
    Write-Host "新增 $today 条目..." -ForegroundColor Green
    $logList = [System.Collections.ArrayList]@($data.log)
    $logList.Insert(0, $newEntry) | Out-Null
    $data.log = $logList.ToArray()
}

# 写回
$json = $data | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($DataFile, $json, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "[OK] 进度已同步到 $DataFile" -ForegroundColor Green
Write-Host "页面将在下次构建/刷新时自动更新。" -ForegroundColor DarkGray

# ── 同步生成可读进度文档 ──
$genScript = Join-Path $scriptDir "generate_progress_doc.ps1"
if (Test-Path $genScript) {
    Write-Host ""
    Write-Host "正在同步进度文档..." -ForegroundColor DarkGray
    & $genScript
} else {
    Write-Host "[WARN] 找不到 generate_progress_doc.ps1，跳过文档生成" -ForegroundColor Yellow
}
