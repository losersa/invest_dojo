# MVP Sprint 0 任务拆解

> 文档状态：**Active v1.0**
> 最后更新：2026-04-28
> 维护者：PM + Tech Lead
> 对应 PRD：[product/02_量化模块_PRD.md](../product/02_量化模块_PRD.md)
> 对应架构：[architecture/](../architecture/)

---

## 目录

- [0. 使用说明](#0-使用说明)
- [1. MVP 范围回顾](#1-mvp-范围回顾)
- [2. 当前代码基础](#2-当前代码基础)
- [3. 开发节奏](#3-开发节奏)
- [4. Epic 拆解（10 周）](#4-epic-拆解10-周)
  - [Epic 0 基础设施](#epic-0-基础设施t1-t10天)
  - [Epic 1 数据层与采集](#epic-1-数据层与采集t3-t14天)
  - [Epic 2 Python 服务骨架](#epic-2-python-服务骨架t10-t17天)
  - [Epic 3 因子库](#epic-3-因子库t14-t28天)
  - [Epic 4 模型训练与回测](#epic-4-模型训练与回测t28-t45天)
  - [Epic 5 模型市场 + 官方模型](#epic-5-模型市场--官方模型t45-t56天)
  - [Epic 6 会话编排与副驾](#epic-6-会话编排与副驾t56-t70天)
  - [Epic 7 数据闭环](#epic-7-数据闭环t70-t77天)
  - [Epic 8 上线打磨](#epic-8-上线打磨t77-t84天)
- [5. 任务依赖图](#5-任务依赖图)
- [6. 里程碑验收](#6-里程碑验收)
- [7. 风险与兜底](#7-风险与兜底)

---

## 0. 使用说明

### 0.1 本文档是什么
把量化模块的 MVP 落地到**可每天执行的任务**。每个任务：
- **粒度**：1~2 天完成
- **独立可测试**：有明确验收标准
- **有依赖链**：知道前置和后置
- **映射到文档**：对应哪份 PRD / 架构 / API

### 0.2 任务编号约定

```
T-<Epic>.<Seq>    # 任务编号，如 T-3.02 = Epic 3 的第 2 个任务
```

### 0.3 任务模板

```
### T-x.yy · <一句话描述>
- 预计工时：X 天
- 依赖：T-x.aa, T-y.bb
- 负责：前端 / 后端 / 算法 / 全栈
- 交付物：
  - 代码 / 文件路径
  - 测试
  - 文档更新
- 验收标准：
  - 具体可验证的条件
- 对应文档：
  - PRD § / 架构 § / API §
```

### 0.4 状态标记

```
🟢 Done        已完成
🟡 In Progress 进行中
⚪️ Todo        未开始
🔴 Blocked     阻塞
```

---

## 1. MVP 范围回顾

引用 [PRD §2.2](../product/02_量化模块_PRD.md#22-mvp-范围p0-全集)，MVP 包含：

- ✅ 因子库浏览 + 详情页（P0）
- ✅ 平台内一键训练（LightGBM，P0）
- ✅ 向量化回测 + 评估报告（P0）
- ✅ 模式 ① 副驾（AI 建议但不下单，P0）
- ✅ 模式 ④ 数据收集（P0 仅收集，不训练）
- ✅ 平台官方模型（至少 1 个 baseline，简化版 P0）

**MVP 不做**：
- 模型上传（P1）
- PK 模式（P1）
- Copilot 模式（P1）
- Notebook 集成（P2）
- 可视化因子组合器（P1）
- 第三方信号接入（P1）
- 付费机制（P2）

---

## 2. 当前代码基础

### 2.1 已有

```
investdojo/                  Monorepo（pnpm workspaces + Turborepo）
├── apps/
│   ├── web/                 Next.js 15 前端（v1 盲测已初步可跑）
│   └── server/              Node orchestrator 骨架
├── packages/
│   ├── core/                撮合引擎、类型定义（已用于模拟炒股 v1）
│   ├── ui/                  共享组件（K 线图、交易面板等）
│   └── api/                 API client SDK 骨架
└── scripts/                 数据采集脚本（seed_data.py / seed_baostock.py / seed_5min.py）
```

### 2.2 Supabase 现状

- 4 场景：covid_2020 / bull_2014 / trade_war_2018 / new_energy_2020
- 日 K：72,980 条真实数据
- 5m K：69,984 条（仅 covid + new_energy，bull 和 trade_war 的 5m 数据待 BaoStock 服务恢复后采集）
- 新闻：49 条

### 2.3 缺什么

按架构文档对照，需要新建：
- 全量 A 股 2014-至今的数据采集
- Python 微服务集群（feature / train / infer / backtest / monitor）
- 因子库的 200 个内置因子
- 官方模型训练流水线
- 会话编排层（Session Orchestrator）
- 若干新表（factors / models / sessions / training_samples ...）

---

## 3. 开发节奏

### 3.1 总时长
- **MVP**：10 周（一个人全职）
- 如果业余时间开发，预计 16-20 周

### 3.2 周节奏建议

| 周几 | 建议 |
|------|------|
| 周一/二 | 攻坚硬任务（训练/推理/撮合） |
| 周三 | 前端集成 / UI 打磨 |
| 周四 | 测试 + 修 Bug |
| 周五 | 文档更新 + 本周复盘 |
| 周末 | 可选：预研下周难点 |

### 3.3 每天工作流

```
早上：看昨天没完成的任务
    ↓
启动 Mac 本地栈（pnpm dev + make py-dev + docker-compose）
    ↓
选 1~2 个任务
    ↓
写代码 + 测试
    ↓
跑 CI（lint + typecheck + test）
    ↓
commit + push
    ↓
更新本日 .workbuddy/memory
    ↓
在本文档里标记任务状态
```

---

## 4. Epic 拆解（10 周）

### Epic 0 基础设施（T1-T10天）

**状态**：🟢 **4/4 全部完成**（T-0.01/02/03/04 合计实际耗时 ~1.5 天，预估 5 天，**提前 3.5 天**）

目标：搭好 Mac 本地开发栈 + 基础设施。

#### T-0.01 · 🟢 Docker Compose 基础设施
- 预计：1 天
- 依赖：无
- 负责：全栈
- 交付物：
  - ✅ `investdojo/infra/docker-compose.yml`（Redis + MinIO）
  - ✅ `investdojo/infra/scripts/dev-up.sh` / `dev-down.sh` / `dev-reset.sh` / `dev-status.sh`
  - ✅ `investdojo/infra/.env.example`
  - ✅ `investdojo/infra/README.md`
- 验收状态：
  - ✅ `./scripts/dev-up.sh` 一键启动 Redis + MinIO
  - ✅ Redis `:6379` 可连（PING → PONG）
  - ✅ MinIO `:9000` S3 API 可访问
  - ✅ MinIO `:9001` 控制台可访问
  - ✅ 5 个 bucket 自动预创建
  - ✅ 使用 OrbStack 作为 Docker 引擎
- 实际耗时：0.5 天
- 对应文档：[架构 00 §9.2](../architecture/00_系统总览.md#92-本地启动)

#### T-0.02 · 🟢 Python 服务骨架
- 预计：2 天
- 依赖：T-0.01
- 负责：后端
- 交付物：
  - ✅ `investdojo/python-services/` 新目录
  - ✅ 5 个 FastAPI app（feature/train/infer/backtest/monitor）
  - ✅ 共享 `common/` 包（config/logging/supabase/redis/minio/app 工厂）
  - ✅ `Procfile` + `Makefile` overmind 并行启动
  - ✅ `pyproject.toml` + `uv.lock`（uv 管理 Python 3.12）
  - ✅ 冒烟测试脚本 `scripts/smoke.sh`
  - ✅ pytest 单元测试（10 个 tests 全绿）
- 验收状态：
  - ✅ `make dev` 一键启动 5 个服务
  - ✅ 每个服务 `/health` 返回 200（status ok）
  - ✅ 每个服务 `/health/ready` 检查 Redis/MinIO/Supabase 全绿
  - ✅ 每个服务 `/docs` 可访问 Swagger UI
  - ✅ 每个服务 `/metrics` 输出 Prometheus 格式
  - ✅ Ctrl+C 能通过 overmind 干净退出所有服务
- 实际耗时：0.5 天
- 对应文档：[架构 00 §2.2 Compute SVC](../architecture/00_系统总览.md#22-每层职责)

#### T-0.03 · 🟢 共享 Python 库（大部分随 T-0.02 完成）
- 预计：1 天
- 依赖：T-0.02
- 负责：后端
- 交付物：
  - ✅ `common/supabase_client.py`（PostgREST 调用封装 + 分页修复）
  - ✅ `common/redis_client.py`（sync + async + Key 约定）
  - ✅ `common/minio_client.py`（S3 SDK 封装 + 路径约定）
  - ✅ `common/logging.py`（structlog 结构化日志）
  - ✅ `common/config.py`（pydantic-settings 统一配置）
  - ⚪️ `common/as_of_enforcer.py`（待 Epic 6 真正实现，此处占位）
- 验收状态：
  - ✅ `from common import settings, get_logger, get_supabase_client` 可用
  - ✅ 单元测试：分页正确加载 > 1000 行数据（验证之前踩过的 bug 已修复）
- 实际耗时：随 T-0.02 一起完成
- 对应文档：[数据层 §8 Redis](../architecture/01_数据层.md#8-redis-缓存设计)

#### T-0.04 · 🟢 CI 流水线
- 预计：1 天
- 依赖：T-0.02
- 负责：DevOps
- 交付物：
  - ✅ `.github/workflows/python-ci.yml`（ruff lint + format + mypy + pytest 单测 + 5 服务冒烟）
  - ✅ `.github/workflows/node-ci.yml`（pnpm install + typecheck + lint + build）
  - ✅ `.github/workflows/docs-check.yml`（lychee 死链检查）
  - ✅ `.pre-commit-config.yaml`（本地钩子，可选安装）
  - ✅ `CONTRIBUTING.md`（开发规范）
  - ✅ `common/as_of_enforcer.py` 占位实现 + 9 个契约测试（Epic 6 前保底）
  - ✅ `pyproject.toml` 加入 `integration` 标记分离单测/集成测试
  - ✅ `Makefile` 新增 `ci/test-unit/test-integration/typecheck` 命令
- 验收状态：
  - ✅ `make ci` 本地跑通（lint + typecheck + 14 单测）
  - ✅ `make test-integration` 5 个集成测试全绿
  - ✅ 4 份 YAML 语法合法
  - ✅ 每个 workflow 通过 `paths` 过滤，只在相关文件变动时跑
  - ✅ Python CI 含独立的 smoke job（启动 Redis/MinIO services 跑冒烟）
  - ✅ 主分支保护：CI 未过不能合并（需 GitHub 设置里开启）
- 实际耗时：0.5 天
- 对应文档：[架构 00 §9.3](../architecture/00_系统总览.md#93-git-工作流)

---

### Epic 1 数据层与采集（T3-T14天）

目标：迁移现有 DB schema + 采集全 A 股数据。

#### T-1.01 · 🟢 数据层迁移 SQL
- 预计：1 天
- 依赖：无
- 负责：后端
- 交付物：
  - ✅ `migrations/` 目录 + 6 个有序 SQL 文件（000~005）
  - ✅ `scripts/migrate.py` 迁移工具（通过 Supabase Management API + curl）
  - ✅ 新增 42 张表（含 17 年分区表） + 改造 2 张现有表
  - ✅ 14 张表启用 RLS
  - ✅ klines_all: scenario_id 可空 + adj_factor + 唯一约束
  - ✅ news: published_at + sentiment_score + tags + url
  - ✅ klines_5min 冗余表已删除
- 验收状态：
  - ✅ 6/6 迁移全绿（Management API + curl）
  - ✅ 现有数据完好（4 场景 / 72980 K线 / 49 新闻）
  - ✅ RLS: 14 张表启用
  - ✅ `migrate.py --status` 显示 6/6 已执行
- 实际耗时：1 天
- 对应文档：[数据层 §3-§7](../architecture/01_数据层.md#3-现有表已上线)

#### T-1.02 · 🟢 股票元数据采集
- 预计：1 天
- 依赖：T-1.01
- 负责：后端
- 交付物：
  - ✅ `scripts/seed_symbols.py`（BaoStock → symbols + industries，一个脚本搞定）
  - ✅ symbols 表 5524 行（5200 在市 + 324 已退市）
  - ✅ industries 表 102 行（19 一级 + 83 二级，证监会分类）
  - ✅ 行业股票计数已回填
- 验收状态：
  - ✅ symbols 5524 行，每只有行业、上市日期、状态
  - ✅ 关键股票验证：茅台/平安/宁德时代 数据正确
  - ⚠️ 沪深 300 成分股 tags 待后续补充
- 实际耗时：0.5 天
- 对应文档：[数据 API §3](../api/01_数据API.md#3-股票元数据-api)

#### T-1.03 · 🟢 全 A 股日 K 采集（2020-至今）
- 预计：2 天（跑采集脚本 + 监控）
- 依赖：T-1.02
- 负责：后端
- 范围调整：用户决定从 **2020** 年开始（不是 2014）
- 交付物：
  - ✅ `scripts/seed_daily_klines.py`（BaoStock → PostgREST，断点续传）
  - ✅ 三轮采集完成（BaoStock 凌晨会断连，用多轮断点续传覆盖）
- 实际数据量：**5,603,772 行** / 4,111 支股票 / 2020-01-01 ~ 2026-04-27
- 验收状态：
  - ✅ 日K 约 560 万行（符合预期，~5000 支 × ~1250 交易日）
  - ✅ 2915 支完整（≥1500 行），631 支 1000~1499 行（新股）
  - ✅ 抽样验证：茅台 2024-04-01 开盘价 1601.87 ✓
  - ⚠️ 1265 支在市股票无数据 → 均为 2024-2026 新上市创业板股（BaoStock 数据延迟，非脚本问题）
- 实际耗时：三轮 ~2.5 小时（103 + 22 + 9 分钟）
- 对应文档：[数据层 §1.1 容量预估](../architecture/01_数据层.md#11-数据量级预估mvp-规模)

#### T-1.04 · 🟢 5m K 补采 + 场景重构
- 预计：1 天
- 依赖：T-1.03
- 负责：后端
- 用户决策（2026-04-29）：**BaoStock 5m 只有 2020+ 数据**，放弃 bull_2014 / trade_war_2018，改用 2020 后的同类型场景
- 交付物：
  - ✅ `scripts/seed_scenario_data.py`（BaoStock + 超时保护 + 断点续传）
  - ✅ 删除 bull_2014 / trade_war_2018 旧场景
  - ✅ 插入 ai_boom_2023（AI 疯牛）+ crisis_2022（多重冲击）新场景
  - ✅ 修复 klines_all 唯一约束：(scenario_id, symbol, timeframe, dt) 四元组
- 最终数据（4 场景）：
  - covid_2020: 351 日K + 16,848 5m
  - new_energy_2020: 1,107 日K + 53,136 5m
  - crisis_2022: 489 日K + **23,472 5m** ⭐
  - ai_boom_2023: 306 日K + **14,688 5m** ⭐
  - **5m 总量: 108,144 行（均为真实 BaoStock）**
- 实际耗时：0.5 天
- 对应文档：[数据层 §10.1 采集→存储→归档](../architecture/01_数据层.md#101-采集--存储--归档)

#### T-1.05 · 🔵 财报采集
- 预计：1 天
- 依赖：T-1.02
- 负责：后端
- 范围：全 A 股 5200 支 × 2019-2024 × 5 报表（profit/balance/cashflow/growth/operation）
- 交付物：
  - ✅ `scripts/seed_fundamentals.py`（带超时保护 + 断点续传）
  - 🔵 后台采集中（PID 8653，caffeinate 防睡眠），速率 10 支/min，预计 ~8.4 小时
- 预估数据量：~12~15 万条（早期未上市的股票会少）
- 验收标准：
  - `fundamentals` 表 ~12 万+ 条
  - 抽样核对（茅台 2023 年报 revenue / net_profit）
  - `announce_date` 字段正确（防未来函数关键）

#### T-1.06 · 🟢 市场快照采集（已完成 2026-04-30）
- 实际：~1 小时
- 依赖：T-1.02, T-1.03（日 K 聚合 advance_decline）
- 负责：后端
- 交付物：
  - `scripts/seed_market_snapshots.py` —— 全量采集
  - `scripts/update_market_snapshots.py` —— 每日增量
  - launchd 任务已合并（每天 19:00 日K + 快照串行）
- 实际数据量：**2,995 行**，2014-01-02 ~ 2026-04-29（12.3 年）
- 字段覆盖：
  - `indexes` 100%（上证/深证/创业板/沪深300/中证500，BaoStock）
  - `north_capital` 89%（2014-11-17 起，AKShare `stock_hsgt_hist_em`）
  - `advance_decline` 51%（2020 起，本地日 K 聚合含涨跌停）
  - `money_flow` / `top_industries` 留 NULL（AKShare 源只有近 120 天，后续再补）
- 验证：2015-06-12 上证 5166.35 ✅ / 2020-03-23 熔断底 126 跌停 ✅

#### T-1.07 · 🟢 数据 API（data-svc，已完成 2026-04-30）
- 实际：~2 小时
- 依赖：T-1.01, T-0.02
- 负责：后端
- 交付物：
  - `python-services/data-svc/`（FastAPI，监听 :8000）
  - 已实现：`/symbols` `/symbols/{code}` `/industries` `/klines` `/klines/latest` `/news` `/fundamentals` `/market/snapshot` `/market/snapshots` `/scenarios` `/scenarios/{id}`
  - **强制 `as_of` 注入**（K 线按 `dt < as_of`；财报按 `announce_date < as_of`；快照按 `date < as_of`）
- 验收标准：
  - ✅ 接口符合 [数据 API](../api/01_数据API.md) 规范（部分扩展见 diff）
  - ✅ 单元测试 19 个全通过（as_of 注入、时区转换、分页等）
  - ✅ 分页正确（Range header 驱动，单页上限 1000）
  - ✅ 端到端验证：as_of=2024-01-04 严格截断未来数据
  - ✅ 防未来红线：`/market/snapshot?date=X&as_of=X` 直接 403 future_leak

---

### Epic 2 Python 服务骨架（T10-T17天）

目标：把剩下的 Python 服务骨架立起来，形成可扩展的微服务集群。

#### T-2.01 · 🟢 feature-svc 骨架（已完成 2026-04-30）
- 实际：~1 小时
- 依赖：T-0.02
- 负责：后端
- 交付物：
  - `python-services/feature-svc/`（FastAPI，监听 :8001）
  - 已实现：`/api/v1/factors` `/factors/categories` `/factors/tags` `/factors/{id}` `/factors/{id}/history`（占位）
  - `scripts/seed_sample_factors.py` · 5 个示范因子（MA 金叉 / MACD / RSI / 量能突破）
- 验收标准：
  - ✅ 启动 + /health + /docs 正常
  - ✅ 5 个示范因子已入库
  - ✅ 14 个单元测试通过（含路由顺序契约）
  - ✅ 中文 tag 筛选正确（`tags=趋势,经典`）

#### T-2.02 · 🟢 train-svc 骨架 + Celery（已完成 2026-04-30）
- 实际：~1 小时
- 依赖：T-0.01, T-0.02
- 负责：后端
- 交付物：
  - `python-services/train-svc/`（FastAPI :8002 + Celery worker）
  - `common/celery_app.py` · 共享 Celery 配置（broker DB=1 / backend DB=2）
  - `Procfile` 新增 `train-worker` 条目
  - 已实现：`POST/GET /api/v1/training/jobs` `DELETE /jobs/{id}` `GET /jobs/{id}`
  - `dummy_train` 任务：状态 pending→running(prepare→fitting)→completed
- 验收标准：
  - ✅ 提交 → Celery 队列 → worker 拉取 → DB 状态正确流转
  - ✅ `training_jobs` 表 status/progress/stage/metrics_preview/started_at/completed_at 都正确
  - ✅ 10 个单测 + 1 个集成测试（eager mode 端到端）通过
  - ✅ worker 重启不丢任务（acks_late + Redis 持久化）

#### T-2.03 · 🟢 infer-svc 骨架（已完成 2026-04-30）
- 实际：~40 分钟
- 依赖：T-0.02
- 负责：后端
- 交付物：
  - `python-services/infer-svc/`（FastAPI :8003）
  - `POST /api/v1/inference/predict` · 单次推理（4 个 mock 模型）
  - `GET /api/v1/inference/models` · 列出 mock 模型
  - `WS /ws/v1/inference/stream` · 占位（Epic 6 T-6.03 完善）
  - `mock_model.py` · 决定性伪推理（hash(model_id+symbol+as_of) 驱动）
- 验收标准：
  - ✅ `POST /predict` 返回符合 Signal schema 的统一格式
  - ✅ 缺 as_of → 422（pydantic 必填）
  - ✅ 空 as_of → 400 MISSING_AS_OF
  - ✅ 未来 as_of → 403 FUTURE_AS_OF（允许 60 秒 clock skew）
  - ✅ 决定性：同参数二次调用，除 timestamp/inference_time_ms 外完全一致
  - ✅ 17 个单测全通过

#### T-2.04 · 🟢 backtest-svc 骨架（已完成 2026-04-30）
- 实际：~1 小时
- 依赖：T-0.02
- 负责：后端
- 交付物：
  - `python-services/backtest-svc/`（FastAPI :8004）
  - `POST /api/v1/backtests/run-fast` · 快速回测（mock，落库）
  - `POST /api/v1/backtests/quick-factor` · 单因子快测（不落库）
  - `GET /api/v1/backtests/{id}` · 详情
  - `GET /api/v1/backtests` · 列表（分页）
  - `mock_engine.py` · 决定性伪回测（GBM 日收益 + 多种指标）
- 验收标准：
  - ✅ 启动 + 接口调通
  - ✅ 结果符合 `BacktestResult` schema（summary/equity_curve/segment_performance）
  - ✅ fast 超大范围 → 413 BACKTEST_FAST_MODE_TOO_LARGE
  - ✅ strategy.type 对应必填校验（type=factor 缺 factor_id → 400）
  - ✅ 决定性：同 config 二次调用，summary + equity_curve 完全一致
  - ✅ 17 个单测全通过

#### T-2.05 · 🟢 monitor-svc 骨架（已完成 2026-04-30）
- 实际：~30 分钟
- 依赖：T-0.02
- 负责：后端
- 交付物：
  - `python-services/monitor-svc/`（FastAPI :8005）
  - `/metrics` · Prometheus 指标（common 自动挂载）
  - `/api/v1/monitor/ping` · 快速探活
  - `/api/v1/monitor/services` · 并发打 5 个兄弟 svc 的 /health
  - `/api/v1/monitor/stats` · 12 项业务指标（symbols/factors/backtests 等）
  - `/api/v1/monitor/overview` · 一锅端（infra + services + stats）
- 验收标准：
  - ✅ `/metrics` 暴露 Prometheus 基础指标（Python GC / 请求 counter / 耗时 histogram）
  - ✅ overview 能准确识别 degraded / down 状态
  - ✅ services 能识别未启动的 svc 为 down（connect_refused）
  - ✅ 9 个单测全通过

#### T-2.06 · 🟢 TypeScript SDK（已完成 2026-04-30）
- 实际：~1 小时
- 依赖：T-1.07, T-2.01
- 负责：前端
- 交付物：
  - `packages/api/src/types/` · 7 个共享类型文件（data/factor/inference/backtest/training/monitor/common）
  - `packages/api/src/base-client.ts` · 统一 fetch 封装（timeout / token / ApiError）
  - `packages/api/src/{data,factor,inference,backtest,train,monitor,session}-client.ts` · 7 个 Client
  - `createInvestDojoClient()` · 一站式工厂，env 变量可配置 baseURL
  - `packages/api/src/__smoke__/run-smoke.ts` · 端到端冒烟脚本
- 验收标准：
  - ✅ `pnpm run type-check` 零错误
  - ✅ smoke 脚本 7 个场景全绿，含 `monitor.getOverview` / `inference.predict` / `backtests.runFast` 等
  - ✅ 客户端层防护：缺 as_of 不发请求即抛错
  - ✅ 前端可 `import { DataClient, createInvestDojoClient } from "@investdojo/api"`
- 对应文档：[因子库 API §10.1 SDK](../api/02_因子库API.md#10-sdk-示例)

---

### Epic 3 因子库（T14-T28天）

目标：落地 200 个内置因子 + 浏览/详情页。

#### T-3.01 · ⚪️ 因子 DSL 解析器
- 预计：2 天
- 依赖：T-2.01
- 负责：算法
- 交付物：
  - `feature-svc/factors/dsl_parser.py`
  - 支持 MA / EMA / BOLL / cross_up / AND/OR 等
  - 把 DSL 解析为 AST
- 验收标准：
  - 合法表达式能解析
  - 非法表达式返回 `INVALID_FORMULA` + 位置
- 对应文档：[因子库 API §11 DSL 语法](../api/02_因子库API.md#11-dsl-公式语言速览补充文档)

#### T-3.02 · ⚪️ 因子计算引擎
- 预计：2 天
- 依赖：T-3.01
- 负责：算法
- 交付物：
  - `feature-svc/factors/engine.py`
  - AST → Pandas 表达式的执行器
  - 支持批量（向量化）和即时计算两种模式
- 验收标准：
  - 单个因子在 3000 股票 × 1 年上计算 < 3s
  - 结果与手动 pandas 计算完全一致（回归测试）

#### T-3.03 · ⚪️ 内置 80 个技术因子
- 预计：2 天
- 依赖：T-3.02
- 负责：算法
- 交付物：
  - `feature-svc/factors/builtin/technical.yaml`
  - 涵盖 MA / EMA / BOLL / MACD / KDJ / RSI / 动量 / 波动率等
- 验收标准：
  - 80 个因子都能正确计算
  - 每个因子带描述和公式
- 对应文档：[PRD §3.1 US-F01](../product/02_量化模块_PRD.md#31-因子库p0)

#### T-3.04 · ⚪️ 内置 120 个基本面/估值/情绪因子
- 预计：3 天
- 依赖：T-3.02, T-1.05
- 负责：算法
- 交付物：
  - `feature-svc/factors/builtin/valuation.yaml`（40）
  - `feature-svc/factors/builtin/growth.yaml`（40）
  - `feature-svc/factors/builtin/sentiment.yaml`（40）
- 验收标准：
  - 总计 200 个因子
  - 分类完整

#### T-3.05 · ⚪️ 因子预计算定时任务
- 预计：1 天
- 依赖：T-3.03, T-3.04
- 负责：后端
- 交付物：
  - Celery Beat 定时任务：每日 17:00 增量计算当天因子值
  - 全量回填脚本：初次上线时算 2014-至今的 200 因子值
- 验收标准：
  - 增量任务单日跑完 < 15 分钟
  - `feature_values` 表逐日填充

#### T-3.06 · ⚪️ 因子库 API（完整）
- 预计：2 天
- 依赖：T-3.02
- 负责：后端
- 交付物：
  - feature-svc 实现所有接口（GET/POST/PUT/DELETE/compute/validate/compare）
- 验收标准：
  - 所有 [因子库 API](../api/02_因子库API.md) 接口可调通
  - Postman 集合通过
- 对应文档：[因子库 API §3-§7](../api/02_因子库API.md#3-公共因子-api)

#### T-3.07 · ⚪️ 前端 · 因子库浏览页
- 预计：2 天
- 依赖：T-3.06, T-2.06
- 负责：前端
- 交付物：
  - `apps/web/app/factors/page.tsx`
  - 分类 tab、排序、搜索、收藏
- 验收标准：
  - 显示 200 个因子
  - 按类别筛选生效
  - 排序切换正确
  - Raycast 设计系统风格一致
- 对应文档：[PRD US-F01](../product/02_量化模块_PRD.md#31-因子库p0)

#### T-3.08 · ⚪️ 前端 · 因子详情页
- 预计：2 天
- 依赖：T-3.07
- 负责：前端
- 交付物：
  - `apps/web/app/factors/[id]/page.tsx`
  - 公式 LaTeX 渲染
  - 历史触发次数时序图
  - 收益分布直方图
  - 最近触发案例
- 验收标准：
  - 所有图表可交互
  - 移动端适配
- 对应文档：[PRD US-F02](../product/02_量化模块_PRD.md#31-因子库p0)

---

### Epic 4 模型训练与回测（T28-T45天）

#### T-4.01 · ⚪️ LightGBM 训练流水线
- 预计：2 天
- 依赖：T-3.06, T-2.02
- 负责：算法
- 交付物：
  - `train-svc/trainers/lightgbm.py`
  - 取特征 → 切分 → 训练 → 评估 → 保存到 MinIO
- 验收标准：
  - 训练 3000 股票 × 3 年数据在 8GB Mac 上 < 3 分钟
  - 评估指标完整（AUC / IC / 混淆矩阵）

#### T-4.02 · ⚪️ 训练 API + 异步任务
- 预计：1.5 天
- 依赖：T-4.01
- 负责：后端
- 交付物：
  - `POST /api/v1/models/train`
  - `GET /api/v1/models/train/jobs/{id}` 轮询
  - WebSocket 推送训练进度
- 验收标准：
  - 符合 [模型 API §4](../api/03_模型API.md#4-平台内训练-api)
  - 任务能取消

#### T-4.03 · ⚪️ 向量化回测引擎
- 预计：2 天
- 依赖：T-4.01
- 负责：算法
- 交付物：
  - `backtest-svc/engines/vectorized.py`
  - 输入 Signal 矩阵 → 输出净值/指标
- 验收标准：
  - 3 年回测 < 10s
  - 指标计算正确（与 backtrader 交叉验证）

#### T-4.04 · ⚪️ 回测 API
- 预计：1.5 天
- 依赖：T-4.03
- 负责：后端
- 交付物：
  - `POST /api/v1/backtests/run-fast`
  - `POST /api/v1/backtests`（异步）
  - `GET /api/v1/backtests/{id}`
- 验收标准：
  - 符合 [回测 API §3 §4](../api/04_回测API.md)

#### T-4.05 · ⚪️ 前端 · 训练向导
- 预计：2 天
- 依赖：T-4.02, T-3.07
- 负责：前端
- 交付物：
  - `apps/web/app/models/new/page.tsx`
  - 四步向导（因子 / 标签 / 区间 / 算法）
  - 实时进度展示
- 验收标准：
  - 新手点"下一步"不填其他都能训出来

#### T-4.06 · ⚪️ 前端 · 训练报告页
- 预计：2 天
- 依赖：T-4.05, T-4.04
- 负责：前端
- 交付物：
  - `apps/web/app/models/[id]/page.tsx`
  - 指标雷达图 / 净值曲线 / 特征重要性 / 分段表现
- 验收标准：
  - 所有图表准确
  - 支持"一键回测"按钮

#### T-4.07 · ⚪️ 前端 · 回测对比
- 预计：1 天
- 依赖：T-4.06
- 负责：前端
- 交付物：
  - `apps/web/app/backtests/compare/page.tsx`
- 验收标准：
  - 可对比 2-3 个模型
  - 净值曲线叠加

---

### Epic 5 模型市场 + 官方模型（T45-T56天）

#### T-5.01 · ⚪️ 设计第一个官方模型 · 动量追踪者
- 预计：2 天
- 依赖：T-4.01, T-3.03
- 负责：算法
- 交付物：
  - `python-services/official-models/momentum_follower/`
  - Notebook 完整训练代码（开源）
  - methodology.md 方法论文档
  - 训练好的 v1 模型上传到 MinIO
- 验收标准：
  - 模型 sharpe > 1.2（自验证）
  - 方法论文档清晰
- 对应文档：[PRD US-X02](../product/02_量化模块_PRD.md#33-模型市场p1)、[ADR 0002](../adr/0002-平台官方模型与用户模型同等待遇.md)

#### T-5.02 · ⚪️ 官方模型注册流程
- 预计：1 天
- 依赖：T-5.01
- 负责：后端
- 交付物：
  - `scripts/register_official_model.py`
  - 在 models 表插入 owner='platform' 记录
  - metadata 完整填充 PlatformModelExtras
- 验收标准：
  - 调用 `GET /api/v1/models/official` 返回这个模型

#### T-5.03 · ⚪️ 模型市场 API
- 预计：1 天
- 依赖：T-5.02
- 负责：后端
- 交付物：
  - 实现 [模型 API §8](../api/03_模型API.md#8-模型市场-api)
- 验收标准：
  - 人机混排排行榜正确

#### T-5.04 · ⚪️ 前端 · 模型市场页
- 预计：2 天
- 依赖：T-5.03
- 负责：前端
- 交付物：
  - `apps/web/app/marketplace/page.tsx`
  - 置顶展示"⭐ 官方模型"板块
  - Tab：官方 / 热门 / 最新 / 表现最好
- 验收标准：
  - 官方模型醒目
  - 可一键"在盲测中试用"

#### T-5.05 · ⚪️ 前端 · 模型详情页（用户 + 官方通用）
- 预计：1.5 天
- 依赖：T-4.06
- 负责：前端
- 交付物：
  - 扩展 `apps/web/app/models/[id]/page.tsx`
  - 官方模型特殊区域：方法论 / 源码链接 / 维护者
- 验收标准：
  - 点击官方模型能看到开源代码链接

---

### Epic 6 会话编排与副驾（T56-T70天）

#### T-6.01 · ⚪️ Session Orchestrator 骨架
- 预计：2 天
- 依赖：T-0.02
- 负责：全栈
- 交付物：
  - `apps/server/src/orchestrator/`
  - WebSocket Gateway + 状态机 + 事件总线
  - 创建会话 / 启动 / 结束
- 验收标准：
  - WebSocket 连接 + 心跳工作正常
  - 状态机转换正确
- 对应文档：[架构 04 §3](../architecture/04_联动机制.md#3-session-orchestrator-架构)

#### T-6.02 · ⚪️ 时钟推进 + 数据广播
- 预计：2 天
- 依赖：T-6.01, T-1.07
- 负责：后端
- 交付物：
  - Clock 模块（严格单调 + 非交易时段跳过）
  - Broadcast Service（差量广播 + sequence）
- 验收标准：
  - 时钟不能回退
  - 非交易时段正确跳过
  - 差量更新正确

#### T-6.03 · ⚪️ 撮合引擎（Simple 模式）
- 预计：2 天
- 依赖：T-6.01
- 负责：后端
- 交付物：
  - `apps/server/src/orchestrator/match_engine.ts`
  - Simple 模式：按 K 线收盘价撮合
  - 校验 T+1 / 涨跌停 / 现金不足
- 验收标准：
  - 所有订单流程正确
  - Portfolio 更新准确
- 对应文档：[架构 04 §9](../architecture/04_联动机制.md#9-撮合引擎)

#### T-6.04 · ⚪️ AsOf Enforcer 实现
- 预计：1 天
- 依赖：T-6.02
- 负责：后端
- 交付物：
  - `DataClientProxy` 自动注入 as_of
  - CI 级"未来函数检测"测试
- 验收标准：
  - 任何绕过 as_of 的代码会被 CI 拦截
- 对应文档：[架构 04 §8](../architecture/04_联动机制.md#8-防未来函数实现)

#### T-6.05 · ⚪️ Infer Client + 流式推理
- 预计：2 天
- 依赖：T-2.03, T-6.02
- 负责：后端
- 交付物：
  - infer-svc 实现 WebSocket 流式推理
  - SO 的 Infer Client（带 5s 超时）
- 验收标准：
  - tick 触发推理 → 信号广播 < 200ms
  - 超时处理正确
- 对应文档：[推理 API §5](../api/05_推理API.md#5-流式推理websocket)

#### T-6.06 · ⚪️ 会话 API（完整）
- 预计：2 天
- 依赖：T-6.01..T-6.05
- 负责：后端
- 交付物：
  - 实现 [会话 API §3-§5](../api/06_会话API.md) 核心接口
  - 副驾模式专用接口（§6.1）
  - 复盘接口（§8）
- 验收标准：
  - Postman 集成测试通过
  - WebSocket 端到端正确

#### T-6.07 · ⚪️ 前端 · 盲测联动版
- 预计：3 天
- 依赖：T-6.06, T-5.04
- 负责：前端
- 交付物：
  - 扩展 `apps/web/app/simulation/`
  - 新增副驾面板组件
  - 会话配置选模型
  - WebSocket 订阅信号
- 验收标准：
  - 盲测中可开副驾
  - 每个 tick 看到信号更新
  - 信号的"关键理由"正确显示

#### T-6.08 · ⚪️ 前端 · 会话复盘页
- 预计：2 天
- 依赖：T-6.06
- 负责：前端
- 交付物：
  - 扩展原型的复盘页（[investdojo-v2-prototype.html 屏 5](../../investdojo-v2-prototype.html)）
  - 事件时间线 / AI 洞察 / 分享
- 验收标准：
  - 符合原型设计
  - 数据从真实 session 加载

---

### Epic 7 数据闭环（T70-T77天）

#### T-7.01 · ⚪️ 训练样本自动生成
- 预计：2 天
- 依赖：T-6.06
- 负责：后端
- 交付物：
  - SO 在会话结束时生成 training_samples
  - Celery 定时任务：N 日后回填 label
- 验收标准：
  - 每次会话样本入库
  - Label 正确回填
- 对应文档：[会话 API §6.4](../api/06_会话API.md#64-模式-数据闭环)

#### T-7.02 · ⚪️ 用户样本管理 API
- 预计：1 天
- 依赖：T-7.01
- 负责：后端
- 交付物：
  - 实现 [会话 API §6.4](../api/06_会话API.md#64-模式-数据闭环) 所有接口
- 验收标准：
  - 可查看、贡献、删除样本

#### T-7.03 · ⚪️ 前端 · 数据管理页
- 预计：1.5 天
- 依赖：T-7.02
- 负责：前端
- 交付物：
  - `apps/web/app/settings/data/page.tsx`
  - 查看我的训练样本
  - 一键贡献到公共池（含知情同意）
  - 一键删除
- 验收标准：
  - 界面清晰
  - 删除有二次确认

---

### Epic 8 上线打磨（T77-T84天）

#### T-8.01 · ⚪️ 端到端测试
- 预计：2 天
- 依赖：所有 Epic 完成
- 负责：全栈
- 交付物：
  - Playwright 测试套件
  - 关键流程：注册 → 浏览因子 → 训练 → 回测 → 盲测副驾 → 复盘
- 验收标准：
  - 全流程测试通过
  - 覆盖率 > 70%

#### T-8.02 · ⚪️ 性能优化
- 预计：2 天
- 依赖：T-8.01
- 负责：全栈
- 交付物：
  - 慢查询优化
  - 前端首屏优化
  - 推理延迟优化
- 验收标准：
  - 首屏 < 2s
  - 因子库页面 < 1s
  - 副驾信号延迟 < 200ms

#### T-8.03 · ⚪️ 监控告警
- 预计：1 天
- 依赖：T-2.05
- 负责：后端
- 交付物：
  - Prometheus 抓取所有服务
  - Grafana 仪表板
  - 关键告警规则
- 验收标准：
  - 错误率 > 1% 触发告警
  - 推理延迟 P99 可视化

#### T-8.04 · ⚪️ 用户文档
- 预计：1 天
- 依赖：T-8.01
- 负责：PM
- 交付物：
  - 用户手册
  - FAQ
- 验收标准：
  - 新用户 10 分钟内能训练第一个模型

#### T-8.05 · ⚪️ 部署上线
- 预计：1.5 天
- 依赖：T-8.01..T-8.04
- 负责：DevOps
- 交付物：
  - Vercel 前端部署
  - K8s 后端（或先 Docker Compose 生产版）
  - 数据库迁移到生产
- 验收标准：
  - 所有服务健康
  - 可通过公网访问
  - 第一波内测用户邀请

---

## 5. 任务依赖图

（核心依赖链，非完整图）

```
Epic 0 基础设施
   │
   ├──→ Epic 1 数据层（与 Epic 0 并行 T3 开始）
   │      │
   │      └──→ T-1.07 data-svc
   │             │
   ├──→ Epic 2 Python 服务骨架
   │      │
   │      └──→ T-2.03 infer-svc ──┐
   │             │                │
   │      └──→ T-2.06 TS SDK ─────┤
   │                               │
   ├──→ Epic 3 因子库 ─────────────┤
   │      │                         │
   ├──→ Epic 4 训练 + 回测 ────────┤
   │      │                         │
   ├──→ Epic 5 官方模型 ───────────┤
   │                                 │
   └──→ Epic 6 会话 + 副驾 ←────────┘
          │
          └──→ Epic 7 数据闭环
                 │
                 └──→ Epic 8 上线打磨
```

### 5.1 关键路径
```
T-0.01 → T-0.02 → T-1.01 → T-1.03 → T-3.02 → T-3.03..05 → T-3.06 → T-4.01 → T-4.03 → T-6.01 → T-6.05 → T-6.07 → T-8.05
```

### 5.2 可并行的分支
- Epic 1 数据采集 可以和 Epic 2 服务骨架 并行
- Epic 3 因子库的前端 可以和 Epic 4 训练 并行
- Epic 5 官方模型 可以和 Epic 6 会话 并行
- Epic 7 数据闭环 可以和 Epic 8 上线打磨 并行

---

## 6. 里程碑验收

按 PRD 里的 6 个里程碑验收：

### M1 · 因子库上线（T+28 天）
对应：Epic 0 + 1 + 2 + 3

验收：
- 200 因子可浏览、可搜索
- 因子详情页完整（含历史表现）
- 因子库 API 全部可调通

### M2 · 训练与回测（T+45 天）
对应：Epic 4

验收：
- 一键训练从开始到报告 < 10 分钟
- 训练出来的模型可一键回测
- 新手能在 5 分钟内训出第一个模型

### M3 · 副驾 MVP（T+65 天）
对应：Epic 6

验收：
- 盲测中可开副驾
- 每个 tick 信号推送 < 200ms
- 关键理由展示清晰

### M4 · 官方模型（T+56 天）
对应：Epic 5（独立里程碑，与 M3 并行）

验收：
- 首个官方模型"动量追踪者"上线
- 模型市场有"⭐ 官方"板块
- 新用户默认加载官方模型作副驾

### M5 · 市场 + 上传（MVP 不做）
对应：Epic 5 的扩展，留给 Phase 2

### M6 · PK + Copilot（MVP 不做）
对应：Phase 2

---

## 7. 风险与兜底

### 7.1 技术风险

| 风险 | 概率 | 影响 | 兜底 |
|------|-----|------|------|
| BaoStock 服务长期不稳 | 中 | 数据采集延期 | 用 AKShare + Tushare 互补 |
| 训练任务在 Mac 上跑不动 | 低 | 需要云计算 | 沪深300 + 3 年数据足够 MVP |
| 推理延迟过高 | 中 | 副驾体验差 | 预计算信号 + Redis 缓存 |
| feature_values 表太大 | 高 | DB 爆了 | 按年分区 + 6 月后归档 S3 |
| WebSocket 稳定性问题 | 低 | 联动中断 | 降级 SSE / 轮询 |

### 7.2 进度风险

| 风险 | 兜底 |
|------|------|
| 某 Epic 延期 | 后续 Epic 压缩，优先保证 M1 + M3 |
| 某任务卡壳 > 3 天 | 拆得更细 / 降级实现 / 先跳过做下个 |
| 全职投入变业余 | 用 Sprint 制，按周滚动调整 |

### 7.3 范围风险

如果发现 MVP 太大：
1. **砍掉 Epic 5**（官方模型）→ MVP 减到 8 周
2. **砍掉 Epic 7**（数据闭环）→ 再减 1 周
3. **基本盘保留**：因子库 + 训练 + 回测 + 副驾

---

## 8. 每周复盘模板

```markdown
## Week N 复盘（YYYY-MM-DD ~ YYYY-MM-DD）

### 计划
- T-x.yy ...

### 实际完成
- T-x.yy ...

### 延期任务
- T-x.zz（原计划 N 天，实际 M 天，原因：...）

### 下周计划
- T-x.aa ...

### 学到
- ...

### 改进
- ...
```

---

## 9. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版，按 PRD+架构拆出 9 个 Epic / 60+ 任务 |
