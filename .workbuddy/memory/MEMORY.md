# MEMORY.md — InvestDojo 项目长期记忆

## 项目概况
- **项目名**: InvestDojo 投资道场
- **定位**: 模拟炒股 × 量化回测 × 财报分析 三合一
- **产品分析文档**: `/Users/xxxixi/project/negative_model/output/invest_dojo_product_analysis.html`
- **技术方案文档**: `/Users/xxxixi/project/finance/InvestDojo_技术架构方案.md`

## 核心技术决策（2026-04-13 确定）
- 多端方案: React 生态 (Next.js + Capacitor + Tauri)，覆盖 Web/iOS/Android/macOS/Windows
- 回测引擎: Python 微服务 (FastAPI + VectorBT/Backtrader)
- 数据库 + 同步: Supabase (PostgreSQL + Realtime)
- LLM: DeepSeek V3 (主) / Kimi (备)
- 数据源: AKShare + Tushare + BaoStock (零成本)

## 用户需求偏好
- 强调一份代码多端部署，降低维护难度
- 关注数据同步和多并发性能
- 需要可执行的任务拆解和排期
- **没有 React 和 TypeScript 经验**，使用 Mac 开发，一个人开发调试
- 需要面向新手的详细文档

## 关键文档位置
- 产品分析: `/Users/xxxixi/project/negative_model/output/invest_dojo_product_analysis.html`
- **文档中心**: `/Users/xxxixi/project/finance/docs/README.md`（分层结构：product / architecture / api / adr）
- 量化模块 PRD: `docs/product/02_量化模块_PRD.md`
- 量化模块架构: `docs/architecture/03_量化模块.md`
- 因子库 API 规范: `docs/api/02_因子库API.md` ⭐ 完整
- API 通用约定: `docs/api/00_约定.md`
- 模拟炒股技术方案（模块1旧版）: `InvestDojo_技术架构方案.md`
- 场景重构原型 v2: `investdojo-v2-prototype.html`
- 开发指南: `investdojo/docs/开发指南.md`
- 代码根目录: `investdojo/`
- 数据采集脚本: `investdojo/scripts/seed_data.py` + `seed_baostock.py`

## 文档维护规则（2026-04-28 确立）
- **四层结构**：product（PRD）/ architecture（架构）/ api（接口）/ adr（决策记录）
- PRD 不写技术方案，架构不写需求，API 独立版本化
- 改需求 → 改 product/，不要动 architecture/
- 改架构/技术栈 → 改 architecture/ + 写 ADR
- 改接口 → 改 api/（必须版本化，破坏性变更 6 个月过渡）
- 重大决策必写 ADR（见 adr/0001 和 adr/0002）

## 平台官方模型扩展点（2026-04-28 决策）
- 官方模型走和用户模型**完全一样的注册路径**，只是 owner='platform'
- 通过 metadata JSONB 存扩展字段（tier/category/methodology/retrain_schedule）
- 统一排行榜 + 人机混排，零特殊代码路径
- 详见 ADR 0002

## Supabase 配置（2026-04-13 接入）
- 项目 ID: `adqznqsciqtepzimcvsg`
- URL: `https://adqznqsciqtepzimcvsg.supabase.co`
- 表结构: scenarios(场景), klines_all(统一 K 线，字段 timeframe), news(新闻)
- 数据量（4-29 下午 T-1.04 完成后）:
  - 42 张表（含 17 年分区表 feature_values_*）
  - **全市场日 K: 5,941,010 行 / 4,376 支（2020-01-02 ~ 2026-04-28）**
  - 场景（4 个）: covid_2020 / new_energy_2020 / **crisis_2022** / **ai_boom_2023**
  - 场景日K: 2,253 行 / 场景 5m: **108,144 行**（均为真实 BaoStock）
  - symbols: 5,524 行 / industries: 102 行
  - news: 49 行
- 场景约束：`UNIQUE (scenario_id, symbol, timeframe, dt)` + NULL 时用 partial index
- 每日自动更新：**launchd 每天 19:00 跑增量**
  - 脚本：`investdojo/scripts/update_daily_klines.py`
  - plist：`~/Library/LaunchAgents/com.investdojo.update-daily-klines.plist`
  - 日志：`/tmp/investdojo-update-daily-klines.log`
