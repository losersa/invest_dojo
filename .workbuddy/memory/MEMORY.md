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
- 技术方案: `/Users/xxxixi/project/finance/InvestDojo_技术架构方案.md`
- 开发指南: `/Users/xxxixi/project/finance/investdojo/docs/开发指南.md`
- 代码根目录: `/Users/xxxixi/project/finance/investdojo/`
- 数据采集脚本: `investdojo/scripts/seed_data.py` + `seed_baostock.py`

## Supabase 配置（2026-04-13 接入）
- 项目 ID: `adqznqsciqtepzimcvsg`
- URL: `https://adqznqsciqtepzimcvsg.supabase.co`
- 表结构: scenarios(场景), klines(K线), news(新闻)
- 数据量: 4场景 / 2996条K线 / 49条新闻（真实前复权A股日K数据）
- 数据源: AKShare + BaoStock
- 环境变量: `apps/web/.env.local` + `apps/server/.env`

## 开发环境
- pnpm 通过 fnm 管理: `eval "$(/opt/homebrew/bin/fnm env --use-on-cd --shell zsh)"`
- 终端启动需要先初始化 fnm 环境
