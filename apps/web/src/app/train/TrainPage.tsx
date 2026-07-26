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

// 默认训练区间：最近 3 个月（因子值覆盖随数据更新，旧默认 2026-01-01~03-01 大半无数据）
function defaultTrainRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 3);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

type LabelKind = "return" | "max_return" | "min_return" | "custom";

type PeerMode = "rank" | "relative" | "sector_mean" | "sector_return";

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

export function TrainPage() {
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
  const [symbolsText, setSymbolsText] = useState(DEFAULT_SYMBOLS);
  const [modelName, setModelName] = useState("");
  const [useImportance, setUseImportance] = useState(true);
  const [maxFeatures, setMaxFeatures] = useState(60);

  // ── 标签定义 ──
  const [labelKind, setLabelKind] = useState<LabelKind>("return");
  const [thresholdPct, setThresholdPct] = useState(0); // 涨跌阈值（百分比，UI 友好）
  const [labelExpr, setLabelExpr] = useState("max_ret - abs(min_ret)");

  // ── 同板块横截面特征 / 多股票预测单只 ──
  const [targetSymbol, setTargetSymbol] = useState(""); // 指定「预测哪一只」，留空=全市场面板
  const [peerEnabled, setPeerEnabled] = useState(false);
  const [peerGroupBy, setPeerGroupBy] = useState<"industry" | "industry_level2" | "market">("industry");
  const [peerModes, setPeerModes] = useState<Set<PeerMode>>(
    new Set<PeerMode>(["rank", "relative", "sector_mean"]),
  );
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
        setFactors(all);
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

  // 最近任务
  const refreshRecent = () => {
    sdk.training
      .listJobs({ page: 1, page_size: 8 })
      .then((res) => setRecent(res.data))
      .catch(() => setRecent([]));
  };
  useEffect(() => {
    refreshRecent();
  }, []);

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
        symbols: symbols.length ? symbols : null,
        model_name: modelName.trim() || null,
        features: selected.size ? Array.from(selected) : undefined,
        // 多股票输入预测单只：指定目标股票（留空则全市场面板各自预测）
        target_symbol: targetSymbol.trim() || null,
        // 同板块横截面特征：当前股票在同业中的排名/相对强弱/板块均值/板块前向收益
        peer: peerEnabled
          ? {
              enabled: true,
              group_by: peerGroupBy,
              modes: Array.from(peerModes),
            }
          : null,
        params: {
          selection: useImportance
            ? { method: "importance", max_features: Number(maxFeatures) || 60 }
            : { method: "variance" },
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

      <section className="text-center px-6 pt-[60px] pb-[30px]">
        <h1 className="text-section-display text-white">模型训练</h1>
        <p className="mt-3 text-body-lg text-rc-text-secondary max-w-[680px] mx-auto">
          选择「有信息量」的因子（数值 / 排名型），训练 LightGBM 涨跌方向模型
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
                <Field label="预测目标（可自定义，格式 return_Nx，x=d天/h时/m分）">
                  <input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    className="rc-input font-rc-mono text-[12px]"
                    placeholder="return_5d"
                  />
                  {isIntradayTarget && (
                    <p className="text-[11px] text-amber-400/90 mt-1">
                      分钟/小时级目标：标签将用 5m K线计算（样本点=每日收盘，与日频特征对齐）；
                      5m 数据自 2026-02-02 起，训练集早于该日期的样本会被丢弃。
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
                <Field label="训练开始">
                  <input type="date" value={trainStart} onChange={(e) => setTrainStart(e.target.value)} className="rc-input" />
                </Field>
                <Field label="训练结束">
                  <input type="date" value={trainEnd} onChange={(e) => setTrainEnd(e.target.value)} className="rc-input" />
                  {trainEndTooLate && (
                    <p className="text-[11px] text-amber-400/90 mt-1">
                      ⚠ 训练结束日距今天不足预测周期（{horizonDays} 天）：前向标签需要未来
                      {horizonDays} 天数据，最近的样本将被丢弃，按时间切分的验证/测试集可能为空。
                      建议训练结束 ≤ 数据最新日期 − {horizonDays} 天。
                    </p>
                  )}
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
              </div>

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
            </div>

            {/* 标签定义 */}
            <div className="rc-card space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-[15px] font-medium text-white">标签定义（预测什么）</h3>
                <span className="text-[11px] text-rc-text-dim">metric &gt; 阈值 → 正类(1)</span>
              </div>

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

              {/* ── 板块对比 & 目标股票（并入训练参数）── */}
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
                    开启同板块横截面特征（当前股票在同业中的排名 / 关系）
                  </label>
                </div>

                {peerEnabled && (
                  <div className="space-y-4 border-l-2 border-rc-border-subtle pl-3">
                    <Field label="分组维度（同业 / 同板块 的判定口径）">
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
                          { m: "sector_return", t: "板块前向收益" },
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
                        sector_mean=板块整体水位；sector_return=板块未来涨跌均值。
                      </p>
                    </Field>
                  </div>
                )}
              </div>
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
                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <Metric label="训练 AUC" value={metrics.train_auc} />
                      <Metric label="验证 AUC" value={metrics.valid_auc} />
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
              <h3 className="text-[15px] font-medium text-white">最近任务</h3>
              {recent.length === 0 ? (
                <div className="text-[13px] text-rc-text-dim py-4 text-center">暂无任务</div>
              ) : (
                <div className="space-y-2">
                  {recent.map((j) => (
                    <button
                      key={j.job_id}
                      onClick={() => pollJob(j.job_id)}
                      className="w-full flex items-center justify-between text-left px-3 py-2 rounded-[6px] border border-rc-border-subtle hover:border-rc-border-input transition"
                    >
                      <div className="min-w-0">
                        <div className="text-[13px] text-rc-text-primary truncate">
                          {(j.config as { target?: string })?.target ?? "lightgbm"}
                          {(j.config as { target_symbol?: string })?.target_symbol
                            ? ` · 预测 ${(j.config as { target_symbol?: string }).target_symbol}`
                            : ""}
                        </div>
                        <div className="text-[11px] font-rc-mono text-rc-text-dim truncate">
                          {(j.config as { params?: { split_method?: string } })?.params?.split_method === "random"
                            ? `${j.job_id} · 随机切分`
                            : j.job_id}
                        </div>
                      </div>
                      <StatusBadge status={j.status} />
                    </button>
                  ))}
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
  const rows: { label: string; train: number | null; valid: number | null; pct?: boolean }[] = mt
    ? [
        { label: "AUC", train: mt.train.auc, valid: mt.valid.auc },
        { label: "准确率", train: mt.train.accuracy, valid: mt.valid.accuracy, pct: true },
        { label: "精确率", train: mt.train.precision, valid: mt.valid.precision, pct: true },
        { label: "召回率", train: mt.train.recall, valid: mt.valid.recall, pct: true },
        { label: "F1", train: mt.train.f1, valid: mt.valid.f1, pct: true },
      ]
    : [];

  return (
    <div className="rc-card space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-[15px] font-medium text-white">训练结果产物</h3>
        {result.model_id && (
          <Link
            href={{ pathname: "/sdk-demo", query: { model_id: result.model_id } }}
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
          {result.model_file.download_url ? (
            <a
              href={result.model_file.download_url}
              target="_blank"
              rel="noreferrer"
              className="inline-block mt-2 text-[12px] px-3 py-1 rounded-[6px] border border-rc-border-input text-rc-text-secondary hover:border-rc-blue hover:text-rc-blue transition"
            >
              ⬇ 下载模型（10 分钟有效）
            </a>
          ) : (
            <div className="text-[11px] text-rc-text-dim mt-2">下载链接生成失败（需 MinIO）</div>
          )}
        </div>

        <div className="rc-card border-rc-border-subtle">
          <div className="text-[11px] text-rc-text-dim">特征输入顺序（predict 必须严格对齐）</div>
          <div className="text-[12px] text-rc-text-secondary mt-1">
            共 {result.input_features?.length ?? 0} 个特征
            {result.config?.target_symbol ? ` · 预测 ${result.config.target_symbol}` : ""}
            {result.config?.split_method === "random" ? " · 随机切分" : " · 按时间切分"}
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
          <div className="text-[12px] text-rc-text-secondary mb-2">评估指标表（训练集 vs 验证集）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-rc-text-dim">
                  <th className="text-left font-normal py-1">指标</th>
                  <th className="text-right font-normal py-1">训练集</th>
                  <th className="text-right font-normal py-1">验证集</th>
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
                    <td className="py-1 text-right font-rc-mono text-rc-text-dim">
                      {r.label === "AUC" ? mt.train.n : ""}
                      {r.label === "F1" ? mt.valid.n : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 混淆矩阵 */}
          <div className="grid grid-cols-2 gap-3 mt-3">
            {(["train", "valid"] as const).map((k) => (
              <div key={k} className="rc-card border-rc-border-subtle">
                <div className="text-[11px] text-rc-text-dim mb-1">
                  {k === "train" ? "训练集" : "验证集"}混淆矩阵
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
            ))}
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
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
