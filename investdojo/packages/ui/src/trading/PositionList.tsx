"use client";

// ============================================================
// 持仓列表组件 — 展示所有持仓、浮盈亏、账户概览
// ============================================================

import React from "react";
import type { Portfolio, Position } from "@investdojo/core";
import { cn, formatMoney, formatPercent, getPriceColor, getPriceBgColor } from "../lib/utils";

export interface PositionListProps {
  portfolio: Portfolio;
  onSelectPosition?: (symbol: string) => void;
  selectedSymbol?: string;
}

export function PositionList({ portfolio, onSelectPosition, selectedSymbol }: PositionListProps) {
  return (
    <div className="rounded-lg bg-gray-800/50 border border-gray-700 overflow-hidden">
      {/* 账户概览 */}
      <div className="px-4 py-3 border-b border-gray-700">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-gray-400">总资产</span>
          <span className="text-xl font-bold text-white font-mono">
            {formatMoney(portfolio.totalAssets)}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-gray-500">总盈亏</div>
            <div className={cn("text-sm font-mono font-medium", getPriceColor(portfolio.totalProfitLoss))}>
              {formatMoney(portfolio.totalProfitLoss)}
            </div>
            <div className={cn("text-xs font-mono", getPriceColor(portfolio.totalProfitLossPercent))}>
              {formatPercent(portfolio.totalProfitLossPercent)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">持仓市值</div>
            <div className="text-sm font-mono text-white">{formatMoney(portfolio.totalMarketValue)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">可用现金</div>
            <div className="text-sm font-mono text-white">{formatMoney(portfolio.cash)}</div>
          </div>
        </div>
      </div>

      {/* 持仓列表 */}
      <div>
        {portfolio.positions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-500">
            暂无持仓，点击「买入」开始交易
          </div>
        ) : (
          portfolio.positions.map((pos) => (
            <PositionRow
              key={pos.symbol}
              position={pos}
              isSelected={pos.symbol === selectedSymbol}
              onClick={() => onSelectPosition?.(pos.symbol)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PositionRow({
  position,
  isSelected,
  onClick,
}: {
  position: Position;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full px-4 py-3 flex items-center justify-between border-b border-gray-700/50 transition-colors text-left",
        isSelected ? "bg-blue-500/10" : "hover:bg-gray-700/30",
      )}
    >
      <div className="flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-white">{position.symbolName}</span>
          <span className="text-xs text-gray-500">{position.symbol}</span>
        </div>
        <div className="flex gap-4 mt-1 text-xs text-gray-400">
          <span>持仓 {position.quantity}股</span>
          <span>成本 ¥{position.avgCost.toFixed(2)}</span>
        </div>
      </div>
      <div className="text-right">
        <div className={cn("text-sm font-mono font-medium", getPriceColor(position.profitLoss))}>
          {formatMoney(position.profitLoss)}
        </div>
        <div className={cn(
          "text-xs font-mono px-1.5 py-0.5 rounded mt-0.5 inline-block",
          getPriceBgColor(position.profitLossPercent),
          getPriceColor(position.profitLossPercent),
        )}>
          {formatPercent(position.profitLossPercent)}
        </div>
      </div>
    </button>
  );
}
