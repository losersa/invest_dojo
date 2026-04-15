"use client";

// ============================================================
// 场景选择页 — 展示所有可玩场景
// ============================================================

import React from "react";
import Link from "next/link";
import type { ScenarioMeta } from "@investdojo/core";
import { UserNav } from "@/components/UserNav";

// Mock 场景列表（后续从 API 拉取）
const SCENARIOS: ScenarioMeta[] = [
  {
    id: "covid_2020",
    name: "2020 新冠疫情",
    description: "2020年1月-6月，新冠疫情冲击全球市场。你能在恐慌中找到机会吗？",
    category: "black_swan",
    difficulty: "medium",
    dateRange: { start: "2020-01-02", end: "2020-06-30" },
    symbols: ["000001", "600519", "300750"],
    initialCapital: 1000000,
    tags: ["黑天鹅", "疫情", "恐慌"],
  },
  {
    id: "bull_2014",
    name: "2014-2015 疯牛行情",
    description: "2014年下半年到2015年6月，A股史诗级牛市。你会在5178点全身而退吗？",
    category: "bull_market",
    difficulty: "hard",
    dateRange: { start: "2014-07-01", end: "2015-09-30" },
    symbols: ["000001", "601318", "600036"],
    initialCapital: 500000,
    tags: ["牛市", "泡沫", "杠杆"],
  },
  {
    id: "trade_war_2018",
    name: "2018 中美贸易摩擦",
    description: "2018年3月-12月，中美贸易战全面升级，A股持续调整。",
    category: "policy_driven",
    difficulty: "medium",
    dateRange: { start: "2018-03-01", end: "2018-12-31" },
    symbols: ["000001", "600519", "000858"],
    initialCapital: 500000,
    tags: ["贸易战", "政策", "防守"],
  },
  {
    id: "new_energy_2020",
    name: "2020 新能源板块起飞",
    description: "2020年7月-2021年12月，宁德时代/比亚迪引领新能源板块大涨。",
    category: "sector_rotation",
    difficulty: "easy",
    dateRange: { start: "2020-07-01", end: "2021-12-31" },
    symbols: ["300750", "002594", "601012"],
    initialCapital: 500000,
    tags: ["新能源", "赛道", "趋势"],
  },
];

const categoryConfig: Record<string, { label: string; color: string; icon: string }> = {
  black_swan: { label: "黑天鹅", color: "bg-red-500/20 text-red-400", icon: "🦢" },
  bull_market: { label: "牛市", color: "bg-amber-500/20 text-amber-400", icon: "🐂" },
  bear_market: { label: "熊市", color: "bg-green-500/20 text-green-400", icon: "🐻" },
  sector_rotation: { label: "板块轮动", color: "bg-purple-500/20 text-purple-400", icon: "🔄" },
  policy_driven: { label: "政策驱动", color: "bg-blue-500/20 text-blue-400", icon: "📜" },
};

const difficultyConfig: Record<string, { label: string; color: string }> = {
  easy: { label: "简单", color: "text-green-400" },
  medium: { label: "中等", color: "text-amber-400" },
  hard: { label: "困难", color: "text-red-400" },
};

export function ScenarioListPage() {
  return (
    <div className="min-h-screen bg-gray-950">
      {/* 顶部 */}
      <div className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-6xl mx-auto px-4 py-6">
          <div className="flex items-center justify-between mb-2">
            <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
              ← 返回首页
            </Link>
            <UserNav />
          </div>
          <h1 className="text-2xl font-bold text-white">🎮 历史情景模拟</h1>
          <p className="text-sm text-gray-400 mt-1">
            选择一个历史场景，回到关键时刻重新做出投资决策
          </p>
        </div>
      </div>

      {/* 场景列表 */}
      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SCENARIOS.map((scenario) => {
            const cat = categoryConfig[scenario.category];
            const diff = difficultyConfig[scenario.difficulty];
            return (
              <Link
                key={scenario.id}
                href={`/simulation/${scenario.id}`}
                className="group rounded-xl border border-gray-800 bg-gray-900/50 p-6 hover:border-blue-500/40 hover:bg-gray-900 transition-all"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{cat?.icon}</span>
                    <span className={`text-xs px-2 py-0.5 rounded ${cat?.color}`}>
                      {cat?.label}
                    </span>
                  </div>
                  <span className={`text-xs ${diff?.color}`}>
                    {diff?.label}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-white mb-2 group-hover:text-blue-400 transition-colors">
                  {scenario.name}
                </h2>
                <p className="text-sm text-gray-400 mb-4 line-clamp-2">
                  {scenario.description}
                </p>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>📅 {scenario.dateRange.start} ~ {scenario.dateRange.end}</span>
                  <span>💰 ¥{(scenario.initialCapital / 10000).toFixed(0)}万</span>
                </div>
                <div className="flex gap-2 mt-3">
                  {scenario.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-400"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
