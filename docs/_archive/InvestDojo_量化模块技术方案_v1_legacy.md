# InvestDojo 量化模型模块 · 技术架构方案 v1.0

> 版本：v1.0 · 2026-04-28
> 定位：InvestDojo "道场"三大模块之二 — 量化 MLOps 平台
> 核心理念：**让人的直觉与模型的理性在同一张桌子上对话**

---

## 目录

- [0. 一页纸总览](#0-一页纸总览)
- [1. 定位与非目标](#1-定位与非目标)
- [2. 整体架构分层](#2-整体架构分层)
- [3. 数据层与特征工程（三层架构）](#3-数据层与特征工程三层架构)
- [4. 模型训练与接入（统一抽象）](#4-模型训练与接入统一抽象)
- [5. 回测引擎](#5-回测引擎)
- [6. 在线推理服务](#6-在线推理服务)
- [7. 模型生命周期与监控](#7-模型生命周期与监控)
- [8. 四种联动模式（独立章节）](#8-四种联动模式独立章节)
  - [8.1 模式 ① 并肩（AI 副驾）](#81-模式-并肩ai-副驾)
  - [8.2 模式 ② 对抗（PK 模式）](#82-模式-对抗pk-模式)
  - [8.3 模式 ③ 协作（Copilot）](#83-模式-协作copilot)
  - [8.4 模式 ④ 数据闭环（反哺训练）](#84-模式-数据闭环反哺训练)
- [9. 数据库设计](#9-数据库设计)
- [10. 技术栈与部署拓扑](#10-技术栈与部署拓扑)
- [11. 推进节奏与工作量评估](#11-推进节奏与工作量评估)
- [12. 风险与 Open Question](#12-风险与-open-question)

---

## 0. 一页纸总览

### 一句话定位
**InvestDojo 量化模块 = 可直接与模拟炒股模块联动的完整 MLOps 平台**。散户能在这里把模拟盘里的感觉变成模型，量化玩家能在这里把模型放进真实历史情境里接受人的挑战。

### 核心能力清单

| 能力 | 描述 |
|------|------|
| **特征库** | 内置 200+ 因子（技术/估值/成长/情绪），即选即用 |
| **特征组合器** | 拖拽式公式编辑器，普通用户也能造因子 |
| **Notebook** | 高级用户的 Python Notebook，全量因子 + 数据 API |
| **模型训练** | 内置 LightGBM/XGBoost/LSTM 一键训练 |
| **模型上传** | 支持 pkl/onnx/pt 上传部署 |
| **第三方接入** | 支持聚宽/米筐/Qlib 信号导入 |
| **回测引擎** | 向量化回测 + 事件驱动撮合，日级/分钟级两套 |
| **在线推理** | REST + WebSocket，毫秒级延迟 |
| **模型监控** | 表现跟踪、数据漂移告警、特征重要性演化 |
| **四种联动** | 副驾 / PK / Copilot / 数据闭环，与模拟炒股模块深度联动 |

### 四大联动模式一图读懂

```
模式①  并肩（AI副驾）     人下单 ├── 模型实时给建议（仅观察）
模式②  对抗（PK）        人下单 ├── 模型独立下单 ──── 终局对账
模式③  协作（Copilot）   人下单 ← 模型给建议 → 人采纳/拒绝 → 记录
模式④  数据闭环          人下单 → 操作样本入库 → 训练新模型
```

---

## 1. 定位与非目标

### 1.1 定位
- **它是什么**：面向个人投资者和量化爱好者的 MLOps 平台
- **它不是什么**：
  - 不是实盘交易系统（不对接券商，不下真实单）
  - 不是专业量化私募的生产系统（不追求纳秒级延迟、不做 T+0 高频）
  - 不是 AutoML 工具箱（不做超参搜索大包大揽）

### 1.2 用户画像
| 画像 | 能力水平 | 主要使用路径 |
|------|---------|------------|
| **散户 A** | 只懂 K 线 | 因子库 → 一键训练 → 副驾模式练手 |
| **量化新手 B** | 会 Python | 特征组合器 → 上传自己的模型 → 对抗模式 |
| **策略研究员 C** | 专业 | Notebook → 复杂特征 → 全流程回测 → Copilot 模式打磨 |
| **平台沉默大多数 D** | 只想看结果 | 查看热门模型排行榜，套用策略 |

### 1.3 非目标（明确不做）
- ❌ 多资产类别（仅 A 股，不做港股/美股/期货/数字货币）
- ❌ 高频策略（分钟级是粒度下限）
- ❌ 组合优化器（做纯选股和择时，不做 Markowitz 优化）
- ❌ 自动化策略搜索（不内置遗传算法/Auto-Factor）
- ❌ 实盘通道（只做回测和模拟推理）

---

## 2. 整体架构分层

```
┌─────────────────────────────────────────────────────────────┐
│                    UI 层（Next.js）                          │
│  ┌────────┬────────┬────────┬────────┬────────┐            │
│  │因子浏览│模型训练│回测分析│模型市场│联动控制│            │
│  └────────┴────────┴────────┴────────┴────────┘            │
└─────────────────────────────────────────────────────────────┘
                              ↓ ↑
┌─────────────────────────────────────────────────────────────┐
│            会话编排层（Session Orchestrator, Node）          │
│     管理人+模型共享同一份行情流、同步时钟、记录对账            │
└─────────────────────────────────────────────────────────────┘
                              ↓ ↑
┌──────────────────────────────────┬──────────────────────────┐
│    前端专用 API (Next.js Route)   │  Python 服务集群 (FastAPI)│
│                                  │                          │
│   · 用户/会话/订单管理              │  · feature-svc 特征计算  │
│   · 模型市场/排行榜                │  · train-svc 训练任务    │
│   · 协同模式日志                   │  · infer-svc 推理        │
│                                  │  · backtest-svc 回测     │
│                                  │  · monitor-svc 监控      │
└──────────────────────────────────┴──────────────────────────┘
                              ↓ ↑
┌─────────────────────────────────────────────────────────────┐
│                   数据层                                     │
│  Supabase (PostgreSQL)     Redis Cache       S3/对象存储     │
│  · 行情/新闻/财报           · 热门特征缓存      · 模型文件      │
│  · 因子定义                 · 推理结果缓存      · Notebook快照  │
│  · 用户模型元数据           · 会话状态          · 回测报告      │
└─────────────────────────────────────────────────────────────┘
```

### 关键设计原则

1. **Node 做编排，Python 做计算**
   - 前端对接 Next.js API（延续现有架构）
   - 所有重计算（训练/回测/推理）走 Python 微服务
   - 两端用 HTTP / gRPC / Redis Pub/Sub 通信

2. **统一的"信号"抽象**
   - 无论模型来自哪里（内训/上传/第三方），最终都输出统一格式的 `Signal`
   - `Signal = (timestamp, symbol, action, confidence, features)`
   - 联动层只认 Signal，不关心它从哪来

3. **会话编排是核心**
   - 人和模型共享"同一份真相"（时钟同步、数据同步、成交同步）
   - 这是超强联动能成立的技术前提

---

## 3. 数据层与特征工程（三层架构）

### 3.1 数据层基础

已有（在模拟炒股模块建好的基础上扩展）：
- `klines_all`：日 K + 5m K（已 69984 条真实 5m，待扩到全 A 股 2014-至今）
- `news`：新闻事件流（已 49 条，待扩展为全量）
- `scenarios`：历史情景元数据

新增：
- `fundamentals`：财务数据（资产负债表/利润表/现金流，季度更新）
- `market_snapshot`：市场快照（指数、板块涨跌、北向资金）
- `feature_values`：预计算的因子值矩阵（稀疏存储）

### 3.2 三层特征体系

#### Layer 1 · 因子库（小白层）
内置 200+ 因子，开箱即用。分四大类：

| 大类 | 数量 | 举例 |
|------|------|------|
| **技术类** | ~80 | MA/EMA/BOLL/MACD/KDJ/RSI/OBV/动量/波动率 |
| **估值类** | ~40 | PE/PB/PS/PCF/EV-EBITDA/股息率 |
| **成长类** | ~40 | 营收同比/净利同比/ROE/ROA/毛利率演化 |
| **情绪类** | ~40 | 换手率/龙虎榜上榜次数/北向持仓变化/新闻情感分数 |

**因子定义格式**（YAML，存库）：
```yaml
id: ma_cross_20_60
name: 20日均线上穿60日均线
category: technical
formula: |
  MA(close, 20) > MA(close, 60) and
  MA(close, 20).shift(1) <= MA(close, 60).shift(1)
output_type: boolean
lookback_days: 60
version: 1
```

#### Layer 2 · 可视组合器（中级层）

拖拽式界面 + 公式栏，让不会 Python 的用户也能造因子。
核心交互：

```
┌──────────────────────────────────────────────────────┐
│ 🧪 新因子：放量突破                                    │
├──────────────────────────────────────────────────────┤
│                                                      │
│   [成交量] 今日 > [成交量] MA(20) × 1.5              │
│        AND                                           │
│   [收盘价] 今日 > [最高价] MAX(20)                    │
│                                                      │
│   ┌─ 回测样本 ─────────────────────────┐             │
│   │ 2014-2025 全 A 股触发 12,340 次     │             │
│   │ 触发后 20 日胜率 58.2%               │             │
│   │ 平均涨幅 +3.8%                      │             │
│   └────────────────────────────────────┘             │
│                                                      │
│   [保存] [加入我的因子库] [导出 Python 代码]            │
└──────────────────────────────────────────────────────┘
```

底层：编辑器产出 AST（抽象语法树），服务端转为 Pandas 表达式执行。

#### Layer 3 · Notebook（高级层）

JupyterLite（浏览器内运行的 Python）+ 平台 SDK：

```python
from investdojo import Data, Feature, Backtest

# 取数据（已认证、已缓存）
df = Data.klines(symbols=['600519'], start='2020-01-01', end='2023-12-31')

# 自定义特征
df['my_signal'] = (
    df['close'].rolling(5).mean() > df['close'].rolling(20).mean()
) & (df['volume'] > df['volume'].rolling(20).mean() * 1.5)

# 注册为平台因子（可选）
Feature.register(
    id='my_signal_v1',
    definition=df['my_signal'],
    description='我自己造的信号'
)

# 直接回测
result = Backtest.run(
    signal=df['my_signal'],
    symbols=['600519'],
    initial_capital=100_000,
)
result.show()
```

好处：
- 用户的代码可以一键发布为公共因子
- 平台的 SDK 屏蔽了鉴权、缓存、接口变化
- JupyterLite 不需要服务端 Python 实例（降低基础设施成本）

### 3.3 特征计算与存储

- **预计算模式**（热门因子）：夜间定时任务，把所有股票的因子值算好存 `feature_values`
- **即时计算模式**（自定义因子）：触发时计算，结果入 Redis 缓存 2 小时
- **增量更新**：每日收盘后增量计算当天的新数据

---

## 4. 模型训练与接入（统一抽象）

### 4.1 核心抽象：`Model`

无论模型从哪里来，都必须实现以下接口：

```python
class Model(ABC):
    name: str
    version: str
    input_features: List[str]     # 需要哪些因子
    output_type: Literal['classification', 'regression', 'rank']
    
    def predict(self, features: DataFrame) -> DataFrame:
        """输入特征矩阵，输出 (symbol, timestamp, score/class)"""
        pass
    
    def to_signal(self, prediction: DataFrame) -> List[Signal]:
        """把 predict 结果转成统一 Signal 格式"""
        pass
```

### 4.2 三种模型来源

#### 来源 A · 平台内训练
支持的算法（按难度排序）：
- **Tree 系**：LightGBM、XGBoost、Random Forest
- **线性系**：Logistic Regression、Ridge、Lasso
- **深度学习**：LSTM、Transformer（时间序列专用）

训练流程：
```
1. 选因子（Layer 1/2/3 任一）
   ↓
2. 选标签（未来 N 日涨跌 / 未来 N 日相对收益 / 未来 N 日最大回撤...）
   ↓
3. 选训练区间 + 验证区间（自动防止未来函数）
   ↓
4. 选算法 + 简单超参（不做复杂搜索）
   ↓
5. 后台训练（Python Celery Worker）
   ↓
6. 训练完成推送 → 用户查看评估报告
   ↓
7. 一键发布（可私有/可公开/可上市场）
```

**前端界面（训练向导）**：
```
Step 1: 因子   ☑ MA5/MA20/MA60  ☑ RSI14  ☐ BOLL  ... [已选 18 个]
Step 2: 标签   未来 [5] 个交易日 [相对收益 ▼] 超过 [2%] = 正样本
Step 3: 区间   训练: 2014-01-01 ~ 2021-12-31   验证: 2022-01-01 ~ 2023-12-31
Step 4: 算法   LightGBM (推荐新手)
Step 5: 命名   "我的第一个模型 v1"
             [开始训练]  预计 3 分钟
```

#### 来源 B · 用户上传

支持格式：
- `.pkl`（sklearn/lightgbm/xgboost）
- `.onnx`（任意跨框架）
- `.pt` / `.pth`（PyTorch）
- `.h5`（TensorFlow/Keras）

上传时需要提供：
1. 模型文件（对象存储）
2. 特征声明（`input_features: ['ma5', 'rsi14', ...]`）
3. 调用入口（默认 `model.predict(X)` ，可自定义）
4. 依赖版本（打包到 Dockerfile，运行在沙箱容器）

**安全考虑**：
- 上传的模型必须在**隔离容器**运行（gVisor / Firecracker）
- 不允许访问网络
- 只暴露平台提供的数据 API
- CPU / 内存 / 执行时间配额

#### 来源 C · 第三方策略信号

用户提供信号文件（CSV/Parquet）：
```csv
datetime,symbol,action,confidence
2024-01-02 09:30,600519,BUY,0.82
2024-01-02 09:30,000001,HOLD,0.50
...
```

平台不关心这些信号怎么来的（Qlib/聚宽/米筐/手工研究都行），只关心格式合规。
适用场景：用户已经在别的平台做了研究，想把结果拿到 InvestDojo 的联动环境里 PK。

### 4.3 模型注册表（Model Registry）

统一的元数据：
```json
{
  "id": "model_abc123",
  "name": "我的 LightGBM v3",
  "version": "3.0.1",
  "owner": "user_xxx",
  "source": "internal" | "uploaded" | "external_signal",
  "input_features": ["ma5", "ma20", "rsi14"],
  "target": "relative_return_5d_gt_2pct",
  "training_range": ["2014-01-01", "2021-12-31"],
  "validation_metrics": {
    "accuracy": 0.56, "auc": 0.62, "ic": 0.08
  },
  "visibility": "private" | "public" | "marketplace",
  "created_at": "...",
  "last_used_at": "...",
  "usage_count": 42
}
```

---

## 5. 回测引擎

### 5.1 两种模式

#### 模式 1：向量化回测（Fast Mode）
- 用 Pandas/NumPy 直接算向量
- 假设完美成交（不撮合）
- 毫秒级返回结果
- 适合：调参阶段、批量比较多个策略

#### 模式 2：事件驱动回测（Realistic Mode）
- 逐根 K 线推进，撮合引擎模拟真实成交
- 支持滑点、手续费、涨跌停、停牌
- 秒级~分钟级返回（取决于区间长度）
- 适合：最终评估、联动模式前的准备

### 5.2 评估指标（多维度）

不只看收益率！输出一个**评估雷达图**：

```
              收益率
               ●
          ╱      ╲
    胜率         夏普率
      ●           ●
     ╱             ╲
   IC             卡玛比率
    ●               ●
      ╲           ╱
        ●——————●
      换手率    最大回撤
```

关键指标解释：
- **IC（信息系数）**：预测值与实际收益的相关性（-1 ~ 1）
- **夏普率**：单位风险下的超额收益
- **卡玛比率**：年化收益 / 最大回撤
- **换手率**：平均持仓周期（太高说明策略在频繁折腾）

### 5.3 回测报告页面

```
┌─ 模型：我的 LightGBM v3 · 回测 #42 ─────────────────┐
│                                                   │
│  📊 核心指标                                       │
│  年化收益 +18.3%  |  最大回撤 -12.5%  |  夏普 1.42 │
│                                                   │
│  📈 净值曲线（vs 基准）                             │
│  [图：模型 / 上证指数 / 沪深300 三条线]              │
│                                                   │
│  🔥 分段表现                                       │
│  牛市 +31% (2020-2021)  熊市 -5% (2022)          │
│                                                   │
│  🎯 特征重要性                                     │
│  [柱状图：20 个特征按 SHAP 值排序]                  │
│                                                   │
│  🧪 决策日志                                       │
│  [表格：所有买卖点，可点击看当时的特征值]             │
│                                                   │
│  [进入联动模式 →]  [发布到市场]  [一键分享报告]       │
└───────────────────────────────────────────────────┘
```

---

## 6. 在线推理服务

### 6.1 三种推理方式

#### 批量推理（offline）
用于：回测、因子预计算
接口：`POST /predict/batch { model_id, feature_matrix }` → 批量结果

#### 请求响应推理（online）
用于：模型市场的试算、即时查询
接口：`POST /predict { model_id, features }` → 单次结果
目标延迟：< 50ms

#### 流式推理（streaming）
用于：**联动模式的核心**
协议：WebSocket / Server-Sent Events
场景：用户每次切换 K 线、每次模拟时间推进，都会推一条新的 Signal

```
Client                          Infer Service
  │  ──── 订阅(model_id, session_id) ──→ │
  │                                      │
  │  ←─── Signal(ts, symbol, ...)  ───── │  ← 首次立即推
  │                                      │
  │  ──── 时间推进事件(ts) ─────────────→ │
  │  ←─── Signal(ts, symbol, ...)  ───── │  ← 每次推进都推
  │  ←─── Signal(ts, symbol, ...)  ───── │
```

### 6.2 推理服务拓扑

```
                 LoadBalancer
                      │
           ┌──────────┼──────────┐
           ↓          ↓          ↓
        Infer      Infer       Infer
        Worker     Worker      Worker
           ↓          ↓          ↓
        Model      Model       Model
        Cache      Cache       Cache
    (热门模型加载到内存)
```

- 使用 Ray Serve 或 Triton Inference Server
- 热门模型常驻内存（LRU 缓存）
- 冷门模型按需加载（慢一些，但不占资源）

### 6.3 严格防未来函数

联动模式的致命红线：**模型在 T 时刻决策时绝不能看到 T+1 的数据**。

实现方式：
- 数据 API 有严格的 `as_of` 参数
- 推理服务在调用数据层时，永远传入当前会话时钟
- 单元测试 + CI 检查：尝试在 T 时刻查 T+1 数据会抛异常

---

## 7. 模型生命周期与监控

### 7.1 模型状态机

```
   [训练中] ──训练完成──→ [已训练] ──发布──→ [已发布]
                              │              │
                              └─弃用────┐     │
                                       ↓     │
                                   [已弃用]←──┘
```

### 7.2 监控维度

| 维度 | 告警条件 | 动作 |
|------|---------|------|
| **推理表现** | 过去 30 天收益 vs 上证差值 < -10% | 推送邮件 + 标红 |
| **数据漂移** | 当前特征分布与训练集 KL 散度 > 阈值 | 建议重新训练 |
| **特征可用性** | 某因子连续 3 天计算失败 | 触发补数任务 |
| **推理延迟** | P99 > 500ms | 扩容推理节点 |
| **调用量** | 某模型 7 天无调用 | 移出热缓存 |

### 7.3 模型版本管理

每个模型的每次训练都产生一个新版本（MLflow 风格）：

```
my_lgbm_model
├── v1 (2026-01-15)  AUC 0.58  [已弃用]
├── v2 (2026-02-20)  AUC 0.61
├── v3 (2026-03-10)  AUC 0.63  [当前生产]
└── v4 (2026-04-05)  AUC 0.60  [A/B 测试中]
```

用户可以：
- 对比任意两个版本的回测表现
- 在联动模式中选择用哪个版本
- 回滚到历史版本

---

## 8. 四种联动模式（独立章节）

### 通用前置：会话编排层

所有联动模式都依赖 **Session Orchestrator**，它负责：

1. **时钟同步**：人和模型看到的"当前时间"必须严格一致
2. **数据广播**：每次时间推进，把新 K 线 / 新新闻广播给所有参与者
3. **事件记录**：所有操作（人下单、模型信号、成交结果）统一入库
4. **结束对账**：会话结束时生成复盘报告

数据模型：
```
Session {
  id, scenario_id, user_id,
  mode: 'solo' | 'copilot' | 'pk' | 'observe',
  participants: [
    { type: 'human', id: 'user_xxx' },
    { type: 'model', model_id: 'abc123', version: 'v3' }
  ],
  clock: { current_ts, start_ts, end_ts },
  initial_capital: 100000,
  status: 'running' | 'paused' | 'finished'
}
```

---

### 8.1 模式 ① 并肩（AI 副驾）

#### 用户故事
> 小明在做盲测模拟，右侧有一个 AI 副驾面板，每当他翻页或切 K 线时，面板都会实时显示："模型建议买入，置信度 72%"。他可以看、可以忽略，但模型不会替他下单。

#### 数据流
```
User ──切换日期──→ Frontend
                     ↓
                  Session Orchestrator
                     ↓
             ┌──────┴──────┐
             ↓             ↓
       Data Service   Infer Service（流式）
             ↓             ↓
           K线/新闻      Signal
             └──────┬──────┘
                    ↓
                 Frontend（更新副驾面板）
```

#### 前端界面形态
```
┌─ 盲测进行中 ─────────────────────────────────────┐
│ [K线大图]                                       │
│                                                 │
│ ┌─ 你的交易面板 ──┐  ┌─ 🤖 AI 副驾 · LGB-v3 ──┐ │
│ │                │  │                         │ │
│ │ 买入 / 卖出    │  │ 当前信号：买入            │ │
│ │                │  │ 置信度：72%              │ │
│ │                │  │                         │ │
│ │                │  │ 为什么？                 │ │
│ │                │  │ ✓ 20日均线突破60日均线    │ │
│ │                │  │ ✓ 成交量放大 1.8 倍       │ │
│ │                │  │ ✗ RSI 已接近 70（过热）   │ │
│ │                │  │                         │ │
│ │                │  │ [切换模型]                │ │
│ └────────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

#### 后端接口
- `POST /api/session/copilot/start { scenario_id, model_id }` → 建立副驾会话
- WebSocket `/ws/session/{sid}/signals` → 订阅信号流
- `POST /api/session/{sid}/tick { ts }` → 时间推进

#### 难点
- 推理延迟：用户翻一天 K 线就要推新信号，必须 < 200ms
- 特征解释：每个信号要附带"为什么"，需要预计算 SHAP 值
- 模型选择：用户可能中途换模型，会话要支持热切换

#### 工作量
约 **2~3 周**

---

### 8.2 模式 ② 对抗（PK 模式）

#### 用户故事
> 小红选了她训好的 LSTM 模型和自己来一场 PK。开场时两人拿相同的 10 万本金，看同一份 K 线和新闻。60 天后系统给出对账：小红 +4.82%，模型 +7.13%，模型在回撤控制上明显更好。最震撼的是"决策一致度 47%"——小红发现自己经常和模型反着做，而且往往是自己错了。

#### 数据流
```
Session Start
    ↓
┌── 人（UI下单）──→ Order Book ←── 模型（API下单）──┐
│                      ↓                          │
│                 撮合引擎                          │
│                      ↓                          │
│              两套 Portfolio 记录                  │
│                      ↓                          │
└─── 时间推进 ──→ 下一个 tick ─────────────────────┘
```

#### 公平竞赛机制
为保证 PK 公平，几个关键设计：

1. **同时决策**：每个 tick 人和模型都必须在 X 秒内完成决策，超时视为持仓不变
2. **同数据集**：两者看到的数据严格一致，通过 Session Orchestrator 分发
3. **同撮合规则**：使用同一套滑点/手续费/涨跌停规则
4. **事后审计**：每个决策都记录下当时能看到的全部信息，可追溯

#### 终局对账界面
```
┌─ PK 结果 · 盲测 #a7f42b ────────────────────────┐
│                                                 │
│              人类玩家            AI 模型          │
│  收益        +4.82%  🥈         +7.13%  🥇       │
│  最大回撤    -8.3%              -5.1%            │
│  夏普率      0.82               1.35             │
│  交易次数    5                  22               │
│                                                 │
│  🎯 决策一致度：47%                              │
│  [折线图：两条持仓曲线叠加]                       │
│                                                 │
│  📍 关键分歧点：                                 │
│  DAY 12 · 人卖出 / 模型买入 → 此后 +8%          │
│  DAY 32 · 人止损 / 模型加仓 → 此后 +18%          │
│  DAY 45 · 人观望 / 模型止盈 → 正确               │
│                                                 │
│  [看每一笔分歧的详细对比]                         │
└─────────────────────────────────────────────────┘
```

#### 难点
- **严格的时间对齐**：人和模型的决策都必须发生在**同一个 tick 内**，否则模型有先发优势
- **撮合公平性**：如果两个都下单，谁先成交？→ 使用 FIFO 规则
- **模型推理超时**：模型 5 秒没给信号就视为"持有"
- **反作弊**：模型不能通过缓存看到未来数据（通过 `as_of` 强制）

#### 工作量
约 **3~4 周**

---

### 8.3 模式 ③ 协作（Copilot）

#### 用户故事
> 老王用 Copilot 模式做模拟，每次下单前模型都会先给出建议。老王看完决定采纳还是拒绝。一个月后系统告诉他：你在"牛市阶段"拒绝模型建议的时候胜率 72%，在"熊市阶段"拒绝模型建议的时候胜率只有 35%——也就是说你在恐慌市场里应该更信任模型。

#### 界面交互
```
用户点击"买入"之前：
   ↓
┌─ 🤖 AI 建议 ──────────────────────┐
│ 模型推荐：买入 100 股 @ ¥108      │
│ 置信度：72%                       │
│                                   │
│ 你的操作："买入 100 股 @ ¥108"    │
│                                   │
│ ○ 完全采纳模型建议                 │
│ ● 微调（数量/价格）                │
│ ○ 完全拒绝（按我的来）              │
│                                   │
│ [确认下单]                        │
└───────────────────────────────────┘
```

#### 决策日志
每次"人 vs 模型"的分歧都被记录：
```json
{
  "session_id": "xxx",
  "timestamp": "2020-02-05 09:30",
  "symbol": "600519",
  "market_context": {
    "phase": "panic",           // 恐慌期 / 平静期 / 贪婪期
    "index_trend": "down",
    "volatility": "high"
  },
  "model_suggestion": { "action": "buy", "qty": 100, "conf": 0.72 },
  "user_action":     { "action": "buy", "qty": 50 },
  "decision_type":   "partial_accept",
  "future_pnl_5d":   "+6.8%",     // 5 日后的真实表现（用于评估）
  "verdict":         "model_right_partial"
}
```

#### 个性化洞察
积累 N 个会话后，系统能分析出用户的行为模式：

```
👤 你的 AI 采纳画像（基于 42 次会话）

🎯 总体：
   完全采纳 32%  ·  部分采纳 48%  ·  完全拒绝 20%

📊 按市场环境细分：
   恐慌期：采纳 68%（胜率 72%，建议继续信任模型）
   平静期：采纳 41%（胜率 58%，表现均衡）
   贪婪期：采纳 25%（胜率 38%，⚠️ 过度自信时期）

🧠 最大盲点：
   你在"放量上涨"时 82% 拒绝模型止盈建议
   但这些决策事后胜率只有 31%
```

#### 难点
- 需要积累足够多的会话（单人 40+ 次）才能出有意义的洞察
- 需要对"市场环境"做自动分类（恐慌/平静/贪婪）

#### 工作量
基于模式 ① 扩展，约 **1~2 周**

---

### 8.4 模式 ④ 数据闭环（反哺训练）

#### 用户故事
> 小李做了 50 局盲测，平台提示他："我们用你的交易数据训了一个'小李风格模仿器'模型。在 2023 年的回测里它和你的表现高度一致（相关性 0.87）。"小李在与它 PK 时发现，它在自己的弱点上犯同样的错——于是小李有了一面镜子，可以清楚看到自己的决策模式。

#### 样本生成器

每个人在模拟中的每次下单都可以变成一条样本：

```python
Sample {
    # 输入特征（当时可见的市场状态）
    features: {
        'symbol': '600519',
        'ma5_over_ma20': True,
        'volume_ratio': 1.8,
        'news_sentiment_7d': -0.3,
        'index_trend_30d': -0.05,
        ...  # 共 50+ 个因子
    },
    
    # 标签（用户的决策）
    label: 'buy_heavy',  # buy_heavy / buy_light / hold / sell_light / sell_heavy
    
    # 上下文（用于后续评估）
    context: {
        'session_id': 'xxx',
        'timestamp': '2020-02-05 09:30',
        'future_return_5d': 0.063,  # 后视镜
        'future_return_20d': 0.124,
    }
}
```

#### 用户数据用途（三种）

**用途 A：个性化模型（模仿用户）**
- 训练目标：给定市场状态，预测这个用户会怎么操作
- 用途：生成"你的数字孪生"，作为对照
- 隐私：仅用户自己可见，永远不公开

**用途 B：群体智慧（聚合）**
- 训练目标：给定市场状态，预测"优秀交易者群体"的共识决策
- 筛选：只用会话收益率 Top 20% 的样本
- 隐私：严格脱敏（去掉 user_id，只保留行为）
- 用户可选：是否贡献自己的数据到公共池

**用途 C：纠错模型**
- 训练目标：给定"用户打算做 X"，预测这是不是错误决策
- 用途：Copilot 模式的"刹车"——当你准备下单时，它会说"历史上类似情境下你做这个决策，5 天后通常会后悔"

#### 隐私与合规

- **默认私有**：用户所有样本默认只自己可见
- **显式授权**：想贡献公共池必须签署知情同意
- **严格脱敏**：公共池里去除时间戳、会话 ID、任何个人可识别信息
- **一键删除**：用户可以随时删除自己的全部历史样本

#### 工作量

纯数据收集：**1 周**
加上训练框架：**2~3 周**

---

## 9. 数据库设计

### 9.1 新增表清单

```sql
-- 因子定义表
CREATE TABLE factor_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,  -- technical/value/growth/sentiment
    formula TEXT NOT NULL,  -- YAML 或 Python 表达式
    output_type TEXT,  -- boolean/scalar/rank
    lookback_days INT,
    version INT DEFAULT 1,
    owner TEXT,  -- NULL = 平台内置
    visibility TEXT DEFAULT 'public',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 因子值矩阵（预计算结果）
CREATE TABLE feature_values (
    factor_id TEXT,
    symbol TEXT,
    dt DATE,
    value NUMERIC,
    PRIMARY KEY (factor_id, symbol, dt)
);
CREATE INDEX idx_feature_values_date ON feature_values(dt, factor_id);

-- 模型注册表
CREATE TABLE models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    owner TEXT,
    source TEXT,  -- internal/uploaded/external_signal
    input_features JSONB,
    target TEXT,
    training_range JSONB,
    validation_metrics JSONB,
    file_path TEXT,  -- 对象存储路径
    visibility TEXT DEFAULT 'private',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ,
    usage_count INT DEFAULT 0
);

-- 回测结果
CREATE TABLE backtests (
    id TEXT PRIMARY KEY,
    model_id TEXT REFERENCES models(id),
    config JSONB,  -- 时间/股票池/初始资金等
    metrics JSONB,  -- 收益/回撤/夏普/IC 等
    equity_curve JSONB,  -- 净值时间序列
    trades JSONB,  -- 所有交易日志
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 会话表（联动模式核心）
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    scenario_id TEXT,
    mode TEXT,  -- solo/copilot/pk/observe
    participants JSONB,  -- 参与者列表
    clock_start TIMESTAMPTZ,
    clock_end TIMESTAMPTZ,
    clock_current TIMESTAMPTZ,
    initial_capital NUMERIC,
    status TEXT,
    result_summary JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 会话事件日志（每次下单、信号、tick 都记录）
CREATE TABLE session_events (
    id BIGSERIAL PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id),
    ts TIMESTAMPTZ,
    actor_type TEXT,  -- human/model
    actor_id TEXT,
    event_type TEXT,  -- order/signal/tick/accept/reject
    payload JSONB
);
CREATE INDEX idx_session_events ON session_events(session_id, ts);

-- 训练样本（Mode ④）
CREATE TABLE training_samples (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT,
    session_id TEXT,
    ts TIMESTAMPTZ,
    features JSONB,
    label TEXT,
    context JSONB,
    shared_to_public BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 9.2 Redis 缓存设计

```
HOT_MODELS                 Set       常驻内存的模型 ID 列表
model:{id}:meta           Hash      模型元数据
feature:{id}:{symbol}:latest  String    因子最新值
session:{id}:state        Hash      会话实时状态
session:{id}:signals      List      信号缓冲区
```

### 9.3 对象存储

```
s3://investdojo/
├── models/
│   ├── {model_id}/
│   │   ├── v1/
│   │   │   ├── model.pkl
│   │   │   ├── metadata.json
│   │   │   └── requirements.txt
│   │   └── v2/...
├── notebooks/
│   └── {user_id}/{notebook_id}.ipynb
└── backtest_reports/
    └── {backtest_id}.html
```

---

## 10. 技术栈与部署拓扑

### 10.1 新增技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| Python 微服务框架 | FastAPI | 异步、自动 OpenAPI、性能好 |
| 任务队列 | Celery + Redis | 成熟、文档丰富 |
| 推理服务 | Ray Serve | 原生支持模型热加载、自动扩缩容 |
| 特征计算 | Pandas + NumPy + Polars | 快 |
| 模型训练 | LightGBM + PyTorch + sklearn | 主流组合 |
| 模型容器 | Docker + gVisor | 隔离用户上传的模型 |
| Notebook | JupyterLite | 浏览器内运行，无需服务端 |
| 对象存储 | MinIO（自建）或 Supabase Storage | 就近选择 |
| 监控 | Prometheus + Grafana | 标配 |

### 10.2 部署拓扑（最小集群）

```
┌─ 前端层 (Vercel/自建) ─────────────────────┐
│  Next.js App                             │
└──────────────┬───────────────────────────┘
               │
┌──────────────┴───────────────────────────┐
│  Session Orchestrator (Node 长连接)        │
│  · 1~2 个实例，Nginx 负载均衡               │
└──────────────┬───────────────────────────┘
               │
┌──────────────┴───────────────────────────┐
│  Python 微服务（Docker Compose/K8s）       │
│  ┌──────────────┬──────────────┐         │
│  │ feature-svc  │ train-svc    │         │
│  │  (2 实例)     │  (1 实例+队列) │         │
│  ├──────────────┼──────────────┤         │
│  │ infer-svc    │ backtest-svc │         │
│  │  (2~4 实例)   │  (1 实例)     │         │
│  └──────────────┴──────────────┘         │
└──────────────┬───────────────────────────┘
               │
┌──────────────┴───────────────────────────┐
│  数据层                                    │
│  Supabase (Postgres)    Redis    MinIO   │
└───────────────────────────────────────────┘
```

### 10.3 Mac 开发环境（单机启动）

考虑你一个人 Mac 开发：

```bash
# 1. 数据层（本地）
docker-compose up -d redis minio

# 2. Python 服务（venv）
cd services/
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 3. 并行启动所有服务
make dev  # 用 honcho/foreman 并行 8 个进程
```

所有服务加起来 Mac 上 8GB 内存足够跑。

---

## 11. 推进节奏与工作量评估

### 11.1 分阶段里程碑

```
Phase 0  数据准备 + 基础设施               [1~2 周]
├── 扩展数据到 2014-至今全 A 股
├── 搭建 Python 服务骨架
└── Redis / MinIO / Docker 环境

Phase 1  因子库 + 基础回测                [2~3 周]
├── 内置 200 个因子上线
├── 因子浏览 + 可视化页面
└── Fast Mode 向量化回测

Phase 2  模型训练 + Marketplace            [3~4 周]
├── LightGBM 一键训练
├── 上传模型（pkl/onnx）
├── 模型市场（公开模型排行）
└── 回测报告页面

Phase 3  联动模式 ①（AI 副驾）             [2~3 周]
├── 会话编排层
├── 流式推理服务
└── 副驾面板前端

Phase 4  联动模式 ④（数据闭环）            [1 周]
└── 样本收集（不训练，先攒数据）

Phase 5  联动模式 ③（Copilot）             [1~2 周]
└── 采纳/拒绝 + 决策日志

Phase 6  可视组合器 + Notebook            [3~4 周]
├── 拖拽式因子编辑器
└── JupyterLite 集成

Phase 7  联动模式 ②（PK）                 [3~4 周]
├── 公平竞赛机制
├── 时间对齐 / 撮合公平
└── 终局对账界面

Phase 8  监控 + 优化                       [持续]
├── Prometheus + Grafana
└── 模型表现追踪
```

**总计：约 16~23 周（4~6 个月）一个人全职**。

### 11.2 建议的 MVP 路径（压缩版）

如果想 2~3 个月内出一个能看的版本：

```
MVP (10~12 周)
├── Phase 0 数据 + 基础设施      [2周]
├── Phase 1 因子库 + 回测        [2周]
├── Phase 2 只做平台内训练       [3周]  (砍掉上传和第三方)
├── Phase 3 联动副驾            [2周]
└── Phase 4 数据收集             [1周]
```

然后根据反馈决定继续哪个方向。

### 11.3 先砍什么

为了 MVP 能快速上线，建议先不做：
- ❌ 可视化因子组合器（用 Notebook 代替）
- ❌ 模型上传（只做平台内训练）
- ❌ 第三方信号接入（先看有没有人要）
- ❌ PK 模式（公平竞赛机制复杂）
- ❌ Copilot 模式（依赖数据积累）

先做 ①副驾 和 ④数据闭环，因为：
- ①副驾 单机就能跑，验证"人会不会看模型建议"
- ④数据闭环 零风险，先把数据攒起来，以后想做什么都有料

---

## 12. 风险与 Open Question

### 12.1 技术风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| 推理延迟大 | 副驾模式体验差 | 预计算信号 + Redis 缓存 |
| 用户上传模型安全 | 系统被攻击 | gVisor 沙箱 + 资源配额 |
| 训练任务阻塞 | 用户等太久 | Celery 队列 + 进度通知 |
| Supabase 存储成本 | 全 A 股 5m 数据很大 | 冷数据迁 S3 + 分区 |
| 推理服务崩溃 | 联动模式失效 | 多副本 + 健康检查 |

### 12.2 产品风险

| 风险 | 问题 | 思考方向 |
|------|------|--------|
| 因子太多用户不会选 | 因子库成摆设 | 提供"因子组合模板" |
| 训练出来的模型都差不多 | 没有差异化 | 强调盲测情境下的差异 |
| 联动模式没人用 | 功能空壳 | 先在 Beta 用户群强推 |
| 数据漂移难以察觉 | 模型悄悄变差 | 默认开启监控，有问题自动提示 |

### 12.3 Open Questions（需你决策）

1. **是否支持 T+0 回测**？A 股是 T+1，但 5m 数据能支持日内回测，要不要做？
2. **交易费率默认值**？万三佣金 + 千一印花税？还是可配置？
3. **市场市值范围**？全 A 股（5000+）还是只做沪深 300？数据量差 20 倍。
4. **模型市场要不要做付费机制**？发布者能否从调用中收益？
5. **联动模式 ② PK 是否做排行榜**？把人和模型混在一起排名？
6. **Notebook 的算力限制**？用户能否调用 GPU？

这些问题答案不同，工作量能差一倍。建议先按"简单默认"推进，后续逐项讨论。

---

## 附录 A：关键数据流示意（文字版）

### A.1 因子计算流
```
每日收盘后（17:00）
    ↓
Celery 定时任务
    ↓
取当天 K 线 + 财报（增量）
    ↓
遍历所有"预计算因子"
    ↓
写入 feature_values 表
    ↓
Redis 发布"factor_updated"事件
    ↓
在线推理服务收到事件，刷新缓存
```

### A.2 联动模式数据流
```
用户进入盲测（模式①）
    ↓
Next.js 调 Session Orchestrator /start
    ↓
Orchestrator 创建 Session
    ↓
订阅：feature-svc 流、infer-svc 流、data-svc 流
    ↓
返回 WebSocket URL
    ↓
前端建立 WS 连接
    ↓
用户每次"下一天"：
    - 前端发送 tick 事件
    - Orchestrator 推进时钟
    - 广播新数据给所有参与者
    - infer-svc 计算模型信号
    - Orchestrator 把信号推给前端
    - 前端更新副驾面板
    ↓
会话结束：
    - 落库所有事件
    - 生成对账报告
    - 返回复盘页 URL
```

---

**文档结束** · 1500 行 · 通读约 40 分钟

读完后欢迎反馈：
- 哪些模块优先级要调整
- 哪些 Open Question 需要先定
- MVP 路径是否合理
- 技术栈有没有想换的

下一步根据你的反馈：
1. 细化优先级最高的模块（拆成小任务）
2. 写该模块的 API 规范
3. 开始写代码
