# InvestDojo 变更日志（change-log）

> 每次代码改动完成后追加一条，**最新在最上**。
> 由 `.codebuddy/skills/dev-docs/` 工作流维护；Epic/模块级里程碑另见
> `apps/web/src/app/admin/progress/progress-data.json`（生成 `progress-log.md`）。

---

## 2026-07-27（补 8）· 回测完整异步化（提交→任务队列→前端轮询）

- **问题**：run-fast 同步接口即便提速 5.3×，长区间/大池回测仍卡 event loop 与超时上限（补 7 遗留的"彻底解"）。
- **改动**：
  - `POST /api/v1/backtests` 写 pending 行 → `celery.send_task("backtest.run_backtest")` → 任务写 `status/progress` 到库 → 前端 `GET /{id}` 轮询；`run-fast` 保留为同步兜底。
  - 新增 `python-services/backtest-svc/backtest_celery.py`（`run_backtest` 任务 + `_ensure_progress_column` 幂等加列 + `_on_progress` 回调；成功写 `completed`+summary/equity_curve/segment_performance/feature_importance，失败写 `failed`+error）。
  - `real_engine.py`：`run_real_backtest` 加 `on_progress` 回调（10/30/60/80/95 阶段）。
  - 前端 `backtest/page.tsx`：`pollJob(id)` 每 2s 轮询至完成，进度条 + 阶段文案；SDK `backtests.runAsync` + `BacktestResult.progress`。
  - 迁移 `migrations/010_backtest_progress.sql`：`backtests` 加 `progress`/`meta` JSONB（已执行）。
