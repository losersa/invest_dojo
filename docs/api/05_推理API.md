# 推理 API

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/inference`
> WebSocket URL：`wss://api.investdojo.com/ws/v1/inference`
> 维护者：后端 + 算法
> 对应架构：[architecture/03_量化模块.md#7-推理服务infer-svc](../architecture/03_量化模块.md)

---

## 目录

- [1. 概述](#1-概述)
- [2. 数据模型](#2-数据模型)
- [3. 请求响应推理](#3-请求响应推理)
- [4. 批量推理](#4-批量推理)
- [5. 流式推理（WebSocket）](#5-流式推理websocket)
- [6. 防未来函数契约](#6-防未来函数契约)
- [7. 推理监控 API](#7-推理监控-api)
- [8. 错误码](#8-错误码)

---

## 1. 概述

### 1.1 三种推理方式

| 方式 | 协议 | 延迟目标 | 适用场景 |
|------|------|---------|---------|
| **请求响应** | HTTP POST | < 50ms | 模型详情页试算、单次查询 |
| **批量** | HTTP POST | 无硬约束 | 回测、因子预计算 |
| **流式** | WebSocket / SSE | < 200ms | **联动模式**（副驾/PK/Copilot） |

### 1.2 核心契约

**防未来函数**：所有推理接口都强制要求 `as_of` 参数（联动会话会自动注入）。推理服务只能访问 `as_of` 之前的数据。

**统一 Signal 输出**：无论模型来自哪里，输出格式一致（见 §2.1）。

**确定性**：同一 `(model_id, model_version, features, as_of)` 组合，推理结果完全相同（除非涉及随机性，会返回 `seed`）。

---

## 2. 数据模型

### 2.1 `Signal`（统一信号格式）

```typescript
interface Signal {
  timestamp: string;                // 信号生成时间
  as_of: string;                    // 输入数据截止时间
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;               // 0 ~ 1

  // 输出详情
  score?: number;                   // 原始模型输出分数
  target_position?: number;         // 建议目标仓位 0 ~ 1
  holding_horizon_days?: number;    // 建议持有周期

  // 支撑特征（用于副驾面板展示）
  features: Record<string, number>;

  // 解释性
  explanation?: {
    top_positive_factors: Array<{ name: string; contribution: number }>;
    top_negative_factors: Array<{ name: string; contribution: number }>;
    thesis?: string;                // 一句话解释
  };

  // 元数据
  metadata: {
    model_id: string;
    model_version: string;
    inference_time_ms: number;
    seed?: number;
  };
}
```

### 2.2 `InferenceRequest`（推理请求）

```typescript
interface InferenceRequest {
  model_id: string;
  model_version?: string;           // 不填使用当前版本
  symbols: string[];
  as_of: string;                    // ISO 8601
  include_explanation?: boolean;    // 默认 false
  feature_overrides?: Record<string, Record<string, number>>;
  // 高级：传入自定义特征值（如测试场景）
  // { "600519": { "rsi_14": 25.5, "ma_cross_20_60": 1 } }
}
```

---

## 3. 请求响应推理

### 3.1 `POST /api/v1/inference/predict`

单次推理（一个模型，一批股票）。

**Request Body**：`InferenceRequest`

**示例**：
```json
{
  "model_id": "model_abc",
  "symbols": ["600519", "000001"],
  "as_of": "2024-03-15T15:00:00Z",
  "include_explanation": true
}
```

**响应 200**：
```json
{
  "data": {
    "signals": [
      {
        "timestamp": "2026-04-28T12:20:00Z",
        "as_of": "2024-03-15T15:00:00Z",
        "symbol": "600519",
        "action": "BUY",
        "confidence": 0.72,
        "score": 0.68,
        "target_position": 0.3,
        "features": {
          "ma_cross_20_60": 1,
          "rsi_14": 52.3,
          "volume_ratio": 1.45
        },
        "explanation": {
          "top_positive_factors": [
            { "name": "ma_cross_20_60", "contribution": 0.34 },
            { "name": "volume_ratio", "contribution": 0.28 }
          ],
          "top_negative_factors": [
            { "name": "rsi_14", "contribution": -0.08 }
          ],
          "thesis": "均线金叉 + 放量，但 RSI 接近超买"
        },
        "metadata": {
          "model_id": "model_abc",
          "model_version": "v3.0.0",
          "inference_time_ms": 18
        }
      }
    ]
  }
}
```

### 3.2 `POST /api/v1/inference/ensemble`

多模型集成推理（同时调多个模型，返回平均/投票结果）。

**Request Body**：
```json
{
  "models": [
    { "model_id": "model_a", "weight": 0.5 },
    { "model_id": "model_b", "weight": 0.3 },
    { "model_id": "model_platform_momentum_v2", "weight": 0.2 }
  ],
  "symbols": ["600519"],
  "as_of": "2024-03-15T15:00:00Z",
  "aggregation": "weighted_avg" | "majority_vote" | "max_confidence"
}
```

**响应 200**：返回聚合后的 `Signal[]`，`metadata` 中包含各子模型的原始输出。

---

## 4. 批量推理

### 4.1 `POST /api/v1/inference/batch`

异步批量推理（适合回测场景）。

**Request Body**：
```json
{
  "model_id": "model_abc",
  "universe": "hs300",
  "start": "2022-01-01",
  "end": "2023-12-31",
  "frequency": "daily",
  "as_of_policy": "end_of_day"
}
```

**Request Body 字段**：

| 字段 | 说明 |
|------|------|
| `universe` | 股票池 |
| `frequency` | 推理频率：`daily`/`weekly`/`monthly` |
| `as_of_policy` | `end_of_day`（每日收盘后） / `open`（每日开盘前）/ `15min_delayed`（延迟 15 分钟） |

**响应 202**：
```json
{
  "data": {
    "job_id": "job_infer_abc",
    "status": "pending",
    "estimated_seconds": 120,
    "total_inferences": 125430,
    "poll_url": "/api/v1/inference/batch/job_infer_abc"
  }
}
```

### 4.2 `GET /api/v1/inference/batch/{job_id}`

**响应 200**：
```json
{
  "data": {
    "job_id": "job_infer_abc",
    "status": "completed",
    "progress": 1.0,
    "signals_count": 125430,
    "result_url": "/api/v1/inference/batch/job_infer_abc/signals",
    "download_url": "/api/v1/inference/batch/job_infer_abc/download"
  }
}
```

### 4.3 `GET /api/v1/inference/batch/{job_id}/signals`

分页查询批量结果。

**Query Parameters**：
- `page`, `page_size`
- `symbols`: 筛选
- `start`, `end`

### 4.4 `GET /api/v1/inference/batch/{job_id}/download`

下载全部结果（CSV/Parquet）。

**Query Parameters**：
- `format`: `csv`/`parquet`

---

## 5. 流式推理（WebSocket）

**⭐ 这是联动模式的核心基础设施。**

### 5.1 连接

```
wss://api.investdojo.com/ws/v1/inference/stream?token=<jwt>
```

### 5.2 消息协议（JSON）

#### 5.2.1 订阅模型

Client → Server：
```json
{
  "type": "subscribe",
  "payload": {
    "model_id": "model_abc",
    "model_version": "v3.0.0",
    "session_id": "session_xyz",         // 可选：绑定到会话
    "symbols": ["600519", "000001"],
    "include_explanation": true
  },
  "request_id": "req_123"
}
```

Server → Client（订阅成功）：
```json
{
  "type": "subscribed",
  "payload": {
    "subscription_id": "sub_abc",
    "model_id": "model_abc"
  },
  "request_id": "req_123"
}
```

#### 5.2.2 触发推理

当会话时钟推进，或用户手动触发：

Client → Server：
```json
{
  "type": "infer",
  "payload": {
    "subscription_id": "sub_abc",
    "as_of": "2020-02-05T15:00:00Z"
  },
  "request_id": "req_124"
}
```

Server → Client（推理结果）：
```json
{
  "type": "signal",
  "payload": {
    "subscription_id": "sub_abc",
    "signals": [ /* Signal[] */ ]
  },
  "request_id": "req_124",
  "sequence": 12
}
```

#### 5.2.3 会话自动推送

如果 `subscribe` 时绑定了 `session_id`，则会话时钟每次推进（`tick` 事件）都会自动触发推理：

Server → Client（无需客户端请求）：
```json
{
  "type": "signal",
  "payload": {
    "subscription_id": "sub_abc",
    "triggered_by": "session_tick",
    "as_of": "2020-02-05T15:00:00Z",
    "signals": [ ... ]
  },
  "sequence": 13
}
```

#### 5.2.4 取消订阅

Client → Server：
```json
{
  "type": "unsubscribe",
  "payload": { "subscription_id": "sub_abc" }
}
```

#### 5.2.5 心跳

Server → Client（每 30s）：
```json
{
  "type": "heartbeat",
  "timestamp": "2026-04-28T12:20:00Z"
}
```

客户端 60s 未收到心跳即断开重连。

#### 5.2.6 错误

Server → Client：
```json
{
  "type": "error",
  "payload": {
    "code": "INFERENCE_MODEL_NOT_FOUND",
    "message": "..."
  },
  "request_id": "req_124"
}
```

### 5.3 SSE 备选方案

WebSocket 不可用时，使用 SSE：

```
GET /api/v1/inference/stream/{subscription_id}?token=<jwt>
Accept: text/event-stream
```

响应（持续推送）：
```
event: signal
data: { ... Signal 数据 ... }

event: heartbeat
data: { "timestamp": "..." }
```

### 5.4 性能约束

- 每用户同时最多 5 个 WebSocket 连接
- 每连接最多 10 个订阅
- 单次推理超时：5 秒
- 流式通道心跳间隔：30 秒
- 断线后 60 秒内重连可恢复订阅状态（带 `subscription_id` 重连）

---

## 6. 防未来函数契约

### 6.1 强制性

所有推理接口**必须**传入 `as_of`。缺失时：
- 请求响应接口：`400 Bad Request`
- 流式接口：从绑定的会话时钟读取，否则拒绝订阅

### 6.2 语义

- `as_of` 是**严格小于**语义：只能看到 `< as_of` 的数据
- 例如 `as_of="2024-03-15T15:00:00Z"` 表示能看到 2024-03-15 收盘前的所有数据

### 6.3 数据访问约束

推理服务在执行时：
- 所有对数据层的查询都自动注入 `as_of` 参数
- 因子值查询的 `date < as_of`
- K 线查询的 `dt < as_of`
- 财报查询的 `announce_date < as_of`

### 6.4 单元测试保证

平台 CI 包含 "未来函数检测" 测试：
- 尝试让模型在 `as_of=T` 查询 `T+1` 的数据，必须抛异常
- 关键路径每次 PR 都会跑

### 6.5 联动模式的自动注入

会话模式下，`as_of` 由 Session Orchestrator 自动填充为 `session.clock.current_ts`，客户端无需手动传（见 [会话 API](./06_会话API.md)）。

---

## 7. 推理监控 API

### 7.1 `GET /api/v1/inference/stats`

查询推理调用统计。

**Query Parameters**：
- `model_id`: 筛选
- `period`: `1h`/`24h`/`7d`/`30d`

**响应 200**：
```json
{
  "data": {
    "total_calls": 125430,
    "success_rate": 0.998,
    "avg_latency_ms": 34,
    "p50_latency_ms": 28,
    "p95_latency_ms": 82,
    "p99_latency_ms": 156,
    "by_model": [
      { "model_id": "model_abc", "calls": 52340, "avg_latency_ms": 22 }
    ]
  }
}
```

### 7.2 `GET /api/v1/inference/models/{model_id}/health`

查询某个模型的推理健康状态。

**响应 200**：
```json
{
  "data": {
    "model_id": "model_abc",
    "status": "healthy",
    "last_inference_at": "...",
    "recent_stats": {
      "success_rate_24h": 0.999,
      "avg_latency_24h_ms": 18
    },
    "data_drift": {
      "detected": false,
      "features_with_drift": []
    }
  }
}
```

---

## 8. 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `INFERENCE_MODEL_NOT_FOUND` | 404 | 模型不存在 |
| `INFERENCE_MODEL_NOT_READY` | 422 | 模型未训练完成 |
| `INFERENCE_AS_OF_REQUIRED` | 400 | 缺少 as_of 参数 |
| `INFERENCE_AS_OF_INVALID` | 400 | as_of 格式错 |
| `INFERENCE_FEATURES_UNAVAILABLE` | 422 | 所需因子不可用 |
| `INFERENCE_SYMBOLS_TOO_MANY` | 400 | 单次推理超过 100 只股票 |
| `INFERENCE_TIMEOUT` | 503 | 推理超时 5 秒 |
| `INFERENCE_FUTURE_LEAK_DETECTED` | 500 | 未来函数检测告警（平台内部错误，会重试） |
| `INFERENCE_WS_SUBSCRIPTION_LIMIT` | 429 | WebSocket 订阅数超限 |
| `INFERENCE_WS_CONNECTION_LIMIT` | 429 | WebSocket 连接数超限 |

---

## 9. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版 |
