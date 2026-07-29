"use client";

/**
 * 数据管理后台 — 仅内部员工可访问
 *
 * 功能：
 * - 数据概览（各表行数、最近更新时间）
 * - 手动触发数据更新任务
 * - 查看任务执行状态（含历史记录）
 * - 进入页面即展示最新状态和日志
 *
 * 路由：/admin/data
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { MainNav } from "@/components/MainNav";
import { ensureUser } from "@/lib/auth/auth";

// 同源代理（middleware 转发 data-svc）——远程浏览器里 localhost 指向用户自己电脑，
// 裸 fetch localhost:8006 必然失败（排障手册 ## 0），一律走 /svc/data。
const DATA_SVC_URL = "/svc/data";

interface TableInfo {
  table: string;
  label: string;
  count: number;
  latest: string | null;
  error?: string;
  loaded?: boolean; // 该卡片的数据是否已返回（用于逐个渲染）
}

interface TaskInfo {
  status: "running" | "success" | "failed" | "timeout" | "interrupted";
  label: string;
  tables?: string[];
  started_at: string;
  finished_at: string | null;
  error: string | null;
  progress: number | null;
  progress_current?: number | null;
  progress_total?: number | null;
  last_line: string | null;
}

interface HistoryRecord {
  status: string;
  label: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  progress: number | null;
  last_line: string | null;
  log_lines: number;
}

const TASKS = [
  { id: "update_klines", label: "增量更新 K 线", desc: "从 BaoStock 拉取最新交易日的 5m K 线", tables: ["klines_all"] },
  { id: "update_snapshots", label: "更新市场快照", desc: "更新每日市场统计快照", tables: ["market_snapshots"] },
  { id: "seed_fundamentals", label: "采集基本面", desc: "采集股票基本面数据（EPS、总股本、ROE 等）", tables: ["fundamentals"] },
  { id: "seed_symbols", label: "同步股票代码", desc: "从 BaoStock 同步最新股票列表", tables: ["symbols", "industries"] },
  { id: "backfill_factors", label: "回填因子值", desc: "为已发布因子计算并写入 feature_values 缓存", tables: ["feature_values"] },
];

// 表名 → 中文标签（与数据概览卡片保持一致）
const TABLE_LABELS: Record<string, string> = {
  klines_all: "K 线数据",
  symbols: "股票代码",
  industries: "行业分类",
  factor_definitions: "因子定义",
  feature_values: "因子预计算值",
  market_snapshots: "市场快照",
  fundamentals: "基本面数据",
};

// 数据概览卡片顺序（与后端 _TABLE_DEFS 一致）
const OVERVIEW_TABLES = Object.keys(TABLE_LABELS);

export default function AdminDataPage() {
  // 每张卡片独立保存数据，键为表名；未出现则显示骨架
  const [tableData, setTableData] = useState<Record<string, TableInfo>>({});
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);

  // 获取用户信息
  useEffect(() => {
    ensureUser().then((u) => {
      if (u) {
        setUserId(u.id);
        setUserRole(u.role || "staff");
      } else {
        setUnauthorized(true);
      }
    });
  }, []);

  // 加载任务状态（内存数据，很快，独立请求避免拖慢概览）
  const fetchTasks = useCallback(async () => {
    if (!userId || !userRole) return;
    try {
      const resp = await fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/tasks`, {
        headers: { "X-User-Id": userId, "X-User-Role": userRole },
      });
      if (resp.status === 403) {
        setUnauthorized(true);
        return;
      }
      if (resp.ok) {
        const json = await resp.json();
        setTasks(json.tasks || {});
      }
    } catch {
      // ignore
    }
  }, [userId, userRole]);

  // 加载数据概览：每张卡片单独请求，谁先返回谁先渲染
  const loadOverview = useCallback(async () => {
    if (!userId || !userRole) return;
    setRefreshing(true);
    setError(null);
    fetchTasks();

    await Promise.allSettled(
      OVERVIEW_TABLES.map(async (name) => {
        try {
          const resp = await fetch(
            `${DATA_SVC_URL}/api/v1/data/admin/data/overview/table/${name}`,
            { headers: { "X-User-Id": userId, "X-User-Role": userRole } },
          );
          if (resp.status === 403) {
            setUnauthorized(true);
            return;
          }
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const json = await resp.json();
          setTableData((prev) => ({ ...prev, [name]: { ...json, loaded: true } }));
        } catch (e: unknown) {
          setTableData((prev) => ({
            ...prev,
            [name]: {
              table: name,
              label: TABLE_LABELS[name] ?? name,
              count: -1,
              latest: null,
              loaded: true,
              error: e instanceof Error ? e.message : "加载失败",
            },
          }));
        }
      }),
    );
    setRefreshing(false);
  }, [userId, userRole, fetchTasks]);

  useEffect(() => {
    if (userId && userRole) loadOverview();
  }, [userId, userRole, loadOverview]);

  // 触发任务
  const triggerTask = async (taskName: string) => {
    if (!userId || !userRole) return;
    try {
      const resp = await fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/tasks/${taskName}`, {
        method: "POST",
        headers: {
          "X-User-Id": userId,
          "X-User-Role": userRole,
        },
      });
      const json = await resp.json();
      if (json.task) {
        setTasks((prev) => ({ ...prev, [taskName]: json.task }));
      }
    } catch {
      // ignore
    }
  };

  // 轮询任务状态（有 running 任务时 3 秒轮询）
  useEffect(() => {
    const hasRunning = Object.values(tasks).some((t) => t.status === "running");
    if (!hasRunning) return;
    const timer = setInterval(async () => {
      if (!userId || !userRole) return;
      try {
        const resp = await fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/tasks`, {
          headers: { "X-User-Id": userId, "X-User-Role": userRole },
        });
        if (resp.ok) {
          const json = await resp.json();
          setTasks(json.tasks || {});
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [tasks, userId, userRole]);

  // 正在被更新的表集合（用于高亮数据概览卡片）
  const activeTables = new Set<string>();
  Object.values(tasks).forEach((t) => {
    if (t.status === "running" && t.tables) {
      t.tables.forEach((tb) => activeTables.add(tb));
    }
  });

  if (unauthorized) {
    return (
      <div className="min-h-screen bg-rc-bg">
        <MainNav />
        <main className="max-w-[1000px] mx-auto px-6 py-16 text-center">
          <div className="rc-card p-12">
            <h1 className="text-[24px] text-white mb-4">无权限访问</h1>
            <p className="text-rc-text-secondary">此页面仅限内部员工使用，请先登录员工账号。</p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />
      <main className="max-w-[1200px] mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-[24px] font-semibold text-white">数据管理中心</h1>
            <p className="text-[13px] text-rc-text-secondary mt-1">数据采集、更新任务管理（内部）</p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/data/sql"
              className="px-4 py-2 rounded-[8px] bg-rc-blue/10 border border-rc-blue/30 text-[13px] text-rc-blue hover:bg-rc-blue/20 transition"
            >
              SQL 查询
            </Link>
            <button
              onClick={loadOverview}
              disabled={refreshing}
              className="px-4 py-2 rounded-[8px] bg-rc-surface-card border border-rc-border-subtle text-[13px] text-rc-text-secondary hover:text-white transition disabled:opacity-50"
            >
              {refreshing ? "刷新中…" : "刷新"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rc-card border-rc-red/40 text-rc-red text-[13px] mb-6">
            加载失败：{error}
          </div>
        )}

        {/* 例行任务巡检（celery 例行任务运行状态 + 每日写入量图表） */}
        {userId && userRole && <RoutineSection userId={userId} userRole={userRole} />}

        {/* 数据概览 */}
        <section className="mb-8">
          <h2 className="text-[14px] font-medium text-white mb-4">数据概览</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {OVERVIEW_TABLES.map((name) => {
              const t = tableData[name];
              // 该卡片数据尚未返回 → 显示骨架，其他已返回的卡片照常展示
              if (!t || !t.loaded) {
                return <div key={name} className="rc-card h-[80px] animate-pulse" />;
              }
              const isUpdating = activeTables.has(t.table);
              return (
                <div
                  key={t.table}
                  data-table={t.table}
                  className={`rc-card p-4 transition ${
                    isUpdating ? "border-rc-blue/60 ring-1 ring-rc-blue/40" : ""
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                      {t.label}
                    </div>
                    {isUpdating && (
                      <span className="flex items-center gap-1 text-[9px] font-rc-mono text-rc-blue">
                        <span className="w-1.5 h-1.5 rounded-full bg-rc-blue animate-pulse" />
                        更新中
                      </span>
                    )}
                  </div>
                  <div className={`text-[20px] font-rc-mono mt-1 ${t.count > 0 ? "text-rc-blue" : "text-rc-text-dim"}`}>
                    {t.count >= 0 ? t.count.toLocaleString() : "ERR"}
                  </div>
                  <div className="text-[9px] font-rc-mono text-rc-text-dim/60 mt-0.5">{t.table}</div>
                  {t.latest && (
                    <div className="text-[10px] font-rc-mono text-rc-text-dim mt-1">
                      最近：{t.latest.slice(0, 10)}
                    </div>
                  )}
                  {t.count === 0 && (
                    <div className="text-[10px] text-rc-yellow mt-1">无数据</div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* 例行化任务（celery beat 调度；含依赖检查/日志/源码/手动触发） */}
        {userId && userRole && <RoutineTasksSection userId={userId} userRole={userRole} />}
      </main>
    </div>
  );
}

// ── 状态标签颜色映射 ──
function statusBadge(status: string) {
  switch (status) {
    case "running":
      return { text: "运行中...", cls: "bg-blue-900/30 text-blue-300" };
    case "success":
      return { text: "完成", cls: "bg-green-900/30 text-green-300" };
    case "failed":
      return { text: "失败", cls: "bg-red-900/30 text-red-300" };
    case "timeout":
      return { text: "超时", cls: "bg-yellow-900/30 text-yellow-300" };
    case "interrupted":
      return { text: "已中断", cls: "bg-orange-900/30 text-orange-300" };
    default:
      return { text: status, cls: "bg-gray-900/30 text-gray-300" };
  }
}

function TaskCard({ task, status, onTrigger, userId, userRole }: {
  task: { id: string; label: string; desc: string; tables?: string[] };
  status?: TaskInfo;
  onTrigger: () => void;
  userId: string | null;
  userRole: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [historyLogs, setHistoryLogs] = useState<{ index: number; logs: string[] } | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const isRunning = status?.status === "running";
  const progress = status?.progress;
  const hasStatus = !!status;

  // 页面加载时：如果有状态（不管 running 还是已完成），自动展开日志
  // 只在组件首次挂载时自动展开
  const autoExpandedRef = useRef(false);
  useEffect(() => {
    if (hasStatus && !autoExpandedRef.current) {
      autoExpandedRef.current = true;
      setExpanded(true);
    }
  }, [hasStatus]);

  // 展开时自动加载日志
  // - 运行中：每 2 秒轮询
  // - 已完成/失败/中断：加载一次
  useEffect(() => {
    if (!expanded || !userId || !userRole) return;

    const fetchLogs = async () => {
      try {
        const resp = await fetch(
          `${DATA_SVC_URL}/api/v1/data/admin/data/tasks/${task.id}/logs?tail=200`,
          { headers: { "X-User-Id": userId, "X-User-Role": userRole } },
        );
        if (resp.ok) {
          const json = await resp.json();
          setLogs(json.logs || []);
        }
      } catch { /* ignore */ }
    };

    fetchLogs(); // 立即加载一次

    if (isRunning) {
      const timer = setInterval(fetchLogs, 2000);
      return () => clearInterval(timer);
    }
    // 非 running 状态只加载一次
    return undefined;
  }, [expanded, isRunning, task.id, userId, userRole]);

  // 当 status 变化（如 running → success）时重新加载日志
  useEffect(() => {
    if (expanded && status && !isRunning && userId && userRole) {
      fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/tasks/${task.id}/logs?tail=200`, {
        headers: { "X-User-Id": userId, "X-User-Role": userRole },
      }).then(r => r.json()).then(json => setLogs(json.logs || [])).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status]);

  // 自动滚动到日志底部（仅在容器内部滚动，不影响页面位置）
  useEffect(() => {
    if (isRunning && logContainerRef.current) {
      const el = logContainerRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [logs, isRunning]);

  // 加载历史记录
  const loadHistory = async () => {
    if (!userId || !userRole) return;
    try {
      const resp = await fetch(
        `${DATA_SVC_URL}/api/v1/data/admin/data/tasks/${task.id}/history?limit=10`,
        { headers: { "X-User-Id": userId, "X-User-Role": userRole } },
      );
      if (resp.ok) {
        const json = await resp.json();
        setHistory(json.history || []);
      }
    } catch { /* ignore */ }
  };

  // 加载历史某次的日志
  const loadHistoryLogs = async (index: number) => {
    if (!userId || !userRole) return;
    if (historyLogs?.index === index) {
      setHistoryLogs(null); // toggle
      return;
    }
    try {
      const resp = await fetch(
        `${DATA_SVC_URL}/api/v1/data/admin/data/tasks/${task.id}/history/${index}/logs?tail=200`,
        { headers: { "X-User-Id": userId, "X-User-Role": userRole } },
      );
      if (resp.ok) {
        const json = await resp.json();
        setHistoryLogs({ index, logs: json.logs || [] });
      }
    } catch { /* ignore */ }
  };

  const elapsed = status?.started_at
    ? Math.round((Date.now() - new Date(status.started_at).getTime()) / 1000)
    : 0;

  const badge = status ? statusBadge(status.status) : null;

  return (
    <div className="rc-card overflow-hidden">
      <div className="p-5 flex items-center justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[14px] text-white font-medium">{task.label}</span>
            {badge && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-rc-mono ${badge.cls}`}>
                {badge.text}
              </span>
            )}
            {isRunning && progress !== null && progress !== undefined && (
              <span className="text-[11px] font-rc-mono text-rc-blue">{progress}%</span>
            )}
            {isRunning && status?.progress_current != null && status?.progress_total != null && (
              <span className="text-[10px] font-rc-mono text-rc-text-dim">
                {status.progress_current}/{status.progress_total}
              </span>
            )}
            {isRunning && elapsed > 0 && (
              <span className="text-[10px] font-rc-mono text-rc-text-dim">
                {elapsed}s
              </span>
            )}
          </div>

          <p className="text-[12px] text-rc-text-dim mt-1">{task.desc}</p>

          {/* 写入目标表 */}
          {task.tables && task.tables.length > 0 && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <span className="text-[10px] text-rc-text-dim">写入表：</span>
              {task.tables.map((tb) => (
                <span
                  key={tb}
                  className="text-[10px] font-rc-mono px-1.5 py-0.5 rounded bg-rc-blue/10 border border-rc-blue/25 text-rc-blue"
                  title={tb}
                >
                  {TABLE_LABELS[tb] ?? tb}
                  <span className="text-rc-text-dim/60 ml-1">{tb}</span>
                </span>
              ))}
            </div>
          )}

          {/* 进度条 */}
          {isRunning && progress !== null && progress !== undefined && (
            <div className="mt-2 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
              <div
                className="h-full bg-rc-blue rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}
          {/* 运行中但还没解析到进度 —— 显示未确定的脉冲条，避免用户以为卡住 */}
          {isRunning && (progress === null || progress === undefined) && (
            <div className="mt-2 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
              <div className="h-full w-1/3 bg-rc-blue/50 rounded-full animate-pulse" />
            </div>
          )}

          {/* 当前操作 */}
          {isRunning && status?.last_line && (
            <p className="text-[10px] font-rc-mono text-rc-text-dim mt-1 truncate max-w-[600px]">
              {status.last_line}
            </p>
          )}

          {status?.finished_at && !isRunning && (
            <p className="text-[10px] font-rc-mono text-rc-text-dim mt-1">
              完成于：{new Date(status.finished_at).toLocaleString("zh-CN")}
            </p>
          )}
          {status?.error && !expanded && (
            <p className="text-[11px] text-rc-red mt-1 line-clamp-2">{status.error}</p>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-4">
          {hasStatus && (
            <button
              onClick={() => {
                setShowHistory(false);
                setExpanded(!expanded);
              }}
              className="px-3 py-2 rounded-[8px] text-[12px] bg-[#111] border border-[#222] text-rc-text-muted hover:text-white transition"
            >
              {expanded ? "收起" : "日志"}
            </button>
          )}
          {hasStatus && (
            <button
              onClick={() => {
                setExpanded(false);
                setShowHistory(!showHistory);
                if (!showHistory) loadHistory();
              }}
              className="px-3 py-2 rounded-[8px] text-[12px] bg-[#111] border border-[#222] text-rc-text-muted hover:text-white transition"
            >
              {showHistory ? "收起" : "历史"}
            </button>
          )}
          <button
            onClick={onTrigger}
            disabled={isRunning}
            className="px-4 py-2 rounded-[8px] text-[13px] font-medium transition disabled:opacity-40 bg-rc-blue/10 border border-rc-blue/30 text-rc-blue hover:bg-rc-blue/20"
          >
            {isRunning ? "运行中..." : "执行"}
          </button>
        </div>
      </div>

      {/* 日志面板 */}
      {expanded && (
        <div ref={logContainerRef} className="border-t border-[#1a1a1a] bg-[#0a0a0a] max-h-[300px] overflow-y-auto p-3">
          {logs.length === 0 ? (
            <p className="text-[11px] text-rc-text-dim text-center py-4">
              {isRunning ? "等待输出..." : "无日志"}
            </p>
          ) : (
            <pre className="text-[11px] font-rc-mono text-rc-text-secondary leading-relaxed whitespace-pre-wrap break-all">
              {logs.map((line, i) => (
                <div key={i} className={`py-0.5 ${
                  line.includes("ERROR") || line.includes("error") || line.includes("Traceback") ? "text-rc-red" :
                  line.includes("[OK]") || line.includes("success") ? "text-green-400" :
                  line.includes("%") ? "text-rc-blue" : ""
                }`}>
                  {line}
                </div>
              ))}
            </pre>
          )}
        </div>
      )}

      {/* 历史记录面板 */}
      {showHistory && (
        <div className="border-t border-[#1a1a1a] bg-[#0a0a0a] max-h-[400px] overflow-y-auto p-3">
          {history.length === 0 ? (
            <p className="text-[11px] text-rc-text-dim text-center py-4">暂无历史记录</p>
          ) : (
            <div className="space-y-1">
              <div className="text-[11px] text-rc-text-dim mb-2 px-1">
                最近 {history.length} 次执行记录
              </div>
              {history.map((rec, idx) => {
                const b = statusBadge(rec.status);
                return (
                  <div key={idx}>
                    <div
                      className="flex items-center gap-3 px-3 py-2 rounded-[6px] hover:bg-[#111] cursor-pointer transition"
                      onClick={() => loadHistoryLogs(idx)}
                    >
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-rc-mono ${b.cls}`}>
                        {b.text}
                      </span>
                      <span className="text-[11px] font-rc-mono text-rc-text-secondary flex-1">
                        {rec.started_at ? new Date(rec.started_at).toLocaleString("zh-CN") : "-"}
                      </span>
                      {rec.finished_at && rec.started_at && (
                        <span className="text-[10px] font-rc-mono text-rc-text-dim">
                          {Math.round((new Date(rec.finished_at).getTime() - new Date(rec.started_at).getTime()) / 1000)}s
                        </span>
                      )}
                      <span className="text-[10px] font-rc-mono text-rc-text-dim">
                        {rec.log_lines} 行
                      </span>
                      <span className="text-[10px] text-rc-text-dim">
                        {historyLogs?.index === idx ? "▲" : "▼"}
                      </span>
                    </div>
                    {/* 展开历史日志 */}
                    {historyLogs?.index === idx && (
                      <div className="ml-4 mt-1 mb-2 bg-[#050505] rounded-[6px] max-h-[200px] overflow-y-auto p-2">
                        <pre className="text-[10px] font-rc-mono text-rc-text-dim leading-relaxed whitespace-pre-wrap break-all">
                          {historyLogs.logs.map((line, li) => (
                            <div key={li} className={`py-0.5 ${
                              line.includes("ERROR") || line.includes("Traceback") ? "text-rc-red" :
                              line.includes("[OK]") || line.includes("success") ? "text-green-400" : ""
                            }`}>
                              {line}
                            </div>
                          ))}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────
// 例行任务巡检：celery 例行任务状态格点表 + 每日写入量条形图
// 数据源：routine_task_runs / daily_data_metrics（中间表，毫秒级，不扫大表）
// ──────────────────────────────────────────

interface RoutineRun {
  task_name: string;
  run_date: string;
  status: "success" | "failed" | "skipped";
  detail?: Record<string, unknown>;
  duration_sec?: number;
  finished_at?: string;
}

interface DailyMetric {
  date: string;
  metric: string;
  rows_count: number;
  symbols_covered?: number | null;
}

const ROUTINE_TASKS: Array<{ name: string; label: string }> = [
  { name: "feature.update_klines_5m", label: "5m K线" },
  { name: "feature.update_market_snapshots", label: "市场快照" },
  { name: "feature.compute_incremental", label: "因子增量" },
  { name: "feature.collect_daily_metrics", label: "每日汇总" },
  { name: "feature.weekly_recompute", label: "每周回跑" },
];

const METRIC_ROWS: Array<{ metric: string; label: string }> = [
  { metric: "klines_5m", label: "5m K线" },
  { metric: "klines_1d", label: "日 K" },
  { metric: "market_snapshots", label: "快照" },
  { metric: "feature_values", label: "因子值" },
];

const RUN_STATUS_STYLE: Record<string, { bg: string; text: string }> = {
  success: { bg: "bg-emerald-500/70", text: "✓" },
  failed: { bg: "bg-red-500/80", text: "✗" },
  skipped: { bg: "bg-zinc-500/50", text: "⊘" },
};

function fmtRows(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`;
  return String(n);
}

// 例行巡检 API 走同源代理（/svc/data → data-svc），不依赖浏览器所在机器
// （裸 fetch localhost:8006 在远程浏览器里指向用户自己电脑 → 必然失败，手册 ## 0）
const ROUTINE_API = "/svc/data/api/v1/data/admin/data/routine";

// 快捷筛选档位：近 7/14/30/90 天 + 自定义区间
const RANGE_PRESETS = [
  { key: "7", label: "近 7 天" },
  { key: "14", label: "近 14 天" },
  { key: "30", label: "近 30 天" },
  { key: "90", label: "近 90 天" },
] as const;
const CUSTOM_MAX_DAYS = 92; // 自定义区间上限（格点/条形列数可读性）

function RoutineSection({ userId, userRole }: { userId: string; userRole: string }) {
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [collectMsg, setCollectMsg] = useState<string | null>(null);
  // 时间筛选：快捷档位 or 自定义区间
  const [preset, setPreset] = useState<string>("14");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [appliedCustom, setAppliedCustom] = useState<{ start: string; end: string } | null>(null);

  const headers = { "X-User-Id": userId, "X-User-Role": userRole };
  const isCustom = preset === "custom";

  const query = isCustom && appliedCustom
    ? `start=${appliedCustom.start}&end=${appliedCustom.end}`
    : !isCustom
      ? `days=${preset}`
      : null; // custom 未点查询前不拉

  const load = useCallback(async () => {
    if (!query) return;
    setLoading(true);
    try {
      const [runsResp, metricsResp] = await Promise.all([
        fetch(`${ROUTINE_API}/runs?${query}`, { headers }),
        fetch(`${ROUTINE_API}/metrics?${query}`, { headers }),
      ]);
      if (!runsResp.ok || !metricsResp.ok) {
        setFetchError(`HTTP ${runsResp.status}/${metricsResp.status}`);
      } else {
        setRuns((await runsResp.json()).data ?? []);
        setMetrics((await metricsResp.json()).data ?? []);
        setFetchError(null);
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userRole, query]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  // 区间内的日期列表（两个图表共用；快捷档位=近 N 天，自定义=起止区间）
  const dayList: string[] = (() => {
    if (isCustom && appliedCustom) {
      const out: string[] = [];
      const d0 = new Date(`${appliedCustom.start}T00:00:00`);
      const d1 = new Date(`${appliedCustom.end}T00:00:00`);
      for (let d = new Date(d0); d <= d1 && out.length < CUSTOM_MAX_DAYS; d.setDate(d.getDate() + 1)) {
        out.push(d.toISOString().slice(0, 10));
      }
      return out;
    }
    if (isCustom) return [];
    const n = Number(preset);
    const today = new Date();
    return Array.from({ length: n }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (n - 1 - i));
      return d.toISOString().slice(0, 10);
    });
  })();

  const runMap = new Map<string, RoutineRun>();
  // 同一天多次运行时保留最新一次（接口已按 run_date.desc,finished_at.desc 排序）
  for (const r of runs) {
    const k = `${r.task_name}|${r.run_date}`;
    if (!runMap.has(k)) runMap.set(k, r);
  }
  const metricMap = new Map<string, DailyMetric>();
  for (const m of metrics) metricMap.set(`${m.metric}|${m.date}`, m);

  const triggerCollect = async () => {
    setCollecting(true);
    setCollectMsg(null);
    try {
      const resp = await fetch(`${ROUTINE_API}/collect?days=3`, {
        method: "POST",
        headers,
      });
      if (resp.ok) {
        setCollectMsg("已触发汇总（近 3 天），约 1 分钟后自动刷新");
        setTimeout(load, 60_000);
      } else {
        setCollectMsg(`触发失败 HTTP ${resp.status}`);
      }
    } catch {
      setCollectMsg("触发失败（网络错误）");
    } finally {
      setCollecting(false);
    }
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          <h2 className="text-[14px] font-medium text-white">例行任务巡检</h2>
          {/* 时间筛选：快捷档位 + 自定义区间 */}
          <div className="flex items-center gap-1.5 text-[12px]">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.key}
                onClick={() => { setPreset(p.key); setAppliedCustom(null); }}
                className={`px-2 py-1 rounded-[5px] border transition ${
                  preset === p.key
                    ? "border-rc-blue bg-rc-blue/10 text-white"
                    : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={() => setPreset("custom")}
              className={`px-2 py-1 rounded-[5px] border transition ${
                isCustom
                  ? "border-rc-blue bg-rc-blue/10 text-white"
                  : "border-rc-border-subtle text-rc-text-muted hover:border-rc-border-input"
              }`}
            >
              自定义
            </button>
            {isCustom && (
              <span className="flex items-center gap-1 ml-1">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="rc-input !w-[130px] !py-1 text-[11px]"
                />
                <span className="text-rc-text-dim">~</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="rc-input !w-[130px] !py-1 text-[11px]"
                />
                <button
                  onClick={() => {
                    if (customStart && customEnd && customStart <= customEnd) {
                      setAppliedCustom({ start: customStart, end: customEnd });
                    }
                  }}
                  disabled={!customStart || !customEnd || customStart > customEnd}
                  className="px-2 py-1 rounded-[5px] bg-rc-blue text-white text-[11px] disabled:opacity-40"
                >
                  查询
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {collectMsg && <span className="text-[11px] text-rc-text-dim">{collectMsg}</span>}
          <button
            onClick={triggerCollect}
            disabled={collecting}
            className="px-3 py-1.5 rounded-[6px] bg-rc-surface-card border border-rc-border-subtle text-[12px] text-rc-text-secondary hover:text-white transition disabled:opacity-50"
          >
            {collecting ? "触发中…" : "手动汇总"}
          </button>
        </div>
      </div>

      <div className="rc-card p-5 mb-4">
        <div className="text-[12px] text-rc-text-dim mb-3">
          例行任务运行状态（{isCustom && appliedCustom ? `${appliedCustom.start} ~ ${appliedCustom.end}` : `近 ${preset} 天`}，celery beat 每日调度；✓ 成功 / ✗ 失败 / ⊘ 非交易日跳过 / · 未运行）
        </div>
        {isCustom && !appliedCustom ? (
          <div className="text-[12px] text-rc-text-dim py-4 text-center">
            选择起止日期后点「查询」
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="text-[11px]">
            <thead>
              <tr>
                <th className="text-left text-rc-text-dim font-normal pr-4 pb-2">任务</th>
                {dayList.map((d) => (
                  <th key={d} className="text-rc-text-dim font-normal px-0.5 pb-2 text-center">
                    {d.slice(5)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROUTINE_TASKS.map((t) => (
                <tr key={t.name}>
                  <td className="text-rc-text-secondary pr-4 py-0.5 whitespace-nowrap">{t.label}</td>
                  {dayList.map((d) => {
                    const run = runMap.get(`${t.name}|${d}`);
                    const st = run ? RUN_STATUS_STYLE[run.status] : null;
                    return (
                      <td key={d} className="px-0.5 py-0.5 text-center">
                        <span
                          title={
                            run
                              ? `${d} ${run.status}${run.duration_sec != null ? ` · ${run.duration_sec}s` : ""}${
                                  run.detail?.error ? `\n${String(run.detail.error).slice(0, 200)}` : ""
                                }`
                              : `${d} 未运行`
                          }
                          className={`inline-flex items-center justify-center w-5 h-5 rounded-[4px] text-[10px] ${
                            st ? `${st.bg} text-white` : "text-rc-text-dim"
                          }`}
                        >
                          {st ? st.text : "·"}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </div>

      <div className="rc-card p-5">
        <div className="text-[12px] text-rc-text-dim mb-3">
          每日数据写入量（{isCustom && appliedCustom ? `${appliedCustom.start} ~ ${appliedCustom.end}` : `近 ${preset} 天`}，按数据所属日期统计；行内各自归一化，0 = 当天无数据写入——周末/节假日为 0 属正常）
        </div>
        {loading ? (
          <div className="text-[12px] text-rc-text-dim py-6 text-center">加载中…</div>
        ) : fetchError ? (
          <div className="text-[12px] text-rc-red py-6 text-center">
            巡检数据加载失败：{fetchError}
          </div>
        ) : (
          <div className="space-y-2">
            {METRIC_ROWS.map(({ metric, label }) => {
              const values = dayList.map((d) => metricMap.get(`${metric}|${d}`)?.rows_count ?? null);
              const max = Math.max(1, ...values.map((v) => v ?? 0));
              return (
                <div key={metric} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-rc-text-secondary">{label}</span>
                  <div className="flex gap-[2px] flex-1">
                    {dayList.map((d, i) => {
                      const v = values[i];
                      const m = metricMap.get(`${metric}|${d}`);
                      // 对数归一化：log(v+1)/log(max+1)，量小也可见
                      // （线性归一在 281 vs 45万 这类差距下小值几乎隐形）
                      const ratio =
                        v === null || v === 0 ? 0 : Math.log(v + 1) / Math.log(max + 1);
                      // 色阶分档（5 档），深浅随数据量
                      const LEVELS = [0.2, 0.4, 0.6, 0.8, 1];
                      const opacity =
                        v === null
                          ? 0.15
                          : v === 0
                            ? 1
                            : LEVELS[Math.min(LEVELS.length - 1, Math.floor(ratio * LEVELS.length))];
                      return (
                        <div
                          key={d}
                          title={`${d}\n${v === null ? "未采集" : `${v.toLocaleString()} 行${m?.symbols_covered ? ` · ${m.symbols_covered} 只` : ""}`}`}
                          style={{ opacity }}
                          className={`h-5 flex-1 rounded-[2px] ${
                            v === 0 ? "bg-zinc-700" : "bg-rc-blue"
                          }`}
                        />
                      );
                    })}
                  </div>
                  <span className="w-16 shrink-0 text-right text-[10px] font-rc-mono text-rc-text-dim">
                    {(() => {
                      const last = [...values].reverse().find((v) => v !== null);
                      return last === undefined || last === null ? "—" : `${fmtRows(last)}行`;
                    })()}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

// ──────────────────────────────────────────
// 例行化任务：celery beat 调度的任务卡片（依赖检查 / 日志 / 源码 / 手动触发）
// ──────────────────────────────────────────

interface RunDetail {
  precheck?: Array<{ name: string; ok: boolean; detail?: string; hint?: string | null }>;
  summary?: string[];
  errors?: Array<Record<string, unknown>>;
  log_tail?: string;
  error?: string;
  records_written?: number;
  xsec_records?: number;
  reason?: string;
  // 运行参数（每次运行单独落库，回放历史日志时可核对当次口径）
  days?: number;
  start?: string;
  end?: string;
  date_str?: string;
  cmd?: string;
}

interface RoutineLastRun {
  status: "success" | "failed" | "skipped";
  run_date: string;
  duration_sec?: number;
  finished_at?: string;
  detail?: RunDetail;
}

interface RoutineTaskItem {
  name: string;
  label: string;
  cron: string;
  queue: string;
  desc: string;
  precheck_desc: string;
  source: string;
  last_run?: RoutineLastRun | null;
}

const LAST_STATUS_STYLE: Record<string, { cls: string; text: string }> = {
  success: { cls: "bg-emerald-500/15 text-emerald-400", text: "✓ 成功" },
  failed: { cls: "bg-red-500/15 text-red-400", text: "✗ 失败" },
  skipped: { cls: "bg-zinc-500/15 text-zinc-400", text: "⊘ 跳过" },
};

function RoutineTasksSection({ userId, userRole }: { userId: string; userRole: string }) {
  const [items, setItems] = useState<RoutineTaskItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState<"log" | "source">("log");
  const [sourceCache, setSourceCache] = useState<Record<string, { content: string; truncated: boolean }>>({});
  const [triggering, setTriggering] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // 单任务历史运行记录（日志页签按天/按次回放，每次运行含当次参数+日志）
  const [history, setHistory] = useState<Record<string, RoutineLastRun[]>>({});
  const [selRun, setSelRun] = useState<Record<string, number>>({});
  const headers = { "X-User-Id": userId, "X-User-Role": userRole };

  const load = useCallback(async () => {
    try {
      const resp = await fetch(`${ROUTINE_API}/tasks`, { headers });
      if (resp.ok) setItems((await resp.json()).data ?? []);
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userRole]);

  // 打开「日志」页签时拉取该任务近 60 天运行记录（新→旧）
  const loadHistory = useCallback(async (name: string) => {
    try {
      const resp = await fetch(
        `${ROUTINE_API}/runs?days=60&task_name=${encodeURIComponent(name)}`,
        { headers },
      );
      if (resp.ok) {
        const j = await resp.json();
        setHistory((prev) => ({ ...prev, [name]: j.data ?? [] }));
        setSelRun((prev) => ({ ...prev, [name]: 0 }));
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, userRole]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const trigger = async (t: RoutineTaskItem) => {
    setTriggering(t.name);
    setMsg(null);
    try {
      const resp = await fetch(`${ROUTINE_API}/tasks/${encodeURIComponent(t.name)}/trigger`, {
        method: "POST",
        headers,
      });
      setMsg(resp.ok ? `已触发「${t.label}」，稍后自动刷新状态` : `触发失败 HTTP ${resp.status}`);
      setTimeout(() => {
        void load();
        void loadHistory(t.name);
      }, 8000);
    } catch {
      setMsg("触发失败（网络错误）");
    } finally {
      setTriggering(null);
    }
  };

  const openSource = async (t: RoutineTaskItem) => {
    setTab("source");
    if (sourceCache[t.source]) return;
    try {
      const resp = await fetch(
        `${ROUTINE_API}/tasks/source?path=${encodeURIComponent(t.source)}`,
        { headers },
      );
      if (resp.ok) {
        const j = await resp.json();
        setSourceCache((prev) => ({
          ...prev,
          [t.source]: { content: j.data.content, truncated: j.data.truncated },
        }));
      }
    } catch {
      // ignore
    }
  };

  return (
    <section className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[14px] font-medium text-white">例行化任务</h2>
        {msg && <span className="text-[11px] text-rc-text-dim">{msg}</span>}
      </div>
      <div className="space-y-3">
        {items.map((t) => {
          const last = t.last_run;
          const st = last ? LAST_STATUS_STYLE[last.status] : null;
          const isOpen = expanded === t.name;
          // 日志页签：选中某一次历史运行（默认最新一次=last_run 口径一致）
          const runs = history[t.name];
          const sel = Math.min(selRun[t.name] ?? 0, Math.max((runs?.length ?? 1) - 1, 0));
          const cur: RoutineLastRun | null | undefined =
            runs && runs.length > 0 ? runs[sel] : last;
          return (
            <div key={t.name} className="rc-card p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[14px] text-white font-medium">{t.label}</span>
                    <span className="text-[10px] px-2 py-0.5 rounded-full font-rc-mono bg-rc-surface-card border border-rc-border-subtle text-rc-text-dim">
                      {t.cron}
                    </span>
                    {st && last ? (
                      <span className={`text-[11px] px-2 py-0.5 rounded-full font-rc-mono ${st.cls}`}>
                        {st.text}
                        {last.duration_sec != null && ` ${last.duration_sec}s`}
                      </span>
                    ) : (
                      <span className="text-[11px] px-2 py-0.5 rounded-full font-rc-mono bg-zinc-500/10 text-zinc-500">
                        未运行
                      </span>
                    )}
                    {last?.finished_at && (
                      <span className="text-[10px] font-rc-mono text-rc-text-dim">
                        {last.finished_at.slice(5, 16).replace("T", " ")}
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-rc-text-muted mt-1.5 leading-relaxed">{t.desc}</p>
                  <p className="text-[11px] text-rc-text-dim mt-1">
                    <span className="text-rc-text-dim">依赖检查：</span>
                    {t.precheck_desc} · <span className="font-rc-mono">{t.name}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => trigger(t)}
                    disabled={triggering === t.name}
                    className="px-3 py-1.5 rounded-[6px] text-[12px] font-medium bg-rc-blue/10 border border-rc-blue/30 text-rc-blue hover:bg-rc-blue/20 transition disabled:opacity-50"
                  >
                    {triggering === t.name ? "触发中…" : "▶ 执行"}
                  </button>
                  <button
                    onClick={() => {
                      if (isOpen && tab === "log") setExpanded(null);
                      else {
                        setExpanded(t.name);
                        setTab("log");
                        void loadHistory(t.name);
                      }
                    }}
                    className="px-3 py-1.5 rounded-[6px] text-[12px] bg-rc-surface-card border border-rc-border-subtle text-rc-text-secondary hover:text-white transition"
                  >
                    日志
                  </button>
                  <button
                    onClick={() => {
                      if (isOpen && tab === "source") setExpanded(null);
                      else {
                        setExpanded(t.name);
                        openSource(t);
                      }
                    }}
                    className="px-3 py-1.5 rounded-[6px] text-[12px] bg-rc-surface-card border border-rc-border-subtle text-rc-text-secondary hover:text-white transition"
                  >
                    源码
                  </button>
                </div>
              </div>

              {isOpen && (
                <div className="mt-4 border-t border-rc-border-subtle pt-4">
                  {tab === "log" ? (
                    <div className="space-y-3">
                      {/* 历史运行选择：每次运行（参数+日志）单独落库，可按天/按次回放 */}
                      {runs === undefined ? (
                        <div className="text-[11px] text-rc-text-dim">加载运行记录中…</div>
                      ) : runs.length > 0 ? (
                        <div>
                          <div className="text-[11px] text-rc-text-dim mb-1.5">
                            运行记录（近 60 天，点击查看对应一次的参数与日志）
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {runs.map((r, i) => {
                              const rs = LAST_STATUS_STYLE[r.status];
                              const sameDay = runs.some((x) => x !== r && x.run_date === r.run_date);
                              return (
                                <button
                                  key={`${r.run_date}|${r.finished_at ?? i}`}
                                  onClick={() => setSelRun((prev) => ({ ...prev, [t.name]: i }))}
                                  className={`px-2 py-1 rounded-[6px] text-[10px] font-rc-mono border transition ${
                                    i === sel
                                      ? "border-rc-blue/50 bg-rc-blue/15 text-white"
                                      : "border-rc-border-subtle bg-rc-surface-card text-rc-text-dim hover:text-white"
                                  }`}
                                >
                                  {r.run_date.slice(5)}
                                  {sameDay && r.finished_at ? ` ${r.finished_at.slice(11, 16)}` : ""}{" "}
                                  {rs?.text.split(" ")[0] ?? r.status}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                      {cur ? (
                        <>
                          {/* 当次运行状态 / 完成时间 / 耗时 */}
                          <div className="flex items-center gap-2 flex-wrap text-[11px] font-rc-mono">
                            <span className={`px-2 py-0.5 rounded-full ${LAST_STATUS_STYLE[cur.status]?.cls ?? ""}`}>
                              {LAST_STATUS_STYLE[cur.status]?.text ?? cur.status}
                            </span>
                            {cur.finished_at && (
                              <span className="text-rc-text-dim">
                                {cur.finished_at.slice(0, 16).replace("T", " ")}
                              </span>
                            )}
                            {cur.duration_sec != null && (
                              <span className="text-rc-text-dim">{cur.duration_sec}s</span>
                            )}
                          </div>
                          {/* 当次运行参数（核对当次口径） */}
                          {cur.detail &&
                            (cur.detail.cmd ||
                              cur.detail.days != null ||
                              cur.detail.start ||
                              cur.detail.end ||
                              cur.detail.date_str) && (
                              <div className="text-[11px] font-rc-mono text-rc-text-dim">
                                参数：
                                {cur.detail.cmd ??
                                  [
                                    cur.detail.days != null && `days=${cur.detail.days}`,
                                    cur.detail.date_str && `date=${cur.detail.date_str}`,
                                    cur.detail.start && `start=${cur.detail.start}`,
                                    cur.detail.end && `end=${cur.detail.end}`,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                              </div>
                            )}
                          {cur.detail ? (
                            <>
                              {/* 依赖检查结果 */}
                              {cur.detail.precheck && (
                                <div>
                                  <div className="text-[11px] text-rc-text-dim mb-1.5">依赖检查</div>
                                  <div className="space-y-1">
                                    {cur.detail.precheck.map((c, i) => (
                                      <div key={i} className="flex items-start gap-2 text-[11px]">
                                        <span className={c.ok ? "text-emerald-400" : "text-red-400"}>
                                          {c.ok ? "✓" : "✗"}
                                        </span>
                                        <span className="text-rc-text-secondary font-rc-mono">{c.name}</span>
                                        <span className="text-rc-text-dim">{c.detail}</span>
                                        {c.hint && <span className="text-amber-400/90">{c.hint}</span>}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* 摘要/错误 */}
                              {(cur.detail.records_written != null || cur.detail.xsec_records != null) && (
                                <div className="text-[11px] text-rc-text-secondary font-rc-mono">
                                  records_written={cur.detail.records_written ?? "—"}
                                  {cur.detail.xsec_records != null && ` · xsec=${cur.detail.xsec_records}`}
                                </div>
                              )}
                              {cur.detail.summary && cur.detail.summary.length > 0 && (
                                <pre className="text-[11px] font-rc-mono text-rc-text-muted whitespace-pre-wrap">
                                  {cur.detail.summary.join("\n")}
                                </pre>
                              )}
                              {cur.detail.error && (
                                <pre className="text-[11px] font-rc-mono text-red-300 whitespace-pre-wrap">
                                  {cur.detail.error}
                                </pre>
                              )}
                              {cur.detail.errors && cur.detail.errors.length > 0 && (
                                <pre className="text-[11px] font-rc-mono text-red-300/80 whitespace-pre-wrap max-h-40 overflow-auto">
                                  {JSON.stringify(cur.detail.errors, null, 1).slice(0, 3000)}
                                </pre>
                              )}
                              {cur.detail.log_tail && (
                                <div>
                                  <div className="text-[11px] text-rc-text-dim mb-1.5">运行日志</div>
                                  <pre className="text-[10px] font-rc-mono text-zinc-400 whitespace-pre-wrap max-h-64 overflow-auto bg-black/40 rounded p-3">
                                    {cur.detail.log_tail}
                                  </pre>
                                </div>
                              )}
                            </>
                          ) : (
                            <div className="text-[12px] text-rc-text-dim py-3">该次运行无详情</div>
                          )}
                        </>
                      ) : (
                        <div className="text-[12px] text-rc-text-dim py-3">暂无运行记录</div>
                      )}
                    </div>
                  ) : sourceCache[t.source] ? (
                    <div>
                      <div className="text-[11px] text-rc-text-dim mb-1.5 font-rc-mono">
                        {t.source}
                        {sourceCache[t.source].truncated && "（截断显示前 30KB）"}
                      </div>
                      <pre className="text-[10px] font-rc-mono text-zinc-300 whitespace-pre max-h-96 overflow-auto bg-black/40 rounded p-3">
                        {sourceCache[t.source].content}
                      </pre>
                    </div>
                  ) : (
                    <div className="text-[12px] text-rc-text-dim py-3">加载源码中…</div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="text-[12px] text-rc-text-dim py-6 text-center rc-card">加载中…</div>
        )}
      </div>
    </section>
  );
}
