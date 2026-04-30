# 数据 API

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/data`
> 维护者：后端
> 对应架构：[architecture/01_数据层.md](../architecture/01_数据层.md)（TODO）

---

## 目录

- [1. 概述](#1-概述)
- [2. 数据模型](#2-数据模型)
- [3. 股票元数据 API](#3-股票元数据-api)
- [4. K 线 API](#4-k-线-api)
- [5. 新闻 API](#5-新闻-api)
- [6. 财报与基本面 API](#6-财报与基本面-api)
- [7. 市场快照 API](#7-市场快照-api)
- [8. 场景 API](#8-场景-api)
- [9. 错误码](#9-错误码)

---

## 1. 概述

数据 API 是所有其他模块的**底层依赖**，提供：
- 股票元数据（代码、名称、行业、上市日期）
- K 线行情（日 K + 5m K，未来扩展到 1m/tick）
- 新闻事件流（按时间严格排序）
- 财务报表（季度）
- 市场快照（指数、板块、资金流）
- 历史情景场景（经典关卡/盲测种子）

### 1.1 核心设计原则

**严格的时间语义**：所有接口都支持 `as_of` 参数，用于回测和联动模式的防未来函数。传入 `as_of='2020-03-15'`，系统只会返回该时间点之前的数据。

**严格的分页契约**：任何可能返回超过 1000 行的接口都必须使用分页（延续因子库 API 的分页规范）。

**Unix 时间戳转换**：分钟级 K 线存储为 `timestamptz`，API 返回时统一转为 ISO 8601，前端决定是否转换为 Unix。

### 1.2 通用查询参数

所有"按时间查询"的接口都支持：

| 参数 | 类型 | 说明 |
|------|------|------|
| `start` | `string` | 开始日期/时间（含） |
| `end` | `string` | 结束日期/时间（含） |
| `as_of` | `string` | 截止时间（严格小于），用于防未来函数 |

---

## 2. 数据模型

### 2.1 `Symbol`（股票元数据）

```typescript
interface Symbol {
  code: string;                 // "600519"
  market: 'SH' | 'SZ' | 'BJ';   // 交易所
  name: string;                 // "贵州茅台"
  short_name?: string;          // "茅台"
  industry: string;             // "白酒"
  industry_level2?: string;     // "食品饮料"
  listed_at: string;            // "2001-08-27"
  delisted_at?: string;         // 若已退市
  total_share: number;          // 总股本（亿）
  float_share: number;          // 流通股本（亿）
  status: 'normal' | 'suspended' | 'delisted';
  tags?: string[];              // ["沪深300", "中证500", "红利"]
}
```

### 2.2 `KLine`（K 线）

```typescript
interface KLine {
  symbol: string;
  timeframe: '1m' | '5m' | '15m' | '1h' | '1d' | '1w' | '1M';
  dt: string;                   // ISO 8601，分钟级带时间，日级 "YYYY-MM-DD"
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;               // 成交量（股）
  turnover: number;             // 成交额（元）
  pre_close: number | null;
  change: number | null;
  change_percent: number | null;
  adj_factor?: number;          // 复权因子（用于前复权/后复权切换）
}
```

### 2.3 `NewsItem`（新闻）

```typescript
interface NewsItem {
  id: string;
  published_at: string;         // ISO 8601
  title: string;
  body?: string;                // 正文
  source: string;               // "新华社" / "证券时报"
  category: 'macro' | 'policy' | 'industry' | 'company' | 'market' | 'international';
  sentiment?: 'positive' | 'neutral' | 'negative';
  sentiment_score?: number;     // -1 ~ 1
  related_symbols?: string[];   // 关联股票
  related_industries?: string[];
  tags?: string[];
  url?: string;
}
```

### 2.4 `Fundamental`（财报）

```typescript
interface Fundamental {
  symbol: string;
  report_date: string;          // 财报期 "2024-Q1" / "2024-H1" / "2024-Q3" / "2024"
  announce_date: string;        // 公告日期
  statement: 'income' | 'balance' | 'cashflow';
  data: {
    // income statement
    revenue?: number;
    gross_profit?: number;
    operating_profit?: number;
    net_profit?: number;
    // balance sheet
    total_assets?: number;
    total_liabilities?: number;
    equity?: number;
    // cash flow
    operating_cashflow?: number;
    investing_cashflow?: number;
    financing_cashflow?: number;
  };
  derived: {                    // 派生指标（自动计算）
    roe?: number;               // 净资产收益率
    roa?: number;
    gross_margin?: number;
    net_margin?: number;
    eps?: number;               // 每股收益
    bps?: number;               // 每股净资产
  };
}
```

### 2.5 `MarketSnapshot`（市场快照）

```typescript
interface MarketSnapshot {
  date: string;
  indexes: {
    [code: string]: {           // "000001" 上证、"399001" 深证成指、"000300" 沪深300
      close: number;
      change_percent: number;
      volume: number;
    };
  };
  north_capital: number;        // 北向资金净流入（亿）
  money_flow: {
    main_net: number;           // 主力净流入
    super_large_net: number;
    large_net: number;
    medium_net: number;
    small_net: number;
  };
  advance_decline: {
    advance: number;            // 上涨数
    decline: number;
    unchanged: number;
    limit_up: number;           // 涨停
    limit_down: number;
  };
  top_industries: Array<{       // 板块涨幅前 5
    industry: string;
    change_percent: number;
  }>;
}
```

### 2.6 `Scenario`（场景）

```typescript
interface Scenario {
  id: string;
  name: string;                  // "新冠疫情暴跌"
  description: string;
  mode: 'classic' | 'blind' | 'custom';
  start_date: string;
  end_date: string;
  symbols: string[];             // 关卡预设的股票池
  difficulty?: 'easy' | 'medium' | 'hard';
  tags?: string[];
  // 仅盲测揭晓后展示
  reveal?: {
    title: string;
    summary: string;
    key_events: Array<{ date: string; title: string }>;
  };
  meta?: {
    index_return?: number;       // 期间指数涨跌幅
    max_drawdown?: number;
    volatility?: number;
  };
}
```

---

## 3. 股票元数据 API

### 3.1 `GET /api/v1/data/symbols`

查询股票列表。

**Query Parameters**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `codes` | `string[]` | 否 | 逗号分隔，如 `"600519,000001"` |
| `market` | `string` | 否 | `SH`/`SZ`/`BJ` |
| `industry` | `string` | 否 | 行业筛选 |
| `status` | `string` | 否 | 默认 `normal` |
| `universe` | `string` | 否 | `hs300`/`zz500`/`zz1000`/`all` |
| `search` | `string` | 否 | 按名称/代码模糊搜索 |
| `page`, `page_size` | `number` | 否 | 分页 |

**响应 200**：
```json
{
  "data": [
    {
      "code": "600519",
      "market": "SH",
      "name": "贵州茅台",
      "industry": "白酒",
      "listed_at": "2001-08-27",
      "total_share": 12.56,
      "float_share": 12.56,
      "status": "normal",
      "tags": ["沪深300", "红利"]
    }
  ],
  "pagination": { ... }
}
```

### 3.2 `GET /api/v1/data/symbols/{code}`

获取单只股票详情。

**响应 200**：返回单个 `Symbol` 对象。

### 3.3 `GET /api/v1/data/industries`

获取行业分类列表。

**Query Parameters**：
- `level`: `1` 或 `2`（一级/二级行业）

**响应 200**：
```json
{
  "data": [
    { "name": "白酒", "level": 2, "parent": "食品饮料", "symbol_count": 18 },
    { "name": "银行", "level": 1, "symbol_count": 42 }
  ]
}
```

---

## 4. K 线 API

### 4.1 `GET /api/v1/data/klines`

查询 K 线数据（**最核心接口，调用量最高**）。

**Query Parameters**：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `symbols` | `string[]` | 是 | - | 股票代码，逗号分隔，单次最多 50 个 |
| `timeframe` | `string` | 否 | `1d` | `1m`/`5m`/`15m`/`1h`/`1d`/`1w`/`1M` |
| `start` | `string` | 否 | 1 年前 | 开始日期 |
| `end` | `string` | 否 | 今天 | 结束日期 |
| `as_of` | `string` | 否 | - | 防未来函数截断，严格小于此时间 |
| `adjust` | `string` | 否 | `qfq` | `none`/`qfq` 前复权 / `hfq` 后复权 |
| `format` | `string` | 否 | `long` | `long` 长表 / `wide` 宽表 |
| `fields` | `string[]` | 否 | 全部 | 按需字段，逗号分隔 |

**示例请求**：
```http
GET /api/v1/data/klines?symbols=600519,000001&timeframe=1d&start=2024-01-01&end=2024-03-31&as_of=2024-03-15
```

**响应 200**（long format）：
```json
{
  "data": [
    {
      "symbol": "600519",
      "timeframe": "1d",
      "dt": "2024-01-02",
      "open": 1712.00,
      "high": 1723.88,
      "low": 1701.20,
      "close": 1720.50,
      "volume": 2340000,
      "turnover": 4020350000.00,
      "pre_close": 1705.30,
      "change": 15.20,
      "change_percent": 0.0089
    }
  ],
  "meta": {
    "adjust": "qfq",
    "as_of_applied": "2024-03-15",
    "total_rows": 52
  }
}
```

**响应 200**（wide format，适合前端渲染图表）：
```json
{
  "data": {
    "dates": ["2024-01-02", "2024-01-03", ...],
    "symbols": {
      "600519": {
        "open":  [1712.00, 1720.50, ...],
        "high":  [1723.88, ...],
        "low":   [1701.20, ...],
        "close": [1720.50, ...],
        "volume": [2340000, ...]
      },
      "000001": { ... }
    }
  }
}
```

### 4.2 `GET /api/v1/data/klines/latest`

查询最新一根 K 线（实时行情）。

**Query Parameters**：
- `symbols`: 股票代码列表
- `timeframe`: 默认 `1d`

**响应 200**：返回 `KLine[]`。

### 4.3 `POST /api/v1/data/klines/batch`

批量查询 K 线（请求 body 较大时使用 POST）。

**Request Body**：
```json
{
  "requests": [
    { "symbols": ["600519"], "timeframe": "1d", "start": "2024-01-01", "end": "2024-03-31" },
    { "symbols": ["000001"], "timeframe": "5m", "start": "2024-03-01", "end": "2024-03-15" }
  ],
  "as_of": "2024-03-15"
}
```

**响应 200**：
```json
{
  "data": [
    { "request_index": 0, "klines": [ ... ] },
    { "request_index": 1, "klines": [ ... ] }
  ]
}
```

---

## 5. 新闻 API

### 5.1 `GET /api/v1/data/news`

查询新闻流（按时间倒序）。

**Query Parameters**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `symbols` | `string[]` | 否 | 关联股票 |
| `industries` | `string[]` | 否 | 关联行业 |
| `categories` | `string[]` | 否 | `macro`/`policy`/... |
| `sentiment` | `string` | 否 | `positive`/`negative`/`neutral` |
| `start` | `string` | 否 | |
| `end` | `string` | 否 | |
| `as_of` | `string` | 否 | 防未来函数 |
| `search` | `string` | 否 | 关键词全文搜索 |
| `include_body` | `boolean` | 否，默认 `false` | 是否返回正文（节省带宽） |
| `sort` | `string` | 否 | 默认 `-published_at` |
| `page`, `page_size` | | | 分页 |

**响应 200**：
```json
{
  "data": [
    {
      "id": "news_abc",
      "published_at": "2024-01-23T15:30:00Z",
      "title": "央行宣布降准 0.5 个百分点",
      "source": "新华社",
      "category": "policy",
      "sentiment": "positive",
      "sentiment_score": 0.65,
      "related_symbols": ["600519", "000001"],
      "tags": ["货币政策", "降准"]
    }
  ],
  "pagination": { ... }
}
```

### 5.2 `GET /api/v1/data/news/{id}`

获取单条新闻详情（含正文）。

### 5.3 `GET /api/v1/data/news/timeline`

按时间粒度聚合新闻（用于盲测的新闻时间线）。

**Query Parameters**：
- `start`, `end`: 范围
- `granularity`: `day` / `hour`
- `symbols`: 关联股票

**响应 200**：
```json
{
  "data": [
    {
      "bucket": "2024-01-23",
      "count": 12,
      "top_news": [ /* 精选 3 条 */ ]
    }
  ]
}
```

---

## 6. 财报与基本面 API

### 6.1 `GET /api/v1/data/fundamentals/{symbol}`

查询财报数据。

**Query Parameters**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `statement` | `string` | `income`/`balance`/`cashflow`/`all` |
| `periods` | `string[]` | 如 `"2024-Q1,2023-Q4"` |
| `start`, `end` | | 日期范围（按公告日期） |
| `as_of` | | 防未来函数（只返回公告日期 < as_of 的财报） |
| `limit` | `number` | 最近 N 期，默认 8 |

**响应 200**：
```json
{
  "data": [
    {
      "symbol": "600519",
      "report_date": "2024-Q1",
      "announce_date": "2024-04-26",
      "statement": "income",
      "data": {
        "revenue": 46493000000.00,
        "net_profit": 24065000000.00
      },
      "derived": {
        "net_margin": 0.5177,
        "eps": 19.15
      }
    }
  ]
}
```

### 6.2 `GET /api/v1/data/fundamentals/{symbol}/timeline`

财报时间线（所有历史财报概览）。

**响应 200**：
```json
{
  "data": [
    { "period": "2024-Q1", "announce_date": "2024-04-26", "revenue_yoy": 0.1842, "profit_yoy": 0.1569 },
    { "period": "2023-Annual", "announce_date": "2024-04-03", "revenue_yoy": 0.1812, "profit_yoy": 0.1919 }
  ]
}
```

---

## 7. 市场快照 API

### 7.1 `GET /api/v1/data/market/snapshot`

查询某日市场快照。

**Query Parameters**：
- `date`: 日期，默认今天
- `include_industries`: 是否包含板块数据，默认 `true`

**响应 200**：返回 `MarketSnapshot` 对象。

### 7.2 `GET /api/v1/data/market/indexes`

查询指数 K 线。

**Query Parameters**：与 4.1 相同，`symbols` 传指数代码（`000001` 上证、`399001` 深证成指、`000300` 沪深 300）。

**响应 200**：同 4.1。

### 7.3 `GET /api/v1/data/market/money-flow`

查询资金流向时序。

**Query Parameters**：
- `symbols` 或 `industries`（二选一）
- `start`, `end`
- `granularity`: `day` / `5min`

---

## 8. 场景 API

### 8.1 `GET /api/v1/data/scenarios`

查询历史情景列表。

**Query Parameters**：
- `mode`: `classic` / `blind` / `custom`
- `difficulty`
- `tags`

**响应 200**：
```json
{
  "data": [
    {
      "id": "covid_2020",
      "name": "新冠疫情暴跌",
      "mode": "classic",
      "start_date": "2020-01-02",
      "end_date": "2020-06-30",
      "symbols": ["000001", "600519", "300750"],
      "difficulty": "hard",
      "meta": { "index_return": -0.115, "max_drawdown": -0.182 }
    }
  ]
}
```

### 8.2 `GET /api/v1/data/scenarios/{id}`

场景详情。**盲测模式下 `reveal` 字段不返回**，必须等会话结束才能取。

### 8.3 `POST /api/v1/data/scenarios/generate`

生成一个随机盲测场景。

**Request Body**：
```json
{
  "duration_days": 60,
  "strategy": "random" | "event" | "calm",
  "universe": "hs300",
  "n_symbols": 3,
  "seed": "a7f42b9",
  "blind_options": {
    "hide_symbol_name": true,
    "hide_date": true,
    "hide_industry": false
  }
}
```

**响应 201**：
```json
{
  "data": {
    "id": "blind_a7f42b9",
    "mode": "blind",
    "start_date": "2020-02-14",    // 仅后端可见，前端通过会话 API 访问
    "end_date": "2020-05-05",
    "symbols": ["000001", "600519", "300750"],
    "blind_options": { ... }
    // reveal 字段不返回
  }
}
```

### 8.4 `GET /api/v1/data/scenarios/{id}/reveal`

获取盲测场景的揭晓信息。**必须在会话结束后才能调用**，否则返回 403。

**响应 200**：
```json
{
  "data": {
    "title": "新冠疫情暴跌",
    "summary": "2020 年 1~6 月 A 股经历新冠冲击，上证 -11.5%",
    "key_events": [
      { "date": "2020-01-23", "title": "武汉封城" },
      { "date": "2020-03-23", "title": "美股历史熔断 3 次后触底" }
    ],
    "revealed_symbols": {
      "stock_A": { "code": "600519", "name": "贵州茅台" },
      "stock_B": { "code": "000001", "name": "平安银行" },
      "stock_C": { "code": "300750", "name": "宁德时代" }
    }
  }
}
```

---

## 9. 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `DATA_SYMBOL_NOT_FOUND` | 404 | 股票代码不存在 |
| `DATA_SCENARIO_NOT_FOUND` | 404 | 场景不存在 |
| `DATA_REVEAL_NOT_ALLOWED` | 403 | 会话未结束，不允许揭晓 |
| `DATA_DATE_RANGE_TOO_LARGE` | 400 | 日期范围超过限制（分钟级 ≤ 6 月 / 日级 ≤ 10 年） |
| `DATA_SYMBOLS_TOO_MANY` | 400 | 股票数量超过 50 |
| `DATA_TIMEFRAME_INVALID` | 400 | 不支持的 timeframe |
| `DATA_UNIVERSE_INVALID` | 400 | 未知的 universe |

---

## 10. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版 |
