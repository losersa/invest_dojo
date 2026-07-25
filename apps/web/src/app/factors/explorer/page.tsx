"use client";

// ============================================================
// 因子数据浏览器 — Raycast Design System
//
// 两个主维度（可切换）：
//   ① 时间序列矩阵：1 只股票 × 多因子（按交易日展开）
//   ② 横截面矩阵：某交易日 × 全市场（按股票展开）
//
// 两种展现（可切换）：表格（z-score 热力着色）/ 图表
//
// 后端复用：
//   - 时间序列：POST /factors/compute（逐因子实时算，无需缓存）
//   - 横截面：  POST /factors/batch-query（读 feature_values 缓存，分块）
//   - 股票池：  GET  /data/symbols?universe=
//   - 收盘价：  GET  /data/klines（图表对照轴）
// ============================================================

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import Link from "next/link";
import {
  ApiError,
  type Factor,
  type FactorBatchQueryResponse,
  type FactorCategory,
  type KLine,
} from "@investdojo/api";
import { sdk, ensureUserId } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

const DEFAULT_START = "2026-03-01";
const DEFAULT_END = "2026-04-30";
const DEFAULT_CROSS_DATE = "2026-04-30";
const MAX_FACTORS = 16;
const SYMBOL_CHUNK = 100; // batch-query 单批符号上限
const PLOT_COLORS = [
  "#55b3ff", "#FF6363", "#5ee08a", "#f5c451",
  "#c08bff", "#ff8fab", "#4ed0d0", "#ffa94d",
];

// 按 factor id 确定性映射到固定颜色（与选择顺序无关），保证同一因子颜色稳定
function factorColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PLOT_COLORS[h % PLOT_COLORS.length];
}

const CATEGORY_ICON: Record<string, string> = {
  technical: "📈",
  valuation: "💰",
  growth: "🌱",
  sentiment: "🔥",
  fundamental: "🏛️",
  macro: "🌐",
  custom: "⚙️",
};
const OUTPUT_TYPE_LABEL: Record<string, string> = {
  boolean: "信号",
  scalar: "数值",
  rank: "排名",
};

// ── 通用工具 ──────────────────────────────────
function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

/** 某列（数字）的 z-score，用于热力着色 */
function columnZ(vals: Array<number | null | undefined>): number[] {
  const nums = vals.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  if (nums.length === 0) return vals.map(() => 0);
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  const variance = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
  const std = Math.sqrt(variance) || 1;
  return vals.map((v) => (typeof v === "number" && !Number.isNaN(v) ? (v - mean) / std : 0));
}

/** z-score → 热力背景色（正=暖红，负=冷蓝） */
function heatColor(z: number): string {
  const az = Math.min(Math.abs(z), 3) / 3;
  const alpha = az * 0.55 + (az > 0.02 ? 0.05 : 0);
  return z >= 0
    ? `rgba(255, 99, 99, ${alpha.toFixed(3)})`
    : `rgba(85, 179, 255, ${alpha.toFixed(3)})`;
}

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

type Mode = "timeseries" | "cross";
type View = "table" | "chart";

// ── 数据类型 ──────────────────────────────────
interface TSFactorResult {
  factor: Factor;
  byDate: Map<string, number | boolean | null>;
  error?: string;
}
interface TSResult {
  dates: string[];
  factors: TSFactorResult[];
  price: Map<string, KLine> | null;
}
interface CrossResult {
  symbols: string[];
  factors: Factor[];
  matrix: Array<Array<number | boolean | null>>; // [symbolIdx][factorIdx]
  matched: number;
  expected: number;
}

