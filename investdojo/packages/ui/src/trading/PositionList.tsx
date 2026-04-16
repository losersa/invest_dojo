"use client";

// ============================================================
// 持仓列表 — Raycast Design System
// ============================================================

import React from "react";
import type { Portfolio } from "@investdojo/core";
import { cn, formatMoney, formatPercent, getPriceColor } from "../lib/utils";

export interface PositionListProps {
  portfolio: Portfolio;
  onSelectPosition?: (symbol: string) => void;
  selectedSymbol?: string;
}

export function PositionList({ portfolio, onSelectPosition, selectedSymbol }: PositionListProps) {
  return (
    <div className="rc-card p-0 overflow-hidden">
      {/* Account Overview */}
      <div className="px-5 py-4 border-b border-rc-border">
        <div className="flex justify-between items-center mb-3">
          <span className="text-[10px] text-rc-text-muted font-rc-mono">TOTAL ASSETS</span>
          <span className="text-[20px] font-medium text-white font-mono tracking-[-0.42px]">
            {formatMoney(portfolio.totalAssets)}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] text-rc-text-muted font-rc-mono">P&L</div>
            <div className={cn("text-[13px] font-mono font-medium tracking-[0.2px]", getPriceColor(portfolio.totalProfitLoss))}>
              {formatMoney(portfolio.totalProfitLoss)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-rc-text-muted font-rc-mono">RETURN</div>
            <div className={cn("text-[13px] font-mono font-medium tracking-[0.2px]", getPriceColor(portfolio.totalProfitLossPercent))}>
              {formatPercent(portfolio.totalProfitLossPercent)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-rc-text-muted font-rc-mono">CASH</div>
            <div className="text-[13px] font-mono text-white tracking-[0.2px]">{formatMoney(portfolio.cash)}</div>
          </div>
        </div>
      </div>

      {/* Header */}
      <div className="px-5 py-2 border-b border-rc-border">
        <span className="text-[10px] font-rc-mono text-rc-text-muted">POSITIONS</span>
      </div>

      {/* Position List */}
      {portfolio.positions.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-rc-text-muted tracking-[0.2px]">暂无持仓</p>
        </div>
      ) : (
        <div className="divide-y divide-tai-border-dark">
          {portfolio.positions.map((pos) => (
            <button
              key={pos.symbol}
              onClick={() => onSelectPosition?.(pos.symbol)}
              className={cn(
                "w-full px-5 py-3 text-left transition-all duration-150 hover:bg-white/[0.04]",
                selectedSymbol === pos.symbol && "bg-rc-blue/[0.06] border-l-2 border-rc-blue",
              )}
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-[13px] font-medium text-white tracking-[0.2px]">{pos.symbolName}</div>
                  <div className="text-[11px] text-rc-text-muted mt-0.5 tracking-[0.2px]">
                    {pos.quantity}股 · 成本 ¥{pos.avgCost.toFixed(2)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={cn("text-[13px] font-mono font-medium tracking-[0.2px]", getPriceColor(pos.profitLoss))}>
                    {formatMoney(pos.profitLoss)}
                  </div>
                  <div className={cn("text-[11px] font-mono", getPriceColor(pos.profitLossPercent))}>
                    {formatPercent(pos.profitLossPercent)}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
