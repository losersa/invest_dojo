# InvestDojo 项目架构参考

## Monorepo 结构

```
investdojo/                          ← pnpm + Turborepo monorepo
├── apps/
│   └── web/                         ← Next.js 15 + React 19 前端 (:3000)
├── packages/
│   ├── api/                         ← SDK 客户端（FactorClient, DataClient...）
│   ├── core/                        ← 纯业务逻辑（撮合引擎、场景管理）
│   └── ui/                          ← 共享 React UI 组件
├── python-services/                 ← 6 个 FastAPI 微服务
│   ├── data-svc/        :8006       ← K 线 / 股票数据
│   ├── feature-svc/     :8001       ← 因子 CRUD / 计算
│   ├── train-svc/       :8002       ← 模型训练
│   ├── infer-svc/       :8003       ← 推理
│   ├── backtest-svc/    :8004       ← 回测
│   ├── monitor-svc/     :8005       ← 监控
│   └── common/                      ← 共享模块（supabase client, errors, logging）
├── infra/
│   ├── docker-compose.yml           ← Redis + MinIO
│   └── supabase-lite/               ← PostgreSQL + PostgREST + GoTrue + Kong
├── scripts/                         ← 数据种子 & 迁移脚本
└── docs/                            ← 文档
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 15 + React 19 + Tailwind CSS 4 |
| 状态 | Zustand 5 + TanStack Query |
| 图表 | TradingView Lightweight Charts |
| API SDK | `@investdojo/api`（TypeScript，BaseClient → FactorClient 等） |
| Python 微服务 | FastAPI + uvicorn + uv（依赖管理） |
| 数据库 | PostgreSQL 15 (via Supabase Lite) |
| API 网关 | Kong 3.4 → PostgREST v12 + GoTrue v2 |
| 缓存 | Redis 7 |
| 对象存储 | MinIO |
| ML | LightGBM, XGBoost, scikit-learn |
| 数据源 | BaoStock, AKShare |

## 端口清单

| 端口 | 服务 | 说明 |
|------|------|------|
| 3000 | Next.js Web | 前端开发服务器 |
| 5432 | PostgreSQL | 数据库 |
| 6379 | Redis | 缓存 / Celery broker |
| 8000 | Kong | Supabase API 网关（PostgREST + GoTrue） |
| 8001 | feature-svc | 因子 CRUD / 计算 |
| 8002 | train-svc | 模型训练 |
| 8003 | infer-svc | 推理 |
| 8004 | backtest-svc | 回测 |
| 8005 | monitor-svc | 监控 |
| 8006 | data-svc | K 线 / 股票数据 |
| 9000 | MinIO S3 API | 对象存储 |
| 9001 | MinIO Console | MinIO 管理界面 |

## 凭据

- **PostgreSQL**: user=`postgres`, password=`investdojo_dev_2025`
- **MinIO**: user=`investdojo`, password=`investdojo_dev_only`
- **Supabase JWT Secret**: `investdojo-super-secret-jwt-token-dev-only`
- **ANON_KEY / SERVICE_ROLE_KEY**: 在 `python-services/.env` 和 `apps/web/.env.local` 中

## 网络架构

- Windows 主机 IP: `192.168.1.3`（局域网）
- 前端 `.env.local` 中所有服务 URL 使用 `192.168.1.3` 而非 `localhost`
- Python 服务 `.env` 使用 `localhost`（运行在同一台 Windows 机器上）
- CORS: Kong 配置中已允许 `http://192.168.1.3:3000`

## 数据库核心表

| 表名 | 行数 | 说明 |
|------|------|------|
| klines_all | ~14.17M | 5 分钟 K 线数据 |
| symbols | 5,525 | 股票代码表 |
| industries | 102 | 行业分类 |
| factor_definitions | ~65+ | 因子定义 |
| market_snapshots | 2,996 | 每日市场快照 |
| user_factor_favorites | - | 用户收藏因子 |
| feature_values | - | 因子预计算值 |

## SDK 架构 (`packages/api/`)

```
BaseClient → FactorClient   (feature-svc :8001)
           → DataClient      (data-svc    :8006)
           → TrainClient     (train-svc   :8002)
           → InferenceClient (infer-svc   :8003)
           → BacktestClient  (backtest-svc:8004)
           → MonitorClient   (monitor-svc :8005)
           → SessionClient
```

- `createInvestDojoClient(opts)` 工厂函数创建全局 SDK 实例
- `opts.userId` 回调函数，写接口自动带 `X-User-Id` header
- `apps/web/src/lib/sdk.ts` 中实例化，通过 Supabase Auth session 获取 userId

## 认证流程

1. 前端通过 Supabase GoTrue 注册/登录
2. `sdk.ts` 监听 `onAuthStateChange`，缓存 `userId`
3. SDK 写接口自动带 `X-User-Id` header
4. Python 服务从 `X-User-Id` header 读取用户 ID
5. 权限校验：`factor.owner == x_user_id`
