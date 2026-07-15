$ErrorActionPreference = 'SilentlyContinue'
$log = 'E:\project\ownproject\invest_dojo\_kill.log'
"[kill] start $(Get-Date -Format o)" | Out-File -FilePath $log -Encoding utf8

# 先记录一次父子关系，便于定位"看门狗"来源
"--- snapshot: uvicorn python procs (pid / ppid / path) ---" | Out-File -FilePath $log -Append -Encoding utf8
$snap = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*uvicorn*main:app*' }
foreach ($p in $snap) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)"
    "pid=$($p.ProcessId) ppid=$($p.ParentProcessId) parentName=$($parent.Name) exe=$($p.ExecutablePath)" | Out-File -FilePath $log -Append -Encoding utf8
}

# 树杀 + 循环：taskkill /T 连子进程一起杀，循环直到没有 uvicorn 进程为止
for ($i = 1; $i -le 10; $i++) {
    $procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*uvicorn*main:app*' }
    if (-not $procs) {
        "[kill] round $i : none left, break" | Out-File -FilePath $log -Append -Encoding utf8
        break
    }
    foreach ($p in $procs) {
        "round $i kill /T PID $($p.ProcessId)" | Out-File -FilePath $log -Append -Encoding utf8
        taskkill /F /T /PID $p.ProcessId 2>&1 | Out-File -FilePath $log -Append -Encoding utf8
    }
    Start-Sleep -Milliseconds 800
}

# 最终确认
$left = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -like '*uvicorn*main:app*' }
"[kill] remaining after loop: $($left.Count)" | Out-File -FilePath $log -Append -Encoding utf8
"[kill] done $(Get-Date -Format o)" | Out-File -FilePath $log -Append -Encoding utf8
