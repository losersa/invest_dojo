# InvestDojo 文档索引

> 最后更新：2026-05-01

InvestDojo 投资道场 — 模拟炒股 × 量化回测 × 财报分析 三合一。
本目录采用 **产品 / 架构 / API / 决策记录** 四层文档结构，分层独立维护。

---

## 📂 目录结构

```
docs/
├── README.md                         ← 本文件
├── product/                          ← 产品需求（PRD）
│   ├── 02_量化模块_PRD.md            ✅
│   └── 99_MVP_Sprint0.md              ✅ 10 周任务拆解
├── architecture/                     ← 技术架构
│   ├── 00_系统总览.md                 ✅
│   ├── 01_数据层.md                   ✅
│   ├── 03_量化模块.md                 ✅
│   ├── 04_联动机制.md                 ✅
│   └── 05_特征平台.md                 ✅ 新增
├── api/                              ← 接口规范（7 份全集）
│   ├── 00_约定.md                    ✅
│   ├── 01_数据API.md                 ✅
│   ├── 02_因子库API.md               ✅
│   ├── 03_模型API.md                 ✅
│   ├── 04_回测API.md                 ✅
│   ├── 05_推理API.md                 ✅
│   └── 06_会话API.md                 ✅
├── adr/                              ← 架构决策记录
│   ├── 0001-为什么拆分产品与技术文档.md  ✅
│   ├── 0002-平台官方模型与用户模型同等待遇.md ✅
│   └── 0003-特征平台产品化路径.md       ✅ 新增
└── _archive/                         ← 归档
    └── InvestDojo_量化模块技术方案_v1_legacy.md
```

### 文档边界
- **PRD** 不写技术方案
- **架构文档** 不写需求
- **API 文档** 独立版本化
- **ADR** 记录"为什么"（一次性写入，不再修改）

---

## 📘 Product · 产品需求

| 文件 | 状态 | 说明 |
|------|------|------|
| 00_产品总览.md | ⏳ TODO | 三大模块定位、用户画像、北极星指标 |
| 01_模拟炒股_PRD.md | ⏳ TODO | 经典/盲测/自选 三模式 |
| [02_量化模块_PRD.md](./product/02_量化模块_PRD.md) | ✅ Draft | 因子库/训练/回测/联动/⭐官方模型 |
| 03_财报分析_PRD.md | ⏳ 未开始 | |
| [99_MVP_Sprint0.md](./product/99_MVP_Sprint0.md) | ✅ Active | **MVP 10 周任务拆解** · 8 Epic · 60+ 任务 |

## 🏗 Architecture · 技术架构

| 文件 | 状态 | 说明 |
|------|------|------|
| [00_系统总览.md](./architecture/00_系统总览.md) | ✅ Stable | 整体分层、技术栈、部署拓扑、关键数据流 |
| [01_数据层.md](./architecture/01_数据层.md) | ✅ Stable | DB schema、完整 DDL、索引、RLS、Redis、对象存储 |
| 02_模拟炒股引擎.md | ⏳ TODO（旧文档可迁移） | 撮合、会话、回放 |
| [03_量化模块.md](./architecture/03_量化模块.md) | ✅ Stable | MLOps 平台架构（含官方模型扩展点） |
| [04_联动机制.md](./architecture/04_联动机制.md) | ✅ Stable | Session Orchestrator 完整设计 |
| [05_特征平台.md](./architecture/05_特征平台.md) | ✅ Active | 五层架构栈 + v0.5~v3 路线 |

## 🔌 API · 接口规范

| 文件 | 状态 | 说明 |
|------|------|------|
| [00_约定.md](./api/00_约定.md) | ✅ Stable | 版本、认证、分页、错误码、WebSocket |
| [01_数据API.md](./api/01_数据API.md) | ✅ Stable | 行情/新闻/财报/场景 |
| [02_因子库API.md](./api/02_因子库API.md) | ✅ Stable | 公共因子 + 自定义 + 组合 + 评估 |
| [03_模型API.md](./api/03_模型API.md) | ✅ Stable | 训练/上传/市场/⭐官方模型 |
| [04_回测API.md](./api/04_回测API.md) | ✅ Stable | 快速/精细/对比/分享 |
| [05_推理API.md](./api/05_推理API.md) | ✅ Stable | 批量/请求响应/流式 WebSocket |
| [06_会话API.md](./api/06_会话API.md) | ✅ Stable | 四种联动模式核心 |

