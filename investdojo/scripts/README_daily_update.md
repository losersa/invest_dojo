# InvestDojo 数据自动更新

每天 19:00 自动拉取 A 股日 K 新数据到 Supabase。

## 调度方式

使用 macOS `launchd`（本地，用户级）。

- **plist 位置**：`~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist`
- **执行脚本**：`investdojo/scripts/update_daily_klines.py`
- **运行时间**：**每天 19:00**（A 股 15:00 收盘后 + 数据源同步延迟）
- **日志**：
  - stdout: `/tmp/investdojo-update-daily-klines.log`
  - stderr: `/tmp/investdojo-update-daily-klines.err.log`

## 为什么不用 GitHub Actions

**验证过但不可用**（2026-04-29 测试）：
- GitHub Actions runner 在美国机房
- BaoStock 服务器（上海）对国际链路屏蔽
- `ping www.baostock.com` 完全不通
- 测试 workflow 保留在 `.github/workflows/test-baostock.yml` 作为存档

## 常用命令

### 查看状态
```bash
launchctl list com.investdojo.update-daily-klines
# 返回格式：PID LastExitStatus Label
# PID="-" 表示未运行（正常，只在触发时运行）
# LastExitStatus=0 表示上次成功
```

### 手动立即触发一次
```bash
launchctl start com.investdojo.update-daily-klines
# 日志在 /tmp/investdojo-update-daily-klines.log
```

### 查看日志
```bash
# 实时查看
tail -f /tmp/investdojo-update-daily-klines.log

# 看最新一行进度
tail -c 500 /tmp/investdojo-update-daily-klines.log | tr '\r' '\n' | tail -1

# 查错误
cat /tmp/investdojo-update-daily-klines.err.log
```

### 手动跑脚本（绕过 launchd）
```bash
cd investdojo/python-services
PYTHONPATH=. .venv/bin/python ../scripts/update_daily_klines.py

# 预览（不实际上传）
PYTHONPATH=. .venv/bin/python ../scripts/update_daily_klines.py --dry-run

# 只跑前 N 支（测试）
PYTHONPATH=. .venv/bin/python ../scripts/update_daily_klines.py --limit 20
```

### 停用/启用
```bash
# 停用（删除调度，但不删文件）
launchctl unload ~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist

# 启用
launchctl load ~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist
```

### 调整调度时间
编辑 `~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist` 的 `StartCalendarInterval`，然后重新加载：
```bash
launchctl unload ~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist
launchctl load ~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist
```

## Mac 休眠/关机的处理

**launchd 默认行为**：
- ✅ 黑屏/锁屏：任务正常触发
- ❌ 睡眠：任务**不会触发**，但下次唤醒会检查错过的定时任务并补跑（默认行为）
- ❌ 关机：完全跳过

**如果希望 Mac 睡着也跑**：
- 方案 1：在"系统设置 → 锁定屏幕" 里禁用"在不活跃时关闭显示器"和"如果不活跃，让硬盘进入睡眠状态"（耗电多）
- 方案 2：`caffeinate` 在 19:00 前手动启动（不推荐）
- 方案 3：接受现状，非交易日（周六日）跑不跑都无所谓，偶尔周一没跑到下次 19:00 会补回来

## 脚本逻辑

1. 查每支在市股票的 `MAX(dt)`（按北京时间取 date）
2. 从 `MAX(dt)+1` 到今天拉新数据
3. 如果已是最新，跳过
4. 非交易日（周末/假日）BaoStock 返回空，脚本标为"无新数据"
5. 新股（之前没有任何数据）会从 2020-01-01 开始拉全部历史

## 首次跑或修复

首次（或长期没跑过）跑，会一次性补全缺失的股票历史数据，耗时会较久（~10 分钟）。
之后每天正常触发，只补新的一天，~2-3 分钟即可完成。

## 踩坑记录

1. **时区问题**：Supabase 存 `timestamptz`，北京时间 04-28 存成 UTC `2026-04-27T16:00`。查 `MAX(dt)::date` 要用 `AT TIME ZONE 'Asia/Shanghai'` 转回北京时间再取 date，否则会差一天。
2. **BaoStock 凌晨断连**：23:30~00:30 BaoStock 会维护，这时触发任务会失败。所以 19:00 是最优时间。
3. **GitHub Actions 不可用**：runner 在美国，访问 BaoStock 被墙。
