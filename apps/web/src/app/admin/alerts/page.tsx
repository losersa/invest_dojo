"use client";

import { useCallback, useEffect, useState } from "react";
import { MainNav } from "@/components/MainNav";
import { useCurrentUser, isStaff } from "@/hooks/useCurrentUser";
import { sdk } from "@/lib/sdk";
import type { AlertsOverview, ModuleAlerts, ModuleStatus } from "@investdojo/api";

// ── 状态样式 ──
const STATUS_STYLE: Record<ModuleStatus, { badge: string; text: string }> = {
  ok: { badge: "bg-emerald-500/15 text-emerald-400", text: "正常" },
  warning: { badge: "bg-amber-500/15 text-amber-400", text: "告警" },
  critical: { badge: "bg-red-500/15 text-red-400", text: "严重" },
  unknown: { badge: "bg-zinc-500/15 text-zinc-400", text: "未知" },
};

const LEVEL_STYLE: Record<string, string> = {
  warning: "border-amber-500/30 bg-amber-500/5 text-amber-300",
  critical: "border-red-500/30 bg-red-500/5 text-red-300",
};

// report 各模块已知字段的中文标签
const REPORT_LABELS: Record<string, string> = {
  redis: "Redis",
  minio: "MinIO",
  postgres: "PostgreSQL",
  disk_pct: "磁盘已用%",
  disk_free_gb: "磁盘剩余GB",
  total: "总数",
  ok: "正常数",
  symbols: "股票数",
  klines_1d_latest: "1d K线最新",
  klines_5m_latest: "5m K线最新",
  fundamentals_rows: "基本面记录",
  market_snapshots_latest: "市场快照最新",
  factor_definitions_public: "公开因子数",
  feature_values_latest: "因子值最新",
  running: "运行中",
  completed: "已完成",
  failed_total: "失败总数",
};

interface FailedJob {
  id: string;
  created_at: string | null;
  stage?: string | null;
  error: string;
}

function formatValue(key: string, val: unknown): string {
  if (val === null || val === undefined) return "—";
  if (typeof val === "number") return val.toLocaleString();
  if (typeof val === "boolean") return val ? "是" : "否";
  return String(val);
}

