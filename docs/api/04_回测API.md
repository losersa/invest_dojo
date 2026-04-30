# 回测 API

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/backtests`
> 维护者：后端 + 算法
> 对应架构：[architecture/03_量化模块.md#6-回测引擎backtest-svc](../architecture/03_量化模块.md)

---

## 目录

- [1. 概述](#1-概述)
- [2. 数据模型](#2-数据模型)
- [3. 快速回测 API](#3-快速回测-api)
- [4. 精细回测 API](#4-精细回测-api)
- [5. 回测报告 API](#5-回测报告-api)
- [6. 多策略对比 API](#6-多策略对比-api)
- [7. 回测历史 API](#7-回测历史-api)
- [8. 错误码](#8-错误码)

---

## 1. 概述

### 1.1 两种回测模式

| 模式 | 说明 | 延迟 | 适用 |
|------|------|------|------|
| **Fast**（快速） | 向量化回测，假设完美成交 | < 30s | 调参、对比 |
| **Realistic**（精细） | 事件驱动，含滑点/费率/撮合/涨跌停 | 10s ~ 数分钟 | 终评、联动准备 |

### 1.2 支持回测的对象

- 单个因子（作为二元信号）
- 因子组合（复合表达式）
- 模型（调用 infer 服务）
- 导入的信号文件（external_signal 类型）

---

## 2. 数据模型

### 2.1 `BacktestConfig`（回测配置）

```typescript
interface BacktestConfig {
  mode: 'fast' | 'realistic';

  // 策略来源（四选一）
  strategy: {
    type: 'factor' | 'composite' | 'model' | 'signal_file';
    factor_id?: string;
    composite_id?: string;
    model_id?: string;
    model_version?: string;
    signal_file_id?: string;
  };

  // 时间范围
  start: string;
  end: string;

  // 股票池
  universe: 'hs300' | 'zz500' | 'zz1000' | 'all' | string[];

  // 资金
  initial_capital: number;          // 默认 100000

  // 交易规则（Realistic 模式生效）
  rules?: {
    commission_rate?: number;       // 佣金，默认 0.0003
    stamp_tax?: number;             // 印花税，默认 0.001（仅卖出）
    slippage?: number;              // 滑点，默认 0.0005
    min_commission?: number;        // 最低佣金，默认 5
    t_plus_1?: boolean;             // T+1 规则，默认 true
    allow_limit_order?: boolean;    // 允许涨跌停挂单，默认 false
  };

  // 仓位管理
  position_sizing?: {
    method: 'equal_weight' | 'signal_weight' | 'fixed_amount' | 'custom';
    max_positions?: number;         // 最大持仓数
    single_stock_pct?: number;      // 单只股票仓位上限
    rebalance_frequency?: 'daily' | 'weekly' | 'monthly' | 'signal_triggered';
  };

  // 基准
  benchmark?: string;               // "000300" 沪深300，默认上证

  // 高级选项
  advanced?: {
    include_feature_importance?: boolean;  // 是否计算 SHAP（慢）
    include_trade_log?: boolean;
    include_daily_positions?: boolean;
  };
}
```

### 2.2 `BacktestResult`（结果）

```typescript
interface BacktestResult {
  id: string;
  config: BacktestConfig;
  status: 'pending' | 'running' | 'completed' | 'failed';

  summary: {
    total_return: number;           // 总收益
    annual_return: number;
    benchmark_return: number;
    excess_return: number;          // 超额收益
    sharpe: number;
    sortino: number;
    calmar: number;
    max_drawdown: number;
    max_drawdown_period: [string, string];
    volatility: number;
    win_rate: number;               // 交易胜率
    profit_loss_ratio: number;      // 盈亏比
    turnover_rate: number;          // 换手率
    total_trades: number;
    ic?: number;
    ir?: number;
  };

  equity_curve: {
    dates: string[];
    portfolio: number[];            // 组合净值
    benchmark: number[];
    drawdown: number[];             // 回撤曲线
    cash: number[];
    positions_count: number[];
  };

