# InvestDojo 项目进展日志

> **定位**：按日期记录项目开发进展，同步展示在 `/admin/progress` 页面
> **唯一数据源**：`apps/web/src/app/admin/progress/progress-data.json`
> **更新方式**：每次开发完只需更新 `progress-data.json`，页面自动渲染，本 md 作为可读备份
> **格式**：每日一条，最新的在最上面

---

## 2026-05-17

### 主要进展

- **数据管理后台增强**
  - 修复 backfill_factors 任务脚本路径错误（`SCRIPTS_DIR` 少算一层目录）
  - 修复 Windows GBK 编码问题（emoji 输出 + subprocess 编码设置）
  - 修复 VENV_PYTHON fallback 逻辑，增加 `sys.executable` 兜底
  - 新增任务历史日志持久化（JSON 文件存储到 `.task_history/`）
  - 新增服务重启自动恢复任务状态（running → interrupted）
  - 新增历史记录 API（`GET /tasks/{name}/history`）
  - 前端进入页面即展示最新任务状态和日志，无需点"执行"
  - 前端新增"历史"面板，可回看过去执行记录和日志
  - 修复日志自动滚动导致页面跳转的问题

### 涉及文件

- `python-services/data-svc/routers/admin.py`
- `apps/web/src/app/admin/data/page.tsx`
- `scripts/backfill_factors.py`

### 状态

Epic 3 因子库持续打磨中，数据管理工具链趋于完善。

---

## 2026-05-16

### 主要进展

- **角色与权限体系**
  - `useCurrentUser` hook 提供 `user.role` 和 `isStaff()` 判断
  - `MainNav` 动态菜单：`staffOnly` 项仅员工可见
  - 管理员账号 `1152508446@qq.com` (role=admin)
  - 测试账号 `test-bot@investdojo.internal` (role=staff)

- **数据管理后台 v1**（`/admin/data`）
  - 数据概览（各表行数、最近更新时间）
  - 手动触发数据更新任务（K线、快照、基本面、股票代码）
  - SQL 查询工具（左侧表结构 + 右侧编辑器，只允许 SELECT）
  - 任务进度条 + 实时日志面板（2s 轮询）

### 涉及文件

- `apps/web/src/hooks/useCurrentUser.ts`
- `apps/web/src/components/MainNav.tsx`
- `apps/web/src/app/admin/data/`
- `python-services/data-svc/routers/admin.py`

### 状态

管理工具链初步建立。

---

## 2026-05-15

### 主要进展

- **因子发布自动回填**
  - `publish_factor` 使用 `BackgroundTasks` 异步调用 `_backfill_factor_async` 回填 90 天数据
  - `unpublish_factor` 自动清理 `feature_values` 缓存

- **因子历史值修复**
  - `panel_loader.py` 添加 `_aggregate_5m_to_1d()` 自动聚合（日线缺失时回退到 5 分钟聚合）
  - 前端默认日期范围改为 `2026-03-01 ~ 04-30`（匹配数据实际范围）
  - 私有因子直接实时计算不存储

### 涉及文件

- `python-services/feature-svc/routers/factors.py`
- `python-services/feature-svc/factors/panel_loader.py`
- `python-services/feature-svc/factors/batch_compute.py`

### 状态

因子计算管线全通。

---

## 2026-05-14

### 主要进展

- **鉴权 Bug 审计与修复**（4 个）
  - Bug1: `or` 过滤器 key 冲突 → 分离 `visibility_or_parts` 和 `search_or_parts`
  - Bug2: 创建因子绕过 SDK → 改用 `sdk.factors.createFactor()`
  - Bug3: 匿名用户可写 → 新增 `_require_user_id()` 强制校验，写接口返回 401
  - Bug4: userId 格式不校验 → 检查长度 >=32，排除 "anon/undefined/null"

- **因子库来源重构**
  - 来源分为：全部(公开)、官方因子、用户发布(公开)、我的因子(含私有)
  - 后端 `list_factors` 的 `owner` 参数支持传 UUID

### 涉及文件

- `python-services/feature-svc/routers/factors.py`
- `apps/web/src/app/factors/FactorsPage.tsx`
- `packages/api/src/factor-client.ts`

### 状态

因子库安全性和可用性大幅提升。

---

## 2026-05-13

### 主要进展

- **因子发布/撤销功能**
  - SDK 修复：`sdk.ts` 创建时未传 `userId`，导致 `X-User-Id` header 为空
  - 后端新增 `POST /factors/{id}/unpublish` 接口
  - 前端添加撤销发布按钮

- **CodeBuddy Skill 创建**（`investdojo-dev`）
  - 位于 `.codebuddy/skills/investdojo-dev/`
  - 含多角色协作体系：fe-dev、api-dev、auth-dev、data-eng、infra-ops、tester

### 涉及文件

- `packages/api/src/index.ts`
- `apps/web/src/lib/sdk.ts`
- `.codebuddy/skills/investdojo-dev/`

### 状态

因子发布流程打通，AI 辅助开发体系建立。

---

## 2026-05-02

### 主要进展

- **Supabase 本地栈部署完成**
  - 从 Supabase Cloud 迁移到 Windows 自托管 Supabase Lite
  - Docker Compose 编排：PostgreSQL 15.8 + PostgREST + GoTrue + Kong
  - 数据完整迁移：4 场景 / 72,980 K线 / 49 新闻
  - 详见 `docs/ops/2026-05-02-本地栈部署完成.md`

### 状态

基础设施稳定，进入业务开发阶段。

---

## 2026-04-28

### 主要进展

- **MVP Sprint 0 规划完成**
  - 10 周任务拆解（8 个 Epic，详见 `docs/product/99_MVP_Sprint0.md`）
  - Epic 0 基础设施 4/4 全部完成（实际 1.5 天，预估 5 天）
  - Epic 1 数据层启动

### 状态

项目正式启动。
