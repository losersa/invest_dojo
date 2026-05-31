"use client";

// ============================================================
// 因子对比页 — Raycast Design System
// 多选 2~10 个因子，横向对比触发率/覆盖度/均值等聚合指标
// 数据源：POST /api/v1/factors/compare（基于 feature_values 缓存聚合）
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ApiError,
  type Factor,
  type FactorCompareResponse,
} from "@investdojo/api";
import { sdk, ensureUserId } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

const DEFAULT_START = "2026-03-01";
const DEFAULT_END = "2026-04-30";
const MAX_SELECT = 10;
const MIN_SELECT = 2;

const CATEGORY_ICON: Record<string, string> = {
  technical: "📈",
  valuation: "💰",
  growth: "🌱",
  sentiment: "🔥",
  fundamental: "🏛️",
  macro: "🌐",
  custom: "⚙️",
};

// 对比指标定义（数值越大者为该指标“冠军”，与后端 winner_by_metric 一致）
interface MetricDef {
  key: string;
  label: string;
  appliesTo: "boolean" | "scalar";
  fmt: (v: number) => string;
}

const METRICS: MetricDef[] = [
  { key: "trigger_count", label: "触发次数", appliesTo: "boolean", fmt: (v) => v.toLocaleString() },
  { key: "trigger_rate", label: "触发率", appliesTo: "boolean", fmt: (v) => `${(v * 100).toFixed(2)}%` },
  { key: "avg_value", label: "均值", appliesTo: "scalar", fmt: (v) => fmtNum(v) },
];