- 区分：`scenario_id = NULL` 是全市场数据，`scenario_id != NULL` 是场景切片
- 数据源: AKShare（日K/实时）+ BaoStock（5m+历史日K）
- 环境变量: `apps/web/.env.local` + `apps/server/.env`
- **坑点 1**：Supabase PostgREST 单次查询硬限制 1000 行，分页时**每页重建 query**
- **坑点 2**：Management API 走 curl 最稳（Python urllib 容易 403/500）
- **坑点 3**：PostgREST 批量 POST 比 Management API SQL 快 3-4x（~700~1600 行/s）
- **坑点 4**：BaoStock 凌晨 23:30~00:30 会维护断连，用多轮断点续传兜底
- **坑点 5**：Supabase `timestamptz` 存北京时间要转 UTC（04-28 → 04-27T16:00），查 date 必须 `AT TIME ZONE 'Asia/Shanghai'` 转回来
- **坑点 6**：BaoStock 对 GitHub Actions runner（美国 IP）完全屏蔽，定时任务必须本地跑

## GitHub 仓库
- URL: `https://github.com/losersa/invest_dojo`（注意：**下划线**，不是无符号）
- git remote origin 已修正为带下划线形式
- 公开仓库，GitHub Actions 无限免费额度
- access token 存于 `apps/server/.env` 的 `SUPABASE_ACCESS_TOKEN`（注意：实际是 Supabase token 不是 GitHub token）
- CI workflows 已就位：python-ci / node-ci / docs-check / test-baostock（已验证失败方案）

## 场景设计原则（2026-04-28 重构决策）
- **绝不使用合成/模拟数据，只用真实历史行情**
- 三模式并存：经典关卡 / 盲测随机 / 自选区间
- 数据架构：从"场景分片"改为"全量时间流 + 查询视图"
- 盲度可调：股票名/日期/行业/财报/新闻正文按需隐藏
- 评估维度：相对收益 + 回撤 + 决策质量 + 机会捕获（不只看终值）
- 多阶段揭晓：场景结束后才展示标签和事件时间线
- 原型文档: `/Users/xxxixi/project/finance/investdojo-v2-prototype.html`

## 开发环境
- pnpm 通过 fnm 管理: `eval "$(/opt/homebrew/bin/fnm env --use-on-cd --shell zsh)"`
- 终端启动需要先初始化 fnm 环境
- **容器引擎：OrbStack**（/Applications/OrbStack.app，brew 安装）
- docker 命令在 `/usr/local/bin/docker`
- 本地基础设施：Redis + MinIO，放在 `investdojo/infra/`
  - 启动：`cd investdojo/infra && ./scripts/dev-up.sh`
  - 健康检查：`./scripts/dev-status.sh`
  - Redis: `redis://localhost:6379`
  - MinIO S3: `http://localhost:9000`（user: investdojo / pass: investdojo_dev_only）
  - MinIO Console: `http://localhost:9001`
- **Python 服务集群**：放在 `investdojo/python-services/`
  - uv 管理 Python 3.12 + 虚拟环境
  - overmind 并行启动 5 个服务（Procfile）
  - 服务端口：feature=8001 / train=8002 / infer=8003 / backtest=8004 / monitor=8005
  - 启动：`cd investdojo/python-services && make dev`
  - 冒烟测试：`make smoke`
  - 单测：`make test`
  - 共享代码在 `common/`，启动需 `PYTHONPATH=.`

## CI/CD（GitHub Actions）
- 3 份 workflow 在 `.github/workflows/`：
  - `python-ci.yml`（含 lint-and-test + smoke 两个 job）
  - `node-ci.yml`（typecheck + lint + build）
  - `docs-check.yml`（lychee 死链检查）
- 都走 paths 过滤，只在相关路径变动时触发
- 测试标记：`@pytest.mark.integration` 区分需要外部服务的测试，CI 默认不跑
- 本地 CI 检查：`cd python-services && make ci`
- pre-commit 钩子：`.pre-commit-config.yaml`（可选，用户按 CONTRIBUTING.md 装）
- 防未来函数占位：`common/as_of_enforcer.py` + 9 个契约测试（Epic 6 会完整实现）
