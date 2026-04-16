"use client";

// ============================================================
// 交易历史 — Raycast Design System
// ============================================================

import React from "react";
import type { Order } from "@investdojo/core";
import { cn, formatMoney } from "../lib/utils";

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
    <div className="rc-card p-0 overflow-hidden">
      <div className="px-5 py-2.5 border-b border-rc-border">
        <span className="text-[10px] font-rc-mono text-rc-text-muted">TRADE HISTORY</span>
      </div>

      {sorted.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-[13px] text-rc-text-muted tracking-[0.2px]">暂无交易记录</p>
        </div>
      ) : (
        <div className="divide-y divide-tai-border-dark max-h-[300px] overflow-y-auto">
          {sorted.map((trade) => (
            <div key={trade.id} className="px-5 py-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-[10px] font-rc-mono px-2 py-0.5 rounded-[6px]",
                      trade.direction === "buy"
                        ? "bg-stock-up/[0.1] text-stock-up"
                        : "bg-stock-down/[0.1] text-stock-down",
                    )}
                  >
                    {trade.direction === "buy" ? "BUY" : "SELL"}
                  </span>
                  <span className="text-[13px] text-white tracking-[0.2px]">{trade.symbolName}</span>
                </div>
                <span className="text-[11px] text-rc-text-muted font-rc-mono">{trade.orderDate}</span>
              </div>
              <div className="flex items-center gap-4 mt-1 text-[12px] text-rc-text-secondary tracking-[0.2px]">
                <span className="font-mono">¥{(trade.executedPrice ?? trade.price).toFixed(2)}</span>
                <span>×</span>
                <span className="font-mono">{trade.executedQuantity ?? trade.quantity}股</span>
                <span className="ml-auto font-mono text-white">
                  {formatMoney((trade.executedPrice ?? trade.price) * (trade.executedQuantity ?? trade.quantity))}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
