# 因子库 API 规范

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/factors`
> 维护者：后端 + 算法
> 对应 PRD：[product/02_量化模块_PRD.md#31-因子库p0](../product/02_量化模块_PRD.md#31-因子库p0)

---

## 目录

- [1. 通用约定](#1-通用约定)
- [2. 数据模型](#2-数据模型)
- [3. 公共因子 API](#3-公共因子-api)
- [4. 用户自定义因子 API](#4-用户自定义因子-api)
- [5. 因子计算与查询 API](#5-因子计算与查询-api)
- [6. 因子组合 API](#6-因子组合-api)
- [7. 因子评估与对比 API](#7-因子评估与对比-api)
- [8. 错误码](#8-错误码)
- [9. 变更策略](#9-变更策略)
- [10. SDK 示例](#10-sdk-示例)

---

## 1. 通用约定

### 1.1 版本化
- 所有接口以 `/api/v1/factors` 开头
- 破坏性变更发布新版本 `/api/v2/factors`
- 旧版本至少维护 6 个月过渡期

### 1.2 认证
所有接口需要 Bearer Token（Supabase JWT）：
```http
Authorization: Bearer <supabase_access_token>
```

### 1.3 通用响应格式

**成功**：
```json
{
  "data": { ... },         // 单个对象
  "meta": {                // 可选元信息
    "request_id": "req_abc123",
    "timestamp": "2026-04-28T10:31:00Z"
  }
}
```

**列表**（分页）：
```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "page_size": 20,
    "total": 237,
    "total_pages": 12,
    "has_next": true
  },
  "meta": { ... }
}
```

**错误**：
```json
{
  "error": {
    "code": "FACTOR_NOT_FOUND",
    "message": "Factor with id 'ma_cross_xxx' does not exist",
    "detail": { "factor_id": "ma_cross_xxx" }
  },
  "meta": {
    "request_id": "req_abc123"
  }
}
```

### 1.4 分页参数
- `page` 默认 1
- `page_size` 默认 20，最大 100
- 超出 `total_pages` 返回空列表，不报错

### 1.5 幂等性
- `GET` / `DELETE` 天然幂等
- 写操作（`POST`/`PUT`）通过 `Idempotency-Key` header 保证幂等
  - 建议：UUID v4，24h 内重复请求返回同一结果

### 1.6 速率限制
- 读接口：100 req/min/user
- 写接口：20 req/min/user
- 计算接口：10 req/min/user
- 超限返回 `429 Too Many Requests`，附 `Retry-After` header

### 1.7 时间格式
- 统一 ISO 8601：`2026-04-28T10:31:00Z`
- 日期（不带时间）：`2026-04-28`
- 不使用 Unix timestamp

### 1.8 数值精度
- 价格：保留 4 位小数
- 百分比：保留 4 位小数（如 `0.0234` 表示 2.34%）
- 因子值：JSON `number`，前端自行格式化

---

## 2. 数据模型

### 2.1 `Factor`（因子定义）

```typescript
interface Factor {
  id: string;                      // 全局唯一，如 "ma_cross_20_60"
  name: string;                    // 中文显示名
  name_en?: string;                // 英文名（可选）
  description: string;             // 简短描述
  long_description?: string;       // 详细说明（Markdown）

  category: FactorCategory;        // 分类
  tags: string[];                  // 标签，如 ["趋势", "短线", "高频"]

  formula: string;                 // 因子公式（平台 DSL 或 Python）
  formula_type: 'dsl' | 'python';  // 公式类型

  output_type: 'boolean' | 'scalar' | 'rank';
  output_range?: [number, number]; // 输出范围（对 scalar 有意义）

  lookback_days: number;           // 需要多少天历史数据
  update_frequency: 'daily' | 'realtime';

  version: number;                 // 因子版本号
  owner: string | 'platform';      // 发布者 user_id 或 'platform'
  visibility: 'public' | 'private' | 'unlisted';

