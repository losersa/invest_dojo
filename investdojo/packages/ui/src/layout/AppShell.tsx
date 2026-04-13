"use client";

// ============================================================
// 应用外壳 — 响应式布局（手机底部Tab / 桌面侧边栏）
// ============================================================

import React, { type ReactNode } from "react";
import { cn } from "../lib/utils";

export interface AppShellProps {
  children: ReactNode;
  sidebar?: ReactNode;
  header?: ReactNode;
  /** 当前激活的导航项 */
  activeNav?: string;
  /** 导航项点击 */
  onNavChange?: (key: string) => void;
}

const NAV_ITEMS = [
  { key: "simulation", label: "模拟", icon: "🎮" },
  { key: "backtest", label: "回测", icon: "📊" },
  { key: "analysis", label: "财报", icon: "📋" },
  { key: "settings", label: "设置", icon: "⚙️" },
];

export function AppShell({ children, sidebar, header, activeNav, onNavChange }: AppShellProps) {
  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* 顶部 Header (移动端) */}
      {header && (
        <header className="lg:hidden sticky top-0 z-50 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800 px-4 py-3">
          {header}
        </header>
      )}

      <div className="flex">
        {/* 桌面端侧边栏 */}
        <aside className="hidden lg:flex flex-col w-16 xl:w-56 bg-gray-900 border-r border-gray-800 h-screen sticky top-0">
          {/* Logo */}
          <div className="h-14 flex items-center justify-center xl:justify-start xl:px-4 border-b border-gray-800">
            <span className="text-xl">🥋</span>
            <span className="hidden xl:inline ml-2 font-bold text-white">InvestDojo</span>
          </div>
          {/* 导航 */}
          <nav className="flex-1 py-2">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                onClick={() => onNavChange?.(item.key)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 transition-colors",
                  "xl:rounded-lg xl:mx-2 xl:px-3",
                  activeNav === item.key
                    ? "bg-blue-500/10 text-blue-400"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800",
                )}
              >
                <span className="text-xl xl:text-base">{item.icon}</span>
                <span className="hidden xl:inline text-sm">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* 主内容区 */}
        <main className="flex-1 min-w-0 pb-16 lg:pb-0">
          {sidebar ? (
            <div className="flex">
              <div className="flex-1 min-w-0">{children}</div>
              <div className="hidden md:block w-80 xl:w-96 border-l border-gray-800 h-screen sticky top-0 overflow-y-auto">
                {sidebar}
              </div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      {/* 移动端底部 Tab */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-gray-900/95 backdrop-blur-sm border-t border-gray-800 safe-area-bottom">
        <div className="flex">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavChange?.(item.key)}
              className={cn(
                "flex-1 flex flex-col items-center py-2 gap-0.5 transition-colors",
                activeNav === item.key
                  ? "text-blue-400"
                  : "text-gray-500",
              )}
            >
              <span className="text-lg">{item.icon}</span>
              <span className="text-[10px]">{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
