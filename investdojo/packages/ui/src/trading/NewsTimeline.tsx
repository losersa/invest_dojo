"use client";

// ============================================================
// 新闻时间线组件 — 按时间倒序展示新闻/政策/公告
// ============================================================

import React from "react";
import type { NewsItem } from "@investdojo/core";
import { cn } from "../lib/utils";

export interface NewsTimelineProps {
  /** 新闻列表 */
  news: NewsItem[];
  /** 最大显示条数 */
  maxItems?: number;
  /** 点击新闻展开回调 */
  onNewsClick?: (news: NewsItem) => void;
}

export function NewsTimeline({ news, maxItems = 20, onNewsClick }: NewsTimelineProps) {
  // 按日期倒序
  const sortedNews = [...news]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxItems);

  if (sortedNews.length === 0) {
    return (
      <div className="rounded-lg bg-gray-800/50 border border-gray-700 p-4">
        <p className="text-sm text-gray-500 text-center">暂无新闻</p>
      </div>
    );
  }

  // 按日期分组
  const grouped = groupByDate(sortedNews);

  return (
    <div className="rounded-lg bg-gray-800/50 border border-gray-700 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">📰 新闻 & 政策</span>
      </div>
      <div className="max-h-[500px] overflow-y-auto">
        {grouped.map(([date, items]) => (
          <div key={date}>
            {/* 日期分割线 */}
            <div className="sticky top-0 px-4 py-1.5 bg-gray-900/80 backdrop-blur-sm border-b border-gray-700/50">
              <span className="text-xs text-gray-500 font-mono">{date}</span>
            </div>
            {/* 当天新闻 */}
            {items.map((item) => (
              <NewsCard key={item.id} news={item} onClick={() => onNewsClick?.(item)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NewsCard({ news, onClick }: { news: NewsItem; onClick: () => void }) {
  const categoryConfig = {
    news: { label: "新闻", color: "bg-blue-500/20 text-blue-400" },
    policy: { label: "政策", color: "bg-amber-500/20 text-amber-400" },
    announcement: { label: "公告", color: "bg-purple-500/20 text-purple-400" },
  };

  const sentimentConfig = {
    positive: { icon: "📈", color: "border-l-red-500" },
    negative: { icon: "📉", color: "border-l-green-500" },
    neutral: { icon: "📋", color: "border-l-gray-500" },
  };

  const cat = categoryConfig[news.category];
  const sent = sentimentConfig[news.sentiment];

  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full text-left px-4 py-3 border-b border-gray-700/30 border-l-2 hover:bg-gray-700/20 transition-colors",
        sent.color,
      )}
    >
      <div className="flex items-start gap-2">
        <span className="text-base mt-0.5">{sent.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={cn("text-xs px-1.5 py-0.5 rounded", cat.color)}>
              {cat.label}
            </span>
            {news.impactLevel >= 3 && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">
                重大
              </span>
            )}
            <span className="text-xs text-gray-600 ml-auto">{news.source}</span>
          </div>
          <p className="text-sm text-gray-200 leading-relaxed line-clamp-2">
            {news.title}
          </p>
        </div>
      </div>
    </button>
  );
}

// ------ 工具 ------

function groupByDate(news: NewsItem[]): [string, NewsItem[]][] {
  const map = new Map<string, NewsItem[]>();
  for (const item of news) {
    const items = map.get(item.date) ?? [];
    items.push(item);
    map.set(item.date, items);
  }
  return Array.from(map.entries());
}
