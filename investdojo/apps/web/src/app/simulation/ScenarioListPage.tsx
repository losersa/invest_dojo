"use client";

// ============================================================
// 场景选择页 — Raycast Design System
// Near-black bg + feature cards with warm glow
// ============================================================

import React from "react";
import Link from "next/link";
import type { ScenarioMeta } from "@investdojo/core";
import { UserNav } from "@/components/UserNav";

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
    description: "A股史诗级牛市，从2000到5178。你会在5178点全身而退吗？",
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
    description: "中美贸易战全面升级，A股持续调整。",
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
    description: "宁德时代/比亚迪引领新能源板块大涨。",
    category: "sector_rotation",
    difficulty: "easy",
    dateRange: { start: "2020-07-01", end: "2021-12-31" },
    symbols: ["300750", "002594", "601012"],
    initialCapital: 500000,
    tags: ["新能源", "赛道", "趋势"],
  },
];

const categoryConfig: Record<string, { label: string; icon: string }> = {
  black_swan: { label: "Black Swan", icon: "🦢" },
  bull_market: { label: "Bull Market", icon: "🐂" },
  bear_market: { label: "Bear Market", icon: "🐻" },
  sector_rotation: { label: "Sector Rotation", icon: "🔄" },
  policy_driven: { label: "Policy Driven", icon: "📜" },
};

const difficultyConfig: Record<string, { label: string; color: string }> = {
  easy: { label: "Easy", color: "text-rc-green" },
  medium: { label: "Medium", color: "text-rc-yellow" },
  hard: { label: "Hard", color: "text-rc-red" },
};

export function ScenarioListPage() {
  return (
    <div className="min-h-screen bg-rc-bg">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-rc-bg border-b border-rc-border">
        <div className="max-w-[1200px] mx-auto flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-[20px] font-semibold text-white tracking-[0.2px]">
              InvestDojo
            </Link>
            <span className="text-rc-text-dark">/</span>
            <span className="text-[14px] text-rc-text-muted tracking-[0.2px]">历史模拟</span>
          </div>
          <UserNav />
        </div>
      </nav>

      {/* Hero */}
      <section className="text-center px-6 pt-[80px] pb-[60px]">
        <h1 className="text-section-display text-white">历史情景模拟</h1>
        <p className="mt-4 text-body-lg text-rc-text-secondary max-w-[560px] mx-auto">
          选择一个历史场景，回到关键时刻重新做出投资决策
        </p>
      </section>

      {/* Scenario Cards */}
      <section className="max-w-[1200px] mx-auto px-6 pb-[100px]">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {SCENARIOS.map((scenario) => {
            const cat = categoryConfig[scenario.category];
            const diff = difficultyConfig[scenario.difficulty];
            return (
              <Link
                key={scenario.id}
                href={`/simulation/${scenario.id}`}
                className="group rc-card-feature p-8 transition-all duration-150 hover:translate-y-[-2px]"
              >
                {/* Top row */}
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2.5">
                    <span className="text-xl">{cat?.icon}</span>
                    <span className="rc-badge text-[12px]">{cat?.label}</span>
                  </div>
                  <span className={`text-[12px] font-rc-mono ${diff?.color}`}>
                    {diff?.label}
                  </span>
                </div>

                {/* Title */}
                <h2 className="text-[20px] font-medium text-white mb-2 tracking-[0.2px] group-hover:text-rc-blue transition-colors duration-150">
                  {scenario.name}
                </h2>

                {/* Description */}
                <p className="text-caption text-rc-text-secondary leading-relaxed mb-5 line-clamp-2">
                  {scenario.description}
                </p>

                {/* Meta */}
                <div className="flex items-center gap-5 text-[12px] text-rc-text-muted tracking-[0.2px]">
                  <span>📅 {scenario.dateRange.start} ~ {scenario.dateRange.end}</span>
                  <span>💰 ¥{(scenario.initialCapital / 10000).toFixed(0)}万</span>
                </div>

                {/* Tags */}
                <div className="flex gap-2 mt-4">
                  {scenario.tags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[12px] px-2 py-0.5 rounded-[6px] bg-rc-surface-card text-rc-text-muted border border-rc-border-subtle"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