## 📝 ADR · 架构决策记录

| ID | 标题 | 状态 |
|----|------|------|
| [0001](./adr/0001-为什么拆分产品与技术文档.md) | 为什么拆分产品与技术文档 | Accepted |
| [0002](./adr/0002-平台官方模型与用户模型同等待遇.md) | 平台官方模型与用户模型同等待遇 | Accepted |
| [0003](./adr/0003-特征平台产品化路径.md) | 特征平台产品化路径 | Accepted |

---

## 🗂 历史文档

| 旧文档 | 状态 | 替代位置 |
|--------|------|---------|
| `InvestDojo_技术架构方案.md`（模块1初版） | 仍留在根目录 | 未来迁到 `architecture/02_模拟炒股引擎.md` |
| `InvestDojo_量化模块技术方案.md` v1 | 已归档 | `_archive/` |
| `investdojo-v2-prototype.html` | 仍有效 | 作为产品原型留存 |

---

## 🧭 快速导航

### 我是产品/PM
1. 看 [README 本页](.)
2. 看 [量化模块 PRD](./product/02_量化模块_PRD.md) 了解功能
3. 改需求 → 改 `product/` 下对应 PRD，不要动 `architecture/`

### 我是后端工程师
1. 看 [系统总览](./architecture/00_系统总览.md)（TODO）
2. 看 [量化架构](./architecture/03_量化模块.md) 了解服务拓扑
3. 看 [API 约定](./api/00_约定.md) 再看具体接口
4. 改架构 → 改 `architecture/` + 写 ADR

### 我是前端工程师
1. 看 [API 约定](./api/00_约定.md)
2. 看具体 API 文档（如 [因子库](./api/02_因子库API.md)）
3. 看对应 PRD 理解用户故事

### 我是算法同学
1. 看 [量化模块 PRD](./product/02_量化模块_PRD.md) 的 US-M01~03
2. 看 [量化架构](./architecture/03_量化模块.md) 第 3/5 章
3. 看 [因子库 API](./api/02_因子库API.md) 的 DSL 语法

---

## 📋 待补清单（按优先级）

架构与 API 核心文档已全部完成。剩余均属"不影响动手写代码"的补充：

中优先级（Phase 2 前）：
- [ ] `product/00_产品总览.md`（产品层总览）
- [ ] `product/01_模拟炒股_PRD.md`（把三模式从原型固化为 PRD）

低优先级（长远）：
- [ ] `architecture/02_模拟炒股引擎.md`（从旧 `InvestDojo_技术架构方案.md` 迁移）
- [ ] `product/03_财报分析_PRD.md`
- [ ] 因子 DSL 完整 BNF（`api/02_因子库API.md` 附录）
- [ ] 更多 ADR（如"为什么 Node 做编排 Python 做计算"）

---

## 🔧 维护规范

### 更新规则
| 改什么 | 动哪些文档 |
|--------|----------|
| 新增/调整功能 | 先改 `product/*.md` |
| 改架构/换技术栈 | 改 `architecture/*.md` + 写 `adr/` |
| 改接口 | 改 `api/*.md`（必须版本化） |
| 重大决策 | 必写 ADR |

### 命名规范
- 数字前缀保排序（`00_`, `01_`, `02_`...）
- 中文标题空格用下划线
- 每个文档头部必须有：标题 / 最后更新日期 / 状态（Draft/Stable/Deprecated）

### 状态流转
```
Draft  →  Stable  →  Deprecated
            ↓
         可继续 minor 版本迭代
```

### 交叉引用
- 用相对路径：`[文本](./product/02_xxx.md)`
- 章节锚点：`[文本](./xxx.md#章节)`
- 不复制粘贴，引用即可

---

## 🔗 项目根目录其他文档

这些文档目前还在项目根目录，未来可能迁入 `docs/`：

- `InvestDojo_技术架构方案.md` — 模块1（模拟炒股）的初版技术方案
- `investdojo-pitch.html` 系列 — 招商/演示用 HTML
- `investdojo-v2-prototype.html` — 场景重构原型（新盲测模式）
