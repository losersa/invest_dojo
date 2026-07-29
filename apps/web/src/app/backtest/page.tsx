"use client";

// 模型回测页：从训练结果页「用此模型回测」带 model_id 直达；
// 配置区间/股票池 → backtest-svc run-fast → 汇总指标 + 净值曲线。

import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ApiError,
  type BacktestResult,
  type StrategySpec,
  type PositionSizing,
} from "@investdojo/api";
import { sdk } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

const UNIVERSES = [
  { value: "hs300", label: "沪深 300" },
  { value: "zz500", label: "中证 500" },
  { value: "zz1000", label: "中证 1000" },
  { value: "all", label: "全市场" },
] as const;

function defaultRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setMonth(start.getMonth() - 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

const pct = (v?: number | null) => (v == null ? "-" : `${(v * 100).toFixed(2)}%`);
const num = (v?: number | null) => (v == null ? "-" : v.toFixed(2));

const STAGE_LABEL: Record<string, string> = {
  pending: "等待",
  queued: "已入队",
  loading_model: "加载模型",
  building_features: "构建特征",
  predicting: "模型预测",
  simulating: "资金模拟",
  finalizing: "汇总指标",
  completed: "完成",
  failed: "失败",
};

// 轻量 SVG 净值曲线（策略净值 vs 基准·买入持有），无第三方图表依赖
// 注意：组合=净值比、基准=资金，量纲不同，必须统一归一成「净值比」(起点=1.0=初始资金) 才能同图可比。
// 市场指数K线因库内无指数行情、且与买入持有基准同源会完全重叠，故不在本图绘制。
function EquityChart({ result }: { result: BacktestResult }) {
  const ec = result.equity_curve;
  if (!ec?.dates?.length) return null;
  const W = 860;
  const H = 280;
  const PAD = { l: 52, r: 12, t: 28, b: 26 };
  const n = ec.dates.length;
  const toRatio = (a?: number[]) =>
    a && a.length && a[0] && Number.isFinite(a[0]) ? a.map((v) => v / (a[0] as number)) : null;
  const portR = toRatio(ec.portfolio);
  const benchR = toRatio(ec.benchmark);
  const series = [portR, benchR].filter(Boolean) as number[][];
  const all = series.flat().filter((v) => Number.isFinite(v));
  if (!all.length) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1e-9;
  const x = (i: number) => PAD.l + (i / Math.max(n - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / span) * (H - PAD.t - PAD.b);
  const line = (arr?: number[]) =>
    arr ? arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ") : "";
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * span);
  const dateIdx = [0, Math.floor(n / 2), n - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      <text x={PAD.l} y={12} fontSize={9} fill="#a1a1aa">净值（起点 1.0 = 初始资金）</text>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="#27272a" strokeWidth={1} />
          <text x={PAD.l - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill="#71717a">
            {t.toFixed(2)}
          </text>
        </g>
      ))}
      {dateIdx.map((i) => (
        <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={9} fill="#71717a">
          {ec.dates[i]?.slice(5)}
        </text>
      ))}
      {benchR && <path d={line(benchR)} fill="none" stroke="#71717a" strokeWidth={1.2} />}
      {portR && <path d={line(portR)} fill="none" stroke="#3b82f6" strokeWidth={1.6} />}
      <g fontSize={10}>
        <circle cx={W - 200} cy={16} r={3} fill="#3b82f6" />
        <text x={W - 194} y={19} fill="#d4d4d8">策略净值</text>
        <circle cx={W - 96} cy={16} r={3} fill="#71717a" />
        <text x={W - 90} y={19} fill="#d4d4d8">买入持有</text>
      </g>
    </svg>
  );
}