- **踩坑**：worker 模块名 `celery_worker` 与 train-svc 冲突 → `backtest.run_backtest` 永不注册，重命名为 `backtest_celery.py`（踩坑 [#25](dev-troubleshooting.md)）。
- **验证**：POST 返回 200(pending)；轮询 `pending→running(30%)→completed(100%)`，全套指标落库；`start-celery.sh` 已加专用 backtest worker（`--queues=backtest`）。
- **遗留**：P1 面板 Top-N / P1 样本内·外提示 / P2 factor·composite·signal_file 接真实引擎 / P2 指数 K 线基准（progress backlog 已登记）。

---

## 2026-07-27（补 7）· 回测超时修复 + 特征工程提速 5.3×

- **问题**：模型回测（run-fast）前端报 `Request timeout after 15000ms`；后端实际
  耗时 ~85s，几乎全卡在 `build_dataset` 的 `fetch_features`。
- **根因**：`common/supabase_client.py` 的 `select_all` 用 `LIMIT/OFFSET` 循环分页，
  回测窗口内 `feature_values` ~270 万行被拆成 ~270 次查询；PostgreSQL 对大 OFFSET
  需扫描并跳过前 N 行，最后一次 OFFSET 达 260 万 → 单次就很慢，叠加成 87.5s。
  训练时该耗时被异步 Celery 任务掩盖，同步回测接口直接暴露。
- **修复**：
  - `train-svc/pipeline.py`：fetch_features/build_dataset 增加 `page_size` 参数
    （默认 10000，训练行为不变，向后兼容）；
  - `backtest-svc/real_engine.py`：回测传 `feature_page_size=1_000_000`，每个 50
    因子分块一次性拉完，分页 ~270 次 → ~6 次，无深 OFFSET；
  - `backtest-svc/main.py`：run-fast 真实引擎改由线程池
    `loop.run_in_executor(None, run_real_backtest, ...)` 执行，避免 ~17s 阻塞
    event loop（否则整服务在回测期间无法响应其他请求）；
  - `apps/web/src/lib/sdk.ts`：前端全局 `timeoutMs` 15_000 → 120_000。
- **验证**：`build_dataset` 87.55s → 16.47s（提速 ~5.3×）；回测端到端 ~16s，
  落在 120s 超时内；冒烟全绿；踩坑 #24 已沉淀。
- **遗留**：完整异步化（run 异步接口 + 前端轮询）仍是长区间/大池回测的彻底解。

## 2026-07-27（补 6）· 回测接真实引擎（model 类型）+ 默认锁定模型预测标的

- **需求**：模型回测不再用 mock（此前股票池形同虚设、明细是写死的 5 只大盘股），
  且进入回测页默认选中该模型预测的那支股票。
- **改动**：
  - 新增 `python-services/backtest-svc/real_engine.py`：models 表元数据 → MinIO
    下载模型 → 复用 `train_svc.pipeline.build_dataset` 复现训练特征工程（含
    target_symbol 单只模式 + 同板块 peer 特征）→ `proba >= cls_threshold`
    （训练保存的 Youden J 阈值）出信号 → 单只日频资金模拟（手续费/印花税/
    滑点/T+1），产出真实净值、交易与全套指标；基准缺指数行情时退回目标股
    buy&hold 并在 meta 标注。
  - `backtest-svc/main.py`：`strategy.type == "model"` 走真实引擎（懒加载），
    其余类型仍 mock；meta 透传 `engine=real`/`target_symbol`/`benchmark`。
  - 前端 `apps/web/src/app/backtest/page.tsx`：带 `?model_id=` 进入时股票池
    锁定为「该模型预测股票」；结果区加「标的」badge；历史列表 `__model__`
    显示为「模型标的」。
  - 新增冒烟脚本 `scripts/smoke_real_backtest.py`（自动选带 target_symbol 的
    最新模型 → run-fast → 校验 engine/标的/净值/指标）。
- **踩坑**：训练用 numpy 喂 LightGBM，`booster.feature_name()` 是 `Column_i`，
  按它对齐特征会全 NaN 静默失效 → 必须按 `models.input_features` 顺序重建，
  见踩坑 [#23](dev-troubleshooting.md)。
- **池特征一致性修复（同日补）**：训练手填股票池时，回测原先 `symbols=None`
  会退回自动同行业 → peer 横截面特征（rank/relative/sector_mean）的参照系
  与训练不一致。修复：训练把池快照存 `models.metadata.symbols`
  （`train-svc/tasks.py`）；回测优先用快照，旧模型经 `training_job_id` 回溯
  `training_jobs.config.symbols`，两者皆无才退回自动同行业（与训练默认一致）。
- **验证**：冒烟脚本全绿（样本 156、信号 43、交易 64，engine=real）；
  py_compile 与前端 lint 通过；服务 `--reload` 已热更。
- **后续扩展方向**（已登记 progress backlog）：
  ① 面板模型 Top-N 组合回测（P1）；② 回测区间样本内/外提示与一键设为
  训练 end 之后（P1）；③ factor/composite/signal_file 接真实引擎（P2）；
  ④ 补齐 000300 等指数 K 线（P2）；⑤ 异步 realistic 模式开放（P3）。

## 2026-07-27（补 5）· 训练页按「预测目标股票」分模块 + 参数/结果按用户与任务归属

- **需求**：训练需按「预测目标股票」分成若干模块，点模块进入训练页；模块页
  「最近任务」只与该目标相关；点任务把参数回填左侧表单（可直接改再训练）；
  参数与结果按「用户 + 任务 id」保存；用户表用主键 id 关联。
- **改动**：
  - 训练首页 `apps/web/src/app/train/TrainHome.tsx`（新）：按 `target_symbol`
    聚合出模块卡片（股票名/行业、任务数、已完成数、最近状态），点卡片 →
    `/train?target=CODE`；另有「＋新建训练目标」「全市场面板训练」入口与
    代码直达输入框；卡片股票名经 `sdk.data.getSymbol` 解析（走同源代理）。
  - `apps/web/src/app/train/page.tsx` 按 URL 路由：`/train` → 首页；
    `?target=CODE` → 训练页（目标锁定）；`?target=__all__` → 全市场面板；
    `?target=new` → 新建目标。
  - `TrainPage`：`initialTarget` 预填目标、最近任务按「当前用户 + 目标范围」
    过滤、点历史任务 `applyConfig` 回填全部参数（算法/区间/股票池/因子/标签/
    阈值/切分/调参/同板块特征）并高亮「✓ 参数已填充」。
  - 后端 `train-svc/main.py`：① `create_training_job` 读 `X-User-Id` 写
    `training_jobs.user_id` 与 `config.owner`（原为写死 `None`/`platform`）；
    ② `list_training_jobs` 新增 `target_symbol` 过滤（`__none__`=全市场面板）；
    ③ 新增 `GET /api/v1/training/targets` 聚合接口（分模块数据源）。
  - 迁移 `migrations/008_training_jobs_user_target.sql`：`target_symbol` 独立列
    （从 config 提升）+ `user_id` 外键 `REFERENCES auth.users(id)` + 3 个查询
    索引 + 历史任务回填（**已在本机执行**）。
  - `train-svc/common_utils.py`：`TrainJobConfig` 补声明 `target_symbol`/`peer`/
    `owner`/`visibility` 并加 `extra="allow"`——**修复原 pydantic 静默丢弃这些
    字段导致「预测单只」配置提交后丢失**的隐患。
- **用户主键关联**：`profiles.id`（UUID）= `auth.users.id` 即主键；
  `training_jobs.user_id` 加 FK 用主键关联，`models.owner` 同步存同一 UUID。
- **验证**：迁移已执行（`target_symbol` 列存在、19 条历史任务回填为面板 NULL）；
  `GET /api/v1/training/targets` 返回面板组（19 任务/10 完成）；
  `jobs?target_symbol=__none__` 过滤可用；train-svc 带 `--reload` 已热更。
  **注意**：按目标分的卡片是数据驱动——历史 19 个任务均为全市场面板（原
  `TrainJobConfig` 丢字段导致 config 无 `target_symbol`），故首页当前只显示
  「全市场面板」一张卡；用某目标训练后（模块页目标已锁定）即自动出现对应卡片。
- **涉及文件**：`migrations/008_training_jobs_user_target.sql`、
  `python-services/train-svc/main.py`、`python-services/train-svc/common_utils.py`、
  `packages/api/src/train-client.ts`、`packages/api/src/types/training.ts`、
  `packages/api/src/index.ts`、`apps/web/src/app/train/page.tsx`、
  `apps/web/src/app/train/TrainHome.tsx`（新）、
  `apps/web/src/app/train/TrainPage.tsx`。
- **遗留**：若想要「不训练也能把当前参数存成草稿/预设」的独立功能，可加
  `training_presets` 表（按用户+预设 id），待定。

---

## 2026-07-27（补 4）· 训练区间超覆盖预警 + 5m K线回补 2025

- **答疑核实**：因子计算全部用**日K**（1d 缺失才从 5m 聚合兜底，xsec 由
  feature_values 再算），不依赖 5m；5m 只用于 **h/m 级标签**（_forward_returns_5m）。
- **5m 回补启动**：`update_5m_klines.py --from 2025-01-01 --to 2026-02-01` 后台跑
  （5201 股 ~13 支/分钟，预计 ~6-7 小时，5m+聚合 1d upsert，日志
  `logs/backfill_5m_2025.log`）——h/m 级目标的训练窗口才能覆盖 2025。
- **超范围预警**：feature-svc 新增 `GET /factors/coverage`（feature_values /
  klines_1d / klines_5m 的 min~max，索引级毫秒查询）；训练页区间早于/晚于
  因子值覆盖边界时 amber 预警「实际窗口从覆盖起点起算」，5m 提示改动态日期。
- **涉及文件**：`feature-svc/routers/factors.py`、`apps/web/src/app/train/TrainPage.tsx`。

---

## 2026-07-27（补 3）· 因子值回补至 2025-01-01（训练样本扩容）

- **背景**：训练选 1 年区间实际有效起点只有 2026-02-02（因子值回补起点），
  样本量受限。依赖核查：1d K线 2020 年起 ✅、财报 2021 年起 ✅、磁盘 318G ✅。
- **执行**：`feature.compute_range` 按 13 个月度分段下发（2025-01-01~2026-02-01），
  408 因子 × 5201 股，幂等 upsert，xsec 横截面随段自动刷新；feature 队列
  双 worker 并行，首段实测 ~22 分钟/月，预计总耗时 ~2.5 小时。
- **监控**：`docker exec investdojo-db psql -U postgres -d postgres -t -c
  "SELECT date_trunc('month', date)::date m, count(*) FROM feature_values
   WHERE date < '2026-02-02' GROUP BY m ORDER BY m;"`
- **注意**：回补期间 routine 17:35/19:00 任务排在队列后（预计中午前跑完，不影响）。

---

## 2026-07-27（补 2）· 时间切分加 embargo 隔离带（消除前向标签边界泄漏）

- **背景**：用户指出「训练区间包含验证集时间范围，验证集结果模型是不是见过了」——
  时间切分本身无泄漏（验证集严格晚于训练集），但**前向标签有边界溢出**：
  cutoff 前 H 天的训练样本标签用的是验证窗口内的价格。
- **修复**：`split_train_valid` 新增 `embargo_days`（= 标签周期 H，tasks 按 target
  折算：1d→N 天、5m→⌈bars/48⌉ 天），cutoff 前 H 个交易日的训练样本丢弃；
  训练/验证之间形成 ≥H 个交易日的隔离带（结果页 split_range 可直接看到间隔）。
- **验证**：合成数据 embargo=5 → 训练止 04-15、验证起 04-24，间隔 6 个工作日 ✅。
- **涉及文件**：`train-svc/pipeline.py`、`train-svc/tasks.py`。worker 已重启。
- **顺带澄清**：「训练段比验证段长但样本更少」= 因子覆盖稀疏（因子值最早
  2026-02-02 + 旧 dropna 丢早期稀疏行），非切分逻辑问题；dropna 修复后缓解。

---

## 2026-07-27（补）· 修复小样本模型退化为单叶常数（AUC=0.5）

- **现象**：70 特征 + 1 年区间 + 调参，训练/验证 AUC 精确 0.5000、重要度全 0、
  全判负类（`model_5975f614d8ea`）。
- **根因（双层，手册 ## 22）**：① 整行 dropna（任一特征缺失即丢）使 70 特征
  交集后 1 年仅剩 ~1700 样本（LightGBM 原生支持 NaN，无需丢）；
  ② min_child_samples 不随样本量缩放（464 样本配 200 叶子约束 → 无法分裂）。
- **修复**：dropna 改 `how="all"`；默认与调参网格 min_child_samples 按样本量收缩；
  新增退化检测（双 AUC<0.52 → `degenerate` 标记 + 结果页红色告警）与小样本提示（<1000）。
- **验证**：稀疏特征合成数据实测——样本 3201（旧逻辑 ~40）、min_child 自适应 128、
  train 0.71/valid 0.69，不再退化。
- **涉及文件**：`train-svc/pipeline.py`、`packages/api/src/types/training.ts`、
  `apps/web/src/app/train/TrainPage.tsx`。

---

## 2026-07-27 · 修复 importance 特征选择必崩（无验证集早停）

- **现象**：`train_57d54f87ee66`（73 特征 + importance top-60）fitting 阶段报
  `ValueError: For early stopping, at least one dataset and eval metric is required`。
- **根因**：`_select_by_importance` 的轻量 lgb.train 挂了 `early_stopping` 回调但没传
  valid_sets，LightGBM 4.x 直接抛错。**以前没暴露是因为特征数 ≤ max_features 时
  函数提前 return 不训练**（前几次成功训练都是 19/44 特征 ≤ 60）。
- **修复**：移除早停回调（重要性排序只需固定 100 轮轻量训练）。合成数据实测
  top-k 正确（真信号排第一）。
- **涉及文件**：`train-svc/pipeline.py`。worker 已重启。

---

## 2026-07-26（补 7）· 修复大特征量训练加载撞 55 分钟软超时

- **现象**：`train_3510f583ce9f`（229 特征 × 196 股 × 1 年 + tune）在
  loading_data 阶段 `SoftTimeLimitExceeded` 失败。
- **根因**：`fetch_features` 单查询拉全量（≈1100 万行）+ 默认 1000 行/页
  → 上万次分页往返，撞 celery 55 分钟软超时。
- **修复**：50 因子/块 + 1 万行/页分块拉取（往返次数 ↓10 倍+），逐块日志。
- **建议**：特征数 >100 时优先开 importance top-k；加载快后 tune 的时间占比会上升，
  大样本场景留足余量。
- **涉及文件**：`train-svc/pipeline.py`（fetch_features）。worker 已重启，实测无回归。

---

## 2026-07-26（补 6）· 训练自动调参 + 训练/验证时间范围展示

- **需求**：结果页看不出训练/验证的实际时间范围；正则参数无法调整，过拟合只能干看。
- **改动**：
  - `pipeline.py` 新增 `_time_cv_tune`：时序 expanding 3 折网格搜索（8 组候选 ×
    3 折，仅训练段参与、不碰最终验证集，防调参泄漏），网格围绕正则强度
    （num_leaves 7~63 / min_child_samples 100~400 / feature_fraction 0.6~0.9 / L2 0~10）；
    `params.tune=true` 开启，最优参数回灌最终训练（仍走 valid 早停）。
  - `metrics_table` 新增 `split_range`（训练/验证实际起止日期）、
    `tuned_params` / `cv_auc` / `cv_top`（随 models.validation_metrics 落库）。
  - 训练页加「自动调参」开关（说明耗时 ×3~5）；结果页指标表上方展示
    训练/验证时间范围（含样本数）与调参命中参数。
- **验证**：合成数据 tune 全流程 1.2s，命中强正则组合（num_leaves=7），
  split_range 训练/验证严格无重叠；worker 与前端均已重启。
- **涉及文件**：`train-svc/pipeline.py`、`packages/api/src/types/training.ts`、
  `apps/web/src/app/train/TrainPage.tsx`。

---

## 2026-07-26（补 5）· 训练结果页：训练区间展示 + 过拟合预警

- **背景**：用户训练（2026-01-10~07-10，196 股，variance 全特征）出现
  训练 AUC 0.97 / 验证 AUC 0.55 的典型过拟合；有效样本仅 4950（稀疏因子 dropna 所致）。
- **改动**：结果页模型卡片展示训练区间；指标表前加「过拟合预警」——
  训练/验证 AUC 差距 ≥0.15 时提示拉长训练区间 / importance top-k / 加大正则。
- **涉及文件**：`apps/web/src/app/train/TrainPage.tsx`。

---

## 2026-07-26（补 4）· 模型下载修复 + 专属回测页（/backtest）

- **模型下载 404/拒绝连接**：训练结果页「下载模型」用 MinIO 预签名 URL（localhost:9000），
  远程浏览器必然 ERR_CONNECTION_REFUSED（手册 ## 0）；且 DB `file_path` 带 bucket 前缀
  （`investdojo/models/...`），presign/download 再拼一次 bucket → 双重前缀 NoSuchKey
  （预签名 URL 其实从未真正可用）。修复：train-svc 新增
  `GET /models/{model_id}/file` 同源流式下载；`minio_client.download_bytes/get_presigned_url`
  统一剥 bucket 前缀兜底；前端改走 `/svc/train` 代理。已实测返回真实模型文件内容。
- **「用此模型回测」跳错页**：原跳 `/sdk-demo`（API 测试页）。新建专属回测页
  `/backtest`：model_id 直达预填、区间/股票池/资金配置、12 项指标卡 + SVG 净值曲线 +
  历史回测列表、引擎徽标（mock）；导航栏新增「模型回测」。功能说明见
  `docs/features/backtest-page.md`。
- **验证**：`/backtest` 200；`/svc/train/.../file` 代理下载 200；run-fast 真实
  model_id 冒烟返回 completed。
- **涉及文件**：`train-svc/main.py`、`common/minio_client.py`、
  `apps/web/src/app/backtest/page.tsx`（新）、`apps/web/src/app/train/TrainPage.tsx`、
  `apps/web/src/components/MainNav.tsx`。

---

## 2026-07-26（补 3）· 训练指标「零正类预测」修复（自适应分类阈值 + 类别不平衡）

- **现象**：训练完成后混淆矩阵 FP/TP 全 0，精确率/召回率/F1 全 0%，看似"正样本一个都没有"。
- **定位**：标签定义无误（前向收益 `shift(-H)`，正类占比 21%/33% 正常存在）；问题是
  类别不平衡（正类 ~21%）+ 固定 0.5 分类阈值 + 早停后概率压缩 → 模型输出全部 < 0.5。
- **修复**：
  - 分类阈值改「训练集 Youden J 自适应」（不用验证集，防阈值泄漏；钳制 [0.05, 0.95]），
    写入 `metrics_table.cls_threshold`、`models.metadata.cls_threshold`、结果预览；
  - LightGBM 默认参数加 `scale_pos_weight = neg/pos`（可被 params 覆盖）；
  - 训练结果页指标表标题展示当次阈值。
- **验证**：合成不平衡数据（正类 ~20%）实测——阈值自适应为 0.319，train TP=454 /
  valid TP=112，不再零正类；`/train` 200，bundle 含阈值展示。
- **涉及文件**：`train-svc/pipeline.py`、`train-svc/tasks.py`、
  `packages/api/src/types/training.ts`、`apps/web/src/app/train/TrainPage.tsx`。
- **备注**：该模型验证 AUC 0.44 < 0.5 属泛化问题（验证段 regime 反转，正类 21%→33%），
  与阈值无关；建议拉长训练窗口或缩短验证跨度重新评估。

---

## 2026-07-26（补 2）· 修复训练落库 "can't adapt type 'dict'"

- **现象**：训练 fitting 完成、模型传 MinIO 后 `client.insert("models")` 报
  `ProgrammingError: can't adapt type 'dict'`，job 失败。
- **根因**：迁移 006（models 加 `feature_importance JSONB`）未应用到当前库
  （07-25 恢复的 dump 早于 006）→ `_col_type` 查不到列返回空串 → dict 未经 `Json()` 适配；
  且空结果被永久缓存，补列后进程内仍失效（手册 ## 21）。
- **修复**：应用 006 迁移补列；`_col_type` 空结果不缓存；重启 celery worker。
- **验证**：同结构探针行 insert/update/delete 全通（`feature_importance` 等 dict 字段正常）。
- **涉及文件**：`migrations/006_alter_models_training_result.sql`（应用）、
  `python-services/common/supabase_client.py`。

---

## 2026-07-26（补）· 训练页布局合并：标签配置集中到「标签定义」卡片

- **问题**：「预测目标 return_Nx」（标签的前向窗口/频率）在训练参数卡片，而标签类型/阈值/表达式
  在标签定义卡片——同一个标签拆两处；「板块对比 & 目标股票」注释写"并入训练参数"却物理放进了标签卡片。
- **改动**（纯布局，提交参数不变）：
  - 「预测目标 return_Nx」移入「标签定义（预测什么）」卡片顶部——标签三要素
    （前向窗口 + 指标类型 + 阈值/表达式）集中在同一卡片；
  - 「板块对比 & 目标股票」移回「训练参数」卡片（股票池之后，与目标股自动填池联动）；
  - 训练参数 grid 剩 4 项（算法/训练开始/训练结束/验证集切分），正好 2×2。
- **涉及文件**：`apps/web/src/app/train/TrainPage.tsx`。
- **验证**：`next build` 通过。
- **补充（前端缓存坑）**：发布后用户端仍显示旧布局——定位为预渲染 HTML 默认
  `Cache-Control: s-maxage=31536000` 被浏览器/中间代理缓存一年（手册 ## 20）。
  `next.config.ts` 加 `headers()`：HTML 一律 `no-cache, must-revalidate`，
  `_next/static` 哈希资源保持 immutable。已重启验证响应头生效；
  已缓存旧 HTML 的客户端需一次硬刷新（Ctrl+Shift+R）。

---

## 2026-07-26 · 例行任务日志按次回放（参数 + 历史日志）

- **需求**：例行任务按传入参数运行，页面应能看到某一天/某一次运行的日志，而非只有最新一次。
- **改动**：
  - data-svc `GET /routine/runs` 新增 `task_name` 过滤（单任务历史拉取），排序补 `finished_at.desc`；
  - 任务卡片「日志」页签重构：近 60 天运行记录选择器（✓/✗/⊘ 色块，同日多次带时分），
    选中后展示当次运行的 状态/耗时/参数（days/start/end/date_str/cmd）/依赖检查/错误/日志尾部；
  - 巡检格点表同日多次运行保留最新一次；手动触发后自动刷新该任务历史记录。
- **踩坑**：`task_name=feature.compute_incremental` 裸值被 filter 翻译器按首个 `.` 误拆成
  操作符 `feature`、值 `compute_incremental` → 查询恒空；改显式 `eq.` 前缀（手册 ## 19）。
- **涉及文件**：`python-services/data-svc/routers/admin.py`、`apps/web/src/app/admin/data/page.tsx`、
  `docs/ops/dev-troubleshooting.md`（## 19）、`docs/features/routine-observability.md`。
- **验证**：接口按任务过滤返回当次 `days=2` 参数与 precheck skipped 记录；前端重新构建并重启，
  bundle grep 确认新选择器已打包；`/admin/data` 200。

---

## 2026-07-25（补 2）· 例行任务可观测性（数据管理页图表）

- **改动**：数据管理页新增「例行任务巡检」区块——近 14 天任务状态格点表（4 个 celery
  例行任务的成功/失败/跳过）+ 近 30 天每日写入量条形图（5m/1d/快照/因子值）；
  全部读中间表，页面访问不扫大表。
- **涉及文件**：`migrations/007_routine_observability.sql`（routine_task_runs +
  daily_data_metrics + idx_klines_all_tf_dt）、`train-svc/feature_tasks.py`
  （`_record_run` 埋点 + `collect_daily_metrics_task` 每日 20:00 汇总）、
  `train-svc/celery_worker.py`（beat ④）、`data-svc/routers/admin.py`（routine 三端点）、
  `apps/web/src/app/admin/data/page.tsx`（RoutineSection）。
- **验证**：30 天回填完成（120 行，67.8s）；图表即刻暴露因子 7-20/21 仅 281 行、
  7-23/24 为 0（待回补）；`/admin/data` 200、代理链路端到端通。
- **因子回补（已执行）**：巡检图表暴露 5-6 起 54 个工作日因子值残缺（每天仅数百行）。
  先验证 7-23/24 补算产出（各 106 万行 ✅），再按 10 天 × 8 段排队回补
  2026-05-06 ~ 2026-07-22（`feature.compute_range`，幂等 upsert，预计 ~2 小时）。
  注意：compute_range 参数名是 `start/end`（不是 start_date/end_date）。
- **补充**：例行巡检区块初版沿用页面裸 fetch `localhost:8006`——远程浏览器里指向用户
  自己电脑必然失败（显示"未采集"）。已改同源代理 `/svc/data` 并把静默 catch 改为
  显示加载错误（手册 ## 0/## 15）。
- **补充 2**：例行巡检加时间筛选——快捷档位（近 7/14/30/90 天）+ 自定义起止区间
  （上限 92 天），统一控制状态格点表与写入量条形图；后端 runs/metrics 端点支持
  `start/end` 参数（`and` 语法合并区间条件）。
- **补充 3**：写入量回填扩至 90 天（2026-04-27 起，360 行）；条形图颜色深度改
  **对数归一化 + 5 档色阶**（线性归一在 281 vs 45 万的差距下小值几乎隐形）。
- **补充 4（SQL 工具修复）**：`/admin/data/sql` 表预览空白 + 查询报错——根因同例行巡检：
  裸 fetch `localhost:8006` 在远程浏览器指向用户电脑。将数据管理主页与 SQL 页的
  `DATA_SVC_URL` 统一改为同源代理 `/svc/data`（原数据管理页所有区块一并修复），
  表结构加载失败改为显式报错。后端端点本身无恙（schema/sql 正常）。

---

## 2026-07-25（补）· git 版本管理恢复

- **改动**：工作区重建 git 管理——`git init` + 关联远程 `github.com/losersa/invest_dojo`
  （确认项目确为该仓库 clone，`.git` 在磁盘事故中丢失）；`git add -A` 时 git 自动识别出
  245 项 rename（远程 `investdojo/` 子目录 = 工作区根），以 `origin/main`(7962e5a, 07-17)
  为父提交快照提交（ef63ba2），49 提交历史完整保留。
- **验证**：`git log` 历史连通；`.gitignore` 补充排除运行时产物（logs/.venv/.task_history 等）。
- **推送**：已配置 HTTPS PAT 凭证并推送成功 → 远程新分支 `devcloud-snapshot`（2026-07-25）；
  之后日常改动高频 `git commit` 并推送。
- **合并 main**（2026-07-25）：保留外层有价值资产（investdojo-dev skill、CI workflows、
  pre-commit）后，main 快进至 `378e48e`；远程 main 结构统一为 devcloud 工作区结构
  （investdojo/ 子目录提升为根）；日常推送命令 `git push origin master:main`。

---

## 2026-07-25 · 告警中心 + 训练页因子修复 + 5m K线管线 + 磁盘事故 + 快照回滚重建

> ⚠️ 本日工作区曾因 devcloud 磁盘扩容被快照回滚，全部改动丢失后按记录重建
> （详见 `dev-troubleshooting.md` ## 18）。

- **改动**：
  1. 新增 admin 告警中心：monitor-svc `GET /api/v1/monitor/alerts`（6 模块报表+告警，
     含磁盘/市场快照监控）+ 前端 `/admin/alerts` 页面 + 导航入口；
  2. PG 连接池改 `ThreadedConnectionPool` + keepalive + maxconn 20，alerts 聚合加 Semaphore(6)；
  3. 训练页因子加载修复：`has_values` 标注 select_all 拉全量行（单页 15s+/60s 超时）
     → 主键索引 EXISTS（<150ms，~400 倍）；`list_factors` 新增 `value_start/value_end`
     区间判定；TrainPage 因子列表随训练区间 400ms 防抖重拉、无值因子禁选、默认区间近 3 个月；
  4. `batch_compute.py` 0 条写入告警放宽（`zero_records_written`）；
  5. **5m K线管线**：`scripts/update_5m_klines.py`（拉 5m→聚合日K落库，替代独立日K拉取），
     聚合日K与官方对比一致（open/close/volume/pctChg，high/low 偶差 0.01）；
     增量模式交易日自检（end 回退最近交易日，周末/节假日零空跑）；
  6. 例行化调度（celery beat）：17:35 5m K线（每天+自检）、17:45 市场快照（每天）、
     19:00 因子增量（仅工作日，原 17:00 改来）；
     admin 数据管理页注册 `update_5m_klines` / `backfill_5m_klines`；
  7. 前端 explorer/page.tsx 构建修复（非法命名导出 + Dispatch 类型）；生产构建发布（next start）；
  8. 新建 `.codebuddy/skills/dev-docs/` 文档工作流 skill（含 progress 同步流程）。
- **涉及文件**：见各功能说明文档（`docs/features/alerts-center.md`、`klines-5m-pipeline.md`）。
- **原因/背景**：训练页因子"加载不出来"排查（422 → 15s 慢查询双层根因）；K线数据例行化
  需求（5m 拉取+聚合日K）；排查中暴露连接池/进程管理/磁盘/回滚系列坑
  （手册 ## 11-18）。
- **验证**：`/api/v1/monitor/alerts` 全模块 ok；因子列表全页 <150ms、区间判定正确
  （近 3 月 100/100 可选、1 月 0/100 禁选）；聚合日K与官方对比一致；
  交易日自检周六实测正确回退；`/`、`/train`、`/admin/alerts`、`/admin/progress` HTTP 200。
- **磁盘事故**：/data 100% 写满 → PG WAL 失败崩溃循环（手册 ## 17）。清 18.1GB 无引用
  镜像恢复；告警中心已加磁盘监控（≥85%/≥95%）。用户随后扩容磁盘。
- **补充 5（遗留问题闭环）**：
  - 基本面因子覆盖：排查确认**当前代码已正常**（7-23/24 回补后 pe_ttm_low 覆盖 3000 只、
    7-24 全部 408 因子有值、ma 类 5201 只）；7-22 的 200 行为历史遗留，正由 8 段回补重写。
    真正边界：fundamentals 只覆盖 2801/5204（54%）——基本面数据采集范围问题（可选扩充）；
  - date_mask 时区 off-by-one：代码复核后确认**误报**——date_mask 按 panel 索引时区
    （+08:00）构造边界，与 1d K线 dt 约定一致；5m 聚合路径的 dt 取当日首根 bar，
    日期归属同样正确；7-23/24 的 0 条真因是 K线未覆盖目标区间（已随 5m 管线解决）；
  - uvicorn --reload 卡死：根因是 watch 整个工作目录（含 logs/.task_history 高频写入）。
    `start-services-linux.sh` 已加 `--reload-dir <本服务> --reload-dir common` 收窄，
    6 服务已重启生效（logs 变更不再触发全量 reload；单服务变更只 reload 自己）。
- **补充 6（SQL 工具增强）**：编辑器升级——① 选中执行：选中片段时按钮/Ctrl+Enter
  只执行选中部分（按钮文案与字符数提示）；② 语法高亮：零依赖 overlay 方案
  （透明 textarea + 着色层），关键字蓝/字符串绿/注释灰/数字橙/写操作关键字红色波浪线；
  ③ 实时校验颜色指引：括号配对、引号闭合、写操作关键字、非 SELECT 开头 →
  边框红/黄/绿 + 状态行提示，error 级执行前本地拦截。
- **补充 7（因子例行化与新增因子处理）**：
  - 新增**每周全量回跑自愈任务** `feature.weekly_recompute`（beat 周六 03:00，
    近 30 天按 7 天分段串行，幂等 upsert，避开 1h 任务上限），巡检格点表已加该任务；
  - 新增因子的处理链路（机制验证完好）：发布时自动异步回填近 90 天
    （`_backfill_factor_async`）→ 次日 19:00 增量自动纳入（因子列表动态拉取）→
    每周回跑自动覆盖。
- **补充 8（因子口径统一回补，2026-07-26）**：训练区间与因子口径对齐——发现
  2026-02-02 ~ 04-30 为旧口径（180-188 因子，93.6 万行/天），05-06 起为新口径
  （408 因子，187 万行/天），训练区间跨界时前后因子集不一致。已手动触发
  `weekly_recompute`（近 30 天）+ 分 10 段回补 2026-02-02 ~ 05-05（统一为 408 因子，
  幂等 upsert，队列串行约 2.5 小时）。早期日期长窗口因子（ma60 等）因预热期不足
  天然稀疏，属正常。
- **补充 9（SQL 工具超时调整）**：`statement_timeout` 10s → 120s（内部员工工具，
  大表聚合如 feature_values 1.6 亿行 GROUP BY 需要更长窗口，仍保留兜底防失控）。
  注意：查询结果同名列（如两个 COUNT）在 JSON 化时键冲突会被覆盖，建议用别名。
- **补充 10（训练页：股票池行业联动 + 标签频率与目标联动，2026-07-26）**：
  - 填「预测目标股票」后自动查其行业并填入同行业在市股票池（500ms 防抖，可手动改；
    data-svc symbols 端点 industry 过滤复用）；
  - 标签频率与预测目标联动（`parse_horizon_tf`）：`return_Nd` 仍用 1d；`return_Nh/Nm`
    改用 **5m K线**计算真实分钟级标签（horizon 换算 bar 数：h×12、m/5 向上取整；
    样本点=每日最后一根 bar=收盘时点，标签归属北京交易日与日频特征对齐）；
    前端目标为 h/m 时提示 5m 数据自 2026-02-02 起（更早样本丢弃）。
    此前 h/m 目标被折算成天（parse_horizon 近似），语义不准。
- **补充 11（训练页布局与校验，2026-07-26）**：「板块对比 & 目标股票」并入训练参数
  卡片（原独立卡片删除）；新增 train_end 有效性校验——距今天不足预测周期（按 target
  解析，d 级=N 天，h/m 级=1 天缓冲）时黄色警告"前向标签窗口不完整，验证/测试集
  可能为空，建议 train_end ≤ 数据最新日期 − 周期"。确认板块横截面特征为训练时
  实时生成（add_peer_features，非预计算）；行业数据在 symbols 表。
- **补充 12（横截面因子预计算，2026-07-26）**：板块横截面特征从训练时实时计算升级为
  预计算入库——新增 `compute_xsec.py`（全市场按 (date, industry) groupby 做
  rank(pct)/z-score/mean），8 个 xsec_ 因子注册入库（category=xsec,
  formula_type=precomputed）；接入调度：compute_incremental/compute_range 完成后
  自动算（失败不阻断）；全历史回补完成（2026-02-02~07-24，421.9 万行，84 行业）。
  注意：feature_values 无 timeframe 列，写记录不要带。
- **补充 13（例行任务依赖检查 + 页面重构，2026-07-26）**：
  - **precheck 框架**（feature_tasks.py）：例行任务执行前校验依赖，失败 → skipped 不执行
    并记录原因。核心检查 `kline_coverage`（K线最新日期 ≥ 目标 end——历史"0 条空转"
    事故的根因防线）；各任务另有 symbols/klines_all 非空检查。实测：周日触发
    compute_incremental → 0.2s skipped（K线 7-24 < 目标 7-25）；
  - **日志增强**：routine_task_runs.detail 记录 precheck 明细、summary、errors、
    log_tail（subprocess 任务 3000 字符）；
  - **admin API**：GET /routine/tasks（注册表：cron/描述/依赖/最近运行）、
    GET /routine/tasks/source（白名单源码查看）、POST /routine/tasks/{name}/trigger；
  - **前端**：数据管理页「数据更新任务」区块替换为「例行化任务」卡片——每任务显示
    cron/描述/依赖检查/最近状态，按钮：执行（celery 触发）/日志（precheck+摘要+错误+
    日志尾部）/源码（在线查看）。
- **遗留**：
  1. 5m 回补（2026-05-01 起）在事故中中断，需断点续跑（增量模式自动从各股 MAX 续拉）；
  2. 基本面因子仅 ~202/2801 只股票有值（fundamentals JSONB 字段覆盖不足），待查；
  3. date_mask 时区 off-by-one（1d K线 `T00:00:00+08:00` vs UTC 边界）未修；
  4. uvicorn `--reload` 反复卡死（手册 ## 12），生产建议去掉；
  5. **项目无 git 版本管理**——本次回滚靠会话记录重建，强烈建议 git init + 高频提交。

---

## 2026-07-28 · 回测全链路异步化打通（async + Celery + 轮询）

- **需求**：回测计算重（模型路径需拉数百万行特征），同步接口 15s 超时必失败；需要异步任务 + 进度轮询。
- **改动**：
  - 新增 `POST /api/v1/backtests` 异步接口 + `backtest_celery.celery_app`（队列 `backtest`，DB1 连接），`backtest_id` 由 `backtest_id_seq` 自增生成；
  - `main.py` 保留 `POST /run-fast` 同步快跑（带 25s 超时保护）用于本地手动验证，异步路径与快跑路径共用同一套 `run_real_backtest` 真实引擎；
  - 前端 `backtest/page.tsx`：补齐 `runAsync` 客户端方法 + `poll()` 轮询（2s 间隔，最多 120 次）+ `runStatus` 轮询状态机（idle→running→polling→done/error）；
  - `backtest-client.ts` 新增 `getResult` 与 `runAsync`；`types/backtest.ts` 补全 `BacktestResult` / `BacktestMeta` / `BacktestSummary` / `EquityPoint` / `HoldingInfo` 字段；
  - 文档 `routine-observability.md` 与 `dev-troubleshooting.md` 同步回测架构变更。
- **验证**：真实引擎端到端跑通：model 类型返回 251 日期权、含 `engine/model`、`in_sample`/`training_range`/`holdings`；前端轮询状态机在本地 dev 下成功拿到结果并显示净值曲线。

---

## 2026-07-28 · 回测 P1/P2 功能补齐（横截面真实引擎 + Top-N + 样本内外 + 指数基准）

- **需求**：① P1 面板 Top-N 持仓展示 + 样本内/外提示；② P2 factor/composite/signal_file 三类策略接入真实横截面引擎；③ 指数 K 线基准。
- **改动**：
  - `real_engine.py` 新增横截面（面板）回测链路 `_build_score_df`（factor / composite / signal_file 三种策略分发）、`_fetch_factor_values`（读 `value_num`/`value_bool`，修正原 `value` 列）、`_load_signal_file_csv`（`dtype={"symbol": str}` 修复前导零丢失）、`_compute_metrics`（补充 `ic`/`ir`）、`_simulate_cross_section`（pivot+ffill 打分、默认周频调仓、<2 只跳过调仓、>35% 价格尖刺过滤、Top-N 等权组合 + benchmark_price 基准）。`run_real_backtest` 分发：`type != "model"` 走 `run_xsec_backtest`。
  - `backtest_celery.py` 全策略类型路由到真实引擎；`main.py` 快跑路径全类型用真实引擎，`meta.engine` 非 model 标记 `real_xsec`。
  - 前端 `backtest/page.tsx`：策略类型切换（模型 / 因子 / 复合因子 / 信号文件）+ 条件输入（factor_id / compositeId / signalFileId / 自定义股票池），`run()` 构建完整 config（xsec→equal_weight+weekly）；新增样本内/外徽标（`In-sample`/`Out-of-sample` + 重叠天数）、Top-N 持仓表（symbol/entry_date/avg_cost/ret/weight）、净值曲线叠加指数 K 线（`benchmark_price` 紫色虚线）。
  - `types/backtest.ts` 新增 `EquityCurve.benchmark_price?`、`HoldingInfo`、`BacktestMeta`、`BacktestResult.meta?`。
  - 新增 `scripts/make_sample_signal.py` 生成并上传示例信号 CSV 到 MinIO（`signals/{id}.csv`）便于测试。
- **验证**：4 种策略类型端到端跑通（factor / composite / signal_file / model），`meta` 含 `engine`/`in_sample`/`training_range`/`holdings`/`n_symbols`；model 回测正确识别 `in_sample:True, training_range:2025-06-01~2026-06-01, overlap:152`；前端 `tsc --noEmit` 通过（exit 0，无错误）。
- **已知限制**：`klines_all` 无指数数据（000300 为 0 行），基准回退为等权代理并标注 `000300(等权代理)`，净值叠加指数 K 线以 K 线形式呈现；此为数据覆盖限制，非引擎缺陷。

---

## 2026-07-28 · 回测净值曲线 Bug 修复（量纲错位 + 图例重叠 + 基准歧义）

- **现象**：模型回测结果页组合净值曲线左轴数值异常（显示 ~90 万量级、组合线被压到图底，看似净值 0.89），且图例「指数K线」与「002662(buy&hold)」文字重叠；用户误以为 002662(buy&hold) 是模型自己的买卖数据。
- **根因**：`real_engine` 对 model 回测返回的 `equity_curve` 三序列量纲不一致——`portfolio` 是净值比（equity/init_cap，~1.0）、`benchmark` 是绝对资金（init_cap×price/b0，~100 万）、`benchmark_price` 是原始股价（~10–20）；前端 `EquityChart` 直接把三者画在同一坐标轴，组合线被资金量级完全压扁，左轴显示的是资金刻度而非净值比，导致数值「看起来不对」。
- **改动**：`EquityChart` 改为将三条序列统一归一成「净值比」（`v/v[0]`，起点 1.0 = 初始资金）后再同图绘制，左轴标注「净值（起点 1.0 = 初始资金）」；图例精简为「组合净值 / 基准 / 指数K线」并拉开间距避免重叠；图下新增一行说明（蓝=策略净值、灰=基准 002662 买入持有*被动对照非模型交易*、紫=指数K线基准净值）。
- **验证**：`tsc --noEmit` 通过（exit 0）；归一化后组合线终点=1.185 与 total_return +18.51% 一致，基准/指数同为净值比可直观比较超额收益。

---

## 2026-07-28 · 历史回测列表可点击查看详情

- **现象**：「最近回测」列表是静态展示，无法点进去看某次历史回测的净值曲线、持仓、指标等详情。
- **改动**：`backtest/page.tsx` 新增 `openRecent(id)`，点击/回车「最近回测」任意一行即调用 `GET /api/v1/backtests/{id}`（返回完整 `BacktestResult`，含 `equity_curve`/`meta`）并填充到同一结果视图（`setResult` + `setEngine(meta.engine)`），复用既有的净值曲线/样本内外/持仓表渲染；行末加「查看 →」提示，hover 高亮。
- **验证**：`tsc --noEmit` 通过（exit 0）；`get_backtest` 返回整行（config/summary/equity_curve/meta 齐全），详情渲染与即时回测一致。

---

## 2026-07-28 · 净值曲线移除冗余紫色指数线（与买入持有基准同源重叠）

- **现象**：用户反馈图表里看不到紫色「指数K线」线。
- **根因**：紫色线取自 `equity_curve.benchmark_price`，而该字段与灰色基准 `benchmark` 同源（都来自 `bench_close`）；当指数数据缺失、基准回退为 `002662(buy&hold)` 时，两者是同一标的价格的归一化曲线，紫色虚线完全压在灰色实线下不可见——并非真的独立指数基准。
- **改动**：`EquityChart` 移除紫色指数线及其图例，只保留两条有意义序列——蓝=策略净值、灰=基准·买入持有；图下说明补充「市场指数K线因库内无指数行情暂未绘制」。后续若要真正的指数基准，需在 `klines_all` 补充沪深300等指数日线，并在引擎中单独拉取指数序列（与标的买入持有区分）。
- **验证**：`tsc --noEmit` 通过（exit 0）；图例不再重叠，蓝/灰两线清晰可比。
