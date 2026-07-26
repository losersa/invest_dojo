# 横截面因子（行业 rank / z-score / 板块均值）

> 创建：2026-07-26 · 状态：✅ 已上线
> 变更日志：见 `docs/ops/change-log.md`（搜"横截面"）

## 功能概述

把「板块横截面特征」从训练时实时计算升级为**预计算入库**（`feature_values`）：
每日按行业分组对全市场基础字段做组内变换，与普通因子统一存储、统一调度、
训练页直接可选（`has_values` 自动标注）。

## 因子清单（8 个，`xsec_` 前缀，category=xsec）

| factor_id | 含义 | 输出类型 |
|---|---|---|
| xsec_ind_rank_close | 收盘价行业百分位（0~1） | rank |
| xsec_ind_rank_pct_change | 当日涨幅行业百分位 | rank |
| xsec_ind_rank_volume | 成交量行业百分位 | rank |
| xsec_ind_rank_turnover | 成交额行业百分位 | rank |
| xsec_ind_z_pct_change | 当日涨幅行业 z-score | scalar |
| xsec_ind_z_volume | 成交量行业 z-score | scalar |
| xsec_ind_z_turnover | 成交额行业 z-score | scalar |
| xsec_ind_mean_pct_change | 行业涨幅均值（板块水位，组内同值） | scalar |

## 架构

```
celery 因子任务（compute_incremental / compute_range 完成后）
  → compute_xsec_factors(start, end)        # feature-svc/factors/compute_xsec.py
    → 拉全市场 1d K线基础字段（close/volume/turnover/change_percent）
    → 按 (date, industry) groupby：rank(pct=True) / z-score / mean
    → upsert feature_values（value_num，冲突键 factor_id+symbol+date）
```

- **为何单独一步**：普通因子 per-symbol 可按 100 只/批；横截面因子 per-date
  需全市场同组数据，不能按批。
- **组内 <3 只的行业不写**（1-2 只的"组"排名无意义）。
- 行业映射：symbols.industry（约 84 个行业）。

## 调度

- **每日**：19:00 因子增量完成后自动算（`compute_incremental_task` 内 `_run_xsec`，
  失败不阻断主任务）
- **回补**：`compute_range` 完成后同样自动算
- **首次全历史**：2026-02-02 ~ 07-24 已回补（421.9 万行，114 天 × 84 行业）

## 与训练页"板块对比"特征的关系

- 预计算 xsec 因子：固定 industry 口径、8 个基础变换，训练页**因子多选**里直接勾选；
- 训练页 peer 实时特征（add_peer_features）：group_by 可选 industry/industry_level2/market、
  4 种模式任意组合——需要灵活性时用 peer，需要常规口径时用 xsec 预计算（更快、可巡检）。
- 注意两者同时使用会有信息冗余（同语义的特征）。

## 注意事项

- `feature_values` 表无 `timeframe` 列（client 层会忽略多余字段，但新代码不要写）；
- 因子注册 formula_type='precomputed'（区别于 DSL 引擎因子，不参与 eval_ast）；
- 巡检图表（daily_data_metrics）不含 xsec 单独维度（计入 feature_values 总量）。

## 变更历史

- 2026-07-26：初版上线（8 因子 + 全历史回补 + 调度接入）
