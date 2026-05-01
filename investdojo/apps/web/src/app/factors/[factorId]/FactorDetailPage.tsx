"use client";

// ============================================================
// 因子详情页 — Raycast Design System
// 三栏：头部（名称/分类/公式） + 表现统计 + 历史值时间序列
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ApiError,
  type Factor,
  type FactorHistoryLong,
  type FactorPerformance,
} from "@investdojo/api";
import { sdk } from "@/lib/sdk";
import { UserNav } from "@/components/UserNav";

// 默认取最近跑过的一段——对齐 T-3.05 backfill 窗口
const DEFAULT_START = "2024-10-01";
const DEFAULT_END = "2024-12-31";
const DEFAULT_SYMBOLS = ["600519", "000001", "300750"];

const OUTPUT_TYPE_LABEL: Record<string, string> = {
  boolean: "信号（Boolean）",
  scalar: "数值（Scalar）",
  rank: "排名（Rank）",
};

const CATEGORY_ICON: Record<string, string> = {
  technical: "📈",
  valuation: "💰",
  growth: "🌱",
  sentiment: "🔥",
  fundamental: "🏛️",
  macro: "🌐",
  custom: "⚙️",
};

export function FactorDetailPage({ factorId }: { factorId: string }) {
  const [factor, setFactor] = useState<Factor | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 历史值查询参数
  const [symbolsInput, setSymbolsInput] = useState(DEFAULT_SYMBOLS.join(","));
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);

  const [performance, setPerformance] = useState<FactorPerformance | null>(null);
  const [perfLoading, setPerfLoading] = useState(false);

  const [history, setHistory] = useState<FactorHistoryLong | null>(null);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);

  // 加载因子详情
  useEffect(() => {
    let alive = true;
    setLoading(true);
    sdk.factors
      .getFactor(factorId)
      .then((res) => {
        if (alive) setFactor(res.data);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [factorId]);

  // 加载表现统计
  useEffect(() => {
    if (!factor) return;
    let alive = true;
    setPerfLoading(true);
    sdk.factors
      .getFactorPerformance(factor.id, { start, end })
      .then((res) => alive && setPerformance(res.data))
      .catch(() => alive && setPerformance(null))
      .finally(() => alive && setPerfLoading(false));
    return () => {
      alive = false;
    };
  }, [factor, start, end]);

  // 加载历史值
  const symbols = useMemo(
    () =>
      symbolsInput
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20),
    [symbolsInput],
  );

  const loadHistory = () => {
    if (!factor || symbols.length === 0) return;
    setHistLoading(true);
    setHistError(null);
    sdk.factors
      .getFactorHistory(factor.id, { symbols, start, end, format: "long" })
      .then((res) => setHistory(res))
      .catch((e: unknown) => {
        setHistError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
        setHistory(null);
      })
      .finally(() => setHistLoading(false));
  };

  useEffect(() => {
    if (factor) loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factor?.id]);

  if (loading) {
    return (
      <Shell>
        <div className="rc-card h-[300px] animate-pulse" />
      </Shell>
    );
  }

  if (error || !factor) {
    return (
      <Shell>
        <div className="rc-card border-rc-red/40 text-rc-red">
          加载失败：{error ?? "因子不存在"}
          <div className="mt-4">
            <Link href="/factors" className="text-rc-blue underline">
              ← 回到因子库
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const catIcon = CATEGORY_ICON[factor.category] ?? "📊";

  return (
    <Shell name={factor.name}>
      {/* ── 头部信息 ── */}
      <section className="rc-card-feature p-8 mb-6">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-3">
              <span className="rc-badge text-[12px]">
                {catIcon} {factor.category}
              </span>
              <span className="rc-badge text-[12px] text-rc-blue border-rc-blue/30">
                {OUTPUT_TYPE_LABEL[factor.output_type] ?? factor.output_type}
              </span>
              <span className="text-[12px] font-rc-mono text-rc-text-dim">
                v{factor.version} · {factor.update_frequency}
              </span>
              {factor.owner === "platform" && (
                <span className="text-[12px] font-rc-mono text-rc-yellow">⭐ 官方</span>
              )}
            </div>
            <h1 className="text-[28px] font-semibold text-white tracking-[0.2px] mb-1">
              {factor.name}
            </h1>
            {factor.name_en && (
              <p className="text-[13px] font-rc-mono text-rc-text-dim mb-4">{factor.name_en}</p>
            )}
            <p className="text-body text-rc-text-secondary leading-relaxed max-w-[720px]">
              {factor.description || "（无描述）"}
            </p>
            {factor.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-4">
                {factor.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[11px] px-2 py-0.5 rounded-[4px] bg-rc-surface-card text-rc-text-muted border border-rc-border-subtle"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 text-right">
            <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
              Lookback
            </div>
            <div className="text-[24px] font-rc-mono text-rc-blue leading-none mt-1">
              {factor.lookback_days}
              <span className="text-[12px] text-rc-text-dim ml-1">天</span>
            </div>
          </div>
        </div>

        {/* 公式 */}
        <div className="mt-6">
          <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
            Formula（{factor.formula_type.toUpperCase()}）
          </div>
          <pre className="px-4 py-3 rounded-[8px] bg-rc-surface-input border border-rc-border-subtle text-[13px] font-rc-mono text-rc-text-primary whitespace-pre-wrap break-all">
            {factor.formula}
          </pre>
        </div>
      </section>

      {/* ── 表现统计 ── */}
      <section className="mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-white tracking-[0.2px]">
            历史表现统计
            <span className="text-[12px] font-rc-mono text-rc-text-dim ml-2">
              {start} ~ {end}
            </span>
          </h2>
        </div>
        <PerformanceBlock perf={performance} loading={perfLoading} outputType={factor.output_type} />
      </section>

      {/* ── 历史值时间序列 ── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-white tracking-[0.2px]">
            因子历史值
          </h2>
        </div>

        {/* Toolbar */}
        <div className="rc-card p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr_1fr_auto] gap-3 items-end">
            <div>
              <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                股票代码（逗号分隔，最多 20 个）
              </label>
              <input
                value={symbolsInput}
                onChange={(e) => setSymbolsInput(e.target.value)}
                className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
              />
            </div>
            <div>
              <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                Start
              </label>
              <input
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
              />
            </div>
            <div>
              <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                End
              </label>
              <input
                type="date"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
              />
            </div>
            <button
              onClick={loadHistory}
              disabled={histLoading || symbols.length === 0}
              className="rc-btn-primary px-4 py-2 text-[13px] disabled:opacity-40"
            >
              {histLoading ? "计算中…" : "查询"}
            </button>
          </div>
        </div>

        {histError && (
          <div className="rc-card border-rc-red/40 text-rc-red text-[13px]">
            查询失败：{histError}
          </div>
        )}

        {history && <HistoryView history={history} outputType={factor.output_type} symbols={symbols} />}
      </section>
    </Shell>
  );
}

// ────────────────────────────────────────────
// Shell
// ────────────────────────────────────────────

function Shell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-rc-bg">
      <nav className="sticky top-0 z-50 bg-rc-bg border-b border-rc-border">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <Link href="/" className="text-[20px] font-semibold text-white tracking-[0.2px]">
              InvestDojo
            </Link>
            <span className="text-rc-text-dark">/</span>
            <Link href="/factors" className="text-[14px] text-rc-text-muted hover:text-white tracking-[0.2px]">
              因子库
            </Link>
            {name && (
              <>
                <span className="text-rc-text-dark">/</span>
                <span className="text-[14px] text-white tracking-[0.2px] truncate max-w-[360px]">
                  {name}
                </span>
              </>
            )}
          </div>
          <UserNav />
        </div>
      </nav>
      <main className="max-w-[1200px] mx-auto px-6 py-10">{children}</main>
    </div>
  );
}

// ────────────────────────────────────────────
// 表现统计块
// ────────────────────────────────────────────

function PerformanceBlock({
  perf,
  loading,
  outputType,
}: {
  perf: FactorPerformance | null;
  loading: boolean;
  outputType: string;
}) {
  if (loading) {
    return <div className="rc-card h-[96px] animate-pulse" />;
  }
  if (!perf || perf.total_records === 0) {
    return (
      <div className="rc-card text-center py-6 text-rc-text-dim text-[13px]">
        此窗口内暂无预计算数据（feature_values），请等待因子被回填
      </div>
    );
  }

  const items: Array<{ label: string; value: string; accent?: "blue" | "green" | "red" }> = [
    { label: "总记录数", value: perf.total_records.toLocaleString(), accent: "blue" },
    { label: "覆盖股票", value: perf.coverage_symbols.toLocaleString() },
    { label: "覆盖交易日", value: perf.coverage_days.toLocaleString() },
  ];
  if (outputType === "boolean" && perf.trigger_rate !== undefined) {
    const rate = (perf.trigger_rate * 100).toFixed(2);
    items.push({
      label: "触发率",
      value: `${rate}%`,
      accent: perf.trigger_rate > 0.1 ? "red" : "green",
    });
    items.push({ label: "触发次数", value: (perf.trigger_count ?? 0).toLocaleString() });
  }
  if (outputType === "scalar" && perf.mean !== undefined) {
    items.push({ label: "均值", value: fmtNum(perf.mean) });
    items.push({ label: "标准差", value: fmtNum(perf.std) });
    items.push({ label: "最小值", value: fmtNum(perf.min) });
    items.push({ label: "最大值", value: fmtNum(perf.max) });
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
      {items.map((it) => (
        <div key={it.label} className="rc-card p-4">
          <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
            {it.label}
          </div>
          <div
            className={`text-[20px] font-rc-mono mt-1 leading-tight ${
              it.accent === "blue"
                ? "text-rc-blue"
                : it.accent === "red"
                  ? "text-rc-red"
                  : it.accent === "green"
                    ? "text-rc-green"
                    : "text-white"
            }`}
          >
            {it.value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ────────────────────────────────────────────
// 历史值可视化（无依赖 SVG 折线图 + 表格）
// ────────────────────────────────────────────

function HistoryView({
  history,
  outputType,
  symbols,
}: {
  history: FactorHistoryLong;
  outputType: string;
  symbols: string[];
}) {
  const rows = history.data;
  if (rows.length === 0) {
    return (
      <div className="rc-card text-center py-6 text-rc-text-dim text-[13px]">
        未查到数据（status={history.meta.status}）
      </div>
    );
  }

  // 按 symbol 分组
  const bySymbol = useMemo(() => {
    const map = new Map<string, { date: string; value: number | boolean }[]>();
    for (const r of rows) {
      if (!map.has(r.symbol)) map.set(r.symbol, []);
      map.get(r.symbol)!.push({ date: r.date, value: r.value });
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    return map;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="rc-card p-5">
        <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-3">
          {rows.length.toLocaleString()} 条 · {bySymbol.size} 支股票
        </div>
        <div className="grid grid-cols-1 gap-5">
          {symbols.map((sym) => {
            const series = bySymbol.get(sym);
            if (!series || series.length === 0) {
              return (
                <div key={sym} className="text-[12px] font-rc-mono text-rc-text-dim">
                  {sym} · 无数据
                </div>
              );
            }
            return <SparkSeries key={sym} symbol={sym} series={series} outputType={outputType} />;
          })}
        </div>
      </div>
    </div>
  );
}

function SparkSeries({
  symbol,
  series,
  outputType,
}: {
  symbol: string;
  series: { date: string; value: number | boolean }[];
  outputType: string;
}) {
  const W = 1080;
  const H = 100;
  const PADDING = 8;

  // boolean 专用：打点标记
  if (outputType === "boolean") {
    const triggers = series.filter((s) => s.value === true);
    const rate = (triggers.length / series.length) * 100;
    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="font-rc-mono text-[13px] text-white">{symbol}</div>
          <div className="text-[11px] font-rc-mono text-rc-text-dim">
            触发 {triggers.length}/{series.length} · {rate.toFixed(2)}%
          </div>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[60px]">
          <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="rgba(255,255,255,0.08)" />
          {series.map((s, i) => {
            const x = (i / Math.max(1, series.length - 1)) * (W - PADDING * 2) + PADDING;
            if (s.value === true) {
              return (
                <line
                  key={i}
                  x1={x}
                  y1={H * 0.15}
                  x2={x}
                  y2={H * 0.85}
                  stroke="#FF6363"
                  strokeWidth={2}
                  opacity={0.85}
                />
              );
            }
            return (
              <circle key={i} cx={x} cy={H / 2} r={0.8} fill="rgba(255,255,255,0.15)" />
            );
          })}
        </svg>
        <div className="flex justify-between text-[10px] font-rc-mono text-rc-text-dim mt-1">
          <span>{series[0]?.date}</span>
          <span>{series[series.length - 1]?.date}</span>
        </div>
      </div>
    );
  }

  // scalar：折线图
  const vals = series.map((s) => Number(s.value));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const rng = max - min || 1;
  const path = series
    .map((s, i) => {
      const x = (i / Math.max(1, series.length - 1)) * (W - PADDING * 2) + PADDING;
      const y = H - PADDING - ((Number(s.value) - min) / rng) * (H - PADDING * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const last = vals[vals.length - 1];
  const first = vals[0];
  const delta = last - first;
  const pct = (delta / (Math.abs(first) || 1)) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="font-rc-mono text-[13px] text-white">{symbol}</div>
        <div className="flex items-center gap-3 text-[11px] font-rc-mono">
          <span className="text-rc-text-dim">
            range [{fmtNum(min)}, {fmtNum(max)}]
          </span>
          <span className="text-white">当前 {fmtNum(last)}</span>
          <span className={delta >= 0 ? "text-stock-up" : "text-stock-down"}>
            {delta >= 0 ? "+" : ""}
            {fmtNum(delta)} ({pct >= 0 ? "+" : ""}
            {pct.toFixed(2)}%)
          </span>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[100px]">
        <defs>
          <linearGradient id={`grad-${symbol}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#55b3ff" stopOpacity="0.25" />
            <stop offset="100%" stopColor="#55b3ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* baseline */}
        <line x1={0} y1={H - PADDING} x2={W} y2={H - PADDING} stroke="rgba(255,255,255,0.06)" />
        <path d={`${path} L ${W - PADDING} ${H - PADDING} L ${PADDING} ${H - PADDING} Z`} fill={`url(#grad-${symbol})`} />
        <path d={path} fill="none" stroke="#55b3ff" strokeWidth={1.4} />
      </svg>
      <div className="flex justify-between text-[10px] font-rc-mono text-rc-text-dim mt-1">
        <span>{series[0]?.date}</span>
        <span>{series[series.length - 1]?.date}</span>
      </div>
    </div>
  );
}

function fmtNum(v: number | undefined | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