  segment_performance?: {
    bull: PeriodStats;
    bear: PeriodStats;
    sideways: PeriodStats;
    [custom_period: string]: PeriodStats;
  };

  feature_importance?: Array<{
    feature: string;
    importance: number;
    shap_abs_mean: number;
  }>;

  trades?: Trade[];                 // 完整交易日志（可选）

  created_at: string;
  completed_at?: string;
  duration_ms?: number;
}

interface PeriodStats {
  start: string;
  end: string;
  return: number;
  volatility: number;
  sharpe: number;
  max_drawdown: number;
}

interface Trade {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  datetime: string;
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  reason?: string;                  // 触发该交易的信号理由
  pnl?: number;                     // 对应平仓的盈亏
}
```

---

## 3. 快速回测 API

### 3.1 `POST /api/v1/backtests/run-fast`

立即返回结果（同步接口，仅当预估 < 30s 时）。

**Request Body**：
```json
{
  "strategy": {
    "type": "model",
    "model_id": "model_abc"
  },
  "start": "2022-01-01",
  "end": "2023-12-31",
  "universe": "hs300",
  "initial_capital": 100000,
  "benchmark": "000300"
}
```

**响应 200**：返回完整 `BacktestResult`。

**响应 413 Payload Too Large**（如果预估 > 30s）：
```json
{
  "error": {
    "code": "BACKTEST_FAST_MODE_TOO_LARGE",
    "message": "Estimated duration > 30s, please use async API",
    "detail": {
      "estimated_seconds": 180,
      "suggested_endpoint": "POST /api/v1/backtests"
    }
  }
}
```

### 3.2 `POST /api/v1/backtests/quick-factor`

快速测试单因子表现（不保存）。

**Request Body**：
```json
{
  "factor_id": "ma_cross_20_60",
  "start": "2022-01-01",
  "end": "2023-12-31",
  "universe": "hs300"
}
```

**响应 200**：返回 `BacktestResult`，但不落库。

---

## 4. 精细回测 API

### 4.1 `POST /api/v1/backtests`

提交一个异步回测任务（Realistic 模式默认走此接口）。

**Request Body**：完整 `BacktestConfig`，`mode` 可以是 `fast` 或 `realistic`。

**响应 202**：
```json
{
  "data": {
    "backtest_id": "bt_abc123",
    "status": "pending",
    "estimated_seconds": 120,
    "poll_url": "/api/v1/backtests/bt_abc123"
  }
}
```

### 4.2 `GET /api/v1/backtests/{id}`

查询回测状态/结果。

**Query Parameters**：
- `include_trades`: 是否返回交易日志（大，默认 false）
- `include_daily_positions`: 是否返回每日持仓
- `include_feature_importance`: 是否返回 SHAP

**响应 200**（进行中）：
```json
{
  "data": {
    "id": "bt_abc123",
    "status": "running",
    "progress": 0.42,
    "estimated_remaining_seconds": 70
  }
}
```

**响应 200**（完成）：返回完整 `BacktestResult`。

### 4.3 `POST /api/v1/backtests/{id}/cancel`

取消正在运行的回测。

### 4.4 `DELETE /api/v1/backtests/{id}`

删除回测记录（仅 owner）。

---

## 5. 回测报告 API

### 5.1 `GET /api/v1/backtests/{id}/report`

生成/查看回测 HTML 报告（可分享）。

**Query Parameters**：
- `format`: `html` / `pdf` / `json`，默认 `html`

**响应 200**（html）：
```http
Content-Type: text/html
<html>... 完整 HTML 报告 ...</html>
```

**响应 200**（pdf）：二进制流。

### 5.2 `POST /api/v1/backtests/{id}/share`

创建一个公开可分享的链接。

**Request Body**：
```json
{
  "expires_in_days": 30,
  "allow_download": true
}
```

**响应 200**：
```json
{
  "data": {
    "share_token": "share_xyz",
    "share_url": "https://investdojo.com/bt/share_xyz",
    "expires_at": "2026-05-28T..."
  }
}
```

### 5.3 `GET /api/v1/backtests/shared/{token}`

公开访问（无需鉴权）。

---

## 6. 多策略对比 API

### 6.1 `POST /api/v1/backtests/compare`

并行回测多个策略，返回对比结果。

**Request Body**：
```json
{
  "strategies": [
    { "name": "策略A", "strategy": { "type": "model", "model_id": "model_a" } },
    { "name": "策略B", "strategy": { "type": "model", "model_id": "model_b" } },
    { "name": "基准·等权",   "strategy": { "type": "benchmark", "benchmark": "equal_weight_hs300" } }
  ],
  "common_config": {
    "start": "2022-01-01",
    "end": "2023-12-31",
    "universe": "hs300",
    "initial_capital": 100000
  },
  "mode": "fast"
}
```

**响应 202**：
```json
{
  "data": {
    "comparison_id": "cmp_abc",
    "status": "pending",
    "poll_url": "/api/v1/backtests/compare/cmp_abc"
  }
}
```

### 6.2 `GET /api/v1/backtests/compare/{id}`

**响应 200**：
```json
{
  "data": {
    "comparison_id": "cmp_abc",
    "status": "completed",
    "results": [
      {
        "name": "策略A",
        "backtest_id": "bt_a",
        "summary": { "total_return": 0.18, "sharpe": 1.35, ... }
      },
      {
        "name": "策略B",
        "backtest_id": "bt_b",
        "summary": { "total_return": 0.12, "sharpe": 0.98, ... }
      }
    ],
    "winner_by_metric": {
      "total_return": "策略A",
      "sharpe": "策略A",
      "max_drawdown": "策略B"
    },
    "aligned_equity_curves": {
      "dates": [...],
      "strategies": {
        "策略A": [...],
        "策略B": [...]
      }
    }
  }
}
```

---

## 7. 回测历史 API

### 7.1 `GET /api/v1/backtests`

查询当前用户的回测历史。

**Query Parameters**：
- `model_id`: 只看某个模型的回测
- `status`: `completed` / `failed`
- `start`, `end`: 按创建时间筛选
- `sort`: `-created_at`（默认）/ `-summary.total_return`
- `page`, `page_size`

**响应 200**：
```json
{
  "data": [
    {
      "id": "bt_abc",
      "config_summary": "Model model_xyz · 2022-2023 · HS300",
      "summary": {
        "total_return": 0.18,
        "sharpe": 1.35,
        "max_drawdown": -0.08
      },
      "created_at": "2026-04-20T10:00:00Z"
    }
  ],
  "pagination": { ... }
}
```

### 7.2 `GET /api/v1/backtests/stats`

用户的回测统计。

**响应 200**：
```json
{
  "data": {
    "total_backtests": 42,
    "completed": 40,
    "failed": 2,
    "best_sharpe": { "backtest_id": "bt_xxx", "sharpe": 2.15 },
    "avg_duration_seconds": 85
  }
}
```

---

## 8. 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `BACKTEST_NOT_FOUND` | 404 | |
| `BACKTEST_PERMISSION_DENIED` | 403 | |
| `BACKTEST_FAST_MODE_TOO_LARGE` | 413 | 数据量大，需走异步 |
| `BACKTEST_DATE_RANGE_INVALID` | 400 | 日期范围无效 |
| `BACKTEST_STRATEGY_INVALID` | 422 | 策略配置错误 |
| `BACKTEST_MODEL_NOT_READY` | 422 | 模型未训练完成 |
| `BACKTEST_UNIVERSE_EMPTY` | 422 | 股票池为空 |
| `BACKTEST_INSUFFICIENT_DATA` | 422 | 数据不足 |
| `BACKTEST_TIMEOUT` | 503 | 回测超时 |
| `BACKTEST_SHARE_EXPIRED` | 410 | 分享链接已过期 |

---

## 9. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版 |
