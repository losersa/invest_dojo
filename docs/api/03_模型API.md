# 模型 API

> 文档状态：**Stable v1.0**
> 最后更新：2026-04-28
> Base URL：`/api/v1/models`
> 维护者：后端 + 算法
> 对应 PRD：[product/02_量化模块_PRD.md#32-模型训练p0](../product/02_量化模块_PRD.md#32-模型训练p0)
> 对应架构：[architecture/03_量化模块.md#3-模型来源与统一接入](../architecture/03_量化模块.md)

---

## 目录

- [1. 概述](#1-概述)
- [2. 数据模型](#2-数据模型)
- [3. 模型 CRUD](#3-模型-crud)
- [4. 平台内训练 API](#4-平台内训练-api)
- [5. 上传用户模型 API](#5-上传用户模型-api)
- [6. 第三方信号导入 API](#6-第三方信号导入-api)
- [7. ⭐ 平台官方模型 API](#7--平台官方模型-api)
- [8. 模型市场 API](#8-模型市场-api)
- [9. 版本管理 API](#9-版本管理-api)
- [10. 错误码](#10-错误码)

---

## 1. 概述

### 1.1 模型四种来源的统一接入

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Internal     │ │ Uploaded     │ │ External     │ │ ⭐ Platform   │
│ 平台内训练    │ │ 用户上传     │ │ 第三方信号    │ │ 官方模型      │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                                 ↓
                      统一 models 表 + Signal 输出
```

**核心原则**：四种来源走**同一个 `/api/v1/models` 资源域**，通过 `source` 字段区分。官方模型只是 `owner='platform'`，其他字段与用户模型完全一致。

### 1.2 API 分组

- **§3 模型 CRUD**：通用的查询/更新/删除
- **§4 平台内训练**：创建并训练模型（`POST /api/v1/models/train`）
- **§5 上传**：注册已有模型文件
- **§6 第三方信号**：导入信号 CSV
- **§7 官方模型**：平台管理端接口（需 `platform_admin` 权限）
- **§8 市场**：模型市场浏览、订阅
- **§9 版本管理**：每个模型的多版本

---

## 2. 数据模型

### 2.1 `Model`（模型）

```typescript
interface Model {
  id: string;                       // "model_abc123"
  name: string;                     // "我的 LightGBM v1"
  version: string;                  // "1.0.0"
  owner: string;                    // "user_xxx" / "platform"

  source: 'internal' | 'uploaded' | 'external_signal' | 'official';

  input_features: string[];         // 依赖的因子 ID
  target: string;                   // "relative_return_5d_gt_2pct"
  output_type: 'classification' | 'regression' | 'rank';

  algorithm?: string;               // "lightgbm" / "xgboost" / "lstm" / "custom"
  training_range?: [string, string];
  training_samples?: number;

  file_path?: string;               // 对象存储中的路径
  file_size?: number;               // 字节

  validation_metrics?: {
    accuracy?: number;
    auc?: number;
    ic?: number;
    sharpe?: number;
    max_drawdown?: number;
    [key: string]: number | undefined;
  };

  visibility: 'private' | 'unlisted' | 'public';

  metadata?: Record<string, unknown>;  // 扩展字段
  // 官方模型会填充 PlatformModelExtras（见 §7）

  status: 'draft' | 'training' | 'ready' | 'failed' | 'deprecated';
  status_reason?: string;

  usage_count: number;
  last_used_at?: string;

  created_at: string;
  updated_at: string;
}
```

### 2.2 `TrainingJob`（训练任务）

```typescript
interface TrainingJob {
  job_id: string;
  model_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;                 // 0 ~ 1
  stage?: 'loading_data' | 'computing_features' | 'fitting' | 'evaluating' | 'saving';
  estimated_remaining_seconds?: number;
  started_at?: string;
  completed_at?: string;
  error?: { code: string; message: string };
  metrics_preview?: Record<string, number>;
}
```

### 2.3 `PlatformModelExtras`（官方模型扩展）

参见 [ADR 0002](../adr/0002-平台官方模型与用户模型同等待遇.md)：

```typescript
interface PlatformModelExtras {
  is_official: true;
  official_tier: 'baseline' | 'experimental' | 'premium';
  official_category:
    | 'momentum_follower'
    | 'value_investor'
    | 'sentiment_trader'
    | 'multi_factor'
    | 'deep_learning';
  doc_url: string;
  source_code_url: string;
  retrain_schedule: 'quarterly' | 'monthly' | 'manual';
  last_retrained_at: string;
  maintainer: string;
  deprecation_notice?: string;
  methodology: {
    thesis: string;
    features_used: string[];
    target: string;
    training_window: [string, string];
    known_limitations: string[];
  };
}
```

---

## 3. 模型 CRUD

### 3.1 `GET /api/v1/models`

查询模型列表。

**Query Parameters**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `owner` | `string` | `me`（当前用户）/ `platform` / user_id |
| `source` | `string` | `internal`/`uploaded`/`external_signal`/`official` |
| `visibility` | `string` | `private`/`unlisted`/`public`/`all` |
| `status` | `string` | `ready`/`training`/`failed` |
| `category` | `string` | 仅对官方模型有效 |
| `search` | `string` | 按名称搜索 |
| `sort` | `string` | `-updated_at`/`-usage_count`/`-validation_metrics.sharpe` |
| `page`, `page_size` | | |

**响应 200**：返回 `Model[]` 分页结果。

### 3.2 `GET /api/v1/models/{id}`

获取单个模型详情。

**Query Parameters**：
- `include_metrics_history`: 是否返回每次回测/评估的历史

**权限**：
- `visibility=private` 的模型只能 owner 本人访问
- `unlisted` 任何人只要知道 ID 就能访问
- `public` 所有人可访问

### 3.3 `PATCH /api/v1/models/{id}`

更新模型元数据（仅 owner 可改）。

**可修改字段**：`name`, `description`, `visibility`, `tags`

**不可修改**：`source`, `input_features`, `file_path`, `validation_metrics`（这些修改意味着重新训练）

### 3.4 `DELETE /api/v1/models/{id}`

删除模型（仅 owner 可调）。
- 官方模型（`owner='platform'`）不允许删除，只能标记为 `deprecated`
- 已被某个会话正在使用的模型不能删除（需等会话结束）
- 软删除：标记 `status='deprecated'`，30 天后物理删除

**响应 204**：成功。

---

## 4. 平台内训练 API

### 4.1 `POST /api/v1/models/train`

提交一个训练任务。

**Request Body**：
```json
{
  "name": "我的 LightGBM v1",
  "algorithm": "lightgbm",
  "features": ["ma_cross_20_60", "rsi_14", "volume_ratio", "pe_percentile"],
  "target": {
    "type": "binary_classification",
    "spec": {
      "horizon_days": 5,
      "threshold": 0.02,
      "kind": "relative_return"
    }
  },
  "universe": "hs300",
  "training_range": ["2014-01-01", "2021-12-31"],
  "validation_range": ["2022-01-01", "2023-12-31"],
  "hyperparameters": {
    "num_leaves": 31,
    "learning_rate": 0.05,
    "n_estimators": 100
  },
  "visibility": "private"
}
```

**Request Body 字段说明**：

| 字段 | 说明 |
|------|------|
| `algorithm` | `logistic_regression` / `random_forest` / `lightgbm` / `xgboost` / `lstm` / `transformer` |
| `features` | 特征因子 ID 列表，最多 50 个 |
| `target.type` | `binary_classification` / `regression` / `rank` |
| `target.spec` | 标签定义：horizon_days、threshold、kind |
| `universe` | `hs300`/`zz500`/`zz1000`/`all`/自定义股票列表 |
| `hyperparameters` | 可选，使用算法默认值 |

**响应 202 Accepted**：
```json
{
  "data": {
    "job_id": "job_train_abc",
    "model_id": "model_abc123",
    "status": "pending",
    "estimated_seconds": 180,
    "poll_url": "/api/v1/models/train/jobs/job_train_abc"
  }
}
```

### 4.2 `GET /api/v1/models/train/jobs/{job_id}`

查询训练任务状态。

**响应 200**：返回 `TrainingJob` 对象。

### 4.3 `POST /api/v1/models/train/jobs/{job_id}/cancel`

取消训练任务（仅在 `pending` 或 `running` 状态有效）。

### 4.4 `GET /api/v1/models/{id}/training-report`

获取训练完成报告。

**响应 200**：
```json
{
  "data": {
    "model_id": "model_abc123",
    "algorithm": "lightgbm",
    "training_time_seconds": 142,
    "training_samples": 125430,
    "validation_samples": 32150,
    "metrics": {
      "accuracy": 0.563,
      "auc": 0.621,
      "ic": 0.082,
      "precision": 0.581,
      "recall": 0.523
    },
    "confusion_matrix": [[15234, 5678], [4890, 6348]],
    "feature_importance": [
      { "feature": "ma_cross_20_60", "importance": 0.342 },
      { "feature": "rsi_14", "importance": 0.285 }
    ],
    "by_market_regime": {
      "bull": { "accuracy": 0.612 },
      "bear": { "accuracy": 0.478 },
      "sideways": { "accuracy": 0.551 }
    }
  }
}
```

### 4.5 `GET /api/v1/models/algorithms`

获取支持的算法列表。

**响应 200**：
```json
{
  "data": [
    {
      "id": "lightgbm",
      "name": "LightGBM",
      "category": "tree",
      "difficulty": "easy",
      "typical_training_time_seconds": 30,
      "supported_targets": ["binary_classification", "regression", "rank"],
      "default_hyperparameters": { "num_leaves": 31, "learning_rate": 0.05 }
    }
  ]
}
```

### 4.6 `GET /api/v1/models/targets`

获取预定义标签列表（常用的预测目标）。

**响应 200**：
```json
{
  "data": [
    {
      "id": "relative_return_5d_gt_2pct",
      "name": "未来 5 日相对收益 > 2%",
      "type": "binary_classification",
      "spec": { "horizon_days": 5, "threshold": 0.02, "kind": "relative_return" }
    },
    {
      "id": "absolute_return_20d",
      "name": "未来 20 日绝对收益",
      "type": "regression",
      "spec": { "horizon_days": 20, "kind": "absolute_return" }
    }
  ]
}
```

---

## 5. 上传用户模型 API

### 5.1 `POST /api/v1/models/upload/initiate`

发起上传（获得预签名 URL）。

**Request Body**：
```json
{
  "name": "我的外部 LSTM",
  "file_format": "pkl",
  "file_size": 12582912,
  "input_features": ["ma5", "ma20", "rsi_14"],
  "target": {
    "type": "binary_classification",
    "spec": { "horizon_days": 5, "threshold": 0.02, "kind": "relative_return" }
  }
}
```

**响应 200**：
```json
{
  "data": {
    "model_id": "model_uploaded_xyz",
    "upload_url": "https://minio.../presigned-upload-url",
    "upload_method": "PUT",
    "expires_at": "2026-04-28T13:16:00Z",
    "max_file_size": 524288000
  }
}
```

### 5.2 `POST /api/v1/models/upload/{model_id}/complete`

上传完成后调用，触发 smoke test。

**Request Body**：
```json
{
  "entry_point": "model.predict",
  "requirements": [
    "scikit-learn==1.3.0",
    "lightgbm==4.0.0"
  ],
  "metadata": {
    "framework": "lightgbm",
    "python_version": "3.10"
  }
}
```

**响应 202**：
```json
{
  "data": {
    "smoke_test_job_id": "job_smoke_abc",
    "status": "pending"
  }
}
```

### 5.3 `GET /api/v1/models/upload/{model_id}/smoke-test`

查询 smoke test 结果。

**响应 200**：
```json
{
  "data": {
    "status": "completed",
    "passed": true,
    "test_samples": 3,
    "test_output": [
      { "input": {...}, "output": 0.72, "duration_ms": 15 }
    ],
    "warnings": [
      "模型预测输出类型为 float，将视为 regression 模型"
    ]
  }
}
```

### 5.4 支持的格式

| 格式 | 后缀 | 框架 | 隔离方式 |
|------|------|------|---------|
| Pickle | `.pkl` | sklearn/lightgbm/xgboost | gVisor 沙箱 |
| ONNX | `.onnx` | 跨框架 | ONNX Runtime |
| PyTorch | `.pt`, `.pth` | PyTorch | gVisor 沙箱 |
| TensorFlow | `.h5` | Keras/TF | gVisor 沙箱 |

### 5.5 限制

- 单文件最大 500MB
- 单用户最多 20 个上传模型
- smoke test 超时：30 秒
- 允许的 Python 依赖白名单：见平台文档

---

## 6. 第三方信号导入 API

### 6.1 `POST /api/v1/models/signals/import`

导入外部信号文件。

**Request**：`multipart/form-data`
- `file`: CSV/Parquet 文件
- `metadata`: JSON 字符串

**Metadata 格式**：
```json
{
  "name": "聚宽动量策略 v2 信号",
  "description": "来自聚宽研究的信号",
  "signal_format": "csv",
  "columns": {
    "datetime": "dt",
    "symbol": "code",
    "action": "direction",
    "confidence": "score"
  }
}
```

**响应 200**：
```json
{
  "data": {
    "model_id": "model_signal_xyz",
    "imported_rows": 12450,
    "date_range": ["2020-01-02", "2024-12-31"],
    "symbols_covered": 87,
    "warnings": []
  }
}
```

### 6.2 信号 CSV 格式

```csv
datetime,symbol,action,confidence
2024-01-02 09:30:00,600519,BUY,0.82
2024-01-02 09:30:00,000001,HOLD,0.50
2024-01-02 14:30:00,600519,SELL,0.65
```

支持字段：
- `datetime`: ISO 8601
- `symbol`: 股票代码
- `action`: `BUY` / `SELL` / `HOLD`
- `confidence`: 0 ~ 1
- `position_size`（可选）: 建议仓位 0 ~ 1

---

## 7. ⭐ 平台官方模型 API

**权限**：除 7.1 外，均需 `role: platform_admin`。

### 7.1 `GET /api/v1/models/official`

公开接口，任何人可调用。查询所有官方模型。

**Query Parameters**：
- `tier`: `baseline` / `experimental` / `premium`
- `category`: `momentum_follower` / `value_investor` / ...

**响应 200**：
```json
{
  "data": [
    {
      "id": "model_platform_momentum_v2",
      "name": "动量追踪者",
      "version": "v2.2025-Q2",
      "owner": "platform",
      "source": "official",
      "metadata": {
        "is_official": true,
        "official_tier": "baseline",
        "official_category": "momentum_follower",
        "doc_url": "/docs/models/momentum_follower",
        "source_code_url": "https://github.com/investdojo/official-models/momentum_follower",
        "maintainer": "platform_algo_team",
        "methodology": {
          "thesis": "追踪股票 20-60 日动量的经典策略",
          "features_used": ["ma_cross_20_60", "rsi_14", "volume_ratio"],
          "target": "relative_return_5d_gt_2pct",
          "training_window": ["2014-01-01", "2024-12-31"],
          "known_limitations": ["在趋势反转市效果差", "对小盘股信号较弱"]
        }
      },
      "validation_metrics": {
        "sharpe": 1.42,
        "annual_return": 0.183,
        "max_drawdown": -0.125
      }
    }
  ]
}
```

### 7.2 `POST /api/v1/models/official` （管理端）

创建一个官方模型。

**Request Body**：
```json
{
  "name": "动量追踪者",
  "algorithm": "lightgbm",
  "features": ["ma_cross_20_60", "rsi_14", "volume_ratio"],
  "target": { "type": "binary_classification", "spec": {...} },
  "training_range": ["2014-01-01", "2024-12-31"],
  "platform_extras": {
    "official_tier": "baseline",
    "official_category": "momentum_follower",
    "doc_url": "/docs/...",
    "source_code_url": "https://github.com/...",
    "maintainer": "platform_algo_team",
    "retrain_schedule": "quarterly",
    "methodology": { ... }
  }
}
```

**响应 202**：同 §4.1 的训练任务响应。

### 7.3 `POST /api/v1/models/official/{id}/retrain` （管理端）

触发官方模型的手动重训练。

**Request Body**：
```json
{
  "new_training_range": ["2014-01-01", "2025-12-31"],
  "bump_version": true
}
```

### 7.4 `PUT /api/v1/models/official/{id}/methodology` （管理端）

更新方法论文档（不影响模型本身，仅更新 metadata）。

### 7.5 `POST /api/v1/models/official/{id}/deprecate` （管理端）

标记官方模型为 deprecated。

**Request Body**：
```json
{
  "deprecation_notice": "本模型将在 2026-06-30 下线，推荐迁移到 momentum_v3",
  "successor_id": "model_platform_momentum_v3"
}
```

### 7.6 `POST /api/v1/models/official/{id}/rollback` （管理端）

回滚到某个旧版本。

---

## 8. 模型市场 API

### 8.1 `GET /api/v1/models/marketplace`

浏览公开模型市场（包含用户公开模型 + 官方模型）。

**Query Parameters**：
- `tab`: `official`（仅官方）/ `trending`（热门）/ `new`（最新）/ `top_performance`（表现最好）
- `category`: 分类筛选
- `sort`: `-usage_count` / `-validation_metrics.sharpe` / `-validation_metrics.last_30d_return`

**响应 200**：
```json
{
  "data": [
    {
      "id": "model_xxx",
      "name": "量价背离策略 v3",
      "owner": "user_yyy",
      "owner_display_name": "量化老王",
      "source": "internal",
      "is_official": false,
      "tags": ["反转", "短线"],
      "validation_metrics": { "sharpe": 1.35, "annual_return": 0.18 },
      "usage_count": 1240,
      "star_count": 89,
      "last_30d_performance": 0.064
    }
  ]
}
```

### 8.2 `GET /api/v1/models/marketplace/leaderboard`

统一排行榜（人机混排）。

**Query Parameters**：
- `period`: `7d` / `30d` / `90d` / `ytd` / `all`
- `metric`: `return` / `sharpe` / `winrate`
- `type`: `all` / `official` / `user`

**响应 200**：
```json
{
  "data": [
    {
      "rank": 1,
      "model_id": "model_xxx",
      "name": "多因子合成",
      "owner_type": "platform",
      "metric_value": 0.235,
      "is_official": true
    },
    {
      "rank": 2,
      "model_id": "model_yyy",
      "name": "用户 · 量价背离策略 v3",
      "owner_type": "user",
      "metric_value": 0.218
    }
  ]
}
```

### 8.3 `POST /api/v1/models/{id}/star`

收藏模型。

### 8.4 `DELETE /api/v1/models/{id}/star`

取消收藏。

### 8.5 `POST /api/v1/models/{id}/report`

举报模型（违规、误导等）。

---

## 9. 版本管理 API

### 9.1 `GET /api/v1/models/{id}/versions`

查询某个模型的所有版本。

**响应 200**：
```json
{
  "data": [
    { "version": "v3.0.0", "is_current": true, "created_at": "...", "metrics": {...} },
    { "version": "v2.1.0", "is_current": false, "created_at": "...", "metrics": {...} },
    { "version": "v1.0.0", "is_current": false, "status": "deprecated" }
  ]
}
```

### 9.2 `POST /api/v1/models/{id}/versions/{version}/activate`

切换当前版本（仅 owner 可操作）。

### 9.3 `GET /api/v1/models/{id}/versions/compare`

对比两个版本。

**Query Parameters**：
- `from`: 版本号
- `to`: 版本号

**响应 200**：
```json
{
  "data": {
    "from_version": "v2.1.0",
    "to_version": "v3.0.0",
    "metrics_diff": {
      "sharpe": { "from": 1.12, "to": 1.42, "delta": 0.30 },
      "annual_return": { "from": 0.15, "to": 0.18, "delta": 0.03 }
    },
    "features_added": ["sentiment_score_7d"],
    "features_removed": [],
    "algorithm_changed": false
  }
}
```

---

## 10. 错误码

| Code | HTTP | 说明 |
|------|------|------|
| `MODEL_NOT_FOUND` | 404 | 模型不存在 |
| `MODEL_PERMISSION_DENIED` | 403 | 无权访问此模型 |
| `MODEL_NAME_DUPLICATE` | 409 | 同名模型已存在 |
| `MODEL_IN_USE` | 409 | 模型被会话/回测使用中，不能删除 |
| `MODEL_OFFICIAL_READONLY` | 403 | 官方模型只能管理员操作 |
| `MODEL_UPLOAD_TOO_LARGE` | 400 | 超过 500MB |
| `MODEL_UPLOAD_FORMAT_INVALID` | 400 | 格式不支持 |
| `MODEL_SMOKE_TEST_FAILED` | 422 | 上传模型 smoke test 失败 |
| `MODEL_FEATURES_INVALID` | 400 | 依赖的因子不存在 |
| `MODEL_FEATURES_TOO_MANY` | 400 | 超过 50 个 |
| `MODEL_ALGORITHM_UNSUPPORTED` | 400 | 算法不支持 |
| `TRAINING_JOB_NOT_FOUND` | 404 | 训练任务不存在 |
| `TRAINING_DATA_INSUFFICIENT` | 422 | 训练数据不足 |
| `TRAINING_TIMEOUT` | 503 | 训练超时 |

---

## 11. 版本历史

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-04-28 | v1.0 | 初版 |
