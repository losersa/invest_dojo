"use client";

// ============================================================
// 交易历史列表组件
// ============================================================

import React from "react";
import type { Order } from "@investdojo/core";
import { cn, formatMoney, getPriceColor } from "../lib/utils";

export interface TradeHistoryProps {
  trades: Order[];
  maxItems?: number;
}

export function TradeHistory({ trades, maxItems = 50 }: TradeHistoryProps) {
  const sorted = [...trades]
    .filter((t) => t.status === "filled")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, maxItems);

  return (
    <div className="rounded-lg bg-gray-800/50 border border-gray-700 overflow-hidden">
      <div className="px-4 py-2 border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">📊 交易记录</span>
      </div>
      {sorted.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-gray-500">
          暂无交易记录
        </div>
      ) : (
        <div className="max-h-[400px] overflow-y-auto divide-y divide-gray-700/30">
          {sorted.map((trade) => (
            <div key={trade.id} className="px-4 py-2.5 flex items-center gap-3">
              <span className={cn(
                "text-xs font-bold px-2 py-0.5 rounded",
                trade.direction === "buy"
                  ? "bg-red-500/20 text-red-400"
                  : "bg-green-500/20 text-green-400",
              )}>
                {trade.direction === "buy" ? "买入" : "卖出"}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-sm text-white">{trade.symbolName}</span>
                  <span className="text-xs text-gray-500">{trade.symbol}</span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {trade.orderDate} · {trade.executedQuantity}股 @ ¥{trade.executedPrice?.toFixed(2)}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-mono text-gray-300">
                  {formatMoney((trade.executedPrice ?? 0) * (trade.executedQuantity ?? 0))}
                </div>
                {trade.commission !== undefined && (
                  <div className="text-xs text-gray-600">
                    费用 ¥{((trade.commission ?? 0) + (trade.stampTax ?? 0)).toFixed(2)}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
