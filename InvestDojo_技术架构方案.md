# InvestDojo 投资道场 — 多端技术架构与开发方案

> **版本**: v1.0 | **日期**: 2026-04-13  
> **定位**: 模拟炒股 × 量化回测 × 财报分析 三合一  
> **目标**: 一份代码 → iOS / Android / macOS / Windows / Web 五端部署

---

## 目录

1. [核心框架选型决策](#1-核心框架选型决策)
2. [整体系统架构](#2-整体系统架构)
3. [三大模块代码架构拆解](#3-三大模块代码架构拆解)
4. [数据同步方案](#4-数据同步方案)
5. [多并发评估与应对](#5-多并发评估与应对)
6. [多端部署策略](#6-多端部署策略)
7. [功能拆解与任务清单](#7-功能拆解与任务清单)
8. [开发路线图](#8-开发路线图)
9. [技术风险与缓解](#9-技术风险与缓解)

---

## 1. 核心框架选型决策

### 1.1 多端框架对比

你的核心诉求是 **一份代码多端（iOS/Android/macOS/Windows/Web）**，以下是主流方案的系统对比：

| 维度 | **Flutter** | **React Native + Expo** | **Tauri + Web** | **Electron + Web** |
|------|------------|----------------------|----------------|-------------------|
| **覆盖端** | iOS/Android/macOS/Windows/Web/Linux | iOS/Android/Web（桌面需第三方） | macOS/Windows/Linux/Web（移动端实验性） | macOS/Windows/Linux（移动端不支持） |
| **一份代码率** | ⭐⭐⭐⭐⭐ 95%+ | ⭐⭐⭐⭐ 85%+ | ⭐⭐⭐ 70%（桌面+Web共享，移动端另写） | ⭐⭐⭐ 60%（仅桌面+Web） |
| **性能** | ⭐⭐⭐⭐⭐ 接近原生（Skia 自绘） | ⭐⭐⭐⭐ 良好（Bridge 开销） | ⭐⭐⭐⭐⭐ 接近原生（Rust + WebView） | ⭐⭐⭐ 内存占用大（Chromium 捆绑） |
| **K线图表** | ⭐⭐⭐⭐ fl_chart / 自定义 Canvas | ⭐⭐⭐⭐⭐ 复用 ECharts/TradingView | ⭐⭐⭐⭐⭐ 复用 ECharts/TradingView | ⭐⭐⭐⭐⭐ 复用 ECharts/TradingView |
| **金融场景生态** | ⭐⭐⭐ 社区尚可，金融组件少 | ⭐⭐⭐⭐⭐ 金融 Web 组件极丰富 | ⭐⭐⭐⭐ 复用 Web 生态 | ⭐⭐⭐⭐ 复用 Web 生态 |
| **安装包体积** | ~15-25MB | ~20-40MB | ~3-8MB | ~80-150MB |
| **学习曲线** | Dart（需要学新语言） | React（前端通用） | Rust+Web（Rust 学习成本高） | Web（最低门槛） |
| **热更新** | ⚠️ 有限 | ✅ OTA 更新（Expo） | ❌ 需重新发版 | ❌ 需重新发版 |
| **维护成本** | ⭐⭐⭐⭐ 单一代码库 | ⭐⭐⭐⭐ 单一代码库 | ⭐⭐⭐ Web+桌面分离 | ⭐⭐⭐ 仅桌面 |

### 1.2 ✅ 推荐方案：React 生态 + 分层架构

**最终推荐：React 技术栈（Next.js + Capacitor + Tauri）三位一体**

```
┌─────────────────────────────────────────────────────┐
│                   共享业务逻辑层                       │
│        TypeScript + Zustand + TanStack Query         │
│         （纯逻辑，不含 UI，100% 跨端复用）              │
├──────────┬──────────────┬────────────────────────────┤
│  Web 端   │  移动端        │  桌面端                    │
│  Next.js  │  Capacitor    │  Tauri v2                  │
│  (SSR/SPA)│  (iOS/Android)│  (macOS/Windows)           │
│           │  原生壳包裹     │  Rust 原生壳               │
│           │  共享 Web UI   │  共享 Web UI               │
└──────────┴──────────────┴────────────────────────────┘
```

**为什么选 React 而不是 Flutter：**

| 决策因素 | React 方案 | Flutter 方案 |
|---------|-----------|-------------|
| **K线图表** | TradingView Lightweight Charts / ECharts → 金融级成熟度最高 | fl_chart 功能有限，需要大量自定义 |
| **LLM 流式输出** | SSE/WebSocket + React 渲染 → 天然支持 | 需要额外适配 |
| **财报 PDF 预览** | pdf.js → 成熟 | flutter_pdfview → 兼容性一般 |
| **团队扩展性** | React 开发者多，招人容易 | Dart 开发者少 |
| **Web SEO** | Next.js SSR 天然支持 | Flutter Web SEO 极差 |
| **代码复用率** | **业务逻辑层 100% + UI 层 90%+** | 95%+ 但生态限制更大 |

### 1.3 完整技术栈选型

| 层级 | 技术选型 | 说明 |
|------|---------|------|
| **前端框架** | Next.js 15 (App Router) | Web 端 SSR + 移动端/桌面端 SPA 模式 |
| **移动端壳** | Capacitor 6 | iOS/Android 原生壳，包裹 Web 应用 |
| **桌面端壳** | Tauri v2 | macOS/Windows 原生壳，体积小性能好 |
| **状态管理** | Zustand + Immer | 轻量、跨端兼容、支持持久化 |
| **数据请求** | TanStack Query v5 | 缓存、离线支持、请求去重 |
| **K线图表** | TradingView Lightweight Charts | 金融级 K 线渲染，60fps |
| **数据图表** | ECharts (Apache) | 回测结果、财报数据可视化 |
| **UI 组件** | shadcn/ui + Tailwind CSS 4 | 可定制、轻量、暗色模式原生 |
| **后端框架** | Hono (TypeScript) | 轻量高性能，部署灵活（Cloudflare/Vercel/自建） |
| **数据库** | Supabase (PostgreSQL) | 实时订阅 + Auth + 存储一体化 |
| **实时同步** | Supabase Realtime | 多端状态同步、WebSocket |
| **缓存** | Redis (Upstash) | LLM 结果缓存、行情数据缓存 |
| **回测引擎** | Python (VectorBT + Backtrader) | 独立微服务，通过 API 调用 |
| **LLM** | DeepSeek V3 (主) / Kimi (备) | 金融分析中文能力强、成本低 |
| **数据源** | AKShare + Tushare + BaoStock | A股全量数据，零成本 |
| **认证** | Supabase Auth | OAuth + 邮箱 + 手机号 |
| **支付** | 微信支付 + 支付宝 | 国内订阅收费 |
| **部署** | Vercel (Web) + 自建 VPS (Python) | Web 边缘部署 + 回测计算 |

---

## 2. 整体系统架构

### 2.1 架构分层图

```
                    ┌────────────────────────────────────────┐
                    │              客户端 (5端)                │
                    │  ┌──────┐ ┌──────┐ ┌──────┐ ┌───────┐  │
                    │  │ Web  │ │ iOS  │ │Android│ │macOS/ │  │
                    │  │(Next)│ │(Cap) │ │(Cap)  │ │Windows│  │
                    │  │      │ │      │ │       │ │(Tauri)│  │
                    │  └──┬───┘ └──┬───┘ └──┬────┘ └──┬────┘  │
                    │     └────────┴────────┴─────────┘       │
                    │           共享代码层 (TypeScript)          │
                    │  ┌─────────────────────────────────────┐ │
                    │  │  @investdojo/core — 纯业务逻辑       │ │
                    │  │  @investdojo/ui   — 共享 UI 组件     │ │
                    │  │  @investdojo/api  — API 客户端       │ │
                    │  └─────────────────────────────────────┘ │
                    └──────────────────┬─────────────────────┘
                                       │ HTTPS / WebSocket
                    ┌──────────────────┴─────────────────────┐
                    │              API 网关层                   │
                    │         Hono (Edge Runtime)              │
                    │  ┌───────────┬──────────┬────────────┐   │
                    │  │ Auth中间件 │ 限流器   │ 请求路由    │   │
                    │  └───────────┴──────────┴────────────┘   │
                    └──────┬──────────┬────────────┬──────────┘
                           │          │            │
              ┌────────────┴┐   ┌─────┴─────┐  ┌──┴──────────┐
              │  数据服务层   │   │ AI 服务层  │  │ 实时同步层   │
              │             │   │           │  │             │
              │ ┌─────────┐ │   │ ┌───────┐ │  │ ┌─────────┐ │
              │ │ 行情服务  │ │   │ │LLM网关│ │  │ │Supabase │ │
              │ │(AKShare) │ │   │ │       │ │  │ │Realtime │ │
              │ ├─────────┤ │   │ ├───────┤ │  │ ├─────────┤ │
              │ │ 财报服务  │ │   │ │回测引擎│ │  │ │ 事件总线 │ │
              │ │(Tushare) │ │   │ │(Python│ │  │ │(Pub/Sub)│ │
              │ ├─────────┤ │   │ │VectorBT│ │  │ └─────────┘ │
              │ │ 新闻服务  │ │   │ ├───────┤ │  └─────────────┘
              │ │(预爬+缓存)│ │   │ │复盘AI  │ │
              │ └─────────┘ │   │ │(分析)  │ │
              └─────────────┘   │ ├───────┤ │
                                │ │幻觉校验│ │
                                │ └───────┘ │
                                └───────────┘
                    ┌──────────────────────────────────────┐
                    │            存储层                      │
                    │  ┌──────────┐ ┌──────┐ ┌───────────┐ │
                    │  │PostgreSQL│ │Redis │ │ 对象存储   │ │
                    │  │(Supabase)│ │(缓存) │ │(PDF/图表) │ │
                    │  └──────────┘ └──────┘ └───────────┘ │
                    └──────────────────────────────────────┘
```

### 2.2 Monorepo 代码组织

```
investdojo/
├── apps/
│   ├── web/                    # Next.js Web 应用
│   │   ├── app/                # App Router 页面
│   │   ├── capacitor.config.ts # Capacitor 移动端配置
│   │   └── src-tauri/          # Tauri 桌面端配置
│   │
│   └── server/                 # Hono API 服务
│       ├── routes/             # API 路由
│       ├── services/           # 业务逻辑
│       └── workers/            # 后台任务
│
├── packages/
│   ├── core/                   # @investdojo/core — 纯业务逻辑
│   │   ├── src/
│   │   │   ├── simulation/     # 模拟炒股逻辑
│   │   │   │   ├── engine.ts       # 撮合引擎
│   │   │   │   ├── scenario.ts     # 场景管理
│   │   │   │   ├── portfolio.ts    # 持仓计算
│   │   │   │   └── types.ts        # 类型定义
│   │   │   ├── backtest/       # 回测相关逻辑
│   │   │   │   ├── strategy.ts     # 策略定义
│   │   │   │   ├── report.ts       # 报告生成
│   │   │   │   └── types.ts
│   │   │   ├── analysis/       # 财报分析逻辑
│   │   │   │   ├── financial.ts    # 财务指标计算
│   │   │   │   ├── comparison.ts   # 同行对比
│   │   │   │   └── types.ts
│   │   │   └── sync/           # 数据同步核心
│   │   │       ├── conflict.ts     # 冲突解决
│   │   │       ├── queue.ts        # 离线操作队列
│   │   │       └── types.ts
│   │   └── package.json
│   │
│   ├── ui/                     # @investdojo/ui — 共享 UI 组件
│   │   ├── src/
│   │   │   ├── charts/         # 图表组件
│   │   │   │   ├── KLineChart.tsx      # K 线图
│   │   │   │   ├── EquityCurve.tsx     # 收益曲线
│   │   │   │   ├── FinancialChart.tsx  # 财务图表
│   │   │   │   └── Heatmap.tsx         # 热力图
│   │   │   ├── trading/        # 交易相关组件
│   │   │   │   ├── OrderPanel.tsx      # 下单面板
│   │   │   │   ├── PositionList.tsx    # 持仓列表
│   │   │   │   └── TradeHistory.tsx    # 交易历史
│   │   │   ├── analysis/       # 分析组件
│   │   │   │   ├── ReportCard.tsx      # 分析报告卡片
│   │   │   │   ├── PeerCompare.tsx     # 同行对比
│   │   │   │   └── AIResponse.tsx      # AI 流式回复
│   │   │   └── layout/         # 布局组件
│   │   │       ├── AppShell.tsx        # 应用外壳（响应式）
│   │   │       ├── Sidebar.tsx         # 侧边栏
│   │   │       └── MobileNav.tsx       # 移动端导航
│   │   └── package.json
│   │
│   ├── api/                    # @investdojo/api — API 客户端
│   │   ├── src/
│   │   │   ├── client.ts       # HTTP/WS 客户端封装
│   │   │   ├── hooks/          # React hooks (useMutation/useQuery)
│   │   │   └── types.ts        # API 类型定义
│   │   └── package.json
│   │
│   └── config/                 # @investdojo/config — 共享配置
│       ├── tailwind.config.ts
│       ├── tsconfig.base.json
│       └── eslint.config.js
│
├── services/
│   └── backtest-engine/        # Python 回测微服务
│       ├── main.py             # FastAPI 入口
│       ├── strategies/         # 策略模板库
│       ├── engine/             # VectorBT/Backtrader 封装
│       └── requirements.txt
│
├── data/
│   ├── scenarios/              # 预制历史场景数据
│   ├── news/                   # 预爬历史新闻
│   └── policies/               # 政策事件时间线
│
├── turbo.json                  # Turborepo 配置
├── pnpm-workspace.yaml         # pnpm workspace
└── package.json
```

**代码复用率估算**：

| 层级 | 代码量占比 | 跨端复用率 | 说明 |
|------|-----------|-----------|------|
| `packages/core` | ~30% | **100%** | 纯 TypeScript 逻辑，零平台依赖 |
| `packages/ui` | ~35% | **95%** | React 组件 + Tailwind，移动端/桌面端极少适配 |
| `packages/api` | ~10% | **100%** | 纯 HTTP/WS 客户端 |
| `apps/web` 页面路由 | ~15% | **90%** | Next.js 页面，Capacitor/Tauri 复用 |
| 平台特定代码 | ~10% | **0%** | Capacitor 插件调用、Tauri 系统 API |
| **加权平均** | — | **~92%** | 只有约 8% 的代码需要平台特化 |

---

## 3. 三大模块代码架构拆解

### 3.1 模块 A：历史情景模拟炒股

```
模块A 架构分层
═══════════════════════════════════════════════════

┌─ 展示层 (UI) ──────────────────────────────────┐
│                                                │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ K线回放   │ │ 新闻时间线│ │ 交易面板       │  │
│  │ 组件      │ │ 组件     │ │ (买/卖/持有)   │  │
│  └──────────┘ └──────────┘ └───────────────┘  │
│  ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ 持仓面板  │ │ AI复盘卡 │ │ 场景选择器     │  │
│  └──────────┘ └──────────┘ └───────────────┘  │
└────────────────────┬───────────────────────────┘
                     │
┌─ 状态管理层 ───────┴───────────────────────────┐
│                                                │
│  SimulationStore (Zustand)                     │
│  ├── currentScenario   // 当前场景              │
│  ├── currentDate       // 模拟日期推进           │
│  ├── portfolio         // 持仓 & 资金            │
│  ├── tradeHistory      // 交易记录               │
│  ├── visibleKlines     // 当前可见K线（截止模拟日）│
│  ├── visibleNews       // 当前可见新闻            │
│  └── aiReview          // AI复盘结果             │
│                                                │
└────────────────────┬───────────────────────────┘
                     │
┌─ 业务逻辑层 (core) ┴───────────────────────────┐
│                                                │
│  SimulationEngine                              │
│  ├── advanceDay()      // 推进一天               │
│  ├── executeOrder()    // 执行交易               │
│  ├── calcSlippage()    // 计算滑点               │
│  ├── checkLimits()     // 涨跌停检查             │
│  └── generateMetrics() // 生成绩效指标           │
│                                                │
│  ScenarioManager                               │
│  ├── loadScenario()    // 加载场景数据           │
│  ├── getKlinesUntil()  // 获取截止日期K线        │
│  ├── getNewsUntil()    // 获取截止日期新闻        │
│  └── getPoliciesUntil()// 获取截止日期政策        │
│                                                │
└────────────────────┬───────────────────────────┘
                     │
┌─ 数据层 ───────────┴───────────────────────────┐
│                                                │
│  场景数据包 (预打包 JSON)                        │
│  ├── klines_2020_covid.json   // 2020 新冠K线   │
│  ├── news_2020_covid.json     // 同期新闻       │
│  ├── policy_2020_covid.json   // 同期政策       │
│  └── meta_2020_covid.json     // 场景元信息      │
│                                                │
│  用户操作记录 → Supabase (持久化 + 多端同步)     │
│                                                │
└────────────────────────────────────────────────┘
```

**关键技术决策**：

| 决策点 | 方案 | 理由 |
|-------|------|------|
| K 线渲染 | TradingView Lightweight Charts | 金融级渲染，支持自定义 tooltip 显示新闻标记 |
| 时间推进 | 前端纯状态推进 + 惰性请求 AI | 推进操作零延迟，AI 点评异步加载 |
| 撮合引擎 | 前端 core 包内实现 | 简化版撮合，无需后端计算，离线可用 |
| 场景数据 | 预打包 JSON + CDN 分发 | 首屏加载快，离线可用，不依赖实时 API |
| AI 复盘 | SSE 流式输出 | 用户感知延迟低，逐字输出增强体验 |

### 3.2 模块 B：AI 量化回测

```
模块B 架构分层
═══════════════════════════════════════════════════

┌─ 展示层 (UI) ──────────────────────────────────┐
│                                                │
│  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 自然语言输入框  │  │ 生成的代码预览         │  │
│  │ (策略描述)     │  │ (语法高亮 + 可编辑)    │  │
│  └────────────────┘  └──────────────────────┘  │
│  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 回测参数面板   │  │ 策略模板库             │  │
│  │ (标的/时间/资金)│  │ (20+ 预制策略)        │  │
│  └────────────────┘  └──────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ 回测结果仪表盘                             │  │
│  │ ├── 收益曲线 (vs 基准)                     │  │
│  │ ├── 指标矩阵 (夏普/最大回撤/胜率)           │  │
│  │ ├── 交易明细表                              │  │
│  │ └── AI 策略分析 (流式输出)                   │  │
│  └──────────────────────────────────────────┘  │
└────────────────────┬───────────────────────────┘
                     │
┌─ 前端逻辑层 ───────┴───────────────────────────┐
│                                                │
│  BacktestStore (Zustand)                       │
│  ├── strategyPrompt    // 用户输入的自然语言     │
│  ├── generatedCode     // LLM 生成的策略代码     │
│  ├── backtestParams    // 回测参数               │
│  ├── backtestResult    // 回测结果               │
│  ├── aiAnalysis        // AI 分析内容            │
│  └── runStatus         // pending/running/done   │
│                                                │
└────────────────────┬───────────────────────────┘
                     │  HTTP + SSE
┌─ 后端 API 层 ──────┴───────────────────────────┐
│                                                │
│  Hono API Routes                               │
│  POST /api/backtest/generate-strategy           │
│  │   → 调 DeepSeek → 生成 Python 策略代码       │
│  │   → 代码安全审查（AST 分析）                  │
│  │   → 返回策略代码 (SSE 流式)                   │
│  │                                              │
│  POST /api/backtest/run                         │
│  │   → 将策略代码 + 参数发送到 Python 微服务     │
│  │   → 轮询或 WebSocket 获取进度                 │
│  │   → 返回回测结果                              │
│  │                                              │
│  POST /api/backtest/analyze                     │
│  │   → 结果数据 + Prompt → DeepSeek             │
│  │   → SSE 流式返回分析内容                      │
│                                                │
└────────────────────┬───────────────────────────┘
                     │  HTTP
┌─ Python 回测微服务 ┴───────────────────────────┐
│                                                │
│  FastAPI                                       │
│  ├── POST /execute                             │
│  │   ├── 接收策略代码 + 数据参数                 │
│  │   ├── 沙箱执行 (RestrictedPython/subprocess) │
│  │   ├── VectorBT 向量化回测                    │
│  │   └── 返回: equity_curve, trades, metrics    │
│  │                                              │
│  ├── 数据加载器                                  │
│  │   ├── AKShare → 历史日K线                     │
│  │   ├── 本地缓存 (SQLite/Parquet)              │
│  │   └── 数据预处理 (复权/除权)                   │
│  │                                              │
│  └── 安全沙箱                                    │
│      ├── 30秒超时                                │
│      ├── 禁止网络/文件/系统调用                   │
│      └── 内存限制 512MB                          │
│                                                │
└────────────────────────────────────────────────┘
```

**关键技术决策**：

| 决策点 | 方案 | 理由 |
|-------|------|------|
| 回测执行 | Python 微服务（独立部署） | VectorBT/Backtrader 是 Python 生态，无 JS 替代品 |
| 代码安全 | RestrictedPython + 沙箱 + 超时 | LLM 生成的代码不可信，必须隔离执行 |
| 策略代码展示 | Monaco Editor (Web) | 支持语法高亮、代码补全，用户可手动调整 |
| 数据缓存 | Parquet 文件本地缓存 | 比 SQLite 快 10x，列式存储适合时序数据 |
| 进度反馈 | WebSocket 实时推送 | 回测可能 10-30 秒，用户需要进度条 |

### 3.3 模块 C：AI 财报分析

```
模块C 架构分层
═══════════════════════════════════════════════════

┌─ 展示层 (UI) ──────────────────────────────────┐
│                                                │
│  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 搜索/输入面板   │  │ 分析报告（结构化）     │  │
│  │ 股票代码/上传PDF│  │ 六维雷达图 + 文字分析  │  │
│  └────────────────┘  └──────────────────────┘  │
│  ┌────────────────┐  ┌──────────────────────┐  │
│  │ 同行 PK 对比   │  │ 历史趋势图表          │  │
│  │ (多维度对比表) │  │ (关键指标 5 年走势)   │  │
│  └────────────────┘  └──────────────────────┘  │
│  ┌──────────────────────────────────────────┐  │
│  │ AI 深度解读（流式输出）                      │  │
│  │ ├── 盈利能力分析                             │  │
│  │ ├── 成长性判断                               │  │
│  │ ├── 风险预警                                 │  │
│  │ └── 投资建议摘要                              │  │
│  └──────────────────────────────────────────┘  │
└────────────────────┬───────────────────────────┘
                     │
┌─ 后端处理流程 ─────┴───────────────────────────┐
│                                                │
│  Step 1: 数据采集                               │
│  ├── AKShare: 三大报表 + 基本面指标              │
│  ├── 行业分类 → 自动匹配同行公司                  │
│  └── 巨潮网: 年报 PDF（可选）                    │
│                                                │
│  Step 2: 指标计算 (Python/TypeScript)           │
│  ├── 盈利能力: ROE, ROA, 毛利率, 净利率           │
│  ├── 成长性: 营收增速, 利润增速, 研发投入比        │
│  ├── 运营效率: 存货周转, 应收账款周转              │
│  ├── 财务风险: 资产负债率, 流动比率                │
│  ├── 估值水平: PE, PB, PS, PEG                  │
│  └── 现金流质量: 经营性现金流/净利润              │
│                                                │
│  Step 3: LLM 分析                               │
│  ├── 结构化 Prompt (注入计算好的指标数据)         │
│  ├── DeepSeek V3 生成分析报告                    │
│  └── Hallucination Guard 校验输出数字            │
│                                                │
│  Step 4: 缓存 + 存储                            │
│  ├── Redis: 缓存分析结果 (TTL = 24h)            │
│  └── PostgreSQL: 用户的分析历史记录               │
│                                                │
└────────────────────────────────────────────────┘
```

---

## 4. 数据同步方案

### 4.1 同步架构设计

InvestDojo 的多端数据同步需要解决以下核心问题：

| 问题 | 场景 | 解决方案 |
|------|------|---------|
| **实时同步** | 手机上下了一笔模拟交易，Mac 立即看到 | Supabase Realtime (WebSocket) |
| **离线操作** | 地铁上无网，仍能做模拟交易 | TanStack Query 离线队列 + 乐观更新 |
| **冲突解决** | 两端同时操作，数据冲突 | Last-Write-Wins + 操作日志回放 |
| **数据一致性** | 持仓余额必须准确 | Server-Authoritative（服务端权威） |

```
多端同步数据流
═══════════════════════════════════════════════════

    iOS 端                  Web 端               Mac 端
    ┌─────┐               ┌─────┐              ┌─────┐
    │     │               │     │              │     │
    │  Z  │──── write ───▶│     │              │     │
    │  u  │               │  S  │              │  Z  │
    │  s  │◀── realtime ──│  u  │── realtime ─▶│  u  │
    │  t  │   subscribe   │  p  │   broadcast  │  s  │
    │  a  │               │  a  │              │  t  │
    │  n  │               │  b  │              │  a  │
    │  d  │               │  a  │              │  n  │
    │     │               │  s  │              │  d  │
    │  +  │               │  e  │              │     │
    │     │               │     │              │  +  │
    │ TQ  │  offline ──┐  │  R  │              │     │
    │     │  queue     │  │  e  │              │ TQ  │
    └─────┘            │  │  a  │              └─────┘
                       │  │  l  │
                       │  │  t  │
                       └─▶│  i  │
                   网络恢复│  m  │
                   时重放  │  e  │
                          └─────┘
```

### 4.2 同步数据分类

不同数据有不同的同步策略：

| 数据类型 | 同步策略 | 一致性要求 | 存储位置 |
|---------|---------|-----------|---------|
| **用户配置** | 双向同步 | 最终一致 | Supabase `user_settings` |
| **模拟交易记录** | Server-Push | 强一致（金额相关） | Supabase `trades` |
| **持仓数据** | Server-Authoritative | 强一致 | Supabase `portfolios`（服务端计算） |
| **回测历史** | 拉取同步 | 最终一致 | Supabase `backtest_results` |
| **财报分析缓存** | 读缓存 | 可延迟 | Redis + 本地 IndexedDB |
| **场景进度** | 双向同步 | 最终一致 | Supabase `scenario_progress` |
| **行情数据** | 只读 CDN | 不可变 | CDN + 本地缓存 |

### 4.3 离线操作队列

```typescript
// packages/core/src/sync/queue.ts

interface OfflineOperation {
  id: string;
  type: 'trade' | 'advance_day' | 'save_setting';
  payload: unknown;
  timestamp: number;
  status: 'pending' | 'synced' | 'conflict';
}

class OfflineQueue {
  private queue: OfflineOperation[] = [];
  
  // 离线时：操作入队 + 乐观更新本地状态
  enqueue(op: OfflineOperation) {
    this.queue.push(op);
    this.persistToLocal(); // IndexedDB / AsyncStorage
  }
  
  // 网络恢复时：按时间顺序重放
  async flush() {
    const sorted = this.queue
      .filter(op => op.status === 'pending')
      .sort((a, b) => a.timestamp - b.timestamp);
    
    for (const op of sorted) {
      try {
        await this.syncToServer(op);
        op.status = 'synced';
      } catch (e) {
        if (isConflict(e)) {
          op.status = 'conflict';
          await this.resolveConflict(op);
        }
      }
    }
  }
  
  // 冲突解决：交易类操作用服务端权威值
  private async resolveConflict(op: OfflineOperation) {
    if (op.type === 'trade') {
      // 服务端重新计算持仓 → 覆盖本地
      const serverState = await api.getPortfolio();
      store.setPortfolio(serverState);
    }
  }
}
```

### 4.4 Supabase Realtime 订阅

```typescript
// packages/api/src/realtime.ts

function setupRealtimeSync(userId: string) {
  const channel = supabase.channel(`user:${userId}`);
  
  // 监听交易记录变更
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'trades', filter: `user_id=eq.${userId}` },
    (payload) => {
      // 其他端新增了交易 → 本地状态更新
      tradeStore.handleRemoteChange(payload);
    }
  );
  
  // 监听持仓变更
  channel.on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'portfolios', filter: `user_id=eq.${userId}` },
    (payload) => {
      portfolioStore.setFromServer(payload.new);
    }
  );
  
  // 监听场景进度同步
  channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'scenario_progress', filter: `user_id=eq.${userId}` },
    (payload) => {
      scenarioStore.syncProgress(payload);
    }
  );
  
  channel.subscribe();
}
```

---

## 5. 多并发评估与应对

### 5.1 并发热点分析

| 服务 | 并发类型 | 预估峰值 QPS | 瓶颈分析 |
|------|---------|-------------|---------|
| **K线数据请求** | 读密集 | 500-2000 | CDN 缓存可解决 |
| **模拟交易执行** | 写密集 | 100-500 | 前端计算 + 服务端批量写入 |
| **LLM 复盘/分析** | IO 密集（API 调用） | 50-200 | LLM API 并发限制 |
| **回测执行** | CPU 密集 | 10-50 | Python 进程隔离，排队执行 |
| **Realtime 连接** | 长连接 | 1000-5000 | Supabase 免费版限制 200 连接 |
| **财报数据拉取** | 外部 API | 20-100 | AKShare 有频率限制 |

### 5.2 应对策略

#### 5.2.1 前端计算卸载（减少后端压力）

```
前端可完成的计算（零后端压力）
├── 模拟撮合引擎 → 纯前端 TypeScript
├── 持仓盈亏计算 → 纯前端
├── K 线技术指标 → 纯前端 (ta.js)
├── 图表渲染 → 纯前端
└── 场景数据加载 → CDN + 本地缓存

必须后端处理
├── LLM 调用 → API 密钥不能暴露在前端
├── 回测执行 → Python 环境
├── 数据同步 → Supabase (托管)
└── 用户认证 → Supabase Auth
```

#### 5.2.2 LLM 调用并发控制

```typescript
// apps/server/src/services/llm-gateway.ts

class LLMGateway {
  // 令牌桶限流：每用户每分钟 10 次
  private rateLimiter = new TokenBucket({
    capacity: 10,
    refillRate: 10,  // 每分钟补充 10 个
    refillInterval: 60_000,
  });
  
  // 结果缓存：相同分析请求缓存 24h
  private cache = new Redis();
  
  async analyze(prompt: string, userId: string): Promise<string> {
    // 1. 检查缓存
    const cacheKey = hash(prompt);
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;
    
    // 2. 限流检查
    if (!this.rateLimiter.consume(userId)) {
      throw new RateLimitError('请稍后再试，每分钟限 10 次分析');
    }
    
    // 3. 并发队列（全局最大 20 并发）
    return this.queue.add(async () => {
      const result = await deepseek.chat(prompt);
      await this.cache.set(cacheKey, result, { ex: 86400 });
      return result;
    });
  }
}
```

#### 5.2.3 回测任务队列

```python
# services/backtest-engine/queue.py

from fastapi import BackgroundTasks
from concurrent.futures import ProcessPoolExecutor
import asyncio

# 进程池：最多 4 个回测并行执行
executor = ProcessPoolExecutor(max_workers=4)

# 任务队列：超出 4 个的排队等待
task_queue = asyncio.Queue(maxsize=50)

async def submit_backtest(strategy_code: str, params: dict):
    task_id = generate_id()
    
    # 入队
    await task_queue.put({
        "task_id": task_id,
        "code": strategy_code,
        "params": params,
        "status": "queued"
    })
    
    # 异步执行
    asyncio.create_task(process_queue())
    
    return {"task_id": task_id, "status": "queued", "position": task_queue.qsize()}

async def process_queue():
    task = await task_queue.get()
    loop = asyncio.get_event_loop()
    
    # 在独立进程中执行回测（隔离 + 超时）
    result = await asyncio.wait_for(
        loop.run_in_executor(executor, run_backtest_sandboxed, task),
        timeout=30  # 30秒超时
    )
    
    # 结果写入数据库 → 触发 Realtime 通知前端
    await save_result(task["task_id"], result)
```

### 5.3 扩展性评估

| 阶段 | 用户规模 | 基础设施 | 月成本 |
|------|---------|---------|--------|
| **MVP** (0-1000 DAU) | 1K | Vercel Free + Supabase Free + 1台 2C4G VPS | ~¥200/月 |
| **增长期** (1K-10K DAU) | 10K | Vercel Pro + Supabase Pro + 2台 4C8G | ~¥2,000/月 |
| **规模化** (10K-100K DAU) | 100K | Vercel Enterprise + Supabase Team + K8s 集群 | ~¥20,000/月 |

---

## 6. 多端部署策略

### 6.1 各端部署方案

```
                    ┌─────────────────────────────────┐
                    │        共享 Web 应用代码          │
                    │     Next.js + React + Tailwind    │
                    └────────┬────────┬────────┬───────┘
                             │        │        │
                    ┌────────┴──┐ ┌───┴────┐ ┌─┴───────┐
                    │           │ │        │ │         │
               ┌────┴────┐     │ │        │ │         │
               │  Web 端  │     │ │ 移动端  │ │ 桌面端   │
               │         │     │ │        │ │         │
               │ Vercel  │     │ │Capacitor│ │ Tauri v2│
               │ Edge    │     │ │        │ │         │
               │ Deploy  │     │ │ ┌──┐┌──┐│ │┌──┐┌───┐│
               │         │     │ │ │📱││📱││ ││🖥️││🖥️ ││
               │  🌐     │     │ │ │iO││An││ ││ma││Win││
               │         │     │ │ │S ││dr││ ││c ││dow││
               └─────────┘     │ │ └──┘└──┘│ │└──┘└───┘│
                               │ └────────┘ └─────────┘
                               │
                         ┌─────┴──────┐
                         │  PWA 模式   │
                         │ (可选 Plan B)│
                         └────────────┘
```

### 6.2 各端特化处理

| 端 | 壳技术 | 特化功能 | 打包产物 |
|---|--------|---------|---------|
| **Web** | Next.js (SSR + SPA) | SEO、分享链接、首屏 SSR | Vercel 自动部署 |
| **iOS** | Capacitor 6 | 推送通知 (APNs)、Haptic 反馈、Face ID | .ipa → App Store |
| **Android** | Capacitor 6 | 推送通知 (FCM)、Material Design 适配 | .apk/.aab → Google Play / 国内渠道 |
| **macOS** | Tauri v2 | 菜单栏快捷入口、原生通知、多窗口 | .dmg → 官网 / Mac App Store |
| **Windows** | Tauri v2 | 系统托盘、原生通知、自动更新 | .msi/.exe → 官网 / Microsoft Store |

### 6.3 平台适配层代码

```typescript
// packages/core/src/platform/index.ts

// 统一平台抽象层 — 各端实现不同

interface PlatformAdapter {
  // 存储
  getStorage(): StorageAdapter;
  
  // 通知
  sendNotification(title: string, body: string): Promise<void>;
  
  // 生物识别
  authenticate(): Promise<boolean>;
  
  // 分享
  share(data: ShareData): Promise<void>;
  
  // 深色模式
  getColorScheme(): 'light' | 'dark';
  onColorSchemeChange(cb: (scheme: string) => void): void;
}

// Web 实现
class WebPlatform implements PlatformAdapter {
  getStorage() { return new IndexedDBStorage(); }
  async sendNotification(title, body) {
    if ('Notification' in window) {
      new Notification(title, { body });
    }
  }
  // ...
}

// Capacitor (iOS/Android) 实现  
class CapacitorPlatform implements PlatformAdapter {
  getStorage() { return new CapacitorStorage(); }  // @capacitor/preferences
  async sendNotification(title, body) {
    await LocalNotifications.schedule({ notifications: [{ title, body, id: Date.now() }] });
  }
  async authenticate() {
    const result = await BiometricAuth.authenticate({ reason: '验证身份' });
    return result.verified;
  }
  // ...
}

// Tauri (Desktop) 实现
class TauriPlatform implements PlatformAdapter {
  getStorage() { return new TauriFileStorage(); }  // tauri fs
  async sendNotification(title, body) {
    await invoke('show_notification', { title, body });
  }
  // ...
}

// 运行时自动选择
export const platform: PlatformAdapter = detectPlatform();
```

### 6.4 响应式 UI 策略

```
屏幕宽度适配方案
═══════════════════════════════════════════

  < 640px (手机)        640-1024px (平板)      > 1024px (桌面)
  ┌───────────┐         ┌──────────────┐      ┌────────────────────┐
  │ 底部Tab    │         │ 折叠侧边栏    │      │ 完整侧边栏 + 多面板  │
  │ 导航      │         │ + 内容区      │      │ 交易面板 | K线 | 新闻 │
  │ ┌───────┐ │         │ ┌──┬────────┐│      │ ┌───┬──────┬──────┐ │
  │ │ 全屏   │ │         │ │  │        ││      │ │   │      │      │ │
  │ │ K线    │ │         │ │☰ │ K线    ││      │ │Nav│ K线  │ 新闻  │ │
  │ │       │ │         │ │  │ + 交易  ││      │ │   │      │      │ │
  │ │       │ │         │ │  │        ││      │ │   │      │ 交易  │ │
  │ └───────┘ │         │ └──┴────────┘│      │ └───┴──────┴──────┘ │
  │ ┌─┬─┬─┬─┐ │         └──────────────┘      └────────────────────┘
  │ │🏠│📊│📋│⚙│ │
  │ └─┴─┴─┴─┘ │
  └───────────┘

  Tailwind CSS 断点：sm:640 md:768 lg:1024 xl:1280
  组件库 shadcn/ui 原生支持响应式
```

---

## 7. 功能拆解与任务清单

### 7.1 模块 A 任务拆解：历史情景模拟炒股

| # | 任务 | 子任务 | 优先级 | 预估工时 | 依赖 |
|---|------|-------|-------|---------|------|
| A1 | **场景数据准备** | | | **2周** | |
| A1.1 | | AKShare 历史 K 线数据采集脚本 | P0 | 2d | - |
| A1.2 | | 历史新闻爬取 + 日期对齐 | P0 | 3d | - |
| A1.3 | | 重大政策事件标注数据库 | P1 | 2d | - |
| A1.4 | | 预制 10 个经典场景数据包 | P0 | 3d | A1.1-A1.3 |
| A2 | **撮合引擎** | | | **1周** | |
| A2.1 | | 简化版订单撮合逻辑 (core) | P0 | 2d | - |
| A2.2 | | 涨跌停/T+1 规则实现 | P0 | 1d | A2.1 |
| A2.3 | | 滑点模拟（基于历史成交量） | P1 | 1d | A2.1 |
| A2.4 | | 手续费计算（印花税/佣金） | P0 | 0.5d | A2.1 |
| A3 | **前端核心页面** | | | **3周** | |
| A3.1 | | 场景选择页（卡片展示） | P0 | 2d | A1.4 |
| A3.2 | | K 线回放组件（TradingView LC） | P0 | 4d | A1.1 |
| A3.3 | | 新闻时间线组件 | P0 | 2d | A1.2 |
| A3.4 | | 交易面板（买入/卖出/持仓） | P0 | 3d | A2 |
| A3.5 | | 持仓概览 + 收益曲线 | P0 | 2d | A2 |
| A3.6 | | 场景结束 → 复盘报告页 | P1 | 2d | A4 |
| A4 | **AI 复盘引擎** | | | **1周** | |
| A4.1 | | DeepSeek 复盘 Prompt 工程 | P0 | 2d | - |
| A4.2 | | SSE 流式输出 API | P0 | 1d | A4.1 |
| A4.3 | | 复盘报告结构化模板 | P1 | 1d | A4.1 |
| A4.4 | | 幻觉校验（数值比对） | P2 | 1d | A4.1 |

### 7.2 模块 B 任务拆解：AI 量化回测

| # | 任务 | 子任务 | 优先级 | 预估工时 | 依赖 |
|---|------|-------|-------|---------|------|
| B1 | **回测微服务** | | | **2周** | |
| B1.1 | | FastAPI 服务搭建 + 健康检查 | P0 | 1d | - |
| B1.2 | | VectorBT 回测引擎封装 | P0 | 3d | - |
| B1.3 | | AKShare 数据加载 + Parquet 缓存 | P0 | 2d | - |
| B1.4 | | 安全沙箱（RestrictedPython） | P0 | 2d | B1.2 |
| B1.5 | | 任务队列 + 进度推送 | P1 | 2d | B1.2 |
| B2 | **LLM 策略生成** | | | **1.5周** | |
| B2.1 | | 自然语言 → 策略代码 Prompt 工程 | P0 | 3d | - |
| B2.2 | | Few-shot 示例库（20+ 策略） | P0 | 2d | B2.1 |
| B2.3 | | 生成代码的 AST 安全检查 | P0 | 1d | B2.1 |
| B2.4 | | 策略代码编辑器（Monaco） | P1 | 2d | B2.1 |
| B3 | **回测结果展示** | | | **2周** | |
| B3.1 | | 收益曲线 vs 基准图表 | P0 | 2d | B1 |
| B3.2 | | 指标仪表盘（夏普/回撤/胜率） | P0 | 2d | B1 |
| B3.3 | | 交易明细表 | P1 | 1d | B1 |
| B3.4 | | AI 策略分析（SSE 流式） | P0 | 2d | B1+B2 |
| B3.5 | | 策略参数优化面板 | P2 | 3d | B1 |

### 7.3 模块 C 任务拆解：AI 财报分析

| # | 任务 | 子任务 | 优先级 | 预估工时 | 依赖 |
|---|------|-------|-------|---------|------|
| C1 | **数据采集服务** | | | **1.5周** | |
| C1.1 | | AKShare 三大报表采集 | P0 | 2d | - |
| C1.2 | | 行业分类 + 同行匹配 | P0 | 2d | C1.1 |
| C1.3 | | 基本面指标拉取 (Tushare) | P0 | 1d | - |
| C1.4 | | 年报 PDF 解析（可选） | P2 | 3d | - |
| C2 | **指标计算引擎** | | | **1周** | |
| C2.1 | | 六维指标计算（盈利/成长/运营/风险/估值/现金流） | P0 | 3d | C1 |
| C2.2 | | 同行排名算法 | P0 | 1d | C2.1 |
| C2.3 | | 历史趋势计算（5年滚动） | P1 | 1d | C2.1 |
| C3 | **分析展示** | | | **2周** | |
| C3.1 | | 搜索/输入页面 | P0 | 1d | - |
| C3.2 | | 六维雷达图 | P0 | 2d | C2 |
| C3.3 | | 同行 PK 对比表 | P0 | 2d | C2 |
| C3.4 | | AI 深度分析（流式输出） | P0 | 2d | C2 |
| C3.5 | | 历史趋势图表 | P1 | 2d | C2 |
| C3.6 | | 分析报告导出（PDF/图片） | P2 | 2d | C3.2-C3.5 |

### 7.4 基础设施任务拆解

| # | 任务 | 优先级 | 预估工时 | 说明 |
|---|------|-------|---------|------|
| I1 | Monorepo 搭建 (Turborepo + pnpm) | P0 | 1d | 项目骨架 |
| I2 | Supabase 项目初始化 + Schema 设计 | P0 | 2d | 数据库 |
| I3 | Auth 模块（邮箱/手机/OAuth） | P0 | 2d | 注册登录 |
| I4 | 共享 UI 组件库 (shadcn/ui) | P0 | 2d | 基础组件 |
| I5 | API 网关 (Hono) + 中间件 | P0 | 1d | 后端入口 |
| I6 | LLM 网关 + 限流 + 缓存 | P0 | 2d | AI 调用层 |
| I7 | Realtime 同步模块 | P1 | 3d | 多端同步 |
| I8 | Capacitor 移动端壳 | P1 | 2d | iOS/Android |
| I9 | Tauri 桌面端壳 | P2 | 2d | macOS/Windows |
| I10 | CI/CD 流水线 | P1 | 2d | 自动构建部署 |
| I11 | 订阅支付系统 | P1 | 3d | 微信支付/支付宝 |

---

## 8. 开发路线图

### 8.1 Phase 路线图总览

```
时间轴（周）
W1  W2  W3  W4  W5  W6  W7  W8  W9  W10 W11 W12 W13 W14 W15 W16 W17 W18 W19 W20
│   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │   │
├───┴───┴───┴───┴───┴───┴───┴───┤   │   │   │   │   │   │   │   │   │   │   │
│     Phase 1: MVP 模拟炒股       │   │   │   │   │   │   │   │   │   │   │   │
│     Web 端上线 (8周)            │   │   │   │   │   │   │   │   │   │   │   │
├─────────────────────────────────┤   │   │   │   │   │   │   │   │   │   │   │
                                  ├───┴───┴───┴───┴───┤   │   │   │   │   │   │
                                  │  Phase 2: 量化回测  │   │   │   │   │   │   │
                                  │  + 移动端 (5周)     │   │   │   │   │   │   │
                                  ├─────────────────────┤   │   │   │   │   │   │
                                                        ├───┴───┴───┴───┴───┤   │
                                                        │  Phase 3: 财报分析  │   │
                                                        │  + 桌面端 (5周)     │   │
                                                        ├─────────────────────┤   │
                                                                              ├───┤
                                                                              │P4 │
                                                                              │优化│
                                                                              └───┘
```

### 8.2 Phase 1 详细排期（Week 1-8）

**目标**：Web 端 MVP 上线 — 历史情景模拟炒股

| 周次 | 任务 | 交付物 | 里程碑 |
|------|------|--------|--------|
| W1 | I1 Monorepo 搭建 + I2 Supabase + I3 Auth | 项目骨架 + 数据库 + 登录注册 | 🏁 基础设施就绪 |
| W2 | A1.1-A1.3 场景数据准备 + I4 UI 组件库 | 10 个场景原始数据 + shadcn 组件 | |
| W3 | A1.4 数据包打包 + A2 撮合引擎 | 可用的场景数据 + 交易引擎 | 🏁 核心引擎就绪 |
| W4 | A3.1 场景选择页 + A3.2 K线回放 | K 线可回放 | |
| W5 | A3.3 新闻时间线 + A3.4 交易面板 | 完整交易体验 | 🏁 核心体验可玩 |
| W6 | A4 AI 复盘引擎 + A3.5 持仓概览 | AI 复盘功能 | |
| W7 | A3.6 复盘报告 + I5 API 网关 + I6 LLM 网关 | 完整闭环 | 🏁 功能完整 |
| W8 | 联调测试 + 性能优化 + 上线部署 | 生产环境上线 | 🚀 **Web MVP 上线** |

### 8.3 Phase 2 详细排期（Week 9-13）

**目标**：量化回测模块 + 移动端上线

| 周次 | 任务 | 交付物 | 里程碑 |
|------|------|--------|--------|
| W9 | B1.1-B1.3 回测微服务 + B2.1 Prompt 工程 | Python 服务可运行 | |
| W10 | B1.4 沙箱 + B2.2 策略模板 + B2.3 安全检查 | 安全的代码执行 | 🏁 回测引擎就绪 |
| W11 | B3.1-B3.4 回测结果展示 + AI 分析 | 完整回测体验 | |
| W12 | I8 Capacitor 移动端壳 + 适配 + I11 支付 | iOS/Android 可运行 | 🏁 移动端就绪 |
| W13 | 联调 + TestFlight/内测 + 上线 | 移动端上架 | 🚀 **移动端 + 回测上线** |

### 8.4 Phase 3 详细排期（Week 14-18）

**目标**：财报分析模块 + 桌面端 + 多端同步

| 周次 | 任务 | 交付物 | 里程碑 |
|------|------|--------|--------|
| W14 | C1 数据采集 + C2 指标计算 | 财报数据管道 | |
| W15 | C3.1-C3.4 分析展示 + AI 深度分析 | 财报分析可用 | 🏁 财报模块就绪 |
| W16 | I9 Tauri 桌面端壳 + 适配 | macOS/Windows 可运行 | |
| W17 | I7 Realtime 多端同步 + 离线队列 | 跨端数据一致 | 🏁 全端同步就绪 |
| W18 | 全端联调 + 性能优化 + 发布 | 全平台发布 | 🚀 **全端正式版上线** |

### 8.5 Phase 4：持续迭代（Week 19+）

- 实时策略模拟（Paper Trading）
- 批量财报分析 + 行业研报自动生成
- API 开放平台
- 社区功能（策略分享、排行榜）
- 国际化（港股/美股支持）

---

## 9. 技术风险与缓解

| 风险 | 概率 | 影响 | 缓解策略 |
|------|------|------|---------|
| **LLM 生成的策略代码有漏洞** | 高 | 🔴 安全 | RestrictedPython 沙箱 + AST 白名单 + 30s 超时 + 内存限制 |
| **AKShare/Tushare API 不稳定** | 中 | 🟡 可用性 | 多数据源备份 + 本地 Parquet 缓存 + 降级策略 |
| **LLM 幻觉产生虚假财务数据** | 高 | 🔴 合规 | 所有数值由 Python 计算，LLM 仅做文字分析 + 输出校验 |
| **多端同步冲突** | 中 | 🟡 体验 | Server-Authoritative + 离线队列 + 冲突自动回滚 |
| **回测服务高并发阻塞** | 中 | 🟡 体验 | 任务队列 + 进程池限制 + 用户排队提示 |
| **Capacitor Web 性能瓶颈** | 低 | 🟡 体验 | K 线组件使用 Canvas/WebGL 渲染 + 虚拟列表 |
| **App Store 审核被拒** | 中 | 🟡 上线 | 投资建议免责声明 + "教育工具"定位 + 无实盘交易 |
| **证券投资咨询合规风险** | 中 | 🔴 法律 | 全面标注"不构成投资建议" + 定位教育工具 + 咨询律师 |

---

## 附录 A：数据库 Schema 概要

```sql
-- 核心表结构

-- 用户
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  display_name TEXT,
  subscription_tier TEXT DEFAULT 'free', -- free/pro/premium
  subscription_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 模拟场景进度
CREATE TABLE scenario_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  scenario_id TEXT NOT NULL,          -- 'covid_2020' 等
  current_date DATE NOT NULL,         -- 模拟推进到的日期
  initial_capital NUMERIC(14,2),
  current_capital NUMERIC(14,2),
  status TEXT DEFAULT 'in_progress',  -- in_progress/completed
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, scenario_id)
);

-- 模拟交易记录
CREATE TABLE simulation_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  scenario_id TEXT NOT NULL,
  trade_date DATE NOT NULL,
  symbol TEXT NOT NULL,                -- '600519'
  direction TEXT NOT NULL,             -- 'buy'/'sell'
  quantity INT NOT NULL,
  price NUMERIC(10,2) NOT NULL,
  commission NUMERIC(10,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 回测记录
CREATE TABLE backtest_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  strategy_prompt TEXT,               -- 用户的自然语言描述
  strategy_code TEXT,                 -- 生成的 Python 代码
  params JSONB,                       -- 回测参数
  result JSONB,                       -- 回测结果数据
  ai_analysis TEXT,                   -- AI 分析内容
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 财报分析缓存
CREATE TABLE analysis_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  report_period TEXT NOT NULL,         -- '2025Q4'
  analysis_data JSONB,                 -- 计算好的指标
  ai_report TEXT,                      -- AI 分析报告
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, report_period)
);

-- RLS 策略：用户只能访问自己的数据
ALTER TABLE scenario_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE simulation_trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users access own data" ON scenario_progress
  FOR ALL USING (auth.uid() = user_id);
-- (其他表同理)
```

## 附录 B：关键第三方依赖清单

| 包名 | 版本 | 用途 | 许可证 |
|------|------|------|--------|
| `next` | 15.x | Web 框架 | MIT |
| `@capacitor/core` | 6.x | 移动端壳 | MIT |
| `@tauri-apps/api` | 2.x | 桌面端壳 | MIT/Apache-2.0 |
| `zustand` | 5.x | 状态管理 | MIT |
| `@tanstack/react-query` | 5.x | 数据请求 | MIT |
| `lightweight-charts` | 4.x | K 线图表 | Apache-2.0 |
| `echarts` | 5.x | 数据可视化 | Apache-2.0 |
| `hono` | 4.x | API 框架 | MIT |
| `@supabase/supabase-js` | 2.x | BaaS 客户端 | MIT |
| `monaco-editor` | 0.48+ | 代码编辑器 | MIT |
| `vectorbt` (Python) | 0.26+ | 向量化回测 | AGPL → 注意授权 |
| `backtrader` (Python) | 1.9+ | 事件驱动回测 | GPL → 注意授权 |
| `akshare` (Python) | 1.18+ | A 股数据源 | MIT |
| `fastapi` (Python) | 0.110+ | 回测 API 服务 | MIT |

> ⚠️ **VectorBT 使用 AGPL 许可证**，如果修改其代码需要开源。建议作为独立微服务调用（AGPL 的网络使用条款仍需注意），或考虑付费商用许可。Backtrader 是 GPL，同样建议进程隔离。

---

## 附录 C：决策记录 (ADR)

### ADR-001: 为什么不用 Flutter

- **日期**: 2026-04-13
- **决策**: 选择 React (Next.js + Capacitor + Tauri) 而非 Flutter
- **原因**: 金融 K 线图表 Web 生态远超 Flutter (TradingView LC, ECharts)；LLM SSE 流式输出在 Web 端天然支持；团队扩展性（React 开发者 >> Dart 开发者）；Web SEO 对引流至关重要
- **风险**: Capacitor 性能不如 Flutter 原生渲染，但 K 线使用 Canvas/WebGL 可弥补

### ADR-002: 为什么回测用独立 Python 微服务

- **日期**: 2026-04-13  
- **决策**: 回测引擎独立为 Python FastAPI 微服务
- **原因**: VectorBT/Backtrader 是 Python 生态，无可比拟的 JS 替代品；GPL/AGPL 许可证需要进程隔离；CPU 密集计算需要独立扩缩容；安全沙箱在 Python 进程中更好控制
- **代价**: 增加一个服务的运维成本；TypeScript ↔ Python 通信延迟约 50-200ms

### ADR-003: 为什么选 Supabase 而非自建

- **日期**: 2026-04-13
- **决策**: 使用 Supabase 作为主数据库 + Auth + Realtime
- **原因**: Realtime 订阅开箱即用，省去自建 WebSocket 服务；Row Level Security 安全模型成熟；Auth 支持多种登录方式；免费层足够 MVP 验证
- **风险**: 免费版 Realtime 连接数限制 200，规模化后需升级或迁移

---

*文档结束 — InvestDojo 投资道场技术架构方案 v1.0*
