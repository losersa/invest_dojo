# 会话 API（联动模式核心）

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/sessions`
> WebSocket URL：`wss://api.investdojo.com/ws/v1/sessions/{id}`
> 维护者：全栈
> 对应 PRD：[product/02_量化模块_PRD.md#35-联动模式p0-p1](../product/02_量化模块_PRD.md)
> 对应架构：[architecture/04_联动机制.md](../architecture/04_联动机制.md)（TODO）

---

## 目录

- [1. 概述](#1-概述)
- [2. 数据模型](#2-数据模型)
- [3. 会话生命周期 API](#3-会话生命周期-api)
- [4. 时钟推进与数据广播](#4-时钟推进与数据广播)
- [5. 交易与订单 API](#5-交易与订单-api)
- [6. 四种联动模式专用 API](#6-四种联动模式专用-api)
  - [6.1 模式 ①：副驾](#61-模式-副驾)
  - [6.2 模式 ②：PK](#62-模式-pk)
  - [6.3 模式 ③：Copilot](#63-模式-copilot)
  - [6.4 模式 ④：数据闭环](#64-模式-数据闭环)
- [7. WebSocket 协议](#7-websocket-协议)
- [8. 复盘与对账 API](#8-复盘与对账-api)
- [9. 错误码](#9-错误码)

---

## 1. 概述

### 1.1 会话 = 一局盲测/PK/Copilot

每一次用户进入模拟交易都会创建一个会话（Session）。会话持有：
- **时钟**（模拟时间，不是真实时间）
- **参与者**（人、模型、观察者）
- **投资组合**（每个参与者一份）
- **事件日志**（每次 tick/下单/信号）

### 1.2 四种模式

| 模式 | `mode` | 参与者 | 谁下单 |
|------|--------|-------|-------|
| **经典 / Solo** | `solo` | 仅用户 | 用户 |
| **① 副驾** | `copilot_observer` | 用户 + 模型（观察） | 用户 |
| **② PK** | `pk` | 用户 + 1 个模型 | 双方独立下单 |
| **③ Copilot** | `copilot_interactive` | 用户 + 模型（协作） | 用户采纳/拒绝模型建议 |

> 模式 ④ **数据闭环**不是独立 session 模式，而是所有 session 都默认开启的"数据收集"能力。

### 1.3 关键设计约束

- **时钟严格单调**：`current_ts` 只能向前推进
- **数据严格防未来**：所有参与者的查询都自动注入会话时钟
- **模型响应超时**：模型每次决策最多 5 秒，超时视为持有
- **会话不可回档**：一旦关闭就不能重开，要重玩需新建

---

## 2. 数据模型

### 2.1 `Session`（会话）

```typescript
interface Session {
  id: string;
  user_id: string;
  scenario_id: string;
  mode: 'solo' | 'copilot_observer' | 'pk' | 'copilot_interactive';

  participants: Participant[];

  clock: {
    start_ts: string;           // 场景开始时间
    end_ts: string;
    current_ts: string;         // 当前时钟
    total_ticks: number;
    current_tick: number;
    tick_granularity: '5m' | '1h' | '1d';
  };

  initial_capital: number;

  status: 'initializing' | 'running' | 'paused' | 'finished' | 'abandoned';

  blind_options?: {             // 盲测选项
    hide_symbol_name: boolean;
    hide_date: boolean;
    hide_industry: boolean;
    hide_fundamentals: boolean;
    news_title_only: boolean;
  };

  data_collection_opt_in: boolean;  // 模式 ④ 是否开启

  created_at: string;
  started_at?: string;
  finished_at?: string;
}

interface Participant {
  type: 'human' | 'model';
  id: string;                   // user_id 或 model_id
  model_version?: string;
  display_name?: string;
  portfolio: Portfolio;
  stats: {
    total_return?: number;
    trade_count: number;
    last_action_at?: string;
  };
}
```

### 2.2 `Portfolio`（组合）

```typescript
interface Portfolio {
  participant_id: string;
  cash: number;
  total_value: number;
  total_return: number;
  positions: Position[];
  max_drawdown: number;
  updated_at: string;
}

interface Position {
  symbol: string;
  symbol_display?: string;      // 盲测模式下为 "股票A"
  quantity: number;
  avg_price: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_pct: number;
  available_quantity: number;   // T+1 可卖
}
```

### 2.3 `SessionEvent`（事件）

```typescript
interface SessionEvent {
  id: string;
  session_id: string;
  ts: string;                   // 会话时钟
  real_ts: string;              // 真实墙钟

  actor_type: 'human' | 'model' | 'system';
  actor_id: string;

  event_type:
    | 'tick'                    // 时钟推进
    | 'order_placed'
    | 'order_filled'
    | 'signal_generated'        // 模型信号
    | 'model_suggestion'        // Copilot 建议
    | 'suggestion_accepted'
    | 'suggestion_rejected'
    | 'session_started'
    | 'session_paused'
    | 'session_resumed'
    | 'session_finished';

  payload: Record<string, unknown>;
}
```

---

## 3. 会话生命周期 API

### 3.1 `POST /api/v1/sessions`

创建新会话。

**Request Body**：
```json
{
  "scenario_id": "covid_2020",
  "mode": "copilot_observer",
  "initial_capital": 100000,
  "participants": {
    "models": [
      { "model_id": "model_platform_momentum_v2" }
    ]
  },
  "blind_options": {
    "hide_symbol_name": true,
    "hide_date": true
  },
  "data_collection_opt_in": true,
  "tick_granularity": "5m"
}
```

**响应 201**：
```json
{
  "data": {
    "session_id": "sess_abc123",
    "status": "initializing",
    "websocket_url": "wss://api.investdojo.com/ws/v1/sessions/sess_abc123",
    "clock": {
      "start_ts": "2020-01-02T09:30:00Z",
      "end_ts": "2020-06-30T15:00:00Z",
      "current_ts": "2020-01-02T09:30:00Z",
      "total_ticks": 5856,
      "current_tick": 0,
      "tick_granularity": "5m"
    }
  }
}
```

### 3.2 `GET /api/v1/sessions/{id}`

获取会话详情。

**Query Parameters**：
- `include_events`: 是否返回最近事件，默认 false

**响应 200**：返回 `Session` 对象。

### 3.3 `POST /api/v1/sessions/{id}/start`

从 `initializing` 转到 `running`。

**响应 200**：返回更新后的 Session。

### 3.4 `POST /api/v1/sessions/{id}/pause`

暂停（仅 `running` 可用）。

### 3.5 `POST /api/v1/sessions/{id}/resume`

恢复（仅 `paused` 可用）。

### 3.6 `POST /api/v1/sessions/{id}/finish`

结束会话（无论是否到 end_ts）。

**Request Body**：
```json
{
  "reason": "user_ended" | "time_ended" | "abandoned"
}
```

**响应 200**：
```json
{
  "data": {
    "session": { ... },
    "debrief_url": "/api/v1/sessions/sess_abc123/debrief"
  }
}
```

### 3.7 `GET /api/v1/sessions`

查询用户的会话列表。

**Query Parameters**：
- `status`: 筛选
- `mode`: 筛选
- `scenario_id`: 筛选
- `sort`: `-created_at`（默认）
- `page`, `page_size`

---

## 4. 时钟推进与数据广播

### 4.1 `POST /api/v1/sessions/{id}/tick`

推进时钟一步。

**Request Body**：
```json
{
  "steps": 1,                   // 推进多少 tick，默认 1
  "target_ts": null             // 或直接跳到某时间
}
```

**响应 200**：
```json
{
  "data": {
    "clock": {
      "current_ts": "2020-01-02T09:35:00Z",
      "current_tick": 1
    },
    "new_data": {
      "klines": [ /* 刚刚推出的 K 线 */ ],
      "news": [ /* 这个时间段内发布的新闻 */ ]
    },
    "signals": [ /* 订阅的模型推出的信号 */ ],
    "portfolio_updates": [
      { "participant_id": "...", "total_value": 100820 }
    ]
  }
}
```

> 通常前端不直接调用此 REST 接口，而是走 WebSocket。本接口主要用于测试/管理。

### 4.2 `GET /api/v1/sessions/{id}/data`

查询会话内当前可见的数据（自动应用 as_of = current_ts）。

**Query Parameters**：
- `type`: `klines` / `news` / `fundamentals`
- 其他同数据 API 的 Query Parameters

**响应 200**：与 [数据 API](./01_数据API.md) 格式一致，但已自动截断到 `current_ts`。

---

## 5. 交易与订单 API

### 5.1 `POST /api/v1/sessions/{id}/orders`

下单（人类参与者）。

**Request Body**：
```json
{
  "symbol": "600519",
  "side": "BUY",
  "quantity": 100,
  "price": 1720.50,
  "order_type": "limit" | "market",
  "reason": "看好白酒板块回暖",   // 可选，用户备注
  "triggered_by": null           // 或 "model_suggestion:xxx" 若是采纳模型建议
}
```

**响应 201**：
```json
{
  "data": {
    "order_id": "ord_abc",
    "status": "filled",          // filled/partial/rejected
    "filled_price": 1720.50,
    "filled_quantity": 100,
    "commission": 5.16,
    "portfolio_after": { ... }
  }
}
```

**响应 400/422**：
```json
{
  "error": {
    "code": "ORDER_INSUFFICIENT_CASH",
    "detail": { "required": 172050, "available": 150000 }
  }
}
```

### 5.2 `POST /api/v1/sessions/{id}/orders/models`

模型下单（由 Session Orchestrator 代模型调用，非对外接口）。

**Request Body**：
```json
{
  "model_participant_id": "model_abc",
  "orders": [
    { "symbol": "600519", "side": "BUY", "quantity": 100, "signal_id": "sig_xxx" }
  ]
}
```

### 5.3 `GET /api/v1/sessions/{id}/orders`

查询订单历史。

**Query Parameters**：
- `participant_id`: 按参与者筛选
- `symbol`: 按股票筛选
- `status`: `filled`/`partial`/`rejected`/`pending`
- `start`, `end`: 按会话时钟筛选

---

## 6. 四种联动模式专用 API

### 6.1 模式 ①：副驾

#### 6.1.1 `POST /api/v1/sessions/{id}/copilot/attach-model`

在会话中附加一个副驾模型。

**Request Body**：
```json
{
  "model_id": "model_platform_momentum_v2",
  "model_version": "v2.2025-Q2",
  "include_explanation": true
}
```

**响应 200**：
```json
{
  "data": {
    "subscription_id": "sub_abc",
    "attached_at": "..."
  }
}
```

#### 6.1.2 `POST /api/v1/sessions/{id}/copilot/detach-model`

移除副驾模型。

#### 6.1.3 `GET /api/v1/sessions/{id}/copilot/latest-signals`

主动拉取最新信号（通常走 WebSocket，本接口为兜底）。

**响应 200**：返回 `Signal[]`。

---

### 6.2 模式 ②：PK

#### 6.2.1 `POST /api/v1/sessions` 创建 PK 会话

PK 模式要求 `participants.models` 有且仅有一个模型，两者初始资金相同。

```json
{
  "scenario_id": "...",
  "mode": "pk",
  "initial_capital": 100000,
  "participants": {
    "models": [
      { "model_id": "model_my_lstm_v1", "decision_timeout_seconds": 5 }
    ]
  },
  "pk_options": {
    "fair_play_strict": true,    // 强制模型每 tick 必须决策
    "same_universe": true,
    "same_rules": true
  }
}
```

#### 6.2.2 `GET /api/v1/sessions/{id}/pk/standings`

查询实时对账。

**响应 200**：
```json
{
  "data": {
    "clock": { "current_ts": "...", "progress": 0.34 },
    "standings": [
      {
        "participant_type": "human",
        "participant_id": "user_xxx",
        "total_return": 0.048,
        "rank": 2
      },
      {
        "participant_type": "model",
        "participant_id": "model_my_lstm_v1",
        "total_return": 0.071,
        "rank": 1
      }
    ],
    "decision_consistency": 0.47,   // 决策一致度
    "recent_divergences": [
      {
        "ts": "...",
        "symbol": "600519",
        "human_action": "SELL",
        "model_action": "BUY"
      }
    ]
  }
}
```

#### 6.2.3 `GET /api/v1/sessions/{id}/pk/divergences`

查询人机分歧点。

**Query Parameters**：
- `page`, `page_size`
- `symbol`: 按股票筛选

**响应 200**：
```json
{
  "data": [
    {
      "ts": "2020-02-28T09:30:00Z",
      "symbol": "600519",
      "human": { "action": "SELL", "qty": 100 },
      "model": { "action": "HOLD" },
      "future_return_5d_after": 0.078,
      "verdict": "model_right"
    }
  ],
  "pagination": { ... }
}
```

---

### 6.3 模式 ③：Copilot

#### 6.3.1 `POST /api/v1/sessions/{id}/copilot/suggestion`

请求模型建议（用户点击"买入"前触发）。

**Request Body**：
```json
{
  "symbol": "600519",
  "proposed_action": { "side": "BUY", "quantity": 100, "price": 1720.50 }
}
```

**响应 200**：
```json
{
  "data": {
    "suggestion_id": "sug_abc",
    "model_signal": {
      "action": "BUY",
      "confidence": 0.72,
      "target_position": 0.3,
      "suggested_quantity": 100
    },
    "divergence": {
      "action_match": true,
      "quantity_match": true,
      "notes": "模型建议相同方向，数量一致"
    },
    "context": {
      "market_regime": "panic"   // 当前市场状态：panic/calm/greed
    }
  }
}
```

#### 6.3.2 `POST /api/v1/sessions/{id}/copilot/suggestion/{sid}/decide`

用户决策。

**Request Body**：
```json
{
  "decision": "accept" | "adjust" | "reject",
  "final_order": {               // 最终下单参数
    "symbol": "600519",
    "side": "BUY",
    "quantity": 50,              // 如果 adjust
    "price": 1720.50
  }
}
```

**响应 200**：
```json
{
  "data": {
    "decision_logged": true,
    "order_placed": {
      "order_id": "ord_xxx"
    }
  }
}
```

#### 6.3.3 `GET /api/v1/sessions/{id}/copilot/decisions`

查询本会话的所有 Copilot 决策日志。

#### 6.3.4 `GET /api/v1/users/me/copilot/insights`

跨会话的个性化洞察（累计 40+ 会话后才有意义）。

**响应 200**：
```json
{
  "data": {
    "based_on_sessions": 42,
    "overall": {
      "fully_accepted": 0.32,
      "partially_accepted": 0.48,
      "fully_rejected": 0.20
    },
    "by_market_regime": {
      "panic": {
        "acceptance_rate": 0.68,
        "acceptance_winrate": 0.72,
        "rejection_winrate": 0.35
      },
      "calm": { ... },
      "greed": { ... }
    },
    "biggest_blindspots": [
      {
        "context": "在放量上涨时拒绝止盈建议",
        "rejection_rate": 0.82,
        "rejection_winrate": 0.31,
        "hint": "模型在这个场景通常是对的"
      }
    ]
  }
}
```

---

### 6.4 模式 ④：数据闭环

#### 6.4.1 `GET /api/v1/sessions/{id}/samples`

查询本会话生成的训练样本（仅 owner）。

**响应 200**：
```json
{
  "data": {
    "count": 18,
    "samples": [
      {
        "id": "sample_xxx",
        "ts": "2020-02-05T09:30:00Z",
        "features": { "ma_cross_20_60": 1, "rsi_14": 52.3 },
        "label": "buy_heavy",
        "context": {
          "market_regime": "panic",
          "future_return_5d": 0.063,
          "future_return_20d": 0.124
        }
      }
    ]
  }
}
```

#### 6.4.2 `GET /api/v1/users/me/training-samples`

跨会话的样本统计。

**Query Parameters**：
- `include_shared`: 是否包含已贡献到公共池的
- `start`, `end`: 按会话时间筛选

**响应 200**：
```json
{
  "data": {
    "total": 1240,
    "private": 1080,
    "shared": 160,
    "by_label": {
      "buy_heavy": 280,
      "buy_light": 320,
      "hold": 340,
      "sell_light": 180,
      "sell_heavy": 120
    },
    "date_range": ["2024-01-15", "2026-04-28"]
  }
}
```

#### 6.4.3 `POST /api/v1/users/me/training-samples/share`

将私有样本贡献到公共池（需要显式同意）。

**Request Body**：
```json
{
  "sample_ids": ["sample_xxx", ...] | "all",
  "consent": {
    "agreed_to_anonymization": true,
    "agreed_to_public_use": true,
    "agreement_version": "v1.0"
  }
}
```

**响应 200**：
```json
{
  "data": {
    "shared_count": 160,
    "anonymized_fields": ["user_id", "session_id", "timestamp"],
    "revoke_url": "/api/v1/users/me/training-samples/shared/revoke"
  }
}
```

#### 6.4.4 `DELETE /api/v1/users/me/training-samples`

删除自己的训练样本（GDPR-style 数据主权）。

**Request Body**：
```json
{
  "sample_ids": ["..."] | "all",
  "delete_from_shared_pool": true
}
```

---

## 7. WebSocket 协议

### 7.1 连接

```
wss://api.investdojo.com/ws/v1/sessions/{session_id}?token=<jwt>
```

连接成功后自动订阅该会话的所有事件。

### 7.2 消息类型

#### 7.2.1 时钟推进（服务端推送）

```json
{
  "type": "tick",
  "payload": {
    "current_ts": "2020-02-05T09:35:00Z",
    "current_tick": 421,
    "new_klines": [...],
    "new_news": [...],
    "portfolio_updates": [...]
  },
  "sequence": 421
}
```

#### 7.2.2 模型信号（服务端推送）

```json
{
  "type": "model_signal",
  "payload": {
    "participant_id": "model_xxx",
    "signals": [ /* Signal[] */ ]
  },
  "sequence": 422
}
```

#### 7.2.3 人下单（服务端回显）

```json
{
  "type": "order_filled",
  "payload": {
    "order_id": "ord_abc",
    "participant_id": "user_xxx",
    "symbol": "600519",
    "side": "BUY",
    "quantity": 100,
    "price": 1720.50
  },
  "sequence": 423
}
```

#### 7.2.4 客户端控制消息

触发推进：
```json
{ "type": "request_tick", "payload": { "steps": 1 } }
```

暂停：
```json
{ "type": "pause" }
```

#### 7.2.5 心跳

同 [API 约定 §13.3](./00_约定.md#133-心跳)。

---

## 8. 复盘与对账 API

### 8.1 `GET /api/v1/sessions/{id}/debrief`

获取完整复盘报告。

**响应 200**：
```json
{
  "data": {
    "session_summary": {
      "duration_days": 60,
      "final_return": 0.048,
      "benchmark_return": -0.115,
      "excess_return": 0.163,
      "max_drawdown": -0.083,
      "trade_count": 5
    },
    "participant_comparison": [   // PK 模式才有
      {
        "participant": "human",
        "total_return": 0.048,
        "sharpe": 0.82,
        "trades": 5
      },
      {
        "participant": "model_my_lstm_v1",
        "total_return": 0.071,
        "sharpe": 1.35,
        "trades": 22
      }
    ],
    "equity_curves": {
      "dates": [...],
      "human": [...],
      "model_my_lstm_v1": [...],
      "benchmark": [...],
      "theoretical_best": [...]   // 完美买卖信号
    },
    "scenario_reveal": {          // 盲测才揭晓
      "title": "新冠疫情暴跌",
      "summary": "...",
      "key_events": [...],
      "revealed_symbols": {...}
    },
    "timeline_with_decisions": [
      {
        "ts": "2020-02-03T09:30:00Z",
        "event_type": "optimal_buy_point",
        "symbol": "600519",
        "user_action": null,
        "commentary": "此时是周期低点，但你当时未入场"
      },
      {
        "ts": "2020-02-05T09:30:00Z",
        "event_type": "user_buy",
        "symbol": "600519",
        "quantity": 100,
        "price": 1720.50,
        "commentary": "比最优点晚了 2 天"
      }
    ],
    "ai_insights": {
      "strengths": ["在暴跌市守住本金"],
      "blindspots": ["在美股熔断后恐慌抛售"],
      "suggestions": ["下一局开启'新闻只看标题'盲度"]
    }
  }
}
```

### 8.2 `POST /api/v1/sessions/{id}/debrief/share`

生成分享链接。

**响应 200**：同回测分享接口。

### 8.3 `GET /api/v1/sessions/{id}/debrief/share/{token}`

公开访问（无需鉴权）。

### 8.4 `GET /api/v1/sessions/{id}/debrief/export`

导出复盘数据。

**Query Parameters**：
- `format`: `json` / `csv` / `pdf`

---

## 9. 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `SESSION_NOT_FOUND` | 404 | |
| `SESSION_PERMISSION_DENIED` | 403 | |
| `SESSION_STATUS_INVALID` | 422 | 状态不允许此操作 |
| `SESSION_SCENARIO_INVALID` | 422 | 场景无效 |
| `SESSION_MODE_INVALID` | 400 | 模式无效 |
| `SESSION_CLOCK_OVERFLOW` | 422 | 时钟已到尾部 |
| `ORDER_INSUFFICIENT_CASH` | 422 | 现金不足 |
| `ORDER_INSUFFICIENT_POSITION` | 422 | 可卖仓位不足 |
| `ORDER_T_PLUS_1_VIOLATION` | 422 | 违反 T+1 规则 |
| `ORDER_PRICE_OUT_OF_LIMIT` | 422 | 价格超出涨跌停 |
| `MODEL_DECISION_TIMEOUT` | 504 | 模型决策超时（PK 模式） |
| `DEBRIEF_NOT_READY` | 422 | 会话未结束，不能查看复盘 |
| `COPILOT_SUGGESTION_NOT_FOUND` | 404 | 建议已过期或不存在 |
| `SAMPLE_CONSENT_REQUIRED` | 422 | 贡献样本需明确同意 |

---

## 10. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版，覆盖四种联动模式 |
