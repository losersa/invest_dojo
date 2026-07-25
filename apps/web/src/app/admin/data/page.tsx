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
import { createClient } from "@/lib/supabase/client";

const DATA_SVC_URL = process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://localhost:10006";

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
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) {
        setUserId(user.id);
        const role = (user.user_metadata?.role as string) || "staff";
        setUserRole(role);
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

        {/* 数据更新任务 */}
        <section>
          <h2 className="text-[14px] font-medium text-white mb-4">数据更新任务</h2>
          <div className="space-y-3">
            {TASKS.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                status={tasks[task.id]}
                onTrigger={() => triggerTask(task.id)}
                userId={userId}
                userRole={userRole}
              />
            ))}
          </div>
        </section>
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

function RoutineSection({ userId, userRole }: { userId: string; userRole: string }) {
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [metrics, setMetrics] = useState<DailyMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [collectMsg, setCollectMsg] = useState<string | null>(null);

  const headers = { "X-User-Id": userId, "X-User-Role": userRole };

  const load = useCallback(async () => {
    try {
      const [runsResp, metricsResp] = await Promise.all([
        fetch(`${ROUTINE_API}/runs?days=14`, { headers }),
        fetch(`${ROUTINE_API}/metrics?days=30`, { headers }),
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
  }, [userId, userRole]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  // ── 状态格点表：近 14 天 × 4 任务 ──
  const RUN_DAYS = 14;
  const today = new Date();
  const dayList: string[] = Array.from({ length: RUN_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (RUN_DAYS - 1 - i));
    return d.toISOString().slice(0, 10);
  });
  const runMap = new Map<string, RoutineRun>();
  for (const r of runs) runMap.set(`${r.task_name}|${r.run_date}`, r);

  // ── 每日写入量：近 30 天 × 4 指标（行内各自归一化）──
  const METRIC_DAYS = 30;
  const metricDays: string[] = Array.from({ length: METRIC_DAYS }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (METRIC_DAYS - 1 - i));
    return d.toISOString().slice(0, 10);
  });
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
        <h2 className="text-[14px] font-medium text-white">例行任务巡检</h2>
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
          例行任务运行状态（近 14 天，celery beat 每日调度；✓ 成功 / ✗ 失败 / ⊘ 非交易日跳过 / · 未运行）
        </div>
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
      </div>

      <div className="rc-card p-5">
        <div className="text-[12px] text-rc-text-dim mb-3">
          每日数据写入量（近 30 天，按数据所属日期统计；行内各自归一化，0 = 当天无数据写入——周末/节假日为 0 属正常）
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
              const values = metricDays.map((d) => metricMap.get(`${metric}|${d}`)?.rows_count ?? null);
              const max = Math.max(1, ...values.map((v) => v ?? 0));
              return (
                <div key={metric} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-[11px] text-rc-text-secondary">{label}</span>
                  <div className="flex gap-[2px] flex-1">
                    {metricDays.map((d, i) => {
                      const v = values[i];
                      const m = metricMap.get(`${metric}|${d}`);
                      const intensity = v === null ? 0 : Math.max(0.12, (v ?? 0) / max);
                      return (
                        <div
                          key={d}
                          title={`${d}\n${v === null ? "未采集" : `${v.toLocaleString()} 行${m?.symbols_covered ? ` · ${m.symbols_covered} 只` : ""}`}`}
                          style={{ opacity: v === null ? 0.15 : intensity }}
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
