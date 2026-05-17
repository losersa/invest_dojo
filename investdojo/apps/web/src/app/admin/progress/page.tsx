"use client";

/**
 * 项目进度页面 — 仅内部员工可访问
 *
 * 数据来源：progress-data.json（唯一数据源）
 * 更新方式：只需更新 progress-data.json，页面自动渲染
 *
 * 路由：/admin/progress
 */

import React, { useState } from "react";
import { MainNav } from "@/components/MainNav";
import { useCurrentUser, isStaff } from "@/hooks/useCurrentUser";
import progressData from "./progress-data.json";

// ── 类型定义 ──

type EpicStatus = "done" | "active" | "todo";
type ModuleStatus = "done" | "active" | "partial" | "todo";

interface Epic {
  id: number;
  name: string;
  done: number;
  total: number;
  status: EpicStatus;
}

interface ArchModule {
  name: string;
  layer: "infra" | "backend" | "frontend" | "tooling";
  status: ModuleStatus;
  progress: number;
  desc: string;
  details: string[];
}

interface ProgressEntry {
  date: string;
  highlights: { title: string; items: string[] }[];
  files?: string[];
  status: string;
}

// ── 从 JSON 加载 ──

const EPICS = progressData.epics as Epic[];
const ARCH_MODULES = progressData.modules as ArchModule[];
const PROGRESS_LOG = progressData.log as ProgressEntry[];

// ── 辅助 ──

const LAYER_LABELS: Record<string, string> = {
  infra: "基础设施",
  backend: "后端服务",
  frontend: "前端页面",
  tooling: "工具链",
};

function statusDotCls(s: string) {
  switch (s) {
    case "done": return "bg-green-400";
    case "active": return "bg-blue-400 animate-pulse";
    case "partial": return "bg-yellow-400";
    default: return "bg-[#333]";
  }
}

function barCls(s: string) {
  switch (s) {
    case "done": return "bg-green-500";
    case "active": return "bg-rc-blue";
    case "partial": return "bg-yellow-500";
    default: return "bg-[#333]";
  }
}

function badgeCls(s: string) {
  switch (s) {
    case "done": return "bg-green-900/30 text-green-300";
    case "active": return "bg-blue-900/30 text-blue-300";
    case "partial": return "bg-yellow-900/30 text-yellow-300";
    default: return "bg-[#1a1a1a] text-rc-text-dim";
  }
}

// ═══════════════════════════════════════════════════════════

