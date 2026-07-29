"use client";

// ============================================================
// 模型训练页 — 用「有信息量」的因子训练 LightGBM 模型
// 左侧配置（含因子多选），右侧实时进度 + 最近任务
// ============================================================

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { type Factor, type TrainingJob, type TrainJobConfig, type TrainingResult } from "@investdojo/api";
import { sdk, ensureUserId } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

const OUTPUT_TYPE_LABEL: Record<string, string> = {
  boolean: "信号",
  scalar: "数值",
  rank: "排名",
};

const INFORMATIVE = new Set(["scalar", "rank"]);

const DEFAULT_SYMBOLS = "603216,603408,603409,603416,603418,603421,603209,603210";

// 自动调参目标指标（后端 TUNE_METRICS 对应；logloss 越低越好，其余越高越好）
const TUNE_METRIC_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "auc", label: "AUC（ROC）", hint: "排序能力·默认；验证集正样本少时噪声大" },
  { value: "pr_auc", label: "PR-AUC", hint: "类不平衡下更敏感、更稳" },
  { value: "logloss", label: "LogLoss", hint: "概率校准，全样本参与、噪声最小（越低越好）" },
  { value: "f1", label: "F1", hint: "训练集选阈值后算验证集 F1，直接对齐能否开单" },
];
const TUNE_METRIC_LABEL: Record<string, string> = Object.fromEntries(
  TUNE_METRIC_OPTIONS.map((o) => [o.value, o.label]),
);

// 默认训练区间：最近 3 个月（因子值覆盖随数据更新，旧默认 2026-01-01~03-01 大半无数据）
function defaultTrainRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 3);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

type LabelKind = "return" | "max_return" | "min_return" | "custom";

type PeerMode = "rank" | "relative" | "sector_mean";

// 与后端 pipeline.add_peer_features._ALLOWED 对齐：只允许基于「当前已知因子值」的模式。
// 旧模型可能存过已移除的未来函数模式（如 "sector_return"），用作模板时必须过滤掉。
const PEER_MODES: PeerMode[] = ["rank", "relative", "sector_mean"];

const LABEL_KINDS: { value: LabelKind; label: string; desc: string }[] = [
  { value: "return", label: "收盘涨跌", desc: "ret = close[t+H]/close[t] − 1（默认）" },
  { value: "max_return", label: "期间最大涨幅", desc: "max_ret = 窗口内最高价/close − 1" },
  { value: "min_return", label: "期间最大回撤", desc: "min_ret = 窗口内最低价/close − 1（通常为负）" },
  { value: "custom", label: "自定义表达式", desc: "用下方变量自由组合，metric > 阈值 记为正类" },
];

// 自定义标签可用变量（与后端 LABEL_VARIABLES 对齐）
const LABEL_VARS: { name: string; desc: string }[] = [
  { name: "close", desc: "当日收盘价" },
  { name: "open / high / low / volume", desc: "当日开/高/低/量" },
  { name: "close_fwd", desc: "H 日后收盘价" },
  { name: "high_max / low_min", desc: "前向窗口内最高价 / 最低价" },
  { name: "vol_mean", desc: "前向窗口内平均成交量" },
  { name: "ret", desc: "收盘收益 close_fwd/close − 1" },
  { name: "max_ret / min_ret", desc: "期间最大涨幅 / 最大回撤" },
];
// 可用函数：abs, maximum, minimum, clip, sign, log, log1p, sqrt, where

interface JobMonitor {
  job: TrainingJob | null;
  error: string | null;
  loading: boolean;
}

interface TrainPageProps {
  /** 初始预测目标股票（来自 /train?target=CODE）；空串=全市场/新建 */
  initialTarget?: string;
  /** 目标是否锁定（进入具体股票模块时为 true，仅作提示，仍可修改） */
  targetLocked?: boolean;
  /** 最近任务过滤范围：target=只看该目标 / panel=只看全市场面板 / all=当前用户全部 */
  recentScope?: "target" | "panel" | "all";
}

