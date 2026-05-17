# InvestDojo 脚本索引

所有脚本位于 `investdojo/scripts/` 目录。运行前需确保 Python 虚拟环境已激活。

## 数据种子脚本

### 股票代码

| 脚本 | 说明 | 数据源 |
|------|------|--------|
| `seed_symbols.py` | 同步股票代码到 Supabase Cloud | BaoStock |
| `seed_symbols_local.py` | 同步股票代码到本地 Supabase Lite | BaoStock |

### K 线数据

| 脚本 | 说明 | 数据源 |
|------|------|--------|
| `seed_5min.py` | 种子 5 分钟 K 线数据 | BaoStock |
| `seed_5min_missing.py` | 补充缺失的 5 分钟 K 线 | BaoStock |
| `seed_daily_klines.py` | 种子日 K 线数据 | BaoStock |
| `seed_baostock.py` | BaoStock 通用数据采集 | BaoStock |

### 因子

| 脚本 | 说明 |
|------|------|
| `seed_factors_extended.py` | 种子 65 个扩展因子定义 |
| `seed_sample_factors.py` | 种子示例因子 |
| `register_builtin_factors.py` | 注册内置因子到数据库 |
| `backfill_factors.py` | 回填因子计算值到 feature_values 表 |

### 市场快照

| 脚本 | 说明 |
|------|------|
| `seed_market_snapshots.py` | 种子市场日快照（Cloud） |
| `seed_market_snapshots_local.py` | 种子市场日快照（本地） |

### 基本面

| 脚本 | 说明 |
|------|------|
| `seed_fundamentals.py` | 种子基本面数据 |
| `seed_scenario_data.py` | 种子历史场景数据 |

### 日常更新

| 脚本 | 说明 |
|------|------|
| `update_daily_klines.py` | 每日增量更新 K 线 |
| `update_market_snapshots.py` | 每日更新市场快照 |

## 工具脚本

| 脚本 | 说明 |
|------|------|
| `migrate.py` | 数据库迁移 |
| `migrate_supabase_to_local.sh` | Supabase Cloud → 本地迁移 |
| `seed_data.py` | 通用数据种子入口 |
| `seed_retry.py` | 失败重试包装器 |
| `check_api_access.sh` | 检查 API 可达性 |
| `check_backfill_progress.sh` | 检查因子回填进度 |
| `check_fundamentals_progress.sh` | 检查基本面数据进度 |

## 运行方式

```powershell
# Windows PowerShell
cd investdojo/scripts
$env:PYTHONPATH = ".."
python seed_symbols_local.py

# 或者从 python-services 目录
cd investdojo/python-services
$env:PYTHONPATH = "."
python ../scripts/seed_factors_extended.py
```
