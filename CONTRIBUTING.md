# 贡献指南

> 状态：v1.0 · 2026-04-28

本文档描述 InvestDojo 项目的开发规范。不遵守的 PR 会被 CI 拦下。

---

## 1. 仓库结构

```
finance/                           ← Git 根
├── docs/                          产品/架构/API/ADR 四层文档
├── investdojo/                    Monorepo 代码
│   ├── apps/{web,server}/        Next.js + Node orchestrator
│   ├── packages/{core,ui,api}/   共享包
│   ├── python-services/           5 个 Python 微服务
│   └── infra/                     本地基础设施（Docker Compose）
└── .github/workflows/             CI 配置
```

## 2. 分支规范

- `main` 受保护，不能直接推
- 特性分支：`feat/xxx` / `fix/xxx` / `docs/xxx` / `chore/xxx`
- PR 必须走 CI 才能合并

## 3. 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

常用 type：
- `feat` 新功能
- `fix` 修 bug
- `docs` 文档
- `refactor` 重构
- `test` 测试
- `chore` 杂项

示例：
```
feat(feature-svc): 实现 MA 交叉因子
fix(supabase): 修复分页 bug（filter 格式错误）
docs(api): 补充因子库 API 错误码
```

## 4. 本地开发前置

```bash
# Node 环境
eval "$(fnm env --use-on-cd --shell zsh)"
fnm use 22

# Python 环境（在 python-services/ 下）
brew install uv overmind
cd investdojo/python-services
uv sync

# 基础设施
cd investdojo/infra
./scripts/dev-up.sh
```

## 5. 本地跑 CI 检查

提交前建议本地跑一遍，避免 CI 失败：

```bash
# Python 侧
cd investdojo/python-services
make ci              # lint + typecheck + unit test

# Node 侧
cd investdojo
pnpm type-check
pnpm lint
pnpm build
```

## 6. pre-commit 钩子（推荐）

```bash
# 装一次
brew install pre-commit
cd /Users/xxxixi/project/finance
pre-commit install

# 之后每次 commit 自动跑
# 手动跑所有文件：
pre-commit run --all-files
```

## 7. 测试规范

Python 测试分两类（通过 pytest 标记）：

- `@pytest.mark.integration` — 需要真实 Supabase/Redis/MinIO
- 默认单元测试 — 不依赖外部

CI 只跑单元测试（integration 本地或 secrets 配置后才跑）：

```bash
make test-unit         # CI 跑的
make test-integration  # 本地跑的
make test              # 全跑
```

## 8. 文档规范

修改文档的原则见 [docs/README.md](./docs/README.md)：

- 改需求 → 改 `docs/product/`
- 改架构 → 改 `docs/architecture/` + 写 ADR
- 改接口 → 改 `docs/api/`

## 9. 防未来函数（红线）

任何数据查询都要传 `as_of`。联动模式下由 Session Orchestrator 自动注入。
CI 会跑 as_of enforcer 的契约测试。
违反红线的 PR 会被拦下。

详见 [docs/architecture/04_联动机制.md §8](./docs/architecture/04_联动机制.md#8-防未来函数实现)。

## 10. 秘密管理

- **不要**把 Supabase service_role_key 提交到仓库
- 放在 `investdojo/apps/server/.env`（已 gitignore）
- GitHub Secrets 用于 CI 时注入
- pre-commit 钩子会扫 JWT 模式
