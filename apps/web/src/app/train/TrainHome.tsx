"use client";

// ============================================================
// 模型训练首页 — 按「预测目标股票」分模块
// 每个模块 = 一只预测目标股票（或全市场面板），聚合该目标下的训练任务。
// 点击模块 → 跳转训练页（/train?target=CODE），预测目标锁定、最近任务只看该目标。
// ============================================================

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { TrainingTargetGroup } from "@investdojo/api";
import { sdk, ensureUserId } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";

interface SymbolMeta {
  code: string;
  name?: string;
  industry?: string;
}

export function TrainHome() {
  const router = useRouter();
  const [groups, setGroups] = useState<TrainingTargetGroup[]>([]);
  const [names, setNames] = useState<Record<string, SymbolMeta>>({});
  const [loading, setLoading] = useState(true);
  const [codeInput, setCodeInput] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureUserId();
        const res = await sdk.training.listTargets();
        if (!alive) return;
        setGroups(res.data ?? []);
      } catch {
        if (alive) setGroups([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 拉取目标股票名称（分模块卡片展示）
  const codes = useMemo(
    () => groups.map((g) => g.target_symbol).filter((c): c is string => !!c),
    [groups],
  );
  useEffect(() => {
    if (codes.length === 0) return;
    let alive = true;
    (async () => {
      const entries = await Promise.all(
        codes.map(async (code) => {
          try {
            const res = await sdk.data.getSymbol(code);
            const s = res.data;
            return [code, { code, name: s.name, industry: s.industry ?? undefined }] as const;
          } catch {
            return [code, { code }] as const;
          }
        }),
      );
      if (!alive) return;
      setNames(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [codes]);

  const namedGroups = groups.filter((g) => g.target_symbol);
  const panelGroup = groups.find((g) => g.target_symbol === null);

  const goCode = () => {
    const code = codeInput.trim();
    if (/^\d{6}$/.test(code)) router.push(`/train?target=${code}`);
  };

  return (
    <div className="min-h-screen bg-rc-bg">
      <MainNav />

      <section className="text-center px-6 pt-[60px] pb-[30px]">
        <h1 className="text-section-display text-white">模型训练</h1>
        <p className="mt-3 text-body-lg text-rc-text-secondary max-w-[680px] mx-auto">
          按「预测目标股票」分模块管理训练。选择一个目标进入训练页，
          该目标下的历史任务与参数会自动归拢，点任务即可复用参数。
        </p>
      </section>

      {/* 新建目标 / 快捷入口 */}
      <section className="max-w-[1200px] mx-auto px-6 pb-6">
        <div className="rc-card flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <input
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goCode()}
              placeholder="输入 6 位股票代码新建目标，如 600519"
              className="rc-input w-[280px] font-rc-mono text-[13px]"
            />
            <button
              onClick={goCode}
              className="px-4 py-2 rounded-[8px] bg-white text-black text-[13px] font-medium hover:bg-[#ddd] transition"
            >
              进入训练
            </button>
          </div>
          <div className="flex gap-2">
            <Link
              href="/train?target=new"
              className="px-4 py-2 rounded-[8px] border border-rc-border-input text-rc-text-secondary text-[13px] hover:border-rc-blue hover:text-rc-blue transition"
            >
              ＋ 新建训练目标
            </Link>
            <Link
              href="/train?target=__all__"
              className="px-4 py-2 rounded-[8px] border border-rc-border-input text-rc-text-secondary text-[13px] hover:border-rc-blue hover:text-rc-blue transition"
            >
              全市场面板训练
            </Link>
          </div>
        </div>
      </section>

      <section className="max-w-[1200px] mx-auto px-6 pb-[100px]">
        {loading ? (
          <div className="text-[13px] text-rc-text-dim py-16 text-center">加载训练模块…</div>
        ) : namedGroups.length === 0 && !panelGroup ? (
          <div className="rc-card text-center py-16">
            <div className="text-[15px] text-rc-text-secondary">还没有任何训练任务</div>
            <div className="text-[13px] text-rc-text-dim mt-2">
              在上方输入目标股票代码，或点「全市场面板训练」开始你的第一次训练。
            </div>
          </div>
        ) : (
          <>
            {namedGroups.length > 0 && (
              <>
                <h2 className="text-[15px] font-medium text-white mb-3">按预测目标股票</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                  {namedGroups.map((g) => (
                    <TargetCard
                      key={g.target_symbol}
                      group={g}
                      meta={names[g.target_symbol!]}
                      onClick={() => router.push(`/train?target=${g.target_symbol}`)}
                    />
                  ))}
                </div>
              </>
            )}

            {panelGroup && (
              <>
                <h2 className="text-[15px] font-medium text-white mb-3">全市场面板</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  <TargetCard
                    group={panelGroup}
                    onClick={() => router.push("/train?target=__all__")}
                  />
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function TargetCard({
  group,
  meta,
  onClick,
}: {
  group: TrainingTargetGroup;
  meta?: SymbolMeta;
  onClick: () => void;
}) {
  const isPanel = group.target_symbol === null;
  const title = isPanel ? "全市场面板" : (meta?.name ?? group.target_symbol);
  return (
    <button
      onClick={onClick}
      className="rc-card text-left hover:border-rc-blue transition group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[16px] font-medium text-white truncate group-hover:text-rc-blue transition">
            {title}
          </div>
          <div className="text-[12px] font-rc-mono text-rc-text-dim mt-0.5">
            {isPanel ? "不指定目标股 · 各自预测" : group.target_symbol}
            {meta?.industry ? ` · ${meta.industry}` : ""}
          </div>
        </div>
        {group.latest_status && <StatusBadge status={group.latest_status} />}
      </div>

      <div className="flex items-center gap-4 mt-4 text-[12px]">
        <div>
          <span className="text-rc-text-dim">任务</span>
          <span className="ml-1.5 font-rc-mono text-white">{group.job_count}</span>
        </div>
        <div>
          <span className="text-rc-text-dim">已完成</span>
          <span className="ml-1.5 font-rc-mono text-green-400">{group.completed_count}</span>
        </div>
        {group.latest_target && (
          <div className="ml-auto font-rc-mono text-rc-text-muted">{group.latest_target}</div>
        )}
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-900/20 text-yellow-400 border-yellow-700/30",
    running: "bg-blue-900/20 text-blue-400 border-blue-700/30",
    completed: "bg-green-900/20 text-green-400 border-green-700/30",
    failed: "bg-red-900/20 text-red-400 border-red-700/30",
    cancelled: "bg-gray-800/40 text-gray-400 border-gray-700/40",
  };
  return (
    <span
      className={`shrink-0 px-2 py-0.5 rounded-[5px] border text-[11px] font-rc-mono ${
        map[status] ?? "bg-gray-800/40 text-gray-400 border-gray-700/40"
      }`}
    >
      {status}
    </span>
  );
}
