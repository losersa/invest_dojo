# 🥋 InvestDojo 投资道场

> 模拟炒股 × 量化回测 × 财报分析 三合一投资学习平台

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 9

### 安装依赖

```bash
pnpm install
```

### 配置环境变量

```bash
cp apps/web/.env.example apps/web/.env.local
cp apps/server/.env.example apps/server/.env
```

### 启动开发

```bash
# 同时启动 Web + API
pnpm dev

# 仅启动 Web
pnpm dev:web

# 仅启动 API
pnpm dev:server
```

Web 端访问: http://localhost:3000  
API 端访问: http://localhost:4000

### 构建

```bash
pnpm build
```

## 项目结构

```
investdojo/
├── apps/
│   ├── web/          # Next.js 15 Web 应用
│   └── server/       # Hono API 服务
├── packages/
│   ├── core/         # 纯业务逻辑（撮合引擎、场景管理）
│   ├── ui/           # 共享 React UI 组件
│   └── api/          # API 客户端 + Supabase
├── turbo.json        # Turborepo 配置
└── pnpm-workspace.yaml
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 15 + React 19 + Tailwind CSS 4 |
| 状态 | Zustand 5 + TanStack Query |
| 图表 | TradingView Lightweight Charts |
| 后端 | Hono (TypeScript) |
| 数据库 | Supabase (PostgreSQL) |
| LLM | DeepSeek V3 |

## 当前进度

- [x] Monorepo 骨架
- [x] 模块 A: 历史情景模拟炒股（代码框架）
- [ ] 模块 B: AI 量化回测
- [ ] 模块 C: AI 财报分析
- [ ] Capacitor 移动端壳
- [ ] Tauri 桌面端壳