/** 渲染模块报表：已知 key 中文标签 + 数值格式化；复杂结构（服务列表/失败列表）单独渲染 */
function ModuleReport({ mod }: { mod: ModuleAlerts }) {
  const r = mod.report;
  const simpleEntries = Object.entries(r).filter(
    ([k, v]) =>
      typeof v !== "object" &&
      k !== "services" &&
      k !== "recent_failed" &&
      k !== "feature_values_recent",
  );

  return (
    <div className="space-y-3">
      {simpleEntries.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          {simpleEntries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-zinc-500">{REPORT_LABELS[k] ?? k}</dt>
              <dd className="text-zinc-200 font-mono text-xs leading-5">
                {formatValue(k, v)}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {/* infra/services 状态点 */}
      {mod.module === "infra" && (
        <div className="flex gap-4 text-xs">
          {Object.entries(r)
            .filter(([k]) => ["redis", "minio", "postgres"].includes(k))
            .map(([k, v]) => (
              <span key={k} className="flex items-center gap-1.5 text-zinc-400">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    v === "ok" ? "bg-emerald-400" : "bg-red-400"
                  }`}
                />
                {REPORT_LABELS[k] ?? k}
              </span>
            ))}
        </div>
      )}

      {/* services 模块的服务列表 */}
      {mod.module === "services" && Array.isArray(r.services) && (
        <ul className="space-y-1 text-xs">
          {(r.services as Array<{ name: string; role: string; status: string; latency_ms?: number }>).map(
            (s) => (
              <li key={s.name} className="flex items-center justify-between text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      s.status === "ok" ? "bg-emerald-400" : "bg-red-400"
                    }`}
                  />
                  {s.name}
                  <span className="text-zinc-600">{s.role}</span>
                </span>
                <span className="font-mono text-zinc-600">{s.latency_ms}ms</span>
              </li>
            ),
          )}
        </ul>
      )}

      {/* feature 模块近几天写入量 */}
      {mod.module === "feature" && Array.isArray(r.feature_values_recent) && (
        <div className="text-xs text-zinc-500">
          近几日因子值：
          {(r.feature_values_recent as Array<{ date: string; rows: number }>).map((d) => (
            <span key={d.date} className="ml-2 font-mono text-zinc-400">
              {d.date.slice(5)} · {d.rows.toLocaleString()}行
            </span>
          ))}
        </div>
      )}

      {/* train/backtest 失败任务列表 */}
      {Array.isArray(r.recent_failed) && r.recent_failed.length > 0 && (
        <ul className="space-y-1.5">
          {(r.recent_failed as FailedJob[]).map((j) => (
            <li
              key={j.id}
              className="rounded border border-red-500/20 bg-red-500/5 px-2 py-1.5 text-xs"
            >
              <div className="flex justify-between gap-2 text-zinc-400">
                <span className="font-mono">{j.id.slice(0, 8)}…</span>
                <span>{j.created_at ? j.created_at.slice(0, 16).replace("T", " ") : ""}</span>
              </div>
              {j.error && <div className="mt-0.5 text-red-300/80 break-all">{j.error}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AdminAlertsPage() {
  const { user, loading: userLoading } = useCurrentUser();
  const [data, setData] = useState<AlertsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sdk.monitor.getAlerts();
      setData(res.data);
      setLastRefresh(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user || !isStaff(user)) return;
    load();
    const timer = setInterval(load, 60_000); // 每分钟自动刷新
    return () => clearInterval(timer);
  }, [user, load]);

  if (userLoading) {
    return (
      <div className="min-h-screen bg-black text-white">
        <MainNav />
        <div className="p-8 text-zinc-500">加载中…</div>
      </div>
    );
  }
  if (!user || !isStaff(user)) {
    return (
      <div className="min-h-screen bg-black text-white">
        <MainNav />
        <div className="p-8 text-zinc-500">无权限访问（仅内部员工）</div>
      </div>
    );
  }

  const overall = data?.overall ?? "unknown";
  const overallStyle = STATUS_STYLE[overall];

  return (
    <div className="min-h-screen bg-black text-white">
      <MainNav />
      <main className="mx-auto max-w-6xl px-6 py-6">
        {/* 头部：总体状态 */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">告警中心</h1>
            <p className="mt-1 text-xs text-zinc-500">
              分模块数据报表与告警 · 每分钟自动刷新
              {lastRefresh && ` · 上次刷新 ${lastRefresh.toLocaleTimeString()}`}
              {data && ` · 聚合耗时 ${data.elapsed_ms}ms`}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data && (
              <div className="flex items-center gap-2 text-sm">
                <span className={`rounded px-2.5 py-1 text-xs font-medium ${overallStyle.badge}`}>
                  总体：{overallStyle.text}
                </span>
                {data.alert_counts.critical > 0 && (
                  <span className="rounded bg-red-500/15 px-2 py-1 text-xs text-red-400">
                    严重 {data.alert_counts.critical}
                  </span>
                )}
                {data.alert_counts.warning > 0 && (
                  <span className="rounded bg-amber-500/15 px-2 py-1 text-xs text-amber-400">
                    告警 {data.alert_counts.warning}
                  </span>
                )}
              </div>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-50"
            >
              {loading ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            加载失败：{error}
          </div>
        )}

        {/* 模块卡片 */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {data?.modules.map((mod) => {
            const st = STATUS_STYLE[mod.status] ?? STATUS_STYLE.unknown;
            return (
              <section
                key={mod.module}
                className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"
              >
                <header className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-medium text-zinc-200">
                    {mod.label}
                    <span className="ml-2 font-mono text-xs text-zinc-600">{mod.module}</span>
                  </h2>
                  <span className={`rounded px-2 py-0.5 text-xs ${st.badge}`}>{st.text}</span>
                </header>

                <ModuleReport mod={mod} />

                {mod.alerts.length > 0 && (
                  <div className="mt-3 space-y-2 border-t border-zinc-800/60 pt-3">
                    {mod.alerts.map((a, i) => (
                      <div
                        key={i}
                        className={`rounded border px-3 py-2 text-xs ${LEVEL_STYLE[a.level] ?? LEVEL_STYLE.warning}`}
                      >
                        <div>{a.message}</div>
                        {a.hint && <div className="mt-1 opacity-70">{a.hint}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {!data && !error && !loading && (
          <div className="py-16 text-center text-sm text-zinc-600">暂无数据</div>
        )}
      </main>
    </div>
  );
}