export function FactorComparePage() {
  // 候选因子（公开/官方，compare 仅对有缓存数据的因子有效）
  const [candidates, setCandidates] = useState<Factor[]>([]);
  const [candLoading, setCandLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // 已选因子（保留完整对象用于展示名称/类型）
  const [selected, setSelected] = useState<Factor[]>([]);

  // 对比参数
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [metrics, setMetrics] = useState<string[]>(["trigger_count", "trigger_rate", "avg_value"]);

  // 对比结果
  const [result, setResult] = useState<FactorCompareResponse | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(() => new Set(selected.map((f) => f.id)), [selected]);

  // 搜索防抖
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // 加载候选因子列表
  useEffect(() => {
    let alive = true;
    setCandLoading(true);
    ensureUserId()
      .then(() =>
        sdk.factors.listFactors({
          owner: "all",
          visibility: "public",
          search: search || undefined,
          sort: "-updated_at",
          include_stats: false,
          page: 1,
          page_size: 50,
        }),
      )
      .then((res) => {
        if (alive) setCandidates(res.data);
      })
      .catch(() => {
        if (alive) setCandidates([]);
      })
      .finally(() => alive && setCandLoading(false));
    return () => {
      alive = false;
    };
  }, [search]);

  const toggleSelect = (f: Factor) => {
    setSelected((prev) => {
      if (prev.some((x) => x.id === f.id)) {
        return prev.filter((x) => x.id !== f.id);
      }
      if (prev.length >= MAX_SELECT) return prev; // 超过上限不再添加
      return [...prev, f];
    });
  };

  const removeSelected = (id: string) => setSelected((prev) => prev.filter((x) => x.id !== id));

  const toggleMetric = (key: string) => {
    setMetrics((prev) => (prev.includes(key) ? prev.filter((m) => m !== key) : [...prev, key]));
  };

  const canCompare = selected.length >= MIN_SELECT && metrics.length > 0 && !comparing;

  const runCompare = () => {
    if (selected.length < MIN_SELECT) return;
    setComparing(true);
    setError(null);
    sdk.factors
      .compareFactors({
        factor_ids: selected.map((f) => f.id),
        start,
        end,
        metrics,
      })
      .then((res) => setResult(res.data))
      .catch((e: unknown) => {
        setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : String(e));
        setResult(null);
      })
      .finally(() => setComparing(false));
  };

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />

      {/* 面包屑 */}
      <div className="max-w-[1200px] mx-auto px-6 pt-4">
        <div className="flex items-center gap-2 text-sm text-[#888]">
          <Link href="/factors" className="hover:text-white transition">
            因子库
          </Link>
          <span>/</span>
          <span className="text-white">因子对比</span>
        </div>
      </div>

      <main className="max-w-[1200px] mx-auto px-6 py-6 space-y-6">
        {/* 标题 */}
        <div>
          <h1 className="text-[28px] font-semibold text-white tracking-[0.2px]">因子对比</h1>
          <p className="text-body text-rc-text-secondary mt-1">
            选择 {MIN_SELECT}~{MAX_SELECT} 个因子横向对比触发率、覆盖度、均值等指标。
            <span className="text-rc-text-dim ml-1">
              对比基于预计算缓存（feature_values），官方/已发布因子数据更完整。
            </span>
          </p>
        </div>

        {/* ── 已选因子 ── */}
        <section className="rc-card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
              已选因子 {selected.length}/{MAX_SELECT}
            </div>
            {selected.length > 0 && (
              <button
                onClick={() => setSelected([])}
                className="text-[12px] text-rc-text-dim hover:text-rc-red transition"
              >
                清空
              </button>
            )}
          </div>
          {selected.length === 0 ? (
            <p className="text-[13px] text-rc-text-dim py-2">从下方列表中选择因子开始对比…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {selected.map((f) => (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-[6px] bg-rc-surface-input border border-rc-border-input text-[13px] text-rc-text-primary"
                >
                  <span>{CATEGORY_ICON[f.category] ?? "📊"}</span>
                  <span className="max-w-[180px] truncate">{f.name}</span>
                  <button
                    onClick={() => removeSelected(f.id)}
                    className="text-rc-text-dim hover:text-rc-red transition leading-none"
                    aria-label="移除"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* ── 工具条：时间窗 + 指标 + 对比按钮 ── */}
        <section className="rc-card p-4">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3 items-end">
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
              onClick={runCompare}
              disabled={!canCompare}
              className="rc-btn-primary px-6 py-2 text-[13px] disabled:opacity-40"
            >
              {comparing ? "对比中…" : "开始对比"}
            </button>
          </div>

          {/* 指标选择 */}
          <div className="mt-4">
            <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px] mb-2">
              对比指标
            </div>
            <div className="flex flex-wrap gap-2">
              {METRICS.map((m) => {
                const on = metrics.includes(m.key);
                return (
                  <button
                    key={m.key}
                    onClick={() => toggleMetric(m.key)}
                    className={`px-3 py-1.5 rounded-[6px] text-[12px] border transition ${
                      on
                        ? "bg-rc-blue/15 border-rc-blue/40 text-rc-blue"
                        : "bg-rc-surface-input border-rc-border-input text-rc-text-dim hover:text-rc-text-secondary"
                    }`}
                  >
                    {m.label}
                    <span className="ml-1 opacity-60">
                      {m.appliesTo === "boolean" ? "·信号" : "·数值"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {selected.length < MIN_SELECT && (
            <p className="text-[12px] text-rc-yellow mt-3">至少选择 {MIN_SELECT} 个因子才能对比。</p>
          )}
        </section>

        {/* ── 对比结果 ── */}
        {error && (
          <div className="rc-card border-rc-red/40 text-[13px] text-rc-red">对比失败：{error}</div>
        )}

        {result && (
          <CompareResultTable
            result={result}
            selected={selected}
            activeMetrics={metrics}
          />
        )}

        {/* ── 候选因子选择器 ── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium text-white tracking-[0.2px]">选择因子</h2>
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="搜索因子名称…"
              className="w-[260px] bg-rc-surface-input border border-rc-border-input rounded-[8px] px-3 py-2 text-[13px] text-rc-text-primary focus:outline-none focus:border-rc-blue"
            />
          </div>

          {candLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rc-card h-[88px] animate-pulse" />
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <div className="rc-card text-center py-10 text-rc-text-dim text-[13px]">
              {search ? `未找到匹配 "${search}" 的因子` : "暂无可对比的公开因子"}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {candidates.map((f) => {
                const on = selectedIds.has(f.id);
                const disabled = !on && selected.length >= MAX_SELECT;
                return (
                  <button
                    key={f.id}
                    onClick={() => toggleSelect(f)}
                    disabled={disabled}
                    className={`text-left rc-card p-4 transition border ${
                      on
                        ? "border-rc-blue/60 bg-rc-blue/5"
                        : disabled
                          ? "border-rc-border-subtle opacity-40 cursor-not-allowed"
                          : "border-rc-border-subtle hover:border-rc-border"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[13px]">{CATEGORY_ICON[f.category] ?? "📊"}</span>
                          <span className="text-[13px] font-medium text-white truncate">{f.name}</span>
                        </div>
                        <div className="text-[11px] font-rc-mono text-rc-text-dim">
                          {f.output_type} · v{f.version}
                          {f.owner === "platform" && <span className="text-rc-yellow ml-1">⭐ 官方</span>}
                        </div>
                      </div>
                      <span
                        className={`shrink-0 w-5 h-5 rounded-[4px] border flex items-center justify-center text-[11px] ${
                          on
                            ? "bg-rc-blue border-rc-blue text-white"
                            : "border-rc-border-input text-transparent"
                        }`}
                      >
                        ✓
                      </span>
                    </div>
                    {f.description && (
                      <p className="text-[11px] text-rc-text-muted mt-2 line-clamp-2">{f.description}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ────────────────────────────────────────────
// 对比结果表格
// ────────────────────────────────────────────

function CompareResultTable({
  result,
  selected,
  activeMetrics,
}: {
  result: FactorCompareResponse;
  selected: Factor[];
  activeMetrics: string[];
}) {
  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of selected) m.set(f.id, f.name);
    return m;
  }, [selected]);

  // 只渲染当前勾选且后端实际返回的指标列
  const cols = METRICS.filter((m) => activeMetrics.includes(m.key));

  const valueOf = (row: FactorCompareResponse["comparison"][number], key: string): number | null => {
    const v = (row as unknown as Record<string, unknown>)[key];
    return typeof v === "number" ? v : null;
  };

  return (
    <section className="rc-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[14px] font-medium text-white tracking-[0.2px]">对比结果</h2>
        <span className="text-[12px] font-rc-mono text-rc-text-dim">
          {result.window.start} ~ {result.window.end}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-rc-text-dim text-[11px] font-rc-mono uppercase tracking-[0.3px] border-b border-rc-border-subtle">
              <th className="text-left py-2 pr-4 font-normal">因子</th>
              <th className="text-right py-2 px-3 font-normal">类型</th>
              <th className="text-right py-2 px-3 font-normal">记录数</th>
              <th className="text-right py-2 px-3 font-normal">覆盖股票</th>
              {cols.map((c) => (
                <th key={c.key} className="text-right py-2 px-3 font-normal">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.comparison.map((row) => {
              const name = row.name || nameById.get(row.factor_id) || row.factor_id;
              return (
                <tr key={row.factor_id} className="border-b border-rc-border-subtle/50">
                  <td className="py-3 pr-4 text-white max-w-[260px] truncate">{name}</td>
                  <td className="py-3 px-3 text-right font-rc-mono text-rc-text-secondary">
                    {row.output_type ?? "–"}
                  </td>
                  <td className="py-3 px-3 text-right font-rc-mono text-rc-text-secondary">
                    {row.error ? "–" : (row.total ?? 0).toLocaleString()}
                  </td>
                  <td className="py-3 px-3 text-right font-rc-mono text-rc-text-secondary">
                    {row.error ? "–" : (row.coverage_symbols ?? 0).toLocaleString()}
                  </td>
                  {cols.map((c) => {
                    const v = valueOf(row, c.key);
                    const isWinner = result.winner_by_metric[c.key] === row.factor_id && v !== null;
                    return (
                      <td
                        key={c.key}
                        className={`py-3 px-3 text-right font-rc-mono ${
                          isWinner ? "text-rc-green font-semibold" : "text-rc-text-primary"
                        }`}
                      >
                        {v === null ? (
                          <span className="text-rc-text-dim">–</span>
                        ) : (
                          <>
                            {c.fmt(v)}
                            {isWinner && <span className="ml-1 text-[10px]">🏆</span>}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 错误行提示 */}
      {result.comparison.some((r) => r.error) && (
        <p className="text-[12px] text-rc-yellow mt-3">
          部分因子无缓存数据（标记为 –），通常是未回填或私有因子。
        </p>
      )}

      {/* 冠军汇总 */}
      {Object.keys(result.winner_by_metric).length > 0 && (
        <div className="mt-4 pt-4 border-t border-rc-border-subtle flex flex-wrap gap-2">
          {cols.map((c) => {
            const winnerId = result.winner_by_metric[c.key];
            if (!winnerId) return null;
            const winnerName =
              result.comparison.find((r) => r.factor_id === winnerId)?.name ||
              nameById.get(winnerId) ||
              winnerId;
            return (
              <span
                key={c.key}
                className="text-[12px] px-3 py-1 rounded-[6px] bg-rc-green/10 border border-rc-green/30 text-rc-green"
              >
                {c.label} 冠军：{winnerName}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}

function fmtNum(v: number | undefined | null): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(2);
  return v.toFixed(4);
}