export default function ProgressPage() {
  const { user } = useCurrentUser();
  const staff = isStaff(user);
  const [expandedDate, setExpandedDate] = useState<string | null>(PROGRESS_LOG[0]?.date ?? null);

  if (!staff) {
    return (
      <div className="min-h-screen bg-rc-bg">
        <MainNav />
        <main className="max-w-[1000px] mx-auto px-6 py-16 text-center">
          <div className="rc-card p-12">
            <h1 className="text-[24px] text-white mb-4">无权限访问</h1>
            <p className="text-rc-text-secondary">此页面仅限内部员工使用。</p>
          </div>
        </main>
      </div>
    );
  }

  const totalDone = EPICS.reduce((s, e) => s + e.done, 0);
  const totalAll = EPICS.reduce((s, e) => s + e.total, 0);
  const overallPct = Math.round((totalDone / totalAll) * 100);

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />
      <main className="max-w-[1000px] mx-auto px-6 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-[24px] font-semibold text-white">项目进度</h1>
          <p className="text-[13px] text-rc-text-secondary mt-1">
            MVP Sprint 0 · 开发日志与里程碑跟踪
          </p>
        </div>

        {/* 总体进度 */}
        <section className="rc-card p-6 mb-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[14px] font-medium text-white">总体进度</h2>
            <span className="text-[20px] font-rc-mono text-rc-blue font-semibold">
              {overallPct}%
            </span>
          </div>
          <div className="h-2 bg-[#1a1a1a] rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-rc-blue rounded-full transition-all"
              style={{ width: `${overallPct}%` }}
            />
          </div>
          <div className="text-[11px] font-rc-mono text-rc-text-dim">
            {totalDone} / {totalAll} 任务完成
          </div>
        </section>

        {/* Epic 进度 */}
        <section className="mb-8">
          <h2 className="text-[14px] font-medium text-white mb-4">Epic 进度</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {EPICS.map((epic) => {
              const pct = epic.total > 0 ? Math.round((epic.done / epic.total) * 100) : 0;
              return (
                <div key={epic.id} className="rc-card p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-2 h-2 rounded-full ${statusDotCls(epic.status)}`} />
                    <span className="text-[12px] font-rc-mono text-rc-text-dim">
                      Epic {epic.id}
                    </span>
                  </div>
                  <div className="text-[13px] text-white font-medium mb-2">{epic.name}</div>
                  <div className="h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden mb-1.5">
                    <div
                      className={`h-full rounded-full transition-all ${barCls(epic.status)}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="text-[10px] font-rc-mono text-rc-text-dim">
                    {epic.done}/{epic.total} · {pct}%
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 架构模块进度 */}
        <section className="mb-8">
          <h2 className="text-[14px] font-medium text-white mb-4">架构模块进度</h2>
          {(["infra", "backend", "frontend", "tooling"] as const).map((layer) => {
            const modules = ARCH_MODULES.filter((m) => m.layer === layer);
            return (
              <div key={layer} className="mb-5">
                <h3 className="text-[12px] font-rc-mono text-rc-text-dim uppercase tracking-wider mb-2">
                  {LAYER_LABELS[layer]}
                </h3>
                <div className="space-y-2">
                  {modules.map((mod) => (
                    <details key={mod.name} className="rc-card overflow-hidden group">
                      <summary className="p-3 flex items-center gap-3 cursor-pointer hover:bg-[#0d0d0d] transition list-none">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${statusDotCls(mod.status)}`} />
                        <span className="text-[13px] text-white font-medium min-w-[120px]">
                          {mod.name}
                        </span>
                        <span className="text-[11px] text-rc-text-dim flex-1 truncate">
                          {mod.desc}
                        </span>
                        <div className="w-[100px] h-1.5 bg-[#1a1a1a] rounded-full overflow-hidden shrink-0">
                          <div
                            className={`h-full rounded-full transition-all ${barCls(mod.status)}`}
                            style={{ width: `${mod.progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-rc-mono text-rc-text-dim w-[36px] text-right shrink-0">
                          {mod.progress}%
                        </span>
                      </summary>
                      <div className="border-t border-[#1a1a1a] px-4 py-3 bg-[#060606]">
                        <ul className="space-y-1">
                          {mod.details.map((d, di) => (
                            <li
                              key={di}
                              className={`text-[11px] pl-3 relative before:absolute before:left-0 before:top-[7px] before:w-1 before:h-1 before:rounded-full ${
                                d.includes("未开始") || d.includes("未完成")
                                  ? "text-rc-text-dim before:bg-[#333]"
                                  : d.includes("完成")
                                  ? "text-green-400/80 before:bg-green-500"
                                  : "text-rc-text-secondary before:bg-rc-text-dim"
                              }`}
                            >
                              {d}
                            </li>
                          ))}
                        </ul>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            );
          })}
        </section>

        {/* 开发日志 */}
        <section>
          <h2 className="text-[14px] font-medium text-white mb-4">开发日志</h2>
          <div className="space-y-2">
            {PROGRESS_LOG.map((entry) => {
              const isExpanded = expandedDate === entry.date;
              const totalItems = entry.highlights.reduce((s, h) => s + h.items.length, 0);
              return (
                <div key={entry.date} className="rc-card overflow-hidden">
                  <button
                    onClick={() => setExpandedDate(isExpanded ? null : entry.date)}
                    className="w-full p-4 flex items-center justify-between text-left hover:bg-[#0d0d0d] transition"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-[13px] font-rc-mono text-rc-blue font-medium">
                        {entry.date}
                      </span>
                      <span className="text-[12px] text-rc-text-secondary">
                        {entry.highlights.map((h) => h.title).join(" · ")}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <span className="text-[10px] font-rc-mono text-rc-text-dim">
                        {totalItems} 项
                      </span>
                      <span className="text-[10px] text-rc-text-dim">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-[#1a1a1a] p-4 bg-[#060606]">
                      {entry.highlights.map((group, gi) => (
                        <div key={gi} className={gi > 0 ? "mt-4" : ""}>
                          <h4 className="text-[12px] text-white font-medium mb-2">
                            {group.title}
                          </h4>
                          <ul className="space-y-1">
                            {group.items.map((item, ii) => (
                              <li
                                key={ii}
                                className="text-[11px] text-rc-text-secondary pl-3 relative before:absolute before:left-0 before:top-[7px] before:w-1 before:h-1 before:rounded-full before:bg-rc-text-dim"
                              >
                                {item}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}

                      {entry.files && entry.files.length > 0 && (
                        <div className="mt-4 pt-3 border-t border-[#151515]">
                          <div className="text-[10px] text-rc-text-dim mb-1.5">涉及文件</div>
                          <div className="flex flex-wrap gap-1.5">
                            {entry.files.map((f, fi) => (
                              <span
                                key={fi}
                                className="text-[10px] font-rc-mono px-1.5 py-0.5 rounded bg-[#111] text-rc-text-dim"
                              >
                                {f}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="mt-3 text-[11px] text-rc-text-dim italic">
                        {entry.status}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
