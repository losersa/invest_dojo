"use client";

// ============================================================
// 新闻时间线 — Raycast Design System
// ============================================================

import React from "react";
import type { NewsItem } from "@investdojo/core";
import { cn } from "../lib/utils";

export interface NewsTimelineProps {
  news: NewsItem[];
  maxItems?: number;
  onNewsClick?: (news: NewsItem) => void;
}

const sentimentConfig = {
  positive: { dot: "bg-stock-up", label: "利好" },
  negative: { dot: "bg-stock-down", label: "利空" },
  neutral: { dot: "bg-tai-text-tertiary", label: "中性" },
};

const categoryIcons: Record<string, string> = {
  policy: "📜",
  news: "📰",
  announcement: "📢",
};

export function NewsTimeline({ news, maxItems = 20, onNewsClick }: NewsTimelineProps) {
  const sortedNews = [...news]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxItems);

  if (sortedNews.length === 0) {
    return (
      <div className="rc-card p-5">
        <p className="text-[13px] text-rc-text-muted text-center tracking-[0.2px]">暂无新闻</p>
      </div>
    );
  }

  return (
    <div className="rc-card p-0 overflow-hidden">
      <div className="px-5 py-2.5 border-b border-rc-border">
        <span className="text-[10px] font-rc-mono text-rc-text-muted">NEWS</span>
      </div>

      <div className="divide-y divide-tai-border-dark max-h-[400px] overflow-y-auto">
        {sortedNews.map((item) => {
          const config = sentimentConfig[item.sentiment];
          const icon = categoryIcons[item.category] ?? "📰";

          return (
            <button
              key={item.id}
              onClick={() => onNewsClick?.(item)}
              className="w-full px-5 py-3 text-left hover:bg-white/[0.04] transition-all duration-150"
            >
              <div className="flex items-start gap-3">
                {/* Timeline dot */}
                <div className="flex flex-col items-center mt-1.5">
                  <div className={cn("w-2 h-2 rounded-[4px]", config.dot)} />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[12px]">{icon}</span>
                    <span className="text-[11px] text-rc-text-muted font-rc-mono">{item.date}</span>
                    {item.impactLevel >= 3 && (
                      <span className="rc-badge text-[9px] bg-stock-up/[0.12] text-stock-up border-stock-up/[0.15]">HIGH</span>
                    )}
                  </div>
                  <p className="text-[13px] text-white leading-snug line-clamp-2 tracking-[0.2px]">
                    {item.title}
                  </p>
                  <p className="text-[11px] text-rc-text-muted mt-1 truncate tracking-[0.2px]">
                    {item.source}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