// ============================================================
// 因子多选器（弹层）
// ============================================================
function FactorMultiPicker({
  selected,
  onToggle,
  onClear,
}: {
  selected: Factor[];
  onToggle: (f: Factor) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<FactorCategory | "all">("all");
  const [cands, setCands] = useState<Factor[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点击弹层外部 / 按 Esc 关闭（选择已实时生效，关闭即收起）
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    ensureUserId()
      .then(() =>
        sdk.factors.listFactors({
          owner: "all",
          visibility: "public",
          search: search || undefined,
          category: category === "all" ? undefined : category,
          sort: "-updated_at",
          include_stats: false,
          page: 1,
          page_size: 100,
        }),
      )
      .then((res) => alive && setCands(res.data))
      .catch(() => alive && setCands([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, search, category]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const selectedIds = useMemo(() => new Set(selected.map((f) => f.id)), [selected]);
  const cats: Array<FactorCategory | "all"> = [
    "all",
    "technical",
    "valuation",
    "growth",
    "sentiment",
    "fundamental",
    "macro",
    "custom",
  ];

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="rc-btn-primary px-4 py-2 text-[13px]"
      >
        已选因子 {selected.length}/{MAX_FACTORS} ▾
      </button>

      {open && (
        <div className="absolute z-50 mt-2 w-[420px] max-w-[92vw] rc-card p-4 shadow-2xl">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[12px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
              多选因子
            </div>
            {selected.length > 0 && (
              <button
                onClick={onClear}
                className="text-[12px] text-rc-text-dim hover:text-rc-red transition"
              >
                清空
              </button>
            )}
          </div>

          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="搜索因子名…"
            className="w-full mb-3 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
          />

          <div className="flex flex-wrap gap-1.5 mb-3">
            {cats.map((c) => {
              const on = category === c;
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded-[6px] text-[11px] border transition ${
                    on
                      ? "bg-rc-blue/15 border-rc-blue/40 text-rc-blue"
                      : "bg-rc-surface-input border-rc-border-input text-rc-text-dim hover:text-rc-text-secondary"
                  }`}
                >
                  {c === "all" ? "全部" : CATEGORY_ICON[c] + c}
                </button>
              );
            })}
          </div>

          <div className="max-h-[280px] overflow-y-auto space-y-1 pr-1">
            {loading ? (
              <div className="rc-card h-[60px] animate-pulse" />
            ) : cands.length === 0 ? (
              <div className="text-[12px] text-rc-text-dim py-4 text-center">无匹配因子</div>
            ) : (
              cands.map((f) => {
                const on = selectedIds.has(f.id);
                const disabled = !on && selected.length >= MAX_FACTORS;
                return (
                  <button
                    key={f.id}
                    disabled={disabled}
                    onClick={() => onToggle(f)}
                    className={`w-full text-left flex items-center gap-2 px-3 py-2 rounded-[6px] border transition ${
                      on
                        ? "border-rc-blue/50 bg-rc-blue/5"
                        : disabled
                          ? "border-rc-border-subtle opacity-40 cursor-not-allowed"
                          : "border-rc-border-subtle hover:border-rc-border"
                    }`}
                  >
                    <span
                      className={`shrink-0 w-4 h-4 rounded-[4px] border flex items-center justify-center text-[10px] ${
                        on ? "bg-rc-blue border-rc-blue text-white" : "border-rc-border-input text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                    <span className="text-[13px] text-white truncate flex-1">{f.name}</span>
                    <span className="text-[10px] font-rc-mono text-rc-text-dim shrink-0">
                      {OUTPUT_TYPE_LABEL[f.output_type] ?? f.output_type}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 时间序列图表（多序列归一化 + 收盘价对照）
// ============================================================
function TimeSeriesChart({
  dates,
  series,
  mode,
  price,
}: {
  dates: string[];
  series: Array<{
    name: string;
    color: string;
    type: "scalar" | "boolean" | "rank";
    values: Array<number | boolean | null>;
    anchor?: boolean;
  }>;
  mode: "overlay" | "facets";
  price: Map<string, KLine> | null;
}) {
  const W = 1080;
  const P = 38;
  const n = dates.length;
  const [hi, setHi] = useState<number | null>(null);

  if (n === 0) {
    return <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">无数据</div>;
  }
  const x = (i: number) => (n === 1 ? P : P + (i / (n - 1)) * (W - 2 * P));

  // 分面模式：每个因子独立面板（互不重叠）
  if (mode === "facets") {
    return (
      <div className="rc-card p-5 space-y-4">
        {series.map((s) => (
          <ChartPanel key={s.name} s={s} dates={dates} x={x} W={W} n={n} />
        ))}
        <div className="flex justify-between text-[10px] font-rc-mono text-rc-text-dim pt-1">
          <span>{dates[0]}</span>
          <span>{dates[n - 1]}</span>
        </div>
      </div>
    );
  }

  // 叠加模式：因子与收盘价同图，按各自 min–max 归一化，悬停查看对应数值
  const H = 360;
  const geoms = series.map((s) => {
    if (s.type === "boolean") {
      const markers = s.values
        .map((v, i) => (v === true ? i : -1))
        .filter((i): i is number => i >= 0);
      return { s, isBool: true, path: null as string | null, ys: [] as (number | null)[], markers };
    }
    const nums = s.values.map((v) => (typeof v === "number" ? v : null));
    const vals = nums.filter((v): v is number => v !== null);
    if (vals.length === 0) {
      return { s, isBool: false, path: null as string | null, ys: [] as (number | null)[], markers: [] as number[] };
    }
    const mn = Math.min(...vals);
    const mx = Math.max(...vals);
    const rng = mx - mn || 1;
    const ys = nums.map((v) => (v === null ? null : H - P - ((v - mn) / rng) * (H - 2 * P)));
    const path = nums
      .map((v, i) => {
        if (v === null || ys[i] === null) return null;
        return `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${ys[i]!.toFixed(1)}`;
      })
      .filter(Boolean)
      .join(" ");
    return { s, isBool: false, path, ys, markers: [] as number[] };
  });
  // 收盘价（anchor）置于最底层
  const ordered = [...geoms].sort((a, b) => (a.s.anchor ? 0 : 1) - (b.s.anchor ? 0 : 1));

  // K 线（蜡烛）作为价格底层：按全样本 high–low 归一化
  let candles: Array<React.ReactNode> = [];
  if (price && price.size > 0) {
    const ks = dates.map((d) => price.get(d));
    const los = ks.map((k) => k?.low ?? Infinity).filter((v) => v !== Infinity);
    const his = ks.map((k) => k?.high ?? -Infinity).filter((v) => v !== -Infinity);
    if (los.length > 0 && his.length > 0) {
      const lo = Math.min(...los);
      const hi = Math.max(...his);
      const rng = hi - lo || 1;
      const yP = (p: number) => H - P - ((p - lo) / rng) * (H - 2 * P);
      const spacing = n === 1 ? 0 : (W - 2 * P) / (n - 1);
      const cw = Math.max(1.5, Math.min(spacing * 0.62, 14));
      candles = ks.map((k, i) => {
        if (!k) return null;
        const up = k.close >= k.open;
        const col = up ? "#5ee08a" : "#FF6363";
        const xc = x(i);
        const yO = yP(k.open);
        const yC = yP(k.close);
        const yH = yP(k.high);
        const yL = yP(k.low);
        const top = Math.min(yO, yC);
        const bodyH = Math.max(Math.abs(yO - yC), 1);
        return (
          <g key={`c${i}`}>
            <line x1={xc} y1={yH} x2={xc} y2={yL} stroke={col} strokeWidth={1} opacity={0.65} />
            <rect x={xc - cw / 2} y={top} width={cw} height={bodyH} fill={col} opacity={0.85} />
          </g>
        );
      });
    }
  }

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vbX = ((e.clientX - rect.left) / rect.width) * W;
    let i = Math.round(((vbX - P) / (W - 2 * P)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    setHi(i);
  };

  const tipLeftPct = hi !== null ? (x(hi) / W) * 100 : 0;

  return (
    <div className="rc-card p-5">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        {price && price.size > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-rc-text-secondary">
            <span
              className="w-3 h-[10px] rounded-[2px] border"
              style={{ borderColor: "#5ee08a", background: "linear-gradient(180deg, #5ee08a 50%, #FF6363 50%)", opacity: 0.85 }}
            />
            K 线（开/高/低/收）
          </span>
        )}
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-[12px] text-rc-text-secondary">
            <span className="w-3 h-[3px] rounded-full" style={{ background: s.color }} />
            {s.name}
            {s.anchor && <span className="text-[10px] font-rc-mono text-rc-text-dim">（基准）</span>}
          </span>
        ))}
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          onMouseMove={handleMove}
          onMouseLeave={() => setHi(null)}
        >
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={P} y1={P + g * (H - 2 * P)} x2={W - P} y2={P + g * (H - 2 * P)} stroke="rgba(255,255,255,0.06)" />
          ))}

          {/* K 线底层 */}
          {candles.map((c, i) => (
            <React.Fragment key={i}>{c}</React.Fragment>
          ))}

          {ordered.map((g) => (
            <g key={g.s.name}>
              {g.path && (
                <path
                  d={g.path}
                  fill="none"
                  stroke={g.s.color}
                  strokeWidth={g.s.anchor ? 2.4 : 1.6}
                  opacity={g.s.anchor ? 0.95 : 0.9}
                />
              )}
              {g.isBool &&
                g.markers.map((mi) => (
                  <line
                    key={mi}
                    x1={x(mi)}
                    y1={H - P}
                    x2={x(mi)}
                    y2={H - P - 14}
                    stroke={g.s.color}
                    strokeWidth={2}
                    opacity={0.85}
                  />
                ))}
            </g>
          ))}

          {hi !== null && (
            <line x1={x(hi)} y1={P} x2={x(hi)} y2={H - P} stroke="rgba(255,255,255,0.25)" strokeDasharray="3 3" />
          )}
          {hi !== null &&
            ordered.map((g) =>
              g.ys[hi] !== null && g.ys[hi] !== undefined ? (
                <circle key={g.s.name} cx={x(hi)} cy={g.ys[hi] as number} r={3} fill={g.s.color} />
              ) : null,
            )}
        </svg>

        {hi !== null && (
          <div
            className="absolute top-2 z-10 pointer-events-none -translate-x-1/2 rounded-[8px] border border-rc-border-subtle bg-rc-surface-100/95 px-3 py-2 text-[11px] font-rc-mono shadow-xl"
            style={{ left: `${tipLeftPct}%` }}
          >
            <div className="text-rc-text-secondary mb-1">{dates[hi]}</div>
            {price && price.get(dates[hi]) && (() => {
              const k = price.get(dates[hi])!;
              const cp = k.change_percent;
              const pct = cp != null ? (Math.abs(cp) > 1 ? cp : cp * 100) : null;
              const up = k.close >= k.open;
              const col = up ? "#5ee08a" : "#FF6363";
              return (
                <div className="whitespace-nowrap mb-1 pb-1 border-b border-rc-border-subtle" style={{ color: col }}>
                  <span className="text-rc-text-muted">O</span> {fmtNum(k.open)} ·{" "}
                  <span className="text-rc-text-muted">H</span> {fmtNum(k.high)} ·{" "}
                  <span className="text-rc-text-muted">L</span> {fmtNum(k.low)} ·{" "}
                  <span className="text-rc-text-muted">C</span> {fmtNum(k.close)}
                  {pct != null && (
                    <span className="ml-1">
                      ({pct >= 0 ? "+" : ""}
                      {pct.toFixed(2)}%)
                    </span>
                  )}
                </div>
              );
            })()}
            {ordered.map((g) => {
              const raw = g.s.values[hi];
              const txt =
                g.s.type === "boolean"
                  ? raw === true
                    ? "触发"
                    : "未触发"
                  : raw === null || raw === undefined
                    ? "–"
                    : fmtNum(raw as number);
              let extra = "";
              if (g.s.anchor && price) {
                const k = price.get(dates[hi]);
                const cp = k?.change_percent;
                if (cp != null) {
                  const pct = Math.abs(cp) > 1 ? cp : cp * 100;
                  extra = ` · 涨跌 ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
                }
              }
              return (
                <div key={g.s.name} style={{ color: g.s.color }} className="whitespace-nowrap">
                  {g.s.name}：{txt}
                  {extra}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex justify-between text-[10px] font-rc-mono text-rc-text-dim mt-1">
        <span>{dates[0]}</span>
        <span>
          {price && price.size > 0 ? "K 线(价格轴) + 因子各自 min–max 归一化叠加" : "各序列按自身 min–max 归一化叠加"} · 悬停查看对应数值
        </span>
        <span>{dates[n - 1]}</span>
      </div>
    </div>
  );
}

// 单因子独立面板：自带 min–max 归一化，多因子纵向堆叠互不重叠
function ChartPanel({
  s,
  x,
  W,
  n,
}: {
  s: { name: string; color: string; type: "scalar" | "boolean" | "rank"; values: Array<number | boolean | null> };
  dates: string[];
  x: (i: number) => number;
  W: number;
  n: number;
}) {
  const H = 84;
  const P = 30;
  const midY = P + (H - 2 * P) / 2;
  if (s.type === "boolean") {
    const markers = s.values
      .map((v, i) => (v === true ? x(i) : null))
      .filter((v): v is number => v !== null);
    return (
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="w-3 h-[3px] rounded-full" style={{ background: s.color }} />
          <span className="text-[12px] text-rc-text-secondary">{s.name}</span>
          <span className="text-[10px] font-rc-mono text-rc-text-dim ml-auto">布尔信号 · 触发 {markers.length} 次</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
          <line x1={P} y1={midY} x2={W - P} y2={midY} stroke="rgba(255,255,255,0.06)" />
          {markers.map((mx, j) => (
            <line key={j} x1={mx} y1={midY - 12} x2={mx} y2={midY + 12} stroke={s.color} strokeWidth={2} opacity={0.85} />
          ))}
        </svg>
      </div>
    );
  }
  const nums = s.values.map((v) => (typeof v === "number" ? v : null));
  const vals = nums.filter((v): v is number => v !== null);
  if (vals.length === 0) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-rc-text-dim">
        <span className="w-3 h-[3px] rounded-full" style={{ background: s.color }} />
        {s.name}：无数值
      </div>
    );
  }
  const mn = Math.min(...vals);
  const mx = Math.max(...vals);
  const rng = mx - mn || 1;
  const path = nums
    .map((v, i) => {
      if (v === null) return null;
      const y = H - P - ((v - mn) / rng) * (H - 2 * P);
      return `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
  const rangeLabel = mn === mx ? `恒值 ${fmtNum(mn)}` : `${fmtNum(mn)} ~ ${fmtNum(mx)}`;
  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="w-3 h-[3px] rounded-full" style={{ background: s.color }} />
        <span className="text-[12px] text-rc-text-secondary">{s.name}</span>
        <span className="text-[10px] font-rc-mono text-rc-text-dim ml-auto">{rangeLabel}（归一化）</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <line x1={P} y1={midY} x2={W - P} y2={midY} stroke="rgba(255,255,255,0.06)" />
        <path d={path} fill="none" stroke={s.color} strokeWidth={1.6} />
      </svg>
    </div>
  );
}

// ============================================================
// 横截面图表（单因子分布 / 触发率）
// ============================================================
function CrossChart({
  factor,
  symbols,
  values,
}: {
  factor: Factor;
  symbols: string[];
  values: Array<number | boolean | null>;
}) {
  if (factor.output_type === "boolean") {
    const triggered = symbols.filter((_, i) => values[i] === true);
    const rate = symbols.length ? triggered.length / symbols.length : 0;
    return (
      <div className="rc-card p-5">
        <div className="flex items-center gap-4 mb-4">
          <div className="text-[40px] font-rc-mono text-rc-red leading-none">
            {(rate * 100).toFixed(1)}%
          </div>
          <div className="text-[12px] text-rc-text-dim">
            当日触发 {triggered.length} / {symbols.length} 支
            <br />
            （batch-query 读 feature_values 缓存）
          </div>
        </div>
        <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
          触发股票（前 80）
        </div>
        <div className="flex flex-wrap gap-1.5 max-h-[200px] overflow-y-auto">
          {triggered.length === 0 ? (
            <span className="text-[12px] text-rc-text-dim">当日无触发</span>
          ) : (
            triggered.slice(0, 80).map((s) => (
              <span
                key={s}
                className="text-[11px] font-rc-mono px-2 py-0.5 rounded-[4px] bg-rc-red/10 border border-rc-red/30 text-rc-red"
              >
                {s}
              </span>
            ))
          )}
        </div>
      </div>
    );
  }

  // scalar：按值降序取 Top 30 画横向条
  const pairs = symbols
    .map((s, i) => ({ s, v: values[i] }))
    .filter((p): p is { s: string; v: number } => typeof p.v === "number" && !Number.isNaN(p.v));
  pairs.sort((a, b) => b.v - a.v);
  const top = pairs.slice(0, 30);
  const zs = columnZ(top.map((p) => p.v));
  const maxV = top.length ? Math.max(...top.map((p) => Math.abs(p.v))) || 1 : 1;

  return (
    <div className="rc-card p-5">
      <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-3">
        {factor.name} · 横截面 Top 30（按值降序）
      </div>
      <div className="space-y-1.5">
        {top.length === 0 ? (
          <span className="text-[12px] text-rc-text-dim">该因子当日无数值（可能未回填）</span>
        ) : (
          top.map((p, i) => {
            const w = (Math.abs(p.v) / maxV) * 100;
            return (
              <div key={p.s} className="flex items-center gap-2 text-[12px]">
                <span className="w-[64px] shrink-0 font-rc-mono text-rc-text-muted">{p.s}</span>
                <div className="flex-1 h-[14px] rounded-[3px] bg-rc-surface-input overflow-hidden">
                  <div
                    className="h-full rounded-[3px]"
                    style={{ width: `${w}%`, background: heatColor(zs[i]) }}
                  />
                </div>
                <span className="w-[72px] shrink-0 text-right font-rc-mono text-rc-text-primary">
                  {fmtNum(p.v)}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ============================================================
// 主页面
// ============================================================
function FactorExplorerPage() {
  const [mode, setMode] = useState<Mode>("timeseries");
  const [view, setView] = useState<View>("table");
  const [selectedFactors, setSelectedFactors] = useState<Factor[]>([]);

  // 时间序列参数
  const [symbol, setSymbol] = useState("600519");
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [tsResult, setTsResult] = useState<TSResult | null>(null);
  const [tsLoading, setTsLoading] = useState(false);
  const [tsError, setTsError] = useState<string | null>(null);

  // 横截面参数
  const [crossDate, setCrossDate] = useState(DEFAULT_CROSS_DATE);
  const [universe, setUniverse] = useState<"hs300" | "zz500" | "zz1000" | "custom">("hs300");
  const [customSymbols, setCustomSymbols] = useState("600519,000001,300750");
  const [crossResult, setCrossResult] = useState<CrossResult | null>(null);
  const [crossLoading, setCrossLoading] = useState(false);
  const [crossError, setCrossError] = useState<string | null>(null);

  // 图表选择
  const [plotIds, setPlotIds] = useState<string[]>([]); // 时间序列绘图因子
  const [crossChartId, setCrossChartId] = useState<string>(""); // 横截面绘图因子

  // 当所选因子变化时，默认绘图选择
  useEffect(() => {
    setPlotIds(selectedFactors.slice(0, 3).map((f) => f.id));
    setCrossChartId(selectedFactors[0]?.id ?? "");
  }, [selectedFactors]);

  const toggleFactor = (f: Factor) => {
    setSelectedFactors((prev) => {
      if (prev.some((x) => x.id === f.id)) return prev.filter((x) => x.id !== f.id);
      if (prev.length >= MAX_FACTORS) return prev;
      return [...prev, f];
    });
  };

  // ── 时间序列取数 ──
  const fetchTS = useCallback(async () => {
    const sym = symbol.trim();
    if (selectedFactors.length === 0 || !sym) return;
    setTsLoading(true);
    setTsError(null);
    try {
      const [priceRes, factorSettled] = await Promise.all([
        sdk.data
          .getKlines({ symbols: [sym], start, end, timeframe: "1d", page_size: 1000 })
          .then((r) => {
            const m = new Map<string, KLine>();
            for (const k of r.data as KLine[]) m.set(k.dt.slice(0, 10), k);
            return m;
          })
          .catch(() => null),
        Promise.allSettled(
          selectedFactors.map((f) =>
            sdk.factors
              .computeFactor({
                factor_id: f.id,
                symbols: [sym],
                start,
                end,
                format: "long",
              })
              .then((res) => {
                const rows = (res.data ?? []) as Array<{
                  symbol: string;
                  date: string;
                  value: number | boolean;
                }>;
                const byDate = new Map<string, number | boolean | null>();
                for (const r of rows) byDate.set(r.date, r.value);
                return { factor: f, byDate, error: undefined as string | undefined };
              }),
          ),
        ),
      ]);

      const factorsRes: TSFactorResult[] = factorSettled.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return {
          factor: selectedFactors[i],
          byDate: new Map(),
          error:
            r.reason instanceof ApiError
              ? `[${r.reason.code}] ${r.reason.message}`
              : String(r.reason),
        };
      });

      const dateSet = new Set<string>();
      for (const fr of factorsRes) for (const d of fr.byDate.keys()) dateSet.add(d);
      const dates = Array.from(dateSet).sort();

      setTsResult({ dates, factors: factorsRes, price: priceRes });
    } catch (e) {
      setTsError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
    } finally {
      setTsLoading(false);
    }
  }, [selectedFactors, symbol, start, end]);

  // ── 横截面取数 ──
  const fetchCross = useCallback(async () => {
    if (selectedFactors.length === 0 || !crossDate) return;
    setCrossLoading(true);
    setCrossError(null);
    try {
      let symbols: string[] = [];
      if (universe === "custom") {
        symbols = customSymbols
          .split(/[,，\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 500);
      } else {
        const res = await sdk.data.listSymbols({
          universe,
          page: 1,
          page_size: 500,
        });
        symbols = res.data.map((s) => s.code);
      }
      if (symbols.length === 0) {
        setCrossError("没有可用的股票列表（检查股票池或自定义代码）");
        setCrossLoading(false);
        return;
      }

      const fidIds = selectedFactors.map((f) => f.id);
      const chunks = chunk(symbols, SYMBOL_CHUNK);
      const chunkResults = await Promise.all(
        chunks.map((syms) =>
          sdk.factors.batchQuery({ factor_ids: fidIds, symbols: syms, date: crossDate }),
        ),
      );

      const matrix: Array<Array<number | boolean | null>> = symbols.map(() =>
        fidIds.map(() => null),
      );
      let matched = 0;
      let expected = 0;
      for (const cr of chunkResults) {
        const d = cr.data as FactorBatchQueryResponse;
        const meta = cr.meta as { rows_matched?: number; rows_expected?: number } | undefined;
        matched += meta?.rows_matched ?? 0;
        expected += meta?.rows_expected ?? 0;
        const idxMap = new Map(d.symbols.map((s, i) => [s, i]));
        for (let si = 0; si < symbols.length; si++) {
          const ci = idxMap.get(symbols[si]);
          if (ci == null) continue;
          const rowVals = d.values[ci];
          for (let fi = 0; fi < fidIds.length; fi++) {
            matrix[si][fi] = (rowVals?.[fi] ?? null) as number | boolean | null;
          }
        }
      }

      setCrossResult({ symbols, factors: selectedFactors, matrix, matched, expected });
    } catch (e) {
      setCrossError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
    } finally {
      setCrossLoading(false);
    }
  }, [selectedFactors, crossDate, universe, customSymbols]);

  const canRun =
    selectedFactors.length > 0 &&
    (mode === "timeseries" ? symbol.trim().length > 0 : true) &&
    !tsLoading &&
    !crossLoading;

  const selectedMap = useMemo(
    () => new Map(selectedFactors.map((f) => [f.id, f])),
    [selectedFactors],
  );

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />
      <div className="max-w-[1280px] mx-auto px-6 pt-4">
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Link href="/factors" className="hover:text-white transition">
            因子库
          </Link>
          <span>/</span>
          <span className="text-white">因子数据浏览器</span>
        </div>
      </div>

      <main className="max-w-[1280px] mx-auto px-6 py-6 space-y-5">
        {/* 标题 */}
        <div>
          <h1 className="text-[28px] font-semibold text-white tracking-[0.2px]">因子数据浏览器</h1>
          <p className="text-body text-rc-text-secondary mt-1">
            两种视角看同一批因子：
            <span className="text-rc-blue"> ① 一只股票 × 多因子（时间序列）</span> 或
            <span className="text-rc-green"> ② 某交易日 × 全市场（横截面）</span>。
            表格按 z-score 热力着色，图表可叠加收盘价对照。
          </p>
        </div>

        {/* 控制条：模式 + 因子选择 + 视图 */}
        <section className="rc-card p-4 flex flex-wrap items-end gap-4">
          {/* 模式 tabs */}
          <div className="flex rounded-[8px] border border-rc-border-input overflow-hidden">
            <button
              onClick={() => setMode("timeseries")}
              className={`px-4 py-2 text-[13px] transition ${
                mode === "timeseries"
                  ? "bg-rc-blue/15 text-rc-blue"
                  : "text-rc-text-dim hover:text-rc-text-secondary"
              }`}
            >
              ① 时间序列（1股×多因子）
            </button>
            <button
              onClick={() => setMode("cross")}
              className={`px-4 py-2 text-[13px] transition border-l border-rc-border-input ${
                mode === "cross"
                  ? "bg-rc-green/15 text-rc-green"
                  : "text-rc-text-dim hover:text-rc-text-secondary"
              }`}
            >
              ② 横截面（某日×全市场）
            </button>
          </div>

          {/* 因子多选 */}
          <FactorMultiPicker
            selected={selectedFactors}
            onToggle={toggleFactor}
            onClear={() => setSelectedFactors([])}
          />

          {/* 视图切换 */}
          <div className="flex rounded-[8px] border border-rc-border-input overflow-hidden ml-auto">
            <button
              onClick={() => setView("table")}
              className={`px-3 py-2 text-[13px] transition ${
                view === "table" ? "bg-rc-surface-card text-white" : "text-rc-text-dim hover:text-rc-text-secondary"
              }`}
            >
              表格
            </button>
            <button
              onClick={() => setView("chart")}
              className={`px-3 py-2 text-[13px] transition border-l border-rc-border-input ${
                view === "chart" ? "bg-rc-surface-card text-white" : "text-rc-text-dim hover:text-rc-text-secondary"
              }`}
            >
              图表
            </button>
          </div>
        </section>

        {/* 已选因子 chips */}
        {selectedFactors.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {selectedFactors.map((f) => (
              <span
                key={f.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[6px] bg-rc-surface-input border border-rc-border-input text-[12px] text-rc-text-primary"
              >
                <span>{CATEGORY_ICON[f.category] ?? "📊"}</span>
                {f.name}
                <span className="text-[10px] font-rc-mono text-rc-text-dim">
                  {OUTPUT_TYPE_LABEL[f.output_type] ?? f.output_type}
                </span>
                <button
                  onClick={() => toggleFactor(f)}
                  className="text-rc-text-dim hover:text-rc-red transition leading-none"
                  aria-label="移除"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        {/* ── 时间序列面板 ── */}
        {mode === "timeseries" && (
          <section className="rc-card p-4">
            <div className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr_1fr_auto] gap-3 items-end">
              <div>
                <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                  股票代码
                </label>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value)}
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
                onClick={fetchTS}
                disabled={!canRun}
                className="rc-btn-primary px-5 py-2 text-[13px] disabled:opacity-40"
              >
                {tsLoading ? "计算中…" : "查询"}
              </button>
            </div>
          </section>
        )}

        {/* ── 横截面面板 ── */}
        {mode === "cross" && (
          <section className="rc-card p-4">
            <div className="grid grid-cols-1 md:grid-cols-[1fr_1.4fr_auto] gap-3 items-end">
              <div>
                <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                  交易日
                </label>
                <input
                  type="date"
                  value={crossDate}
                  onChange={(e) => setCrossDate(e.target.value)}
                  className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
                />
              </div>
              <div>
                <label className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                  股票池
                </label>
                {universe === "custom" ? (
                  <input
                    value={customSymbols}
                    onChange={(e) => setCustomSymbols(e.target.value)}
                    placeholder="逗号分隔代码"
                    className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
                  />
                ) : (
                  <select
                    value={universe}
                    onChange={(e) => setUniverse(e.target.value as typeof universe)}
                    className="w-full mt-1 bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
                  >
                    <option value="hs300">沪深300</option>
                    <option value="zz500">中证500</option>
                    <option value="zz1000">中证1000</option>
                  </select>
                )}
                <div className="mt-1 flex gap-2 text-[11px]">
                  {(["hs300", "zz500", "zz1000", "custom"] as const).map((u) => (
                    <button
                      key={u}
                      onClick={() => setUniverse(u)}
                      className={`px-2 py-0.5 rounded-[4px] border transition ${
                        universe === u
                          ? "border-rc-green/40 text-rc-green bg-rc-green/10"
                          : "border-rc-border-input text-rc-text-dim hover:text-rc-text-secondary"
                      }`}
                    >
                      {u === "custom" ? "自定义" : u.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
              <button
                onClick={fetchCross}
                disabled={!canRun}
                className="rc-btn-primary px-5 py-2 text-[13px] disabled:opacity-40"
              >
                {crossLoading ? "查询中…" : "查询"}
              </button>
            </div>
          </section>
        )}

        {/* 错误 */}
        {tsError && (
          <div className="rc-card border-rc-red/40 text-[13px] text-rc-red">时间序列查询失败：{tsError}</div>
        )}
        {crossError && (
          <div className="rc-card border-rc-red/40 text-[13px] text-rc-red">横截面查询失败：{crossError}</div>
        )}

        {/* ── 结果：时间序列 ── */}
        {mode === "timeseries" && tsResult && (
          <TSView result={tsResult} view={view} plotIds={plotIds} setPlotIds={setPlotIds} selectedMap={selectedMap} />
        )}

        {/* ── 结果：横截面 ── */}
        {mode === "cross" && crossResult && (
          <CrossView
            result={crossResult}
            view={view}
            chartId={crossChartId}
            setChartId={setCrossChartId}
          />
        )}

        {selectedFactors.length === 0 && (
          <div className="rc-card text-center py-16 text-rc-text-dim text-[14px]">
            先从上方「已选因子」选择至少一个因子，再点击查询。
          </div>
        )}
      </main>
    </div>
  );
}

// ============================================================
// 时间序列结果视图（表格 / 图表）
// ============================================================
function TSView({
  result,
  view,
  plotIds,
  setPlotIds,
  selectedMap,
}: {
  result: TSResult;
  view: View;
  plotIds: string[];
  setPlotIds: Dispatch<SetStateAction<string[]>>;
  selectedMap: Map<string, Factor>;
}) {
  const { dates, factors, price } = result;

  // 每列 z-score（仅数值列有意义）
  const zByFactor = useMemo(
    () =>
      factors.map((fr) =>
        columnZ(dates.map((d) => {
          const v = fr.byDate.get(d);
          return typeof v === "number" ? v : null;
        })),
      ),
    [factors, dates],
  );

  const [chartMode, setChartMode] = useState<"overlay" | "facets">("overlay");

  if (view === "chart") {
    const plotFactors = plotIds
      .map((id) => factors.find((f) => f.factor.id === id))
      .filter((f): f is TSFactorResult => !!f);
    const series = plotFactors.map((fr) => ({
      name: fr.factor.name,
      color: factorColor(fr.factor.id),
      type: fr.factor.output_type as "scalar" | "boolean" | "rank",
      values: dates.map((d) => fr.byDate.get(d) ?? null),
      anchor: false,
    }));
    return (
      <div className="space-y-4">
        {/* 绘图因子选择 */}
        <div className="rc-card p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
              绘制因子（最多 4 个）· 与 K 线同图对照
            </div>
            <div className="flex rounded-[6px] border border-rc-border-input overflow-hidden text-[12px]">
              <button
                onClick={() => setChartMode("overlay")}
                className={`px-3 py-1.5 transition ${
                  chartMode === "overlay" ? "bg-rc-surface-card text-white" : "text-rc-text-dim hover:text-rc-text-secondary"
                }`}
              >
                叠加(同图)
              </button>
              <button
                onClick={() => setChartMode("facets")}
                className={`px-3 py-1.5 border-l border-rc-border-input transition ${
                  chartMode === "facets" ? "bg-rc-surface-card text-white" : "text-rc-text-dim hover:text-rc-text-secondary"
                }`}
              >
                分面
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {factors.map((fr) => {
              const on = plotIds.includes(fr.factor.id);
              const color = on ? factorColor(fr.factor.id) : undefined;
              return (
                <button
                  key={fr.factor.id}
                  onClick={() =>
                    setPlotIds((prev) =>
                      prev.includes(fr.factor.id)
                        ? prev.filter((x) => x !== fr.factor.id)
                        : [...prev, fr.factor.id].slice(0, 4),
                    )
                  }
                  className={`px-3 py-1.5 rounded-[6px] text-[12px] border transition ${
                    on ? "border-rc-blue/50 bg-rc-blue/5 text-white" : "border-rc-border-input text-rc-text-dim hover:text-rc-text-secondary"
                  }`}
                  style={color ? { borderColor: color, color } : undefined}
                >
                  {fr.factor.name}
                </button>
              );
            })}
          </div>
        </div>
        {series.length > 0 ? (
          <TimeSeriesChart dates={dates} series={series} mode={chartMode} price={price} />
        ) : (
          <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">勾选因子以绘制</div>
        )}
      </div>
    );
  }

  // 表格
  if (dates.length === 0) {
    return (
      <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">
        该股票在所选区间内无因子数据（部分因子依赖基本面字段，尚未采集）。
      </div>
    );
  }
  return (
    <div className="rc-card p-4 overflow-x-auto">
      <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
        {dates.length} 个交易日 × {factors.length} 因子 · 单元格按列 z-score 着色（红=高/蓝=低）
      </div>
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="text-rc-text-dim text-[10px] font-rc-mono uppercase tracking-[0.3px] border-b border-rc-border-subtle">
            <th className="text-left py-2 pr-3 font-normal sticky left-0 bg-rc-surface-card">日期</th>
            {factors.map((fr) => (
              <th key={fr.factor.id} className="text-right py-2 px-3 font-normal whitespace-nowrap">
                {fr.factor.name}
                <span className="block text-[9px] text-rc-text-dim">
                  {OUTPUT_TYPE_LABEL[fr.factor.output_type] ?? fr.factor.output_type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((d, di) => (
            <tr key={d} className="border-b border-rc-border-subtle/40">
              <td className="py-1.5 pr-3 font-rc-mono text-rc-text-muted sticky left-0 bg-rc-surface-card">
                {d}
              </td>
              {factors.map((fr, fi) => {
                const v = fr.byDate.get(d);
                if (fr.error) {
                  return (
                    <td key={fr.factor.id} className="py-1.5 px-3 text-right font-rc-mono text-rc-text-dim">
                      err
                    </td>
                  );
                }
                if (fr.factor.output_type === "boolean") {
                  const on = v === true;
                  return (
                    <td key={fr.factor.id} className="py-1.5 px-3 text-center">
                      {on ? (
                        <span className="text-rc-red font-bold">✓</span>
                      ) : (
                        <span className="text-rc-text-dim">·</span>
                      )}
                    </td>
                  );
                }
                const num = typeof v === "number" ? v : null;
                const z = zByFactor[fi]?.[di] ?? 0;
                return (
                  <td
                    key={fr.factor.id}
                    className="py-1.5 px-3 text-right font-rc-mono text-white"
                    style={num !== null ? { background: heatColor(z) } : undefined}
                  >
                    {num === null ? "–" : fmtNum(num)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// 横截面结果视图（表格 / 图表）
// ============================================================
function CrossView({
  result,
  view,
  chartId,
  setChartId,
}: {
  result: CrossResult;
  view: View;
  chartId: string;
  setChartId: (id: string) => void;
}) {
  const { symbols, factors, matrix, matched, expected } = result;
  const coverage = expected > 0 ? (matched / expected) * 100 : 0;

  // 每列 z-score（按股票横截面对齐）
  const zByFactor = useMemo(
    () =>
      factors.map((f, fi) =>
        columnZ(matrix.map((row) => (typeof row[fi] === "number" ? (row[fi] as number) : null))),
      ),
    [factors, matrix],
  );

  if (view === "chart") {
    const chartFactor = factors.find((f) => f.id === chartId) ?? factors[0];
    const fi = factors.findIndex((f) => f.id === (chartFactor?.id ?? ""));
    return (
      <div className="space-y-4">
        <div className="rc-card p-4">
          <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
            选择查看分布的因子
          </div>
          <div className="flex flex-wrap gap-2">
            {factors.map((f) => (
              <button
                key={f.id}
                onClick={() => setChartId(f.id)}
                className={`px-3 py-1.5 rounded-[6px] text-[12px] border transition ${
                  chartId === f.id
                    ? "border-rc-green/50 bg-rc-green/10 text-rc-green"
                    : "border-rc-border-input text-rc-text-dim hover:text-rc-text-secondary"
                }`}
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
        {chartFactor && fi >= 0 ? (
          <CrossChart factor={chartFactor} symbols={symbols} values={matrix.map((row) => row[fi])} />
        ) : (
          <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">无因子</div>
        )}
      </div>
    );
  }

  // 表格
  if (symbols.length === 0) {
    return (
      <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">无股票数据</div>
    );
  }
  return (
    <div className="rc-card p-4 overflow-auto max-h-[70vh]">
      <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
        {symbols.length} 支股票 × {factors.length} 因子 · 覆盖率 {coverage.toFixed(1)}%（{matched}/{expected}）
        · 单元格按列 z-score 着色
      </div>
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="text-rc-text-dim text-[10px] font-rc-mono uppercase tracking-[0.3px] border-b border-rc-border-subtle sticky top-0 bg-rc-surface-card">
            <th className="text-left py-2 pr-3 font-normal sticky left-0 bg-rc-surface-card">代码</th>
            {factors.map((f) => (
              <th key={f.id} className="text-right py-2 px-3 font-normal whitespace-nowrap">
                {f.name}
                <span className="block text-[9px] text-rc-text-dim">
                  {OUTPUT_TYPE_LABEL[f.output_type] ?? f.output_type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {symbols.map((sym, si) => (
            <tr key={sym} className="border-b border-rc-border-subtle/40">
              <td className="py-1.5 pr-3 font-rc-mono text-rc-text-muted sticky left-0 bg-rc-surface-card">
                {sym}
              </td>
              {factors.map((f, fi) => {
                const v = matrix[si][fi];
                if (f.output_type === "boolean") {
                  const on = v === true;
                  return (
                    <td key={f.id} className="py-1.5 px-3 text-center">
                      {on ? <span className="text-rc-red font-bold">✓</span> : <span className="text-rc-text-dim">·</span>}
                    </td>
                  );
                }
                const num = typeof v === "number" ? v : null;
                const z = zByFactor[fi]?.[si] ?? 0;
                return (
                  <td
                    key={f.id}
                    className="py-1.5 px-3 text-right font-rc-mono text-white"
                    style={num !== null ? { background: heatColor(z) } : undefined}
                  >
                    {num === null ? "–" : fmtNum(num)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Page() {
  return <FactorExplorerPage />;
}
