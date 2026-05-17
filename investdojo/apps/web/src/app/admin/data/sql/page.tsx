"use client";

/**
 * SQL 查询工具 — 数据管理后台子页面
 *
 * 左侧：表结构侧边栏（表名 + 展开列信息）
 * 右侧：SQL 编辑器 + 结果表格
 *
 * 路由：/admin/data/sql
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { MainNav } from "@/components/MainNav";
import { useCurrentUser, isStaff } from "@/hooks/useCurrentUser";
import Link from "next/link";

const DATA_SVC_URL = process.env.NEXT_PUBLIC_DATA_SVC_URL ?? "http://192.168.1.3:8006";

interface Column { name: string; type: string; nullable: boolean; default: string | null }
interface TableSchema { name: string; columns: Column[]; row_estimate?: number }
interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; row_count: number; truncated: boolean }

export default function SQLQueryPage() {
  const { user, loading: authLoading } = useCurrentUser();
  const [tables, setTables] = useState<TableSchema[]>([]);
  const [expandedTable, setExpandedTable] = useState<string | null>(null);
  const [sql, setSql] = useState("SELECT code, name, industry\nFROM symbols\nLIMIT 20;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryTime, setQueryTime] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const headers = user ? { "X-User-Id": user.id, "X-User-Role": user.role } : {};

  // 加载表结构
  useEffect(() => {
    if (!user || !isStaff(user)) return;
    fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/schema`, { headers })
      .then((r) => r.json())
      .then((json) => setTables(json.tables || []))
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // 执行查询
  const executeQuery = useCallback(async () => {
    if (!sql.trim() || !user) return;
    setQueryLoading(true);
    setQueryError(null);
    const t0 = performance.now();
    try {
      const resp = await fetch(`${DATA_SVC_URL}/api/v1/data/admin/data/sql`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sql.trim(), limit: 200 }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        throw new Error(json.detail?.error?.message || json.error?.message || `HTTP ${resp.status}`);
      }
      setResult(json);
      setQueryTime(Math.round(performance.now() - t0));
    } catch (e: unknown) {
      setQueryError(e instanceof Error ? e.message : "查询失败");
      setResult(null);
    } finally {
      setQueryLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, user]);

  // Ctrl+Enter 执行
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      executeQuery();
    }
  };

  // 点击表名插入到 SQL
  const insertTableName = (name: string) => {
    const ta = textareaRef.current;
    if (ta) {
      const pos = ta.selectionStart;
      const before = sql.slice(0, pos);
      const after = sql.slice(pos);
      setSql(`${before}${name}${after}`);
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = pos + name.length;
      }, 0);
    }
  };

  // 点击列名插入
  const insertColumnName = (name: string) => {
    const ta = textareaRef.current;
    if (ta) {
      const pos = ta.selectionStart;
      const before = sql.slice(0, pos);
      const after = sql.slice(pos);
      setSql(`${before}${name}${after}`);
      setTimeout(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = pos + name.length;
      }, 0);
    }
  };

  // 快捷模板
  const setTemplate = (tpl: string) => {
    setSql(tpl);
    textareaRef.current?.focus();
  };

  if (authLoading) {
    return <Shell><div className="rc-card h-[300px] animate-pulse" /></Shell>;
  }
  if (!isStaff(user)) {
    return (
      <Shell>
        <div className="rc-card p-12 text-center">
          <h1 className="text-[24px] text-white mb-4">🔒 无权限访问</h1>
          <p className="text-rc-text-secondary">此页面仅限内部员工使用。</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="flex gap-0 h-[calc(100vh-120px)]">
        {/* ── 左侧：表结构侧边栏 ── */}
        <aside className="w-[260px] shrink-0 border-r border-[#1a1a1a] overflow-y-auto pr-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-[12px] uppercase tracking-[0.3px] text-rc-text-dim font-rc-mono">
              数据库表
            </h3>
            <span className="text-[11px] text-rc-text-dim font-rc-mono">{tables.length} 张</span>
          </div>
          <div className="space-y-0.5">
            {tables.map((t) => {
              const isOpen = expandedTable === t.name;
              return (
                <div key={t.name}>
                  <button
                    onClick={() => setExpandedTable(isOpen ? null : t.name)}
                    className={`w-full text-left px-2 py-1.5 rounded-[4px] text-[12px] font-rc-mono flex items-center justify-between transition hover:bg-[#111] ${
                      isOpen ? "bg-[#111] text-white" : "text-rc-text-muted"
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="text-[10px]">{isOpen ? "▼" : "▶"}</span>
                      <span
                        className="cursor-pointer hover:text-rc-blue"
                        onClick={(e) => { e.stopPropagation(); insertTableName(t.name); }}
                        title="点击插入表名"
                      >
                        {t.name}
                      </span>
                    </span>
                    {t.row_estimate !== undefined && (
                      <span className="text-[10px] text-rc-text-dim">
                        ~{t.row_estimate >= 1000000
                          ? `${(t.row_estimate / 1000000).toFixed(1)}M`
                          : t.row_estimate >= 1000
                          ? `${(t.row_estimate / 1000).toFixed(1)}K`
                          : t.row_estimate}
                      </span>
                    )}
                  </button>
                  {isOpen && (
                    <div className="ml-5 mt-1 mb-2 space-y-0.5">
                      {t.columns.map((col) => (
                        <div
                          key={col.name}
                          className="flex items-center gap-2 text-[11px] font-rc-mono py-0.5 px-1 rounded hover:bg-[#0a0a0a] cursor-pointer group"
                          onClick={() => insertColumnName(col.name)}
                          title={`${col.type}${col.nullable ? " (nullable)" : ""}\n点击插入列名`}
                        >
                          <span className="text-rc-text-muted group-hover:text-rc-blue transition">{col.name}</span>
                          <span className="text-[10px] text-[#444]">{col.type}</span>
                          {!col.nullable && <span className="text-[9px] text-rc-yellow">*</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* ── 右侧：SQL 编辑器 + 结果 ── */}
        <div className="flex-1 flex flex-col min-w-0 pl-4">
          {/* 快捷模板 */}
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span className="text-[11px] text-rc-text-dim">快捷：</span>
            {[
              { label: "股票列表", sql: "SELECT code, name, industry, listed_at\nFROM symbols\nLIMIT 30;" },
              { label: "K线采样", sql: "SELECT symbol, dt, open, close, volume\nFROM klines_all\nWHERE symbol = '600519'\nORDER BY dt DESC\nLIMIT 20;" },
              { label: "因子定义", sql: "SELECT id, name, category, formula, owner, visibility\nFROM factor_definitions\nORDER BY updated_at DESC\nLIMIT 30;" },
              { label: "市场快照", sql: "SELECT *\nFROM market_snapshots\nORDER BY date DESC\nLIMIT 10;" },
              { label: "用户列表", sql: "SELECT id, email, raw_user_meta_data->>'role' as role,\n       raw_user_meta_data->>'display_name' as name,\n       created_at\nFROM auth.users\nORDER BY created_at DESC;" },
              { label: "表大小", sql: "SELECT relname as table_name,\n       n_live_tup as row_count,\n       pg_size_pretty(pg_total_relation_size(relid)) as total_size\nFROM pg_stat_user_tables\nWHERE schemaname = 'public'\nORDER BY n_live_tup DESC;" },
            ].map((tpl) => (
              <button
                key={tpl.label}
                onClick={() => setTemplate(tpl.sql)}
                className="px-2 py-0.5 text-[11px] rounded bg-[#111] border border-[#222] text-rc-text-muted hover:text-white hover:border-rc-blue/30 transition"
              >
                {tpl.label}
              </button>
            ))}
          </div>

          {/* SQL 输入 */}
          <div className="relative mb-3">
            <textarea
              ref={textareaRef}
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={6}
              className="w-full bg-[#0a0a0a] border border-[#222] rounded-[8px] px-4 py-3 text-[13px] font-rc-mono text-rc-text-primary focus:outline-none focus:border-rc-blue resize-y"
              placeholder="输入 SELECT 查询..."
              spellCheck={false}
            />
            <div className="absolute bottom-2 right-2 flex items-center gap-2">
              <span className="text-[10px] text-rc-text-dim">Ctrl+Enter 执行</span>
              <button
                onClick={executeQuery}
                disabled={queryLoading || !sql.trim()}
                className="px-3 py-1 rounded-[6px] text-[12px] font-medium bg-rc-blue/10 border border-rc-blue/30 text-rc-blue hover:bg-rc-blue/20 transition disabled:opacity-40"
              >
                {queryLoading ? "查询中..." : "▶ 执行"}
              </button>
            </div>
          </div>

          {/* 错误信息 */}
          {queryError && (
            <div className="mb-3 px-4 py-3 rounded-[8px] bg-red-900/10 border border-red-700/30 text-[12px] font-rc-mono text-red-300">
              {queryError}
            </div>
          )}

          {/* 结果表格 */}
          {result && (
            <div className="flex-1 overflow-hidden flex flex-col">
              <div className="flex items-center gap-3 mb-2 text-[11px] font-rc-mono text-rc-text-dim">
                <span>{result.row_count} 行</span>
                <span>·</span>
                <span>{result.columns.length} 列</span>
                <span>·</span>
                <span>{queryTime}ms</span>
                {result.truncated && (
                  <span className="text-rc-yellow">（结果已截断）</span>
                )}
              </div>
              <div className="flex-1 overflow-auto border border-[#1a1a1a] rounded-[8px]">
                <table className="w-full border-collapse text-[12px] font-rc-mono">
                  <thead className="sticky top-0 bg-[#111] z-10">
                    <tr>
                      <th className="px-3 py-2 text-left text-rc-text-dim font-normal border-b border-[#222] w-[40px]">#</th>
                      {result.columns.map((col) => (
                        <th key={col} className="px-3 py-2 text-left text-rc-text-dim font-normal border-b border-[#222] whitespace-nowrap">
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} className="hover:bg-[#0a0a0a] transition-colors">
                        <td className="px-3 py-1.5 text-[#444] border-b border-[#111]">{i + 1}</td>
                        {result.columns.map((col) => {
                          const val = row[col];
                          const display = val === null ? "NULL" : String(val);
                          const isNull = val === null;
                          const isNum = typeof val === "number";
                          return (
                            <td
                              key={col}
                              className={`px-3 py-1.5 border-b border-[#111] max-w-[300px] truncate ${
                                isNull ? "text-[#444] italic" : isNum ? "text-rc-blue" : "text-rc-text-primary"
                              }`}
                              title={display}
                            >
                              {display}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!result && !queryError && (
            <div className="flex-1 flex items-center justify-center text-rc-text-dim text-[13px]">
              输入 SQL 查询并按 Ctrl+Enter 执行
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />
      <main className="max-w-[1400px] mx-auto px-6 py-4">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/admin/data" className="text-[13px] text-rc-text-dim hover:text-white transition">
            ← 数据管理
          </Link>
          <span className="text-[13px] text-[#333]">/</span>
          <h1 className="text-[18px] font-semibold text-white">SQL 查询工具</h1>
        </div>
        {children}
      </main>
    </div>
  );
}