  stats?: FactorStats;             // 历史表现统计（可选）

  created_at: string;
  updated_at: string;
  deprecated_at?: string;          // 若已弃用
}

type FactorCategory =
  | 'technical'      // 技术类
  | 'valuation'      // 估值类
  | 'growth'         // 成长类
  | 'sentiment'      // 情绪类
  | 'fundamental'    // 基本面
  | 'macro'          // 宏观
  | 'custom';        // 用户自定义

interface FactorStats {
  total_triggers: number;          // 历史总触发次数
  triggers_by_year: Record<string, number>;
  winrate_5d: number;              // 触发后 5 日胜率
  winrate_20d: number;
  avg_return_5d: number;
  avg_return_20d: number;
  last_triggered_at?: string;
  sample_period: [string, string]; // 统计区间
}
```

### 2.2 `FactorValue`（因子计算结果）

```typescript
interface FactorValue {
  factor_id: string;
  symbol: string;
  date: string;                    // "YYYY-MM-DD"
  value: number | boolean | null;  // null = 未计算/无数据
  computed_at: string;
}
```

### 2.3 `FactorComposite`（因子组合）

```typescript
interface FactorComposite {
  id: string;
  name: string;
  description?: string;
  expression: string;              // 表达式，如 "factor_a AND factor_b > 0.5"
  factor_ids: string[];            // 引用的原子因子
  owner: string;
  visibility: 'public' | 'private';
  created_at: string;
}
```

---

## 3. 公共因子 API

平台内置的 200+ 因子的查询接口。

### 3.1 `GET /api/v1/factors`

获取因子列表（支持筛选/排序/分页）。

**Query Parameters**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `category` | `FactorCategory` | 否 | - | 按分类筛选 |
| `tags` | `string[]` | 否 | - | 逗号分隔多标签，AND 关系 |
| `owner` | `'platform' \| 'user' \| 'all'` | 否 | `all` | 来源筛选 |
| `visibility` | `'public' \| 'private' \| 'all'` | 否 | `public` | 私有需本人或管理员 |
| `search` | `string` | 否 | - | 关键词搜索（名称/描述） |
| `sort` | `string` | 否 | `-updated_at` | 排序字段，`-` 前缀为降序。可选：`updated_at` `winrate_20d` `total_triggers` `usage_count` |
| `page` | `number` | 否 | 1 | |
| `page_size` | `number` | 否 | 20 | |
| `include_stats` | `boolean` | 否 | `true` | 是否包含 `stats` 字段（关闭可显著提速） |

**示例请求**：
```http
GET /api/v1/factors?category=technical&sort=-winrate_20d&page=1&page_size=10
```

**响应 200**：
```json
{
  "data": [
    {
      "id": "ma_cross_20_60",
      "name": "20日均线上穿60日均线",
      "description": "短期均线向上穿越长期均线，经典趋势启动信号",
      "category": "technical",
      "tags": ["趋势", "经典", "中线"],
      "formula": "MA(close,20) cross_up MA(close,60)",
      "formula_type": "dsl",
      "output_type": "boolean",
      "lookback_days": 60,
      "update_frequency": "daily",
      "version": 1,
      "owner": "platform",
      "visibility": "public",
      "stats": {
        "total_triggers": 12340,
        "winrate_5d": 0.547,
        "winrate_20d": 0.582,
        "avg_return_5d": 0.012,
        "avg_return_20d": 0.038,
        "sample_period": ["2014-01-01", "2025-12-31"]
      },
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2026-04-01T00:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 10,
    "total": 80,
    "total_pages": 8,
    "has_next": true
  }
}
```

### 3.2 `GET /api/v1/factors/categories`

获取所有分类及其因子数量。

**响应 200**：
```json
{
  "data": [
    { "category": "technical", "label": "技术类", "count": 80 },
    { "category": "valuation", "label": "估值类", "count": 40 },
    { "category": "growth", "label": "成长类", "count": 40 },
    { "category": "sentiment", "label": "情绪类", "count": 40 },
    { "category": "custom", "label": "用户自定义", "count": 237 }
  ]
}
```

### 3.3 `GET /api/v1/factors/tags`

获取所有标签及其出现次数（用于前端 autocomplete）。

**响应 200**：
```json
{
  "data": [
    { "tag": "趋势", "count": 35 },
    { "tag": "反转", "count": 22 },
    { "tag": "短线", "count": 18 }
  ]
}
```

### 3.4 `GET /api/v1/factors/{id}`

获取单个因子的完整信息。

**Path Parameters**：
- `id`: 因子 ID

**Query Parameters**：
- `include_stats`: 是否包含统计（默认 true）
- `include_examples`: 是否包含最近触发案例（默认 false，取 3 个会慢）

**响应 200**：
```json
{
  "data": {
    "id": "ma_cross_20_60",
    "name": "20日均线上穿60日均线",
    "long_description": "# 因子说明\n\n20 日短期均线向上穿越 60 日长期均线时触发...",
    "category": "technical",
    "formula": "MA(close,20) cross_up MA(close,60)",
    "formula_type": "dsl",
    "output_type": "boolean",
    "lookback_days": 60,
    "version": 1,
    "owner": "platform",
    "stats": { ... },
    "examples": [
      {
        "symbol": "600519",
        "symbol_name": "贵州茅台",
        "trigger_date": "2024-03-15",
        "price_at_trigger": 1720.50,
        "return_20d": 0.082,
        "kline_preview_url": "/api/v1/klines/600519?start=2024-02-15&end=2024-04-15"
      }
    ],
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2026-04-01T00:00:00Z"
  }
}
```

**响应 404**：因子不存在。

### 3.5 `GET /api/v1/factors/{id}/history`

获取因子在指定股票上的历史值时间序列。

**Query Parameters**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `symbols` | `string[]` | 是 | - | 股票代码，逗号分隔，最多 20 个 |
| `start` | `string` | 否 | 1 年前 | 开始日期 |
| `end` | `string` | 否 | 今天 | 结束日期 |
| `format` | `'wide' \| 'long'` | 否 | `long` | 宽表 / 长表 |

**示例请求**：
```http
GET /api/v1/factors/ma_cross_20_60/history?symbols=600519,000001&start=2024-01-01&end=2024-12-31&format=long
```

**响应 200**（long format）：
```json
{
  "data": [
    { "factor_id": "ma_cross_20_60", "symbol": "600519", "date": "2024-01-02", "value": false },
    { "factor_id": "ma_cross_20_60", "symbol": "600519", "date": "2024-01-03", "value": false },
    { "factor_id": "ma_cross_20_60", "symbol": "600519", "date": "2024-01-04", "value": true },
    { "factor_id": "ma_cross_20_60", "symbol": "000001", "date": "2024-01-02", "value": null }
  ],
  "meta": {
    "cached": true,
    "computed_at": "2026-04-28T02:00:00Z"
  }
}
```

**响应 200**（wide format，适合图表渲染）：
```json
{
  "data": {
    "dates": ["2024-01-02", "2024-01-03", "2024-01-04"],
    "symbols": {
      "600519": [false, false, true],
      "000001": [null, null, null]
    }
  }
}
```

### 3.6 `GET /api/v1/factors/{id}/performance`

获取因子的历史表现详细统计（用于详情页的可视化）。

**Query Parameters**：
- `start`: 统计开始日期
- `end`: 统计结束日期
- `universe`: `'hs300'` / `'zz500'` / `'all'`，默认 `all`

**响应 200**：
```json
{
  "data": {
    "summary": {
      "total_triggers": 12340,
      "avg_return_1d": 0.002,
      "avg_return_5d": 0.012,
      "avg_return_20d": 0.038,
      "winrate_1d": 0.521,
      "winrate_5d": 0.547,
      "winrate_20d": 0.582,
      "sharpe": 1.12,
      "max_drawdown": -0.18
    },
    "by_year": [
      { "year": 2024, "triggers": 1234, "winrate_20d": 0.61 },
      { "year": 2023, "triggers": 1180, "winrate_20d": 0.54 }
    ],
    "return_distribution": {
      "bins": [-0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2],
      "counts_5d": [120, 340, 890, 1450, 2100, 2340, 1890, 1120, 680],
      "counts_20d": [210, 380, 560, 890, 1240, 2400, 2890, 1890, 1080]
    },
    "by_market_regime": [
      { "regime": "bull", "winrate_20d": 0.71, "avg_return_20d": 0.058 },
      { "regime": "bear", "winrate_20d": 0.42, "avg_return_20d": 0.012 },
      { "regime": "sideways", "winrate_20d": 0.55, "avg_return_20d": 0.028 }
    ]
  }
}
```

---

## 4. 用户自定义因子 API

### 4.1 `POST /api/v1/factors`

创建一个自定义因子。

**Request Body**：
```json
{
  "name": "我的放量突破",
  "description": "今日放量且突破20日新高",
  "category": "custom",
  "tags": ["短线", "放量"],
  "formula": "volume > MA(volume, 20) * 1.5 AND close > MAX(high, 20)",
  "formula_type": "dsl",
  "output_type": "boolean",
  "lookback_days": 20,
  "visibility": "private"
}
```

**响应 201**：
```json
{
  "data": {
    "id": "custom_u123_001",
    "name": "我的放量突破",
    ...
  }
}
```

**响应 400**：公式语法错误、分类非法等。
```json
{
  "error": {
    "code": "INVALID_FORMULA",
    "message": "Formula parse error at position 42",
    "detail": {
      "position": 42,
      "hint": "Expected operator, got identifier"
    }
  }
}
```

### 4.2 `PUT /api/v1/factors/{id}`

更新自定义因子（仅 owner 可调）。
- 公共因子（owner=platform）不可编辑
- 已被其他用户引用的因子若修改公式，会创建新版本而非覆盖

**Request Body**：同 4.1（部分字段可选）

**响应 200**：返回更新后的因子对象。

### 4.3 `DELETE /api/v1/factors/{id}`

删除自定义因子。
- 已被引用的因子不能删除，需先解除引用
- 已被某个模型训练用过的因子会被标记为 `deprecated`（为了模型可复现性）

**响应 204**：成功。

**响应 409**：冲突。
```json
{
  "error": {
    "code": "FACTOR_IN_USE",
    "message": "This factor is currently used by 3 models",
    "detail": {
      "used_by_models": ["model_abc", "model_def", "model_xyz"]
    }
  }
}
```

### 4.4 `POST /api/v1/factors/{id}/publish`

将私有因子发布为公开（进入因子市场）。

**Request Body**：
```json
{
  "long_description": "这个因子的完整说明...",
  "license": "MIT"
}
```

**响应 200**：发布成功，返回公开 ID（通常和私有 ID 相同）。

### 4.5 `POST /api/v1/factors/validate`

**不保存**，仅校验公式是否合法 + 预览计算结果。

**Request Body**：
```json
{
  "formula": "volume > MA(volume, 20) * 1.5",
  "formula_type": "dsl",
  "preview": {
    "symbols": ["600519"],
    "start": "2024-01-01",
    "end": "2024-03-31"
  }
}
```

**响应 200**（合法）：
```json
{
  "data": {
    "valid": true,
    "parsed_ast": { ... },       // AST 结构，前端可视化用
    "inferred_output_type": "boolean",
    "inferred_lookback": 20,
    "preview_result": [
      { "symbol": "600519", "date": "2024-01-02", "value": false },
      { "symbol": "600519", "date": "2024-01-03", "value": true }
    ],
    "warnings": []
  }
}
```

**响应 200**（不合法，返回 200 但 `valid=false`）：
```json
{
  "data": {
    "valid": false,
    "errors": [
      {
        "code": "UNKNOWN_FUNCTION",
        "message": "Function 'FOO' is not supported",
        "position": 15
      }
    ]
  }
}
```

---

## 5. 因子计算与查询 API

### 5.1 `POST /api/v1/factors/compute`

按需计算因子值（不预存，实时算）。
用于：自定义因子首次使用、参数化因子。

**Request Body**：
```json
{
  "factor_id": "ma_cross_20_60",     // 或 "formula" 二选一
  "formula": null,
  "symbols": ["600519", "000001"],
  "start": "2024-01-01",
  "end": "2024-03-31",
  "cache_ttl_seconds": 7200          // 缓存 2 小时
}
```

**响应 200**：
```json
{
  "data": [
    { "symbol": "600519", "date": "2024-01-02", "value": false },
    ...
  ],
  "meta": {
    "computed_rows": 120,
    "cache_hit": false,
    "compute_time_ms": 340
  }
}
```

**响应 202**（异步，数据量大时）：
```json
{
  "data": {
    "job_id": "job_abc123",
    "status": "pending",
    "estimated_seconds": 30,
    "poll_url": "/api/v1/factors/compute/jobs/job_abc123"
  }
}
```

### 5.2 `GET /api/v1/factors/compute/jobs/{job_id}`

查询异步计算状态。

**响应 200**：
```json
{
  "data": {
    "job_id": "job_abc123",
    "status": "completed",        // pending/running/completed/failed
    "progress": 1.0,
    "result_url": "/api/v1/factors/compute/jobs/job_abc123/result",
    "error": null
  }
}
```

### 5.3 `GET /api/v1/factors/compute/jobs/{job_id}/result`

下载异步计算结果（支持 JSON/CSV/Parquet）。

**Query Parameters**：
- `format`: `'json' | 'csv' | 'parquet'`，默认 `json`

**响应 200**：
- JSON：完整数据
- CSV/Parquet：二进制流，带 `Content-Disposition: attachment`

### 5.4 `POST /api/v1/factors/batch-query`

批量查询多个因子在多个股票上的值。

**Request Body**：
```json
{
  "factor_ids": ["ma_cross_20_60", "rsi_14", "volume_ratio"],
  "symbols": ["600519", "000001"],
  "date": "2024-03-15"            // 单日 或 区间
}
```

**响应 200**（矩阵格式）：
```json
{
  "data": {
    "date": "2024-03-15",
    "factors": ["ma_cross_20_60", "rsi_14", "volume_ratio"],
    "symbols": ["600519", "000001"],
    "values": [
      [true,  52.3, 1.24],
      [false, 48.1, 0.89]
    ]
  }
}
```

---

## 6. 因子组合 API

组合 = 多个因子 + 逻辑表达式（和/或/加权）。

### 6.1 `POST /api/v1/factors/composites`

创建组合。

**Request Body**：
```json
{
  "name": "放量突破+估值合理",
  "description": "技术突破 AND PE 分位 < 70%",
  "expression": "factor('vol_breakout_20') AND factor('pe_percentile', 60) < 0.7",
  "visibility": "private"
}
```

**响应 201**：返回组合对象。

### 6.2 `GET /api/v1/factors/composites/{id}/evaluate`

评估组合在历史上的表现。

**Query Parameters**：同 3.6。

**响应 200**：结构同 3.6，多出一个 `component_contribution` 字段：
```json
{
  "component_contribution": [
    { "factor_id": "vol_breakout_20", "contribution": 0.58 },
    { "factor_id": "pe_percentile",   "contribution": 0.42 }
  ]
}
```

---

## 7. 因子评估与对比 API

### 7.1 `POST /api/v1/factors/compare`

对比多个因子的历史表现。

**Request Body**：
```json
{
  "factor_ids": ["ma_cross_20_60", "ema_cross_12_26", "macd_golden_cross"],
  "start": "2020-01-01",
  "end": "2024-12-31",
  "universe": "hs300",
  "metrics": ["winrate_20d", "avg_return_20d", "sharpe"]
}
```

**响应 200**：
```json
{
  "data": {
    "comparison": [
      { "factor_id": "ma_cross_20_60", "winrate_20d": 0.582, "avg_return_20d": 0.038, "sharpe": 1.12 },
      { "factor_id": "ema_cross_12_26", "winrate_20d": 0.567, "avg_return_20d": 0.034, "sharpe": 0.98 },
      { "factor_id": "macd_golden_cross", "winrate_20d": 0.595, "avg_return_20d": 0.041, "sharpe": 1.23 }
    ],
    "winner_by_metric": {
      "winrate_20d": "macd_golden_cross",
      "avg_return_20d": "macd_golden_cross",
      "sharpe": "macd_golden_cross"
    }
  }
}
```

### 7.2 `GET /api/v1/factors/{id}/correlations`

查询因子与其他因子的相关性（用于避免冗余因子）。

**Query Parameters**：
- `top_n`: 返回最相关的前 N 个，默认 10
- `min_abs_corr`: 最小绝对相关系数，默认 0.3

**响应 200**：
```json
{
  "data": [
    { "factor_id": "ema_cross_12_26", "correlation": 0.82, "overlap_ratio": 0.71 },
    { "factor_id": "ma_cross_10_30",  "correlation": 0.78, "overlap_ratio": 0.68 }
  ]
}
```

---

## 8. 错误码

所有错误码形如 `<CATEGORY>_<CODE>`，HTTP 状态码 + 业务代码双重定位。

### 8.1 HTTP 状态码约定

| 状态码 | 场景 |
|-------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 202 | 异步任务已接受 |
| 204 | 成功，无返回体 |
| 400 | 请求参数错误 |
| 401 | 未认证 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 资源冲突（如重名、被引用） |
| 422 | 业务规则违反（如公式语法错） |
| 429 | 速率限制 |
| 500 | 服务器内部错误 |
| 503 | 服务不可用（如计算服务宕机） |

### 8.2 业务错误码

| Code | HTTP | 说明 |
|------|------|------|
| `FACTOR_NOT_FOUND` | 404 | 因子 ID 不存在 |
| `FACTOR_IN_USE` | 409 | 因子被模型引用，无法删除 |
| `FACTOR_NAME_DUPLICATE` | 409 | 因子名重复 |
| `FACTOR_PERMISSION_DENIED` | 403 | 无权操作此因子 |
| `INVALID_FORMULA` | 422 | 公式语法错误 |
| `UNKNOWN_FUNCTION` | 422 | 公式中使用了未定义函数 |
| `CIRCULAR_DEPENDENCY` | 422 | 因子组合存在循环引用 |
| `COMPUTE_TIMEOUT` | 503 | 计算超时 |
| `SYMBOLS_NOT_ALLOWED` | 400 | 请求的股票代码超出允许范围 |
| `DATE_RANGE_TOO_LARGE` | 400 | 日期范围超过 5 年 |
| `RATE_LIMIT_EXCEEDED` | 429 | 触发速率限制 |

### 8.3 错误响应示例

```json
{
  "error": {
    "code": "INVALID_FORMULA",
    "message": "Formula parse error",
    "detail": {
      "position": 42,
      "line": 1,
      "column": 42,
      "context": "...MA(close, 20) > MA(close, 60",
      "hint": "Missing closing parenthesis"
    }
  },
  "meta": {
    "request_id": "req_abc123",
    "timestamp": "2026-04-28T10:31:00Z"
  }
}
```

---

## 9. 变更策略

### 9.1 破坏性变更

**定义**：改变现有接口的行为、字段含义、错误码等。

**流程**：
1. 在新版本 `/api/v2/factors` 发布
2. 旧版本响应中增加 `Deprecation` 和 `Sunset` header
3. 至少 6 个月过渡期
4. 过渡期内文档明确标注新旧差异

### 9.2 非破坏性变更

**允许直接在 v1 发布**：
- 新增字段（前端应忽略未知字段）
- 新增错误码
- 新增可选参数（有默认值）
- 新增接口

### 9.3 废弃通知

被废弃的接口/字段在响应中加 header：
```http
Deprecation: true
Sunset: Sat, 28 Oct 2026 00:00:00 GMT
Link: </api/v2/factors>; rel="successor-version"
```

---

## 10. SDK 示例

### 10.1 TypeScript SDK（前端）

```typescript
import { InvestDojoClient } from '@investdojo/sdk';

const client = new InvestDojoClient({ token: '...' });

// 浏览因子
const { data, pagination } = await client.factors.list({
  category: 'technical',
  sort: '-winrate_20d',
  page: 1,
});

// 查看详情
const factor = await client.factors.get('ma_cross_20_60', { include_examples: true });

// 创建自定义因子
const myFactor = await client.factors.create({
  name: '我的放量突破',
  formula: 'volume > MA(volume, 20) * 1.5',
  formula_type: 'dsl',
  output_type: 'boolean',
  lookback_days: 20,
  category: 'custom',
  visibility: 'private',
});

// 校验公式（不保存）
const validation = await client.factors.validate({
  formula: 'volume > MA(volume, 20) * 1.5',
  formula_type: 'dsl',
});

// 计算因子值
const values = await client.factors.compute({
  factor_id: 'ma_cross_20_60',
  symbols: ['600519', '000001'],
  start: '2024-01-01',
  end: '2024-03-31',
});
```

### 10.2 Python SDK（Notebook）

```python
from investdojo import Client

client = Client(token='...')

# 浏览
factors = client.factors.list(category='technical', sort='-winrate_20d')

# 详情
factor = client.factors.get('ma_cross_20_60')
print(factor.formula)
print(factor.stats.winrate_20d)

# 计算（返回 DataFrame）
df = client.factors.compute(
    factor_id='ma_cross_20_60',
    symbols=['600519', '000001'],
    start='2024-01-01',
    end='2024-03-31',
    format='dataframe',  # 直接返回 pandas DataFrame
)
df.head()

# 创建
my_factor = client.factors.create(
    name='我的放量突破',
    formula='volume > MA(volume, 20) * 1.5',
    output_type='boolean',
)
```

---

## 11. DSL 公式语言速览（补充文档）

完整语法见 [附录 A](#附录-a-因子-dsl-完整语法)（TBD，下个版本补）。

### 11.1 支持的函数（摘要）

```
# 均值/标准差
MA(series, period)
EMA(series, period)
STD(series, period)

# 极值
MAX(series, period)
MIN(series, period)
ARGMAX(series, period)

# 变化
DIFF(series, period)     # 差分
PCT(series, period)      # 涨跌幅
RANK(series)             # 横截面排名

# 逻辑
cross_up(a, b)           # a 上穿 b
cross_down(a, b)
AND, OR, NOT

# 技术指标快捷函数
RSI(period)
MACD()
BOLL(period, k)
```

### 11.2 内置字段

```
open, high, low, close, volume, turnover
amount                    # 成交额
preclose                  # 前收盘价
pct_change                # 涨跌幅
```

### 11.3 示例

```
# 经典 MA 金叉
MA(close, 20) cross_up MA(close, 60)

# 放量 + 突破
volume > MA(volume, 20) * 1.5 AND close > MAX(high, 20)

# 横截面动量排名 > 0.8
RANK(PCT(close, 20)) > 0.8

# RSI 超卖后反弹
RSI(14) < 30 AND close > close.shift(1)
```

---

## 12. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版，完整因子库 API |

---

## 附录 A. 因子 DSL 完整语法（TBD）

（下个版本补全 BNF 规范）

## 附录 B. 常见场景 Recipe（TBD）

- 如何造一个行业相对强度因子？
- 如何把多个因子组合为打分模型？
- 如何避免因子之间高度共线性？
