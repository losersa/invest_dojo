# 模型回测页（/backtest）

> 2026-07-26 上线。训练结果页「用此模型回测 →」直达（带 `model_id`）。

## 功能

- **直达回测**：`?model_id=` 预填，选区间（默认近 6 个月）/股票池（沪深300/中证500/
  中证1000/全市场）/初始资金 → 一键 `run-fast` 同步回测
- **结果展示**：12 项汇总指标卡（总收益/年化/基准/超额/夏普/最大回撤/胜率/盈亏比/
  换手/交易次数/Calmar/Sortino）+ SVG 净值曲线（组合 vs 基准，无第三方图表依赖）
  + 最大回撤区间标注
- **历史回测**：最近 8 条 completed 记录（时间/模型/区间/收益/夏普）
- **引擎标注**：返回 `meta.engine` 以徽标展示（当前 backtest-svc 为 mock 引擎骨架，
  真实引擎接入后自动显示对应值）

## 链路

```
/backtest 页面 → sdk.backtests.runFast
  → POST /svc/backtest/api/v1/backtests/run-fast（同源代理 → backtest-svc:8004）
  → 写 backtests 表 + 返回 summary/equity_curve
历史列表 → GET /svc/backtest/api/v1/backtests?status=completed
```

## 相关改动（同日）

- 训练结果页「用此模型回测」由 `/sdk-demo`（API 测试页）改跳本页；
- 导航栏新增「模型回测」入口（`/train` 之后）；
- 模型文件下载改同源流式端点 `GET /svc/train/api/v1/training/models/{id}/file`
  （预签名 URL 指向 localhost:9000，远程浏览器不可达；且 DB file_path 带 bucket
  前缀导致双重前缀 NoSuchKey，`minio_client` 已统一剥前缀兜底）。

## 注意事项

- `run-fast` 有 30s 上限（413 BACKTEST_FAST_MODE_TOO_LARGE）：区间大 × 股票多
  时需缩短区间或换小股票池；异步 realistic 模式待真实引擎落地后开放页面入口。
- mock 引擎结果为随机种子合成数据，仅验证链路；不要据此评估模型真实表现。

## 真实回测引擎（2026-07-27 接入）

`strategy.type == "model"` 不再走 mock，由
`python-services/backtest-svc/real_engine.py` 执行：

- **模型加载**：`models` 表元数据 → `file_path` 从 MinIO 下载 →
  `lgb.Booster(model_str=...)` 重建。
- **特征复现**：跨服务复用 `train_svc.pipeline.build_dataset`，与训练完全一致
  （含 `target_symbol` 单只模式 + 同板块 peer 衍生特征）。**池参照系一致**：
  训练把股票池快照存 `models.metadata.symbols`，回测按同一池重算 peer 横截面
  特征；旧模型经 `training_job_id` 回溯训练配置。特征矩阵按
  `models.input_features` **原始顺序**重建、缺列补 NaN、以 numpy 传入
  ——训练用 numpy 喂模型，`booster.feature_name()` 只有 `Column_i`，
  不能按它对齐（踩坑 #23）。
- **信号口径**：`proba = booster.predict(X)`，`signal = proba >= cls_threshold`
  （训练保存的 Youden J 阈值），与训练评估严格一致。
- **资金模拟**：单只标的日频进出场，含手续费 0.03%/印花税 0.05%/滑点/T+1；
  基准默认 000300，库内无指数行情时自动退回目标股 buy&hold（meta.benchmark 标注）。
- **约束**：仅支持带 `metadata.target_symbol` 的单只预测模型；全市场面板模型
  返回明确错误（需 Top-N 组合逻辑，未实现）。factor/composite/signal_file 仍走 mock。
- **前端**：带 `?model_id=` 进入时股票池锁定「该模型预测股票」（`__model__`），
  结果区显示「引擎/标的」badge。
- **冒烟**：`python scripts/smoke_real_backtest.py [model_id] [start] [end]`
  （需 `SUPABASE_SERVICE_ROLE_KEY` 与 backtest-svc 运行中）。
