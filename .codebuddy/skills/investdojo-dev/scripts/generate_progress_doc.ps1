<#
.SYNOPSIS
  从 progress-data.json 生成可读的 Markdown 进度文档
.DESCRIPTION
  progress-data.json 是项目进度的唯一数据源（被 /admin/progress 页面直接消费）。
  本脚本将其渲染为一份人类可读、可纳入版本控制的 Markdown 文档：
    investdojo/docs/ops/progress-log.md
  每次 progress-data.json 变更后都应运行本脚本保持文档同步。
.EXAMPLE
  powershell -File generate_progress_doc.ps1
#>

param(
    [string]$DataFile = "",
    [string]$OutFile = ""
)

# ── 定位 progress-data.json（向上查找，避免硬编码布局）──
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

if (-not $DataFile) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $DataFile = Find-ProgressData $scriptDir
}
if (-not $DataFile -or -not (Test-Path $DataFile)) {
    Write-Error "找不到 progress-data.json"
    exit 1
}

# ── 定位输出目录（与 DataFile 同根的 investdojo/docs/ops/）──
$wsRoot = $DataFile
while ($wsRoot -and -not (Test-Path (Join-Path $wsRoot "investdojo\docs"))) {
    $wsRoot = Split-Path -Parent $wsRoot
}
if (-not $wsRoot) { $wsRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))) }

if (-not $OutFile) {
    $OutFile = Join-Path $wsRoot "investdojo\docs\ops\progress-log.md"
}
$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

Write-Host "=== 生成进度文档 ===" -ForegroundColor Cyan
Write-Host "数据源: $DataFile"
Write-Host "输出  : $OutFile"

$data = Get-Content $DataFile -Raw -Encoding UTF8 | ConvertFrom-Json

# ── 状态映射 ──
$statusIcon = @{ done = "✅"; active = "🔶"; partial = "🟡"; todo = "⬜" }
$statusText = @{ done = "已完成"; active = "进行中"; partial = "部分完成"; todo = "未开始" }
$layerText = @{ infra = "基础设施"; backend = "后端服务"; frontend = "前端页面"; tooling = "工具链" }

# ── 总体统计 ──
$totalDone = 0; $totalAll = 0
foreach ($e in $data.epics) { $totalDone += $e.done; $totalAll += $e.total }
$pct = if ($totalAll -gt 0) { [math]::Round(100 * $totalDone / $totalAll) } else { 0 }
$epicDone = @($data.epics | Where-Object { $_.status -eq "done" }).Count
$epicActive = @($data.epics | Where-Object { $_.status -eq "active" }).Count
$epicTodo = @($data.epics | Where-Object { $_.status -eq "todo" }).Count
$lastDate = if ($data.log -and $data.log.Count -gt 0) { $data.log[0].date } else { "未知" }

# ── 构建文档 ──
$lines = [System.Collections.Generic.List[string]]::new()

$lines.Add("# InvestDojo 项目进度文档")
$lines.Add("")
$lines.Add('> 本文档由 `generate_progress_doc.ps1` **自动生成**，唯一数据源为')
$lines.Add('> `investdojo/apps/web/src/app/admin/progress/progress-data.json`（同时驱动 `/admin/progress` 页面）。')
$lines.Add("> 最后更新：**$lastDate**")
$lines.Add("")

# ── 需求排单（Backlog）──
$lines.Add("## 需求排单（Backlog）")
$lines.Add("")
if ($data.backlog -and $data.backlog.Count -gt 0) {
    $lines.Add("| ID | 优先级 | 状态 | 标题 | 关联 Epic | 负责 | 创建日期 |")
    $lines.Add("|----|--------|------|------|-----------|------|----------|")
    foreach ($b in $data.backlog) {
        $prio = if ($b.priority) { $b.priority } else { "P2" }
        $st = if ($b.status) { $b.status } else { "todo" }
        $ep = if ($null -ne $b.epic) { $b.epic } else { "-" }
        $owner = if ($b.owner) { $b.owner } else { "-" }
        $lines.Add("| $($b.id) | $prio | $st | $($b.title) | $ep | $owner | $($b.created) |")
    }
} else {
    $lines.Add("_暂无排单需求。新增需求请用 `sync_progress.ps1 -Backlog ...` 登记。_")
}
$lines.Add("")

$lines.Add("## 总览")
$lines.Add("")
$lines.Add("- 总体任务完成度：**$totalDone / $totalAll（$pct%）**")
$lines.Add("- Epic 状态：✅ 已完成 $epicDone 个 · 🔶 进行中 $epicActive 个 · ⬜ 未开始 $epicTodo 个")
$lines.Add("")
$lines.Add("## Epic 进度")
$lines.Add("")
$lines.Add("| Epic | 名称 | 完成 | 总计 | 状态 |")
$lines.Add("|------|------|------|------|------|")
foreach ($e in $data.epics) {
    $icon = $statusIcon[$e.status]
    $lines.Add("| $($e.id) | $($e.name) | $($e.done) | $($e.total) | $icon $($statusText[$e.status]) |")
}
$lines.Add("")

# ── 模块按层分组 ──
$lines.Add("## 模块进度")
$lines.Add("")
$layerOrder = @("infra", "backend", "frontend", "tooling")
foreach ($layer in $layerOrder) {
    $mods = $data.modules | Where-Object { $_.layer -eq $layer }
    if (-not $mods) { continue }
    $lines.Add("### $($layerText[$layer])")
    $lines.Add("")
    foreach ($m in $mods) {
        $icon = $statusIcon[$m.status]
        $lines.Add("- **$($m.name)** $icon $($statusText[$m.status])（$($m.progress)%） — $($m.desc)")
        if ($m.details -and $m.details.Count -gt 0) {
            foreach ($d in $m.details) { $lines.Add("  - $d") }
        }
    }
    $lines.Add("")
}

# ── 开发日志 ──
$lines.Add("## 开发日志")
$lines.Add("")
$logLimit = [Math]::Min(10, $data.log.Count)
for ($i = 0; $i -lt $logLimit; $i++) {
    $entry = $data.log[$i]
    $lines.Add("### $($entry.date)")
    if ($entry.status) { $lines.Add("**状态**：$($entry.status)") ; $lines.Add("") }
    foreach ($h in $entry.highlights) {
        $lines.Add("- **$($h.title)**")
        if ($h.items) {
            foreach ($it in $h.items) { $lines.Add("  - $it") }
        }
    }
    if ($entry.files -and $entry.files.Count -gt 0) {
        $lines.Add("")
        $filesStr = $entry.files -join ", "
        $lines.Add("  涉及文件：$filesStr")
    }
    $lines.Add("")
}

$content = $lines -join [System.Environment]::NewLine
[System.IO.File]::WriteAllText($OutFile, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host "[OK] 文档已生成: $OutFile" -ForegroundColor Green