export function TrainPage({
  initialTarget = "",
  targetLocked = false,
  recentScope = "all",
}: TrainPageProps = {}) {
  // ── 因子列表（多选） ──
  const [factors, setFactors] = useState<Factor[]>([]);
  const [factorSearch, setFactorSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingFactors, setLoadingFactors] = useState(true);

  // ── 训练配置 ──
  const [algorithm, setAlgorithm] = useState<"lightgbm" | "dummy">("lightgbm");
  const [target, setTarget] = useState("return_5d");
  const [{ start: initStart, end: initEnd }] = useState(defaultTrainRange);
  const [trainStart, setTrainStart] = useState(initStart);
  const [trainEnd, setTrainEnd] = useState(initEnd);
  const [testStart, setTestStart] = useState("");
  const [testEnd, setTestEnd] = useState("");
  const [refitOnValid, setRefitOnValid] = useState(false); // 最终模型是否并入验证集全量训练
  const [symbolsText, setSymbolsText] = useState(DEFAULT_SYMBOLS);
  const [modelName, setModelName] = useState("");
  const [useImportance, setUseImportance] = useState(true);
  const [maxFeatures, setMaxFeatures] = useState(60);
  const [tuneEnabled, setTuneEnabled] = useState(false);
  const [tuneMetric, setTuneMetric] = useState("auc"); // 自动调参目标指标

  // ── 标签定义 ──
  const [labelKind, setLabelKind] = useState<LabelKind>("return");
  const [thresholdPct, setThresholdPct] = useState(0); // 涨跌阈值（百分比，UI 友好）
  const [labelExpr, setLabelExpr] = useState("max_ret - abs(min_ret)");

  // ── 同板块横截面特征 / 多股票预测单只 ──
  const [targetSymbol, setTargetSymbol] = useState(initialTarget); // 指定「预测哪一只」，留空=全市场面板
  const [peerEnabled, setPeerEnabled] = useState(false);
  const [peerGroupBy, setPeerGroupBy] = useState<"industry" | "industry_level2" | "market">("industry");
  const [peerModes, setPeerModes] = useState<Set<PeerMode>>(
    new Set<PeerMode>(["rank", "relative", "sector_mean"]),
  );
  // 池用途开关：reference=横截面参照系(A) / features=池特征输入(B)
  const [poolMode, setPoolMode] = useState<"reference" | "features">("reference");
  const [poolKlineOnly, setPoolKlineOnly] = useState(false); // B 模式：仅用 technical(K线) 因子
  const [poolHint, setPoolHint] = useState<string | null>(null);

  // 分钟/小时级目标 → 标签用 5m K线计算（与日频特征对齐；5m 数据自 2026-02-02 起）
  const isIntradayTarget = /return_\d+[hm]$/i.test(target.trim());

  // 预测周期（天）：d → N；h/m → 1（5m 标签样本点=每日收盘，归属当日，缓冲 1 天即可）
  const horizonDays = (() => {
    const m = /return_(\d+)([dhm])$/i.exec(target.trim());
    if (!m) return 5;
    return m[2].toLowerCase() === "d" ? parseInt(m[1], 10) : 1;
  })();
  // 训练结束日距今天不足预测周期 → 前向标签窗口不完整，验证/测试集将为空
  const trainEndTooLate =
    !!trainEnd &&
    (Date.now() - new Date(`${trainEnd}T00:00:00`).getTime()) / 86400000 < horizonDays;

  // 目标股票变化 → 自动检测行业并填入同行业股票池（可手动修改）
  useEffect(() => {
    const code = targetSymbol.trim();
    if (!/^\d{6}$/.test(code)) {
      setPoolHint(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        // ① 查目标股行业
        const s1 = await fetch(`/svc/data/api/v1/data/symbols?search=${code}&page_size=20`);
        const j1 = await s1.json();
        const hit = (j1.data ?? []).find((r: { code: string }) => r.code === code);
        if (!alive) return;
        if (!hit?.industry) {
          setPoolHint(hit ? `目标股 ${code} 无行业信息，请手动填写股票池` : `未找到股票 ${code}`);
          return;
        }
        // ② 查同行业在市股票
        const s2 = await fetch(
          `/svc/data/api/v1/data/symbols?industry=${encodeURIComponent(hit.industry)}&page_size=500`,
        );
        const j2 = await s2.json();
        const codes: string[] = (j2.data ?? [])
          .map((r: { code: string }) => r.code)
          .filter(Boolean);
        if (!alive || codes.length === 0) return;
        setSymbolsText(codes.join(","));
        setPoolHint(
          `已按目标股行业「${hit.industry}」自动填入 ${codes.length} 只同行业股票（可手动修改）`,
        );
      } catch {
        if (alive) setPoolHint("行业查询失败，请手动填写股票池");
      }
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [targetSymbol]);
  const [splitMethod, setSplitMethod] = useState<"time" | "random">("time"); // 默认按时间切分

  // ── 训练/操作说明面板 ──
  const [showGuide, setShowGuide] = useState(false);

  // ── 提交 / 监控 ──
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [active, setActive] = useState<JobMonitor>({ job: null, error: null, loading: false });
  const [recent, setRecent] = useState<TrainingJob[]>([]);
  const [result, setResult] = useState<TrainingResult | null>(null); // 训练完成后的「结果产物」
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 数据覆盖边界（feature-svc /factors/coverage，索引级 min/max）：
  // 训练区间超出覆盖时给警告，避免"选了 1 年实际只有 3 个月"的静默截断
  const [coverage, setCoverage] = useState<{
    feature_values?: { start?: string | null; end?: string | null };
    klines_5m?: { start?: string | null; end?: string | null };
  } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/svc/feature/api/v1/factors/coverage");
        if (r.ok) setCoverage((await r.json()).data ?? null);
      } catch {
        // ignore（提示级功能，失败静默）
      }
    })();
  }, []);

  // 拉取 platform 因子（用于多选）—— 后端 page_size 上限 100，需分页拉全。
  // has_values 按「训练起止区间」判定（后端 value_start/value_end），区间变化自动重拉（400ms 防抖）。
  const firstLoadRef = useRef(true);
  useEffect(() => {
    let alive = true;
    setLoadingFactors(true);
    const timer = setTimeout(async () => {
      try {
        const all: Factor[] = [];
        let page = 1;
        const PAGE_SIZE = 100;
        const range =
          trainStart && trainEnd ? { value_start: trainStart, value_end: trainEnd } : {};
        for (;;) {
          const res = await sdk.factors.listFactors({
            owner: "platform",
            visibility: "public",
            page,
            page_size: PAGE_SIZE,
            ...range,
          });
          const list = res.data as Factor[];
          all.push(...list);
          if (!res.pagination?.has_next || list.length < PAGE_SIZE || page >= 50) break;
          page += 1;
        }
        if (!alive) return;
        // 防御：后端翻页排序若不稳定（如排序字段并列）可能跨页返回同一因子，
        // 这里按 id 去重，避免重复 key 触发 React 告警、以及重复勾选/训练。
        const seen = new Set<string>();
        const unique = all.filter((f) => {
          if (seen.has(f.id)) return false;
          seen.add(f.id);
          return true;
        });
        setFactors(unique);
        // 默认勾选：优先「有预计算值的数值/排名型」；若都无值则退化为「数值/排名型」
        const informative = all.filter((f) => INFORMATIVE.has(f.output_type));
        const valued = informative.filter((f) => f.has_values);
        if (firstLoadRef.current) {
          firstLoadRef.current = false;
          setSelected(new Set((valued.length ? valued : informative).map((f) => f.id)));
        } else {
          // 区间变化：剔除已选中在新区间内无值的因子
          const valuedIds = new Set(all.filter((f) => f.has_values).map((f) => f.id));
          setSelected((prev) => new Set([...prev].filter((id) => valuedIds.has(id))));
        }
      } catch {
        if (alive) setFactors([]);
      } finally {
        if (alive) setLoadingFactors(false);
      }
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [trainStart, trainEnd]);

  // 当前选中/回填的历史任务 id（高亮 + 提示「参数已填充」）
  const [pickedJobId, setPickedJobId] = useState<string | null>(null);

  // 最近任务：按「当前用户 + 目标范围」过滤，实现参数/结果按用户与目标归拢
  const refreshRecent = async () => {
    try {
      const uid = await ensureUserId();
      const params: {
        page: number;
        page_size: number;
        user_id?: string;
        target_symbol?: string;
      } = { page: 1, page_size: 12 };
      if (uid) params.user_id = uid;
      if (recentScope === "target" && targetSymbol.trim()) {
        params.target_symbol = targetSymbol.trim();
      } else if (recentScope === "panel") {
        params.target_symbol = "__none__";
      }
      const res = await sdk.training.listJobs(params);
      setRecent(res.data);
    } catch {
      setRecent([]);
    }
  };
  useEffect(() => {
    refreshRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentScope, targetSymbol]);

  // 清理轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const filteredFactors = useMemo(() => {
    const q = factorSearch.trim().toLowerCase();
    return factors.filter(
      (f) =>
        !q ||
        f.name.toLowerCase().includes(q) ||
        (f.name_en ?? "").toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q),
    );
  }, [factors, factorSearch]);

  const grouped = useMemo(() => {
    const m = new Map<string, Factor[]>();
    for (const f of filteredFactors) {
      const k = f.category || "custom";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(f);
    }
    return Array.from(m.entries());
  }, [filteredFactors]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectValuedInformative = () => {
    const informative = factors.filter((f) => INFORMATIVE.has(f.output_type));
    const valued = informative.filter((f) => f.has_values);
    setSelected(new Set((valued.length ? valued : informative).map((f) => f.id)));
  };

  const togglePeerMode = (m: PeerMode) => {
    setPeerModes((prev) => {
      const n = new Set(prev);
      if (n.has(m)) n.delete(m);
      else n.add(m);
      return n;
    });
  };

  const stopPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const pollJob = (jobId: string) => {
    stopPoll();
    setActive({ job: null, error: null, loading: true });
    setResult(null);
    const tick = async () => {
      try {
        const res = await sdk.training.getJob(jobId);
        const job = res.data as TrainingJob;
        setActive({ job, error: null, loading: false });
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          stopPoll();
          refreshRecent();
          // 训练完成 → 拉取「一站式结果产物」（模型文件/特征顺序/重要度/指标表）
          if (job.status === "completed" && job.model_id) {
            sdk.training
              .getJobResult(jobId)
              .then((r) => setResult(r.data))
              .catch(() => setResult(null));
          }
        }
      } catch (e) {
        setActive({ job: null, error: String(e), loading: false });
        stopPoll();
      }
    };
    tick();
    pollRef.current = setInterval(tick, 3000);
  };

  // 把历史任务的 config 回填到左侧表单（可继续修改后重新训练）
  const applyConfig = (cfg: TrainJobConfig) => {
    if (!cfg) return;
    if (cfg.algorithm === "lightgbm" || cfg.algorithm === "dummy") setAlgorithm(cfg.algorithm);
    if (cfg.target) setTarget(cfg.target);
    if (cfg.train_start) setTrainStart(cfg.train_start);
    if (cfg.train_end) setTrainEnd(cfg.train_end);
    if (cfg.test_start) setTestStart(cfg.test_start);
    if (cfg.test_end) setTestEnd(cfg.test_end);
    setRefitOnValid(!!cfg.refit_on_valid);
    if (Array.isArray(cfg.symbols)) setSymbolsText(cfg.symbols.join(","));
    setModelName(cfg.model_name ?? "");
    setTargetSymbol(cfg.target_symbol ?? "");

    // 因子多选
    if (Array.isArray(cfg.features)) setSelected(new Set(cfg.features));

    // 同板块横截面特征
    const peer = cfg.peer;
    if (peer && peer.enabled) {
      setPeerEnabled(true);
      if (peer.group_by) setPeerGroupBy(peer.group_by);
      if (Array.isArray(peer.modes)) {
        // 过滤掉后端已移除的模式（如历史遗留的 "sector_return" 未来函数），
        // 避免用作模板重训时把非法模式提交给后端导致报错。
        const cleaned = peer.modes.filter(
          (m): m is PeerMode => (PEER_MODES as string[]).includes(m)
        );
        if (cleaned.length) setPeerModes(new Set(cleaned));
      }
      if (peer.pool_mode === "features") setPoolMode("features");
      else setPoolMode("reference");
      setPoolKlineOnly(Boolean(peer.pool_kline_only));
    } else {
      setPeerEnabled(false);
      setPoolMode("reference");
      setPoolKlineOnly(false);
    }

    // params：特征选择 / 调参 / 标签 / 切分
    const params = cfg.params ?? {};
    const selection = params.selection as
      | { method?: string; max_features?: number }
      | undefined;
    if (selection?.method === "importance") {
      setUseImportance(true);
      if (selection.max_features) setMaxFeatures(Number(selection.max_features));
    } else if (selection?.method === "variance") {
      setUseImportance(false);
    }
    setTuneEnabled(Boolean(params.tune));
    setTuneMetric(
      typeof params.tune_metric === "string" && TUNE_METRIC_LABEL[params.tune_metric]
        ? params.tune_metric
        : "auc",
    );

    const label = params.label as
      | { kind?: LabelKind; threshold?: number; expr?: string }
      | undefined;
    if (label?.kind) setLabelKind(label.kind);
    if (typeof label?.threshold === "number") setThresholdPct(label.threshold * 100);
    if (label?.expr) setLabelExpr(label.expr);

    if (params.split_method === "time" || params.split_method === "random") {
      setSplitMethod(params.split_method);
    }
  };

  // 点击历史任务：回填参数 + 监控该任务（完成则拉结果）
  const selectJob = (job: TrainingJob) => {
    setPickedJobId(job.job_id);
    applyConfig(job.config);
    pollJob(job.job_id);
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await ensureUserId();
      const symbols = symbolsText
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const config: TrainJobConfig = {
        algorithm,
        target,
        train_start: trainStart || null,
        train_end: trainEnd || null,
        test_start: testStart || null,
        test_end: testEnd || null,
        refit_on_valid: refitOnValid,
        symbols: symbols.length ? symbols : null,
        model_name: modelName.trim() || null,
        features: selected.size ? Array.from(selected) : undefined,
        // 多股票输入预测单只：指定目标股票（留空则全市场面板各自预测）
        target_symbol: targetSymbol.trim() || null,
        // 同板块横截面特征 / 多股票输入预测单只
        // peer.enabled=true 时，股票池（前端「股票池」框）将作为上下文生效：
        //  - pool_mode="reference"(A)：算目标股在池中的排名/相对强弱/板块均值
        //  - pool_mode="features"(B)：把池当作特征输入，算跨池横截面统计块（仅 technical 因子可选）
        peer: peerEnabled
          ? {
              enabled: true,
              group_by: peerGroupBy,
              modes: Array.from(peerModes),
              pool_mode: poolMode,
              pool_kline_only: poolMode === "features" ? poolKlineOnly : false,
            }
          : null,
        params: {
          selection: useImportance
            ? { method: "importance", max_features: Number(maxFeatures) || 60 }
            : { method: "variance" },
          // 自动调参：用训练窗口内切出的验证集网格搜索正则强度（不碰测试集，防泄漏）
          tune: tuneEnabled,
          // 调参目标指标（auc / pr_auc / logloss / f1），仅 tune=true 时后端使用
          tune_metric: tuneMetric,
          label: {
            kind: labelKind,
            threshold: (Number(thresholdPct) || 0) / 100, // 百分比 → 小数
            expr: labelKind === "custom" ? labelExpr.trim() : "",
          },
          num_boost_round: 200,
          // 切分方式：time=按时间（默认，杜绝未来函数）/ random=随机（仅对照实验）
          split_method: splitMethod,
        },
      };
      const res = await sdk.training.createJob({ config });
      pollJob(res.data.job_id);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const metrics = active.job?.metrics_preview as
    | {
        train_auc?: number;
        valid_auc?: number;
        test_auc?: number | null;
        feature_importance?: Record<string, number>;
        model_id?: string;
      }
    | null;

  const topImp = metrics?.feature_importance
    ? Object.entries(metrics.feature_importance)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 10)
    : [];

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />

      <section className="max-w-[1400px] mx-auto px-6 pt-6">
        <Link href="/train" className="text-[13px] text-rc-blue hover:underline">
          ← 返回训练目标
        </Link>
      </section>

      <section className="text-center px-6 pt-[24px] pb-[30px]">
        <h1 className="text-section-display text-white">
          {targetLocked && targetSymbol
            ? `预测 ${targetSymbol}`
            : recentScope === "panel"
              ? "全市场面板训练"
              : "模型训练"}
        </h1>
        <p className="mt-3 text-body-lg text-rc-text-secondary max-w-[680px] mx-auto">
          {targetLocked && targetSymbol
            ? `围绕目标股票 ${targetSymbol} 训练：股票池自动取同业，标签只保留该股。可点右侧历史任务复用参数。`
            : "选择「有信息量」的因子（数值 / 排名型），训练 LightGBM 涨跌方向模型"}
        </p>
      </section>

      {/* ── 训练逻辑 & 操作说明 ── */}
      <section className="max-w-[1400px] mx-auto px-6 pb-6">
        <button
          onClick={() => setShowGuide((v) => !v)}
          className="flex items-center gap-2 text-[13px] text-rc-blue hover:underline"
        >
          <span className={`transition-transform ${showGuide ? "rotate-90" : ""}`}>▸</span>
          训练逻辑 & 操作说明
        </button>
        {showGuide && <TrainGuide />}
      </section>

      <section className="max-w-[1400px] mx-auto px-6 pb-[100px]">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* ── 左：配置 ── */}
          <div className="space-y-5">
            {/* 基本参数 */}
            <div className="rc-card space-y-4">
              <h3 className="text-[15px] font-medium text-white">训练参数</h3>

              <div className="grid grid-cols-2 gap-3">
                <Field label="算法">
                  <select
                    value={algorithm}
                    onChange={(e) => setAlgorithm(e.target.value as "lightgbm" | "dummy")}
                    className="rc-input"
                  >
                    <option value="lightgbm">LightGBM（真实训练）</option>
                    <option value="dummy">Dummy（冒烟）</option>
                  </select>
                </Field>
                <Field label="验证集切分方式">
                  <select
                    value={splitMethod}
                    onChange={(e) => setSplitMethod(e.target.value as "time" | "random")}
                    className="rc-input"
                  >
                    <option value="time">按时间（默认·防未来函数）</option>
                    <option value="random">随机（仅对照实验）</option>
                  </select>
                  <p className="text-[11px] text-rc-text-dim mt-1.5">
                    默认「按时间」：训练用较早时段、验证用最近时段，二者时间不重叠，
                    避免未来样本泄漏导致验证 AUC 虚高。
                  </p>
                </Field>
                <Field label="训练区间（开始 ~ 结束）" className="col-span-2">
                  <div className="flex gap-2">
                    <input type="date" value={trainStart} onChange={(e) => setTrainStart(e.target.value)} className="rc-input" placeholder="开始" />
                    <span className="text-rc-text-dim self-center">~</span>
                    <input type="date" value={trainEnd} onChange={(e) => setTrainEnd(e.target.value)} className="rc-input" placeholder="结束" />
                  </div>
                  {trainEndTooLate && (
                    <p className="text-[11px] text-amber-400/90 mt-1">
                      ⚠ 训练结束日距今天不足预测周期（{horizonDays} 天）：前向标签需要未来
                      {horizonDays} 天数据，最近的样本将被丢弃，按时间切分的验证/测试集可能为空。
                      建议训练结束 ≤ 数据最新日期 − {horizonDays} 天。
                    </p>
                  )}
                </Field>
                <Field label="预留测试集（可选·不参与训练）" className="col-span-2">
                  <div className="flex gap-2">
                    <input type="date" value={testStart} onChange={(e) => setTestStart(e.target.value)} className="rc-input" placeholder="开始" />
                    <span className="text-rc-text-dim self-center">~</span>
                    <input type="date" value={testEnd} onChange={(e) => setTestEnd(e.target.value)} className="rc-input" placeholder="结束" />
                  </div>
                  <p className="text-[11px] text-rc-text-dim mt-1">
                    你手里未参与训练的「未来数据」。训练用它做最终评估、与验证集对比泛化效果；
                    不参与调参（避免乐观偏差）。留空则不评估测试集。
                  </p>
                </Field>
              </div>

              {/* 数据覆盖预警：区间超出因子值覆盖边界时提示（防静默截断） */}
              {coverage?.feature_values?.start && trainStart && trainStart < coverage.feature_values.start && (
                <p className="text-[11px] text-amber-400/90 -mt-2">
                  ⚠ 训练开始早于因子值覆盖起点（{coverage.feature_values.start}）：
                  早于该日的样本无因子值将被丢弃，实际训练窗口从该日起算。
                </p>
              )}
              {coverage?.feature_values?.end && trainEnd && trainEnd > coverage.feature_values.end && (
                <p className="text-[11px] text-amber-400/90 -mt-2">
                  ⚠ 训练结束晚于因子值覆盖终点（{coverage.feature_values.end}）：
                  之后的样本无因子值将被丢弃。
                </p>
              )}

              <Field label="股票池（逗号分隔，留空自动取样）">
                <textarea
                  value={symbolsText}
                  onChange={(e) => setSymbolsText(e.target.value)}
                  rows={2}
                  className="rc-input resize-none font-rc-mono text-[12px]"
                  placeholder="603216,603408,..."
                />
                {poolHint && (
                  <p className="text-[11px] text-rc-blue mt-1">{poolHint}</p>
                )}
              </Field>

              {/* ── 板块对比 & 目标股票 ── */}
              <div className="border-t border-rc-border-subtle pt-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h4 className="text-[13px] font-medium text-white">板块对比 & 目标股票</h4>
                  <span className="text-[11px] text-rc-text-dim">可选 · 增强横截面信息</span>
                </div>

                <Field label="预测目标股票（多股票输入预测单只，留空=全市场面板各自预测）">
                  <input
                    value={targetSymbol}
                    onChange={(e) => setTargetSymbol(e.target.value)}
                    className="rc-input font-rc-mono text-[12px]"
                    placeholder="如 600519（不填则训练全部股票）"
                  />
                  <p className="text-[11px] text-rc-text-dim mt-1.5">
                    指定后，训练股票池自动取「该股 + 同板块同业」，标签只保留目标股票，
                    但特征含同业聚合项，等价于「用一篮子同业作为上下文，预测其中一只的涨跌」。
                  </p>
                </Field>

                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-[13px] text-rc-text-secondary">
                    <input
                      type="checkbox"
                      checked={peerEnabled}
                      onChange={(e) => setPeerEnabled(e.target.checked)}
                      className="accent-rc-blue"
                    />
                    开启同业 / 股票池特征增强（指定目标股票后，股票池框将作为上下文生效）
                  </label>
                </div>

                {peerEnabled && (
                  <div className="space-y-4 border-l-2 border-rc-border-subtle pl-3">
                    <Field label="股票池用途（A / B 模式）">
                      <div className="flex gap-2">
                        {([
                          { m: "reference", t: "A · 横截面参照系", d: "池作为参照系，算目标股在池中的排名/相对强弱/板块均值" },
                          { m: "features", t: "B · 池特征输入", d: "池作为特征输入，算跨池横截面统计块（维度有界）" },
                        ] as const).map(({ m, t }) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setPoolMode(m)}
                            className={`flex-1 px-2.5 py-1.5 rounded-[6px] border text-[12px] transition ${
                              poolMode === m
                                ? "border-rc-blue bg-rc-blue/10 text-white"
                                : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-rc-text-dim mt-1.5">
                        {poolMode === "features"
                          ? "B：对每个因子在股票池内按交易日聚合 mean/std/min/max/median，生成与池大小无关的有界特征块（pool__{因子}__{统计}），与目标股自身特征一起喂入模型。"
                          : "A：以股票池为横截面参照系，计算目标股每个因子在池中的排名 / 相对强弱(Z) / 板块均值，等价于「用一篮子同业作为上下文预测其中一只」。"}
                      </p>
                    </Field>

                    {poolMode === "features" && (
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-2 text-[13px] text-rc-text-secondary">
                          <input
                            type="checkbox"
                            checked={poolKlineOnly}
                            onChange={(e) => setPoolKlineOnly(e.target.checked)}
                            className="accent-rc-blue"
                          />
                          池特征仅用 K线(technical)因子
                        </label>
                        <span className="text-[11px] text-rc-text-dim">
                          （默认关闭=用全部选中因子；开启后只取价格/成交量派生因子，避开基本面因子噪声）
                        </span>
                      </div>
                    )}

                    <Field label="分组维度（同业 / 同板块 的判定口径，A 模式使用）">
                      <select
                        value={peerGroupBy}
                        onChange={(e) =>
                          setPeerGroupBy(e.target.value as "industry" | "industry_level2" | "market")
                        }
                        className="rc-input"
                      >
                        <option value="industry">行业 industry</option>
                        <option value="industry_level2">二级行业 industry_level2</option>
                        <option value="market">市场 market</option>
                      </select>
                    </Field>

                    <Field label="特征类型（可多选）">
                      <div className="flex flex-wrap gap-1.5">
                        {([
                          { m: "rank", t: "组内排名" },
                          { m: "relative", t: "相对强弱(Z)" },
                          { m: "sector_mean", t: "板块均值" },
                        ] as const).map(({ m, t }) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => togglePeerMode(m)}
                            className={`px-2.5 py-1 rounded-[5px] border text-[11px] transition ${
                              peerModes.has(m)
                                ? "border-rc-blue bg-rc-blue/10 text-rc-blue"
                                : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <p className="text-[11px] text-rc-text-dim mt-1.5">
                        rank=该因子在组内同日的百分位排名；relative=(自身−组内均值)/组内标准差；
                        sector_mean=板块整体水位。
                      </p>
                    </Field>
                  </div>
                )}
              </div>

              <Field label="模型名称（可选）">
                <input
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="rc-input"
                  placeholder="留空自动生成"
                />
              </Field>

              <div className="flex items-center gap-3 pt-1">
                <label className="flex items-center gap-2 text-[13px] text-rc-text-secondary">
                  <input
                    type="checkbox"
                    checked={useImportance}
                    onChange={(e) => setUseImportance(e.target.checked)}
                    className="accent-rc-blue"
                  />
                  按重要性筛选特征（top-k）
                </label>
                <input
                  type="number"
                  min={5}
                  max={300}
                  value={maxFeatures}
                  disabled={!useImportance}
                  onChange={(e) => setMaxFeatures(Number(e.target.value))}
                  className="rc-input w-20 disabled:opacity-40"
                />
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-[13px] text-rc-text-secondary">
                  <input
                    type="checkbox"
                    checked={tuneEnabled}
                    onChange={(e) => setTuneEnabled(e.target.checked)}
                    className="accent-rc-blue"
                  />
                  自动调参（用验证集网格搜索正则强度）
                </label>
                {tuneEnabled && (
                  <label className="flex items-center gap-2 text-[12px] text-rc-text-secondary">
                    目标指标
                    <select
                      value={tuneMetric}
                      onChange={(e) => setTuneMetric(e.target.value)}
                      className="rc-input w-auto py-1 text-[12px]"
                    >
                      {TUNE_METRIC_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="text-[11px] text-rc-text-dim -mt-2">
                在 num_leaves / min_child_samples / feature_fraction / L2 网格上，用训练窗口内切出的
                验证集按所选指标直接选最优（不碰测试集，防泄漏）；训练耗时约 ×3~5。
                {tuneEnabled && (
                  <>
                    {" "}
                    当前指标：{TUNE_METRIC_LABEL[tuneMetric]} ——{" "}
                    {TUNE_METRIC_OPTIONS.find((o) => o.value === tuneMetric)?.hint}。
                    验证集正样本很少（&lt;10）时建议改用 LogLoss 或 PR-AUC，AUC 噪声太大。
                  </>
                )}
              </p>

              <div className="flex items-start gap-3 pt-1">
                <input
                  type="checkbox"
                  checked={refitOnValid}
                  onChange={(e) => setRefitOnValid(e.target.checked)}
                  className="accent-rc-blue mt-0.5"
                />
                <div>
                  <label className="text-[13px] text-rc-text-secondary cursor-pointer">
                    最终模型并入验证集全量训练（train + valid）
                  </label>
                  <p className="text-[11px] text-rc-text-dim mt-0.5">
                    关闭（默认）：最终模型只在训练集上训练，验证集保留为干净评估集，但损失约 20% 数据。
                    开启：用训练集+验证集全量训练（数据更多、拟合更强），但验证集变为样本内，
                    只有「预留测试集」能真实反映泛化能力。
                  </p>
                </div>
              </div>
            </div>

            {/* 标签定义 */}
            <div className="rc-card space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-medium text-white">标签定义（预测什么）</h3>
                <span className="text-[11px] text-rc-text-dim">metric &gt; 阈值 → 正类(1)</span>
              </div>

              {/* 标签三要素：前向窗口(return_Nx) + 指标类型 + 阈值/表达式，全部在此卡片 */}
              <Field label="预测目标 / 前向窗口（格式 return_Nx，x=d天/h时/m分）">
                <input
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="return_5d"
                />
                {isIntradayTarget && (
                  <p className="text-[11px] text-amber-400/90 mt-1">
                    分钟/小时级目标：标签将用 5m K线计算（样本点=每日收盘，与日频特征对齐）；
                    5m 数据自 {coverage?.klines_5m?.start ?? "2026-02-02"} 起，
                    训练集早于该日期的样本会被丢弃。
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {["return_5d", "return_10d", "return_20d", "return_60d"].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setTarget(p)}
                      className={`px-2 py-0.5 rounded-[5px] border text-[11px] font-rc-mono transition ${
                        target === p
                          ? "border-rc-blue bg-rc-blue/10 text-rc-blue"
                          : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-rc-text-dim mt-1.5">
                  自定义示例：return_30d（30 日）、return_3h（约半日）。模型预测该周期内收益率方向（&gt;0 为正类）。
                </p>
              </Field>

              <Field label="标签类型">
                <div className="grid grid-cols-2 gap-1.5">
                  {LABEL_KINDS.map((k) => (
                    <button
                      key={k.value}
                      type="button"
                      onClick={() => setLabelKind(k.value)}
                      className={`text-left px-2.5 py-1.5 rounded-[6px] border text-[12px] transition ${
                        labelKind === k.value
                          ? "border-rc-blue bg-rc-blue/10 text-white"
                          : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                      }`}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-rc-text-dim mt-1.5 font-rc-mono">
                  {LABEL_KINDS.find((k) => k.value === labelKind)?.desc}
                </p>
              </Field>

              <Field label="涨跌阈值（%）— metric 超过此值记为「涨」正类">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step={0.1}
                    value={thresholdPct}
                    onChange={(e) => setThresholdPct(Number(e.target.value))}
                    className="rc-input w-28 font-rc-mono"
                  />
                  <span className="text-[12px] text-rc-text-dim">
                    = {((Number(thresholdPct) || 0) / 100).toFixed(4)}（小数）
                  </span>
                  <div className="flex gap-1">
                    {[0, 1, 2, 5].map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setThresholdPct(p)}
                        className={`px-2 py-0.5 rounded-[5px] border text-[11px] font-rc-mono transition ${
                          thresholdPct === p
                            ? "border-rc-blue bg-rc-blue/10 text-rc-blue"
                            : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                        }`}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                </div>
                <p className="text-[11px] text-rc-text-dim mt-1.5">
                  例：阈值 2% 表示「未来 H 日{labelKind === "min_return" ? "回撤" : "涨幅"}超过 2%」才算正类；
                  0% 即默认的涨跌方向。阈值过高/过低会导致样本单一类别而报错。
                </p>
              </Field>

              {labelKind === "custom" && (
                <Field label="自定义标签表达式">
                  <textarea
                    value={labelExpr}
                    onChange={(e) => setLabelExpr(e.target.value)}
                    rows={2}
                    className="rc-input resize-none font-rc-mono text-[12px]"
                    placeholder="max_ret - abs(min_ret)"
                  />
                  <div className="mt-2 rounded-[6px] border border-rc-border-subtle p-2.5 space-y-1">
                    <div className="text-[11px] text-rc-text-secondary">可用变量：</div>
                    {LABEL_VARS.map((v) => (
                      <div key={v.name} className="flex gap-2 text-[11px]">
                        <span className="w-40 shrink-0 font-rc-mono text-rc-blue">{v.name}</span>
                        <span className="text-rc-text-dim">{v.desc}</span>
                      </div>
                    ))}
                    <div className="text-[11px] text-rc-text-dim pt-1">
                      函数：<span className="font-rc-mono">abs, maximum, minimum, clip, sign, log, log1p, sqrt, where</span>
                      （仅白名单，禁止属性/下标/导入）
                    </div>
                  </div>
                </Field>
              )}

            </div>

            {/* 因子多选 */}
            <div className="rc-card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-medium text-white">
                  因子特征
                  <span className="ml-2 text-[12px] font-rc-mono text-rc-blue">
                    已选 {selected.size}
                  </span>
                </h3>
                <div className="flex gap-2">
                  <button onClick={selectValuedInformative} className="text-[12px] text-rc-blue hover:underline">
                    选有值的因子
                  </button>
                  <button
                    onClick={() => setSelected(new Set())}
                    className="text-[12px] text-rc-text-dim hover:underline"
                  >
                    清空
                  </button>
                </div>
              </div>

              <input
                value={factorSearch}
                onChange={(e) => setFactorSearch(e.target.value)}
                placeholder="🔎 搜索因子名 / id"
                className="rc-input"
              />

              {loadingFactors ? (
                <div className="text-[13px] text-rc-text-dim py-6 text-center">加载因子…</div>
              ) : (
                <div className="max-h-[360px] overflow-y-auto pr-1 space-y-3">
                  {grouped.map(([cat, list]) => (
                    <div key={cat}>
                      <div className="text-[11px] uppercase tracking-[0.3px] text-rc-text-dim font-rc-mono mb-1">
                        {cat}
                      </div>
                      <div className="grid grid-cols-2 gap-1.5">
                        {list.map((f) => {
                          const on = selected.has(f.id);
                          const inf = INFORMATIVE.has(f.output_type);
                          const usable = f.has_values;
                          return (
                            <button
                              key={f.id}
                              onClick={() => usable && toggle(f.id)}
                              disabled={!usable}
                              title={
                                usable
                                  ? f.id
                                  : `${f.id}（所选训练区间内无预计算因子值，不可选）`
                              }
                              className={`text-left px-2.5 py-1.5 rounded-[6px] border text-[12px] transition flex items-center justify-between gap-2 ${
                                on
                                  ? "border-rc-blue bg-rc-blue/10 text-white"
                                  : usable
                                    ? "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                                    : "border-rc-border-subtle text-rc-text-dim opacity-40 cursor-not-allowed"
                              }`}
                            >
                              <span className="truncate">{f.name}</span>
                              <span
                                className={`shrink-0 text-[10px] font-rc-mono ${
                                  inf ? "text-rc-blue" : "text-rc-text-dim"
                                }`}
                              >
                                {(f.has_values ? "✓" : "") + (OUTPUT_TYPE_LABEL[f.output_type] ?? f.output_type)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-[11px] text-rc-text-dim">
                提示：✓ 表示「训练起止区间内」有预计算因子值、可直接训练；灰色因子在该区间无值、不可选（调整训练日期会自动重判）。
                蓝标为「数值 / 排名」型因子（有方差、可学习）；信号型（boolean）会被特征选择自动过滤。
              </p>
            </div>

            <button
              onClick={submit}
              disabled={submitting}
              className="w-full bg-white text-black py-3 rounded-[10px] text-[15px] font-medium hover:bg-[#ddd] transition disabled:opacity-40"
            >
              {submitting ? "提交中…" : "🚀 开始训练"}
            </button>
            {submitError && (
              <div className="rc-card border-rc-red/40 text-rc-red text-[13px]">{submitError}</div>
            )}
          </div>

          {/* ── 右：监控 + 最近 ── */}
          <div className="space-y-5">
            <div className="rc-card space-y-3">
              <h3 className="text-[15px] font-medium text-white">实时进度</h3>
              {!active.job && !active.loading && !active.error && (
                <div className="text-[13px] text-rc-text-dim py-8 text-center">
                  提交训练任务后，这里显示实时进度与指标
                </div>
              )}
              {active.loading && !active.job && (
                <div className="text-[13px] text-rc-text-dim py-8 text-center">等待 worker…</div>
              )}
              {active.error && <div className="text-[13px] text-rc-red">{active.error}</div>}
              {active.job && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <StatusBadge status={active.job.status} />
                    <span className="text-[11px] font-rc-mono text-rc-text-dim">
                      {active.job.job_id}
                    </span>
                  </div>
                  <div>
                    <div className="flex justify-between text-[12px] text-rc-text-secondary mb-1">
                      <span>阶段：{active.job.stage ?? "-"}</span>
                      <span>{Math.round((active.job.progress ?? 0) * 100)}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-rc-surface-input overflow-hidden">
                      <div
                        className="h-full bg-rc-blue transition-all"
                        style={{ width: `${Math.round((active.job.progress ?? 0) * 100)}%` }}
                      />
                    </div>
                  </div>
                  {active.job.error && (
                    <div className="rc-card border-rc-red/40 text-rc-red text-[12px]">
                      {JSON.stringify(active.job.error)}
                    </div>
                  )}
                  {metrics && (
                    <div
                      className={`grid gap-3 pt-1 ${
                        metrics.test_auc != null ? "grid-cols-3" : "grid-cols-2"
                      }`}
                    >
                      <Metric label="训练 AUC" value={metrics.train_auc} />
                      <Metric label="验证 AUC" value={metrics.valid_auc} />
                      {metrics.test_auc != null && (
                        <Metric label="测试 AUC" value={metrics.test_auc} />
                      )}
                    </div>
                  )}
                  {topImp.length > 0 && (
                    <div>
                      <div className="text-[12px] text-rc-text-secondary mb-2">Top 特征重要性</div>
                      <div className="space-y-1">
                        {topImp.map(([fid, imp]) => (
                          <div key={fid} className="flex items-center gap-2 text-[12px]">
                            <span className="w-32 truncate font-rc-mono text-rc-text-muted">{fid}</span>
                            <div className="flex-1 h-1.5 rounded-full bg-rc-surface-input overflow-hidden">
                              <div
                                className="h-full bg-rc-blue"
                                style={{ width: `${Math.max(4, Math.min(100, (imp as number) * 100))}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── 训练结果产物：模型文件 / 特征顺序 / 重要度 / 指标表 ── */}
            {result && result.ready && <TrainingResultPanel result={result} />}

            <div className="rc-card space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-medium text-white">
                  最近任务
                  <span className="ml-2 text-[11px] text-rc-text-dim">
                    {recentScope === "target"
                      ? `预测 ${targetSymbol || "—"}`
                      : recentScope === "panel"
                        ? "全市场面板"
                        : "我的全部"}
                  </span>
                </h3>
                <span className="text-[11px] text-rc-text-dim">点任务可复用参数</span>
              </div>
              {recent.length === 0 ? (
                <div className="text-[13px] text-rc-text-dim py-4 text-center">暂无任务</div>
              ) : (
                <div className="space-y-2">
                  {recent.map((j) => {
                    const picked = pickedJobId === j.job_id;
                    return (
                      <button
                        key={j.job_id}
                        onClick={() => selectJob(j)}
                        className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-[6px] border transition ${
                          picked
                            ? "border-rc-blue bg-rc-blue/10"
                            : "border-rc-border-subtle hover:border-rc-border-input"
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-[13px] text-rc-text-primary truncate">
                            {(j.config as { target?: string })?.target ?? "lightgbm"}
                            {(j.target_symbol ?? (j.config as { target_symbol?: string })?.target_symbol)
                              ? ` · 预测 ${j.target_symbol ?? (j.config as { target_symbol?: string }).target_symbol}`
                              : ""}
                            {picked && (
                              <span className="ml-2 text-[10px] text-rc-blue">✓ 参数已填充</span>
                            )}
                          </div>
                          <div className="text-[11px] font-rc-mono text-rc-text-dim truncate">
                            {(j.config as { params?: { split_method?: string } })?.params?.split_method === "random"
                              ? `${j.job_id} · 随机切分`
                              : j.job_id}
                          </div>
                        </div>
                        <StatusBadge status={j.status} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TrainingResultPanel({ result }: { result: TrainingResult }) {
  const impEntries = result.feature_importance
    ? Object.entries(result.feature_importance).sort((a, b) => (b[1] as number) - (a[1] as number))
    : [];
  const maxImp = impEntries.length ? (impEntries[0][1] as number) : 1;
  const mt = result.metrics_table;
  // 正样本数/占比：新任务后端直出 pos/pos_ratio；旧任务从混淆矩阵 [FN,TP] 兜底推算
  const posOf = (s?: { pos?: number; confusion?: [[number, number], [number, number]] }) =>
    s ? (s.pos ?? (s.confusion ? s.confusion[1][0] + s.confusion[1][1] : null)) : null;
  const posRatioOf = (s?: { pos_ratio?: number | null; n?: number } & Parameters<typeof posOf>[0]) => {
    if (!s) return null;
    if (s.pos_ratio != null) return s.pos_ratio;
    const p = posOf(s);
    return p != null && s.n ? p / s.n : null;
  };
  const validPos = posOf(mt?.valid);
  const rows: { label: string; train: number | null; valid: number | null; test?: number | null; pct?: boolean }[] = mt
    ? [
        { label: "AUC", train: mt.train.auc, valid: mt.valid.auc, test: mt.test?.auc ?? null },
        { label: "准确率", train: mt.train.accuracy, valid: mt.valid.accuracy, test: mt.test?.accuracy ?? null, pct: true },
        { label: "精确率", train: mt.train.precision, valid: mt.valid.precision, test: mt.test?.precision ?? null, pct: true },
        { label: "召回率", train: mt.train.recall, valid: mt.valid.recall, test: mt.test?.recall ?? null, pct: true },
        { label: "F1", train: mt.train.f1, valid: mt.valid.f1, test: mt.test?.f1 ?? null, pct: true },
        { label: "正样本占比", train: posRatioOf(mt.train), valid: posRatioOf(mt.valid), test: mt.test ? posRatioOf(mt.test) : null, pct: true },
      ]
    : [];

  return (
    <div className="rc-card space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-[15px] font-medium text-white">训练结果产物</h3>
        {result.model_id && (
          <Link
            href={{ pathname: "/backtest", query: { model_id: result.model_id } }}
            className="text-[12px] px-3 py-1.5 rounded-[6px] bg-rc-blue/15 text-rc-blue border border-rc-blue/40 hover:bg-rc-blue/25 transition"
          >
            用此模型回测 →
          </Link>
        )}
      </div>

      {/* 模型文件 + 关键信息 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rc-card border-rc-border-subtle">
          <div className="text-[11px] text-rc-text-dim">模型文件（MinIO）</div>
          <div className="text-[12px] font-rc-mono text-rc-text-muted mt-1 truncate">
            {result.model_file.file_path ?? "-"}
          </div>
          <div className="text-[11px] text-rc-text-dim mt-1">
            {result.model_name} · {result.algorithm} · {result.target}
            {result.model_file.file_size ? ` · ${(result.model_file.file_size / 1024).toFixed(1)} KB` : ""}
          </div>
          {result.training_range?.start && (
            <div className="text-[11px] text-rc-text-dim mt-1 font-rc-mono">
              训练区间：{result.training_range.start} ~ {result.training_range.end}
            </div>
          )}
          {result.model_file.file_path ? (
            <a
              href={`/svc/train/api/v1/training/models/${result.model_id}/file`}
              target="_blank"
              rel="noreferrer"
              className="inline-block mt-2 text-[12px] px-3 py-1 rounded-[6px] border border-rc-border-input text-rc-text-secondary hover:border-rc-blue hover:text-rc-blue transition"
            >
              ⬇ 下载模型
            </a>
          ) : (
            <div className="text-[11px] text-rc-text-dim mt-2">模型文件未上传（需 MinIO）</div>
          )}
        </div>

        <div className="rc-card border-rc-border-subtle">
          <div className="text-[11px] text-rc-text-dim">特征输入顺序（predict 必须严格对齐）</div>
          <div className="text-[12px] text-rc-text-secondary mt-1">
            共 {result.input_features?.length ?? 0} 个特征
            {result.config?.target_symbol ? ` · 预测 ${result.config.target_symbol}` : ""}
            {result.config?.split_method === "random" ? " · 随机切分" : " · 按时间切分"}
            {result.metrics_table?.final_train_on_valid ? " · 已并入验证集全量训练" : ""}
            {result.n_final_train ? ` · 训练样本 ${result.n_final_train}` : ""}
          </div>
          <div className="flex flex-wrap gap-1 mt-2 max-h-[120px] overflow-y-auto pr-1">
            {(result.input_features ?? []).map((f) => (
              <span
                key={f}
                className="px-1.5 py-0.5 rounded-[4px] border border-rc-border-subtle text-[10px] font-rc-mono text-rc-text-muted"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* 评估指标表 */}
      {mt && (
        <div>
          {/* 退化告警：双 AUC≈0.5，模型未学到有效信号 */}
          {mt.degenerate && (
            <div className="mb-3 rounded-[6px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
              ✗ 模型退化：训练/验证 AUC ≈ 0.5，未学到有效信号（单叶常数）。
              常见原因：有效样本过少（当前训练 {mt.train.n} 样本）、特征在该区间无区分度、
              标签阈值不合理。建议：拉长区间、减少特征数或开 importance top-k、检查标签阈值后重训。
            </div>
          )}
          {/* 小样本提示 */}
          {!mt.degenerate && mt.train.n < 1000 && (
            <div className="mb-3 rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              ⚠ 有效训练样本仅 {mt.train.n}（&lt;1000）：稀疏因子交集会丢样本，
              统计意义偏弱，建议拉长训练区间或精简特征数。
            </div>
          )}
          {/* 硬警告：验证集零正类预测（召回=0）——阈值下模型一笔单都不会开 */}
          {!mt.degenerate && mt.valid.recall === 0 && (validPos ?? 0) > 0 && (
            <div className="mb-3 rounded-[6px] border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
              ✗ 验证集零正类预测：在阈值 {mt.cls_threshold ?? "-"} 下，验证集 {validPos} 个正样本
              全部漏判（召回 0%、F1 0）。即使 AUC 看起来尚可，这个模型在样本外不会给出任何买入信号，
              实盘/回测基本不可用。常见原因：训练集过拟合导致概率分布漂移、训练/验证正样本占比差异大。
              建议：换面板训练加大样本、拉长标签周期、加强正则后重训。
            </div>
          )}
          {/* 验证集正样本过少：valid AUC 噪声大，自动调参目标不可靠 */}
          {!mt.degenerate && validPos != null && validPos > 0 && validPos < 10 && (
            <div className="mb-3 rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              ⚠ 验证集正样本仅 {validPos} 个（&lt;10）：验证 AUC 统计噪声极大，
              以它为目标的自动调参结果不可靠（不同超参的差异可能纯属运气）。
              建议：扩大验证窗口 / 换面板训练 / 降低标签阈值以增加正样本。
            </div>
          )}
          {/* 过拟合预警：训练/验证 AUC 差距 ≥ 0.15 提示 */}
          {!mt.degenerate && mt.train.auc != null && mt.valid.auc != null && mt.train.auc - mt.valid.auc >= 0.15 && (
            <div className="mb-3 rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              ⚠ 过拟合预警：训练 AUC {mt.train.auc.toFixed(4)} 与验证 AUC {mt.valid.auc.toFixed(4)}
              差距 {(mt.train.auc - mt.valid.auc).toFixed(2)}（≥0.15）。模型在样本外失效风险高，
              建议：拉长训练区间（≥1 年）、开启 importance top-k 减特征、或加大正则后重训。
            </div>
          )}
          {/* 泛化漂移预警：验证集（调参用）与测试集（预留）差距 ≥ 0.1 提示 */}
          {mt.test && mt.valid.auc != null && mt.test.auc != null && mt.valid.auc - mt.test.auc >= 0.1 && (
            <div className="mb-3 rounded-[6px] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-300">
              ⚠ 泛化漂移预警：验证集 AUC {mt.valid.auc.toFixed(4)} 与测试集 AUC {mt.test.auc.toFixed(4)}
              差距 {(mt.valid.auc - mt.test.auc).toFixed(2)}（≥0.1）。模型在「预留测试集」上明显弱于调参用的验证集，
              可能是过拟合验证集或时序分布漂移，建议核对标签口径与测试集区间。
            </div>
          )}
          <div className="text-[12px] text-rc-text-secondary mb-2">
            评估指标表（训练集 vs 验证集
            {mt.cls_threshold != null && (
              <span className="text-rc-text-dim">
                {" "}· 分类阈值 {mt.cls_threshold}（训练集 Youden J 自适应，非固定 0.5）
              </span>
            )}
            ）
          </div>
          {mt.final_train_on_valid && (
            <div className="mb-3 rounded-[6px] border border-rc-blue/40 bg-rc-blue/10 px-3 py-2 text-[12px] text-rc-blue">
              ℹ 已开启「并入验证集全量训练」：验证集被并入最终训练，故上表验证集指标为样本内结果、
              不可作为泛化评估；真实泛化能力请仅以「预留测试集」为准。
            </div>
          )}
          {mt.split_range && (
            <div className="text-[11px] font-rc-mono text-rc-text-dim mb-2">
              训练集 {mt.split_range.train.start} ~ {mt.split_range.train.end}（{mt.train.n} 样本）
              {" · "}
              验证集 {mt.split_range.valid.start} ~ {mt.split_range.valid.end}（{mt.valid.n} 样本）
              {mt.split_range.test && (
                <>
                  {" · "}
                  测试集 {mt.split_range.test.start} ~ {mt.split_range.test.end}（{mt.test?.n} 样本）
                </>
              )}
            </div>
          )}
          {mt.tuned_params && (
            <div className="text-[11px] font-rc-mono text-rc-text-dim mb-2">
              自动调参：{Object.entries(mt.tuned_params).map(([k, v]) => `${k}=${v}`).join(" · ")}
              {mt.cv_auc != null &&
                `（验证集 ${TUNE_METRIC_LABEL[mt.cv_metric ?? "auc"] ?? mt.cv_metric} ${mt.cv_auc}${
                  mt.cv_metric === "logloss" ? " · 越低越好" : ""
                }）`}
            </div>
          )}
          {!mt.test && (
            result.config?.test_start ? (
              <div className="mb-3 rounded-[6px] border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[12px] text-amber-300">
                ⚠ 你填写了预留测试集（{result.config.test_start} ~ {result.config.test_end}），但该区间未产生任何测试样本，
                故无测试集列。常见原因：因子数据尚未覆盖该时间段（或特征缺失被全部丢弃）。
                可在上方训练卡片的「数据覆盖预警」核对因子值覆盖上沿；若数据已补齐，重新训练即可出现测试集。
              </div>
            ) : (
              <div className="mb-3 rounded-[6px] border border-rc-border-subtle bg-rc-surface-panel px-3 py-2 text-[12px] text-rc-text-dim">
                ℹ 本次未填写「预留测试集」时间范围，仅展示训练集/验证集评估。
                在上方「预留测试集（可选·不参与训练）」填入你手里未参与训练的「未来数据」，
                训练后会多出测试集列，用于与验证集对比泛化漂移。
              </div>
            )
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-rc-text-dim">
                  <th className="text-left font-normal py-1">指标</th>
                  <th className="text-right font-normal py-1">训练集</th>
                  <th className="text-right font-normal py-1">验证集</th>
                  {mt.test && <th className="text-right font-normal py-1">测试集</th>}
                  <th className="text-right font-normal py-1">样本数</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className="border-t border-rc-border-subtle">
                    <td className="py-1 text-rc-text-secondary">{r.label}</td>
                    <td className="py-1 text-right font-rc-mono text-white">
                      {r.train == null ? "-" : r.pct ? `${(r.train * 100).toFixed(1)}%` : r.train.toFixed(4)}
                    </td>
                    <td className="py-1 text-right font-rc-mono text-white">
                      {r.valid == null ? "-" : r.pct ? `${(r.valid * 100).toFixed(1)}%` : r.valid.toFixed(4)}
                    </td>
                    {mt.test && (
                      <td className="py-1 text-right font-rc-mono text-white">
                        {r.test == null ? "-" : r.pct ? `${(r.test * 100).toFixed(1)}%` : r.test.toFixed(4)}
                      </td>
                    )}
                    <td className="py-1 text-right font-rc-mono text-rc-text-dim">
                      {r.label === "AUC" ? mt.train.n : ""}
                      {r.label === "F1" ? mt.valid.n : ""}
                      {mt.test && r.label === "准确率" ? mt.test.n : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 混淆矩阵 */}
          <div className={`grid gap-3 mt-3 ${mt.test ? "grid-cols-3" : "grid-cols-2"}`}>
            {(["train", "valid", "test"] as const).map((k) =>
              mt[k] ? (
                <div key={k} className="rc-card border-rc-border-subtle">
                  <div className="text-[11px] text-rc-text-dim mb-1">
                    {k === "train" ? "训练集" : k === "valid" ? "验证集" : "测试集"}混淆矩阵
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-center font-rc-mono text-[11px]">
                    {mt[k].confusion.map((row, i) =>
                      row.map((v, j) => (
                        <div
                          key={`${i}-${j}`}
                          className={`py-1.5 rounded-[4px] ${
                            i === j
                              ? "bg-rc-surface-input text-rc-text-muted"
                              : "bg-rc-red/15 text-rc-red"
                          }`}
                        >
                          {v}
                        </div>
                      )),
                    )}
                  </div>
                  <div className="text-[10px] text-rc-text-dim mt-1 text-center">
                    [[TN,FP],[FN,TP]]
                  </div>
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}

      {/* 完整特征重要度 */}
      {impEntries.length > 0 && (
        <div>
          <div className="text-[12px] text-rc-text-secondary mb-2">
            特征重要度（完整，按 gain 排序）
          </div>
          <div className="space-y-1 max-h-[260px] overflow-y-auto pr-1">
            {impEntries.map(([fid, imp]) => (
              <div key={fid} className="flex items-center gap-2 text-[12px]">
                <span className="w-40 truncate font-rc-mono text-rc-text-muted">{fid}</span>
                <div className="flex-1 h-1.5 rounded-full bg-rc-surface-input overflow-hidden">
                  <div
                    className="h-full bg-rc-blue"
                    style={{ width: `${Math.max(2, Math.min(100, ((imp as number) / (maxImp || 1)) * 100))}%` }}
                  />
                </div>
                <span className="w-12 text-right font-rc-mono text-rc-text-dim">
                  {(imp as number).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function TrainGuide() {
  return (
    <div className="rc-card space-y-5 mt-3">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 训练逻辑（数据处理 → 模型） */}
        <div className="space-y-3">
          <h4 className="text-[14px] font-medium text-white">训练逻辑（后端数据流）</h4>
          <ol className="space-y-2.5 text-[12.5px] text-rc-text-secondary">
            <Step n="1" title="构建因子矩阵 X">
              从 <code className="font-rc-mono text-rc-blue">feature_values</code> 取因子长表，pivot 成宽表：行 =
              <span className="text-rc-text-muted"> symbol × date</span>，列 = 各 <span className="text-rc-text-muted">factor_id</span>。
              仅用 scalar/rank 因子的 <code className="font-rc-mono text-rc-blue">value_num</code>（boolean 信号转 0/1 但默认不参与训练）。
            </Step>
            <Step n="2" title="构造标签 y（可配置）">
              从 <code className="font-rc-mono text-rc-blue">klines_all</code> 取 OHLCV，按标签类型算连续 metric：
              <span className="text-rc-text-muted"> 收盘涨跌 ret / 期间最大涨幅 max_ret / 最大回撤 min_ret / 自定义表达式</span>；
              再按<span className="text-rc-blue"> 涨跌阈值</span>二值化：<span className="text-rc-text-muted">y = (metric &gt; threshold)</span>。
              H 由 target 解析（return_5d → 5 个交易日）。
            </Step>
            <Step n="3" title="特征选择（两关）">
              <span className="text-rc-blue">variance</span>：丢弃常量（nunique≤1）、缺失率&gt;95%、零方差因子。
              <span className="text-rc-blue">importance</span>（可选）：先训轻量 LightGBM，按 gain 选 top-k。
            </Step>
            <Step n="4" title="训练 LightGBM">
              <span className="text-rc-blue">按时间切分</span>（默认）训练·验证集：训练用较早时段、
              验证用最近时段，二者时间严格不重叠，杜绝未来函数 / 信息泄漏；
              二分类预测涨跌方向（label&gt;0 为正类），early stopping 30 轮，
              输出 train / valid AUC 与特征重要性。
              {` `}「随机切分」仅保留作对照实验。
            </Step>
            <Step n="5" title="模型注册">
              booster 序列化为字符串上传 <span className="text-rc-text-muted">MinIO</span>，
              登记到 <span className="text-rc-text-muted">models / model_versions</span>，并记录最终选中的因子。
            </Step>
          </ol>
        </div>

        {/* 操作逻辑（人怎么用） */}
        <div className="space-y-3">
          <h4 className="text-[14px] font-medium text-white">操作逻辑（本页怎么用）</h4>
          <ol className="space-y-2.5 text-[12.5px] text-rc-text-secondary">
            <Step n="1" title="选因子">
              左侧多选，默认勾选 scalar/rank（数值 / 排名型，有方差可学习）。
              boolean 信号型会被特征选择自动过滤，建议优先选数值 / 排名因子。
            </Step>
            <Step n="2" title="填配置">
              算法（lightgbm 真实 / dummy 冒烟）、预测目标（可自定义 return_Nx，如 return_20d / return_3h）、
              训练起止日期、股票池（留空自动取样）、模型名称（留空自动生成）。
            </Step>
            <Step n="3" title="开特征选择">
              「按重要性筛选」勾选后填写 top-k（默认 60），对海量因子做增益剪枝，加速并降过拟合。
            </Step>
            <Step n="4" title="提交并监控">
              点「开始训练」后，右侧实时显示 阶段 + 进度条 + 训练/验证 AUC + Top 特征重要性；
              可点「最近任务」回看历史。
            </Step>
            <Step n="5" title="解读结果">
              valid_auc 越接近 1 越好；≈0.5 说明在所选窗口里这些因子缺乏预测力
              （多为数据信号不足，而非代码问题），应换更大股票池 / 更长区间或重算因子值。
            </Step>
          </ol>
        </div>
      </div>
      <div className="border-t border-rc-border-subtle pt-3 space-y-2">
        <h4 className="text-[13px] font-medium text-white">默认标签定义</h4>
        <p className="text-[12px] text-rc-text-secondary leading-relaxed">
          不改任何设置时，默认标签 = <span className="font-rc-mono text-rc-blue">收盘涨跌方向</span>：
          <span className="font-rc-mono text-rc-text-muted"> ret = close[t+H] / close[t] − 1</span>，
          阈值 <span className="font-rc-mono">threshold = 0</span> →
          <span className="text-rc-text-muted"> ret &gt; 0 记为正类(1，涨)，否则负类(0，跌/平)</span>。
          H 来自预测目标（如 return_5d 即未来 5 个交易日）。
        </p>
        <div className="text-[12px] text-rc-text-secondary leading-relaxed">
          自定义示例：
          <ul className="mt-1 space-y-1 text-rc-text-dim">
            <li>· <span className="font-rc-mono text-rc-blue">max_ret</span>，阈值 3% → 「未来窗口内最高涨幅 &gt; 3%」（抓强势/打板）</li>
            <li>· <span className="font-rc-mono text-rc-blue">min_ret</span>，阈值 −5% → 「回撤是否小于 5%」（风控/择时）</li>
            <li>· <span className="font-rc-mono text-rc-blue">max_ret - abs(min_ret)</span> → 「涨得多且回撤小」的非对称收益</li>
          </ul>
        </div>
      </div>
      <p className="text-[11px] text-rc-text-dim border-t border-rc-border-subtle pt-3">
        接口：<code className="font-rc-mono">POST /api/v1/training/jobs</code>，
        标签配置放在 <code className="font-rc-mono">config.params.label = {"{ kind, threshold, expr }"}</code>；
        任务由 train-svc（Celery worker）异步执行，状态可轮询。
      </p>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-rc-blue/15 text-rc-blue text-[11px] font-rc-mono flex items-center justify-center mt-0.5">
        {n}
      </span>
      <div>
        <div className="text-white font-medium">{title}</div>
        <div className="leading-relaxed mt-0.5">{children}</div>
      </div>
    </li>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className ?? ""}`}>
      <span className="block text-[12px] text-rc-text-secondary mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value?: number }) {
  return (
    <div className="rc-card border-rc-border-subtle">
      <div className="text-[11px] text-rc-text-dim">{label}</div>
      <div className="text-[20px] font-rc-mono text-white">{value != null ? value.toFixed(4) : "-"}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-900/20 text-yellow-400 border-yellow-700/30",
    running: "bg-blue-900/20 text-blue-400 border-blue-700/30",
    completed: "bg-green-900/20 text-green-400 border-green-700/30",
    failed: "bg-red-900/20 text-red-400 border-red-700/30",
    cancelled: "bg-gray-800/40 text-gray-400 border-gray-700/40",
  };
  return (
    <span
      className={`px-2 py-0.5 rounded-[5px] border text-[11px] font-rc-mono ${
        map[status] ?? "bg-gray-800/40 text-gray-400 border-gray-700/40"
      }`}
    >
      {status}
    </span>
  );
}