function BacktestPageInner() {
  const sp = useSearchParams();
  const [modelId, setModelId] = useState("");
  const [{ start, end }, setRange] = useState(defaultRange);
  const [universe, setUniverse] = useState<string>("hs300");
  const [capital, setCapital] = useState(1_000_000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [recent, setRecent] = useState<BacktestResult[]>([]);
  const [progress, setProgress] = useState<{ pct: number; stage: string } | null>(null);
  const [strategyType, setStrategyType] = useState<StrategySpec["type"]>("model");
  const [factorId, setFactorId] = useState("");
  const [compositeId, setCompositeId] = useState("");
  const [signalFileId, setSignalFileId] = useState("");
  const [explicitSymbols, setExplicitSymbols] = useState("");

  useEffect(() => {
    const m = sp.get("model_id");
    if (m) {
      setModelId(m);
      setUniverse("__model__"); // 默认选中该模型预测的那支股票
    }
  }, [sp]);

  const loadRecent = useCallback(async () => {
    try {
      const r = await sdk.backtests.listBacktests({ status: "completed", page_size: 8 });
      setRecent(r.data ?? []);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

  const openRecent = useCallback(async (id: string) => {
    try {
      setLoading(true);
      setError(null);
      setResult(null);
      setProgress(null);
      const { data } = await sdk.backtests.getBacktest(id);
      setResult(data);
      const meta = (data as unknown as { meta?: { engine?: string } }).meta;
      setEngine(meta?.engine ?? null);
      setLoading(false);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : (e as Error).message);
      setLoading(false);
    }
  }, []);

  const pollJob = useCallback(
    async (id: string) => {
      for (;;) {
        const r = await sdk.backtests.getBacktest(id);
        const b = r.data;
        setProgress(b.progress ?? null);
        if (b.status === "completed") {
          setResult(b);
          const meta = (b as unknown as { meta?: { engine?: string } }).meta;
          setEngine(meta?.engine ?? null);
          setLoading(false);
          void loadRecent();
          return;
        }
        if (b.status === "failed") {
          const msg =
            (b as unknown as { error?: { message?: string } }).error?.message || "回测失败";
          setError(msg);
          setLoading(false);
          return;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    },
    [loadRecent],
  );

  const run = async () => {
    const isModel = strategyType === "model";
    if (isModel && !modelId.trim()) {
      setError("请填写模型 ID（或从训练结果页带 model_id 进入）");
      return;
    }
    if (strategyType === "factor" && !factorId.trim()) {
      setError("请填写因子 ID");
      return;
    }
    if (strategyType === "composite" && !compositeId.trim()) {
      setError("请填写复合因子 ID（逗号分隔）");
      return;
    }
    if (strategyType === "signal_file" && !signalFileId.trim()) {
      setError("请填写信号文件 ID");
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress({ pct: 0, stage: "pending" });
    try {
      const strategy: StrategySpec = { type: strategyType };
      if (isModel) strategy.model_id = modelId.trim();
      if (strategyType === "factor") strategy.factor_id = factorId.trim();
      if (strategyType === "composite") strategy.composite_id = compositeId.trim();
      if (strategyType === "signal_file") strategy.signal_file_id = signalFileId.trim();

      const symbols = explicitSymbols.split(",").map((s) => s.trim()).filter(Boolean);
      const uni: string | string[] | undefined = isModel
        ? "__model__"
        : symbols.length > 0
        ? symbols
        : undefined;
      const positionSizing: PositionSizing | null = isModel
        ? null
        : { method: "equal_weight", max_positions: 10, rebalance_frequency: "weekly" };

      const { data } = await sdk.backtests.runAsync({
        mode: "realistic",
        strategy,
        start,
        end,
        universe: uni,
        initial_capital: capital,
        position_sizing: positionSizing,
        advanced: { include_trade_log: false },
      });
      await pollJob(data.id);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : (e as Error).message);
      setLoading(false);
    }
  };

  const s = result?.summary;
  const initCap = result?.config?.initial_capital ?? 1_000_000;
  const rawBench = result?.meta?.benchmark_name ?? "基准";
  const benchLabel = rawBench.replace(/\(buy&hold\)/i, "（买入持有）");
  const modelTarget = (result?.meta as { target_symbol?: string } | undefined)?.target_symbol;
  const modelTargetLabel = modelTarget
    ? `该模型预测股票 (${modelTarget})`
    : "该模型预测股票";

  return (
    <main className="min-h-screen">
      <MainNav />
      <section className="text-center px-6 pt-[48px] pb-[24px]">
        <h1 className="text-section-display text-white">模型回测</h1>
        <p className="mt-3 text-body-lg text-rc-text-secondary max-w-[680px] mx-auto">
          用训练产出的模型在给定区间/股票池上跑快速回测，查看收益、回撤与净值曲线
        </p>
      </section>

      <section className="max-w-[1100px] mx-auto px-6 pb-[80px] space-y-5">
        {/* 配置 */}
        <div className="rc-card space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="col-span-2 md:col-span-5">
              <div className="text-[11px] text-rc-text-dim mb-1">策略类型</div>
              <div className="flex gap-2 flex-wrap">
                {([
                  ["model", "模型"],
                  ["factor", "因子"],
                  ["composite", "复合因子"],
                  ["signal_file", "信号文件"],
                ] as const).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setStrategyType(v)}
                    className={`px-3 py-1.5 rounded-[6px] text-[12px] border ${
                      strategyType === v
                        ? "bg-rc-blue/20 border-rc-blue/50 text-rc-blue"
                        : "border-zinc-700 text-rc-text-secondary hover:border-zinc-500"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {strategyType === "model" && (
              <div className="col-span-2">
                <div className="text-[11px] text-rc-text-dim mb-1">模型 ID</div>
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="model_xxxxxxxxxxxx"
                />
              </div>
            )}
            {strategyType === "factor" && (
              <div className="col-span-2">
                <div className="text-[11px] text-rc-text-dim mb-1">因子 ID</div>
                <input
                  value={factorId}
                  onChange={(e) => setFactorId(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="factor_xxxxxxxx"
                />
              </div>
            )}
            {strategyType === "composite" && (
              <div className="col-span-2">
                <div className="text-[11px] text-rc-text-dim mb-1">复合因子（逗号分隔的因子 ID）</div>
                <input
                  value={compositeId}
                  onChange={(e) => setCompositeId(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="factor_a,factor_b"
                />
              </div>
            )}
            {strategyType === "signal_file" && (
              <div className="col-span-2">
                <div className="text-[11px] text-rc-text-dim mb-1">信号文件 ID</div>
                <input
                  value={signalFileId}
                  onChange={(e) => setSignalFileId(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="sig_xxx"
                />
              </div>
            )}

            <div>
              <div className="text-[11px] text-rc-text-dim mb-1">开始</div>
              <input
                type="date"
                value={start}
                onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                className="rc-input"
              />
            </div>
            <div>
              <div className="text-[11px] text-rc-text-dim mb-1">结束</div>
              <input
                type="date"
                value={end}
                onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                className="rc-input"
              />
            </div>
            {strategyType === "model" ? (
              <div>
                <div className="text-[11px] text-rc-text-dim mb-1">股票池</div>
                <select
                  value={universe}
                  onChange={(e) => setUniverse(e.target.value)}
                  className="rc-input"
                  disabled
                  title="模型回测固定以其预测标的为准"
                >
                  <option value="__model__">{modelTargetLabel}</option>
                </select>
              </div>
            ) : (
              <div className="col-span-3">
                <div className="text-[11px] text-rc-text-dim mb-1">
                  标的池（逗号分隔；留空=因子覆盖的全部标的）
                </div>
                <input
                  value={explicitSymbols}
                  onChange={(e) => setExplicitSymbols(e.target.value)}
                  className="rc-input font-rc-mono text-[12px]"
                  placeholder="000001,000002,..."
                />
              </div>
            )}
          </div>
          {strategyType === "model" && (
            <p className="text-[11px] text-rc-text-dim -mt-1">
              模型回测固定以其预测标的（{modelTarget ?? "训练时记录的目标股"}）为准
            </p>
          )}
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-rc-text-dim">初始资金</div>
            <input
              type="number"
              min={10000}
              step={100000}
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value) || 1_000_000)}
              className="rc-input w-36"
            />
            <button
              onClick={run}
              disabled={loading}
              className="px-4 py-2 rounded-[6px] text-[13px] font-medium bg-rc-blue/15 border border-rc-blue/40 text-rc-blue hover:bg-rc-blue/25 transition disabled:opacity-50"
            >
              {loading ? "回测中…" : "▶ 运行回测"}
            </button>
            {engine && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-rc-mono bg-amber-500/10 text-amber-400 border border-amber-500/30">
                引擎：{engine}
              </span>
            )}
            {modelTarget && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-rc-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                标的：{modelTarget}
              </span>
            )}
          </div>
          {error && <p className="text-[12px] text-red-400">✗ {error}</p>}

        {loading && progress && (
          <div className="rc-card space-y-2">
            <div className="flex justify-between text-[12px] text-rc-text-secondary">
              <span>回测进行中…（异步任务）</span>
              <span className="font-rc-mono">
                {progress.pct}% · {STAGE_LABEL[progress.stage] ?? progress.stage}
              </span>
            </div>
            <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-rc-blue transition-all duration-500"
                style={{ width: `${Math.max(2, progress.pct)}%` }}
              />
            </div>
          </div>
        )}
        </div>

        {/* 结果 */}
        {result && s && (
          <>
            <div className="rc-card">
              {(result.meta?.in_sample !== undefined && result.meta?.in_sample !== null) && (
                <div className="flex items-center gap-2 mb-3 flex-wrap">
                  {result.meta.in_sample ? (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 border border-red-500/30">
                      样本内回测（过拟合风险）
                    </span>
                  ) : (
                    <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                      样本外回测
                    </span>
                  )}
                  {result.meta.training_range && (
                    <span className="text-[11px] text-rc-text-dim font-rc-mono">
                      训练区间 {result.meta.training_range.start} ~ {result.meta.training_range.end}（重叠 {result.meta.overlap_days} 天）
                    </span>
                  )}
                </div>
              )}
              <div className="grid grid-cols-3 md:grid-cols-6 gap-3 text-center">
                {[
                  { l: "总收益", v: pct(s.total_return), good: s.total_return > 0 },
                  { l: "年化收益", v: pct(s.annual_return), good: s.annual_return > 0 },
                  { l: "基准收益", v: pct(s.benchmark_return) },
                  { l: "超额收益", v: pct(s.excess_return), good: s.excess_return > 0 },
                  { l: "夏普", v: num(s.sharpe), good: s.sharpe > 0 },
                  { l: "最大回撤", v: pct(s.max_drawdown), good: false },
                  { l: "胜率", v: pct(s.win_rate) },
                  { l: "盈亏比", v: num(s.profit_loss_ratio) },
                  { l: "换手率", v: pct(s.turnover_rate) },
                  { l: "交易次数", v: String(s.total_trades ?? 0) },
                  { l: "Calmar", v: num(s.calmar) },
                  { l: "Sortino", v: num(s.sortino) },
                ].map((m) => (
                  <div key={m.l}>
                    <div className="text-[11px] text-rc-text-dim">{m.l}</div>
                    <div
                      className={`text-[15px] font-rc-mono mt-0.5 ${
                        m.good == null ? "text-white" : m.good ? "text-emerald-400" : "text-red-400"
                      }`}
                    >
                      {m.v}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rc-card">
              <div className="text-[12px] text-rc-text-secondary mb-2">
                净值曲线（{result.config?.start} ~ {result.config?.end}）
              </div>
              <EquityChart result={result} />
              <div className="text-[11px] text-rc-text-dim mt-1">
                蓝：策略净值（起点 1.0 = 初始资金 ¥{initCap.toLocaleString()}） · 灰：基准 {benchLabel}（回测首日全仓买入、持有至最后一日、不调仓，被动对照、非模型交易） · 市场指数K线因库内无指数行情暂未绘制
              </div>
              {s.max_drawdown_period && (
                <div className="text-[11px] text-rc-text-dim mt-1 font-rc-mono">
                  最大回撤区间：{s.max_drawdown_period[0]} ~ {s.max_drawdown_period[1]}
                </div>
              )}
            </div>

            {result.meta?.holdings && result.meta.holdings.length > 0 && (
              <div className="rc-card">
                <div className="text-[13px] text-white font-medium mb-3">
                  Top-N 持仓（期末权重 · 区间收益）
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-rc-text-dim">
                        <th className="text-left py-1.5 pr-3">标的</th>
                        <th className="text-right py-1.5 pr-3">权重</th>
                        <th className="text-right py-1.5">区间收益</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.meta.holdings.map((h) => (
                        <tr key={h.symbol} className="border-t border-zinc-800">
                          <td className="py-1.5 pr-3 font-rc-mono text-rc-blue">{h.symbol}</td>
                          <td className="py-1.5 pr-3 text-right font-rc-mono">{pct(h.weight)}</td>
                          <td className={`py-1.5 text-right font-rc-mono ${h.ret >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                            {pct(h.ret)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {/* 历史回测 */}
        {recent.length > 0 && (
          <div className="rc-card">
            <div className="text-[13px] text-white font-medium mb-3">最近回测</div>
            <div className="space-y-1.5">
              {recent.map((b) => (
                <div
                  key={b.id}
                  role="button"
                  tabIndex={0}
                  title="点击查看回测详情"
                  onClick={() => void openRecent(b.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void openRecent(b.id); }}
                  className="flex items-center gap-3 text-[11px] font-rc-mono text-rc-text-muted cursor-pointer rounded px-2 -mx-2 py-1 hover:bg-zinc-800/50 transition"
                >
                  <span className="text-rc-text-dim">{b.created_at?.slice(0, 16).replace("T", " ")}</span>
                  <span className="text-rc-blue">{b.config?.strategy?.model_id ?? b.id}</span>
                  <span>
                    {b.config?.start}~{b.config?.end} ·{" "}
                    {String(b.config?.universe ?? "") === "__model__"
                      ? "模型标的"
                      : String(b.config?.universe ?? "")}
                  </span>
                  <span className={(b.summary?.total_return ?? 0) >= 0 ? "text-emerald-400" : "text-red-400"}>
                    {pct(b.summary?.total_return)}
                  </span>
                  <span className="text-rc-text-dim">sharpe {num(b.summary?.sharpe)}</span>
                  <span className="ml-auto text-zinc-500 shrink-0">查看 →</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

export default function BacktestPage() {
  return (
    <Suspense>
      <BacktestPageInner />
    </Suspense>
  );
}
