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

const DATA_SVC_URL = process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://192.168.1.3:8006";

interface TableInfo {
  table: string;
  label: string;
  count: number;
  latest: string | null;
  error?: string;
}

interface TaskInfo {
  status: "running" | "success" | "failed" | "timeout" | "interrupted";
  label: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  progress: number | null;
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
  { id: "update_klines", label: "增量更新 K 线", desc: "从 BaoStock 拉取最新交易日的 5m K 线" },
  { id: "update_snapshots", label: "更新市场快照", desc: "更新每日市场统计快照" },
  { id: "seed_fundamentals", label: "采集基本面", desc: "采集股票基本面数据（EPS、总股本、ROE 等）" },
  { id: "seed_symbols", label: "同步股票代码", desc: "从 BaoStock 同步最新股票列表" },
  { id: "backfill_factors", label: "回填因子值", desc: "为已发布因子计算并写入 feature_values 缓存" },
];

export default function AdminDataPage() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tasks, setTasks] = useState<Record<string, TaskInfo>>({});
  const [loading, setLoading] = useState(true);
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

  // 加载数据概览
  const loadOverview = useCallback(async () => {
    if (!userId || !userRole) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/overview`, {
        headers: {
          "X-User-Id": userId,
          "X-User-Role": userRole,
        },
      });
      if (resp.status === 403) {
        setUnauthorized(true);
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const json = await resp.json();
      setTables(json.data);
      setTasks(json.tasks || {});
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [userId, userRole]);

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
              className="px-4 py-2 rounded-[8px] bg-rc-surface-card border border-rc-border-subtle text-[13px] text-rc-text-secondary hover:text-white transition"
            >
              刷新
            </button>
          </div>
        </div>

        {error && (
          <div className="rc-card border-rc-red/40 text-rc-red text-[13px] mb-6">
            加载失败：{error}
          </div>
        )}

        {/* 数据概览 */}
        <section className="mb-8">
          <h2 className="text-[14px] font-medium text-white mb-4">数据概览</h2>
          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="rc-card h-[80px] animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {tables.map((t) => (
                <div key={t.table} className="rc-card p-4">
                  <div className="text-[11px] font-rc-mono text-rc-text-dim uppercase tracking-[0.3px]">
                    {t.label}
                  </div>
                  <div className={`text-[20px] font-rc-mono mt-1 ${t.count > 0 ? "text-rc-blue" : "text-rc-text-dim"}`}>
                    {t.count >= 0 ? t.count.toLocaleString() : "ERR"}
                  </div>
                  {t.latest && (
                    <div className="text-[10px] font-rc-mono text-rc-text-dim mt-1">
                      最近：{t.latest.slice(0, 10)}
                    </div>
                  )}
                  {t.count === 0 && (
                    <div className="text-[10px] text-rc-yellow mt-1">无数据</div>
                  )}
                </div>
              ))}
            </div>
          )}
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
  task: { id: string; label: string; desc: string };
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
            {isRunning && elapsed > 0 && (
              <span className="text-[10px] font-rc-mono text-rc-text-dim">
                {elapsed}s
              </span>
            )}
          </div>

          <p className="text-[12px] text-rc-text-dim mt-1">{task.desc}</p>

          {/* 进度条 */}
          {isRunning && progress !== null && progress !== undefined && (
            <div className="mt-2 h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden">
              <div
                className="h-full bg-rc-blue rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
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
