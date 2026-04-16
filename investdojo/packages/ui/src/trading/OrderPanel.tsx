"use client";

// ============================================================
// 交易面板 — Raycast Design System
// Sharp 4px/8px geometry + midnight blue surfaces
// ============================================================

import React, { useState, useCallback } from "react";
import type { KLine, Position } from "@investdojo/core";
import { TRADING_RULES } from "@investdojo/core";
import { cn, formatMoney, formatPercent, getPriceColor } from "../lib/utils";

export interface OrderPanelProps {
  symbol: string;
  symbolName: string;
  currentKline: KLine | null;
  position: Position | null;
  availableCash: number;
  onBuy: (symbol: string, symbolName: string, quantity: number) => void;
  onSell: (symbol: string, symbolName: string, quantity: number) => void;
}

export function OrderPanel({
  symbol, symbolName, currentKline, position, availableCash, onBuy, onSell,
}: OrderPanelProps) {
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState<number>(100);

  const currentPrice = currentKline?.close ?? 0;
  const lotSize = TRADING_RULES.LOT_SIZE;
  const maxBuyQuantity = Math.floor(availableCash / currentPrice / lotSize) * lotSize;
  const maxSellQuantity = position?.availableQuantity ?? 0;
  const maxQuantity = direction === "buy" ? maxBuyQuantity : maxSellQuantity;
  const changePercent = currentKline?.changePercent ?? 0;

  const handleSubmit = useCallback(() => {
    if (quantity <= 0 || !currentKline) return;
    if (direction === "buy") onBuy(symbol, symbolName, quantity);
    else onSell(symbol, symbolName, quantity);
  }, [direction, quantity, symbol, symbolName, currentKline, onBuy, onSell]);

  const quickRatios = [
    { label: "1/4", ratio: 0.25 },
    { label: "1/3", ratio: 0.33 },
    { label: "1/2", ratio: 0.5 },
    { label: "ALL", ratio: 1 },
  ];

  const handleQuickRatio = (ratio: number) => {
    setQuantity(Math.max(Math.floor((maxQuantity * ratio) / lotSize) * lotSize, 0));
  };

  if (!currentKline) {
    return (
      <div className="rc-card p-5">
        <p className="text-[13px] text-rc-text-muted tracking-[0.2px]">请选择股票查看交易信息</p>
      </div>
    );
  }

  return (
    <div className="rc-card p-0 overflow-hidden">
      {/* Stock Header */}
      <div className="px-5 py-4 border-b border-rc-border">
        <div className="flex items-baseline gap-2">
          <span className="text-[18px] font-medium text-white tracking-[-0.18px]">{symbolName}</span>
          <span className="text-[11px] text-rc-text-muted font-rc-mono">{symbol}</span>
        </div>
        <div className="flex items-baseline gap-3 mt-1">
          <span className={cn("text-[24px] font-mono font-medium tracking-[-0.42px]", getPriceColor(changePercent))}>
            ¥{currentPrice.toFixed(2)}
          </span>
          <span className={cn("text-[13px] font-mono", getPriceColor(changePercent))}>
            {formatPercent(changePercent)}
          </span>
        </div>
      </div>

      {/* Buy/Sell Toggle — sharp 4px segments */}
      <div className="flex p-1 mx-4 mt-3 bg-rc-surface-card rounded-[6px]">
        <button
          onClick={() => setDirection("buy")}
          className={cn(
            "flex-1 py-1.5 text-[13px] font-medium rounded-[6px] transition-all duration-150 text-center tracking-[0.2px]",
            direction === "buy"
              ? "bg-stock-up text-white"
              : "text-rc-text-secondary hover:text-white",
          )}
        >
          买入
        </button>
        <button
          onClick={() => setDirection("sell")}
          className={cn(
            "flex-1 py-1.5 text-[13px] font-medium rounded-[6px] transition-all duration-150 text-center tracking-[0.2px]",
            direction === "sell"
              ? "bg-stock-down text-white"
              : "text-rc-text-secondary hover:text-white",
          )}
        >
          卖出
        </button>
      </div>

      {/* Order Area */}
      <div className="p-4 space-y-3.5">
        {/* Price */}
        <div>
          <label className="block text-[10px] text-rc-text-muted mb-1 ml-0.5 font-rc-mono">PRICE</label>
          <div className="flex items-center bg-rc-surface-card rounded-[6px] px-3 py-2.5 border border-rc-border">
            <span className="text-[14px] text-white font-mono tracking-[0.2px]">¥{currentPrice.toFixed(2)}</span>
            <span className="ml-auto rc-badge text-[10px]">MARKET</span>
          </div>
        </div>

        {/* Quantity */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-[10px] text-rc-text-muted ml-0.5 font-rc-mono">QUANTITY</label>
            <span className="text-[11px] text-rc-text-muted tracking-[0.2px]">
              可{direction === "buy" ? "买" : "卖"} {maxQuantity}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setQuantity(Math.max(0, quantity - lotSize))}
              className="w-9 h-9 rounded-[6px] bg-rc-surface-card text-rc-text-secondary hover:bg-rc-surface-card flex items-center justify-center text-[16px] transition-all duration-150"
            >
              −
            </button>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Math.max(0, Math.floor(Number(e.target.value) / lotSize) * lotSize))}
              className="flex-1 bg-rc-surface-card border border-rc-border rounded-[6px] px-3 py-2 text-white text-center font-mono text-[14px] tracking-[0.2px] focus:outline-none focus:border-rc-blue transition-all duration-150"
              step={lotSize}
              min={0}
              max={maxQuantity}
            />
            <button
              onClick={() => setQuantity(Math.min(maxQuantity, quantity + lotSize))}
              className="w-9 h-9 rounded-[6px] bg-rc-surface-card text-rc-text-secondary hover:bg-rc-surface-card flex items-center justify-center text-[16px] transition-all duration-150"
            >
              +
            </button>
          </div>
        </div>

        {/* Quick Ratios */}
        <div className="flex gap-1.5">
          {quickRatios.map(({ label, ratio }) => (
            <button
              key={label}
              onClick={() => handleQuickRatio(ratio)}
              className="flex-1 py-1.5 text-[11px] rounded-[6px] bg-white/[0.04] border border-rc-border text-rc-text-secondary hover:bg-white/[0.08] hover:text-white transition-all duration-150 font-rc-mono"
            >
              {label}
            </button>
          ))}
        </div>

        {/* Summary */}
        <div className="space-y-2 pt-1">
          <div className="flex justify-between text-[13px] tracking-[0.2px]">
            <span className="text-rc-text-secondary">预估金额</span>
            <span className="text-white font-mono">{formatMoney(currentPrice * quantity)}</span>
          </div>
          <div className="flex justify-between text-[13px] tracking-[0.2px]">
            <span className="text-rc-text-secondary">可用资金</span>
            <span className="text-white font-mono">{formatMoney(availableCash)}</span>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={quantity <= 0 || quantity > maxQuantity}
          className={cn(
            "w-full py-3 rounded-[6px] text-[15px] font-medium text-white transition-all duration-150 tracking-[0.2px]",
            direction === "buy"
              ? "bg-stock-up hover:opacity-60 disabled:opacity-30"
              : "bg-stock-down hover:opacity-60 disabled:opacity-30",
            "disabled:cursor-not-allowed",
          )}
        >
          {direction === "buy"
            ? `买入 ${symbolName} ${quantity} 股`
            : `卖出 ${symbolName} ${quantity} 股`}
        </button>
      </div>

      {/* Position Info */}
      {position && (
        <div className="px-5 py-3 border-t border-rc-border bg-rc-surface-100">
          <div className="text-[10px] text-rc-text-muted mb-2 font-rc-mono">POSITION</div>
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-[12px] tracking-[0.2px]">
            <div className="flex justify-between">
              <span className="text-rc-text-muted">持仓</span>
              <span className="text-white font-mono">{position.quantity}股</span>
            </div>
            <div className="flex justify-between">
              <span className="text-rc-text-muted">可卖</span>
              <span className="text-white font-mono">{position.availableQuantity}股</span>
            </div>
            <div className="flex justify-between">
              <span className="text-rc-text-muted">成本</span>
              <span className="text-white font-mono">¥{position.avgCost.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-rc-text-muted">盈亏</span>
              <span className={cn("font-mono", getPriceColor(position.profitLoss))}>
                {formatMoney(position.profitLoss)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
