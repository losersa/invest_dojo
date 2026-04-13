"use client";

// ============================================================
// 交易面板组件 — 买入 / 卖出 / 快捷下单
// ============================================================

import React, { useState, useCallback } from "react";
import type { KLine, Position } from "@investdojo/core";
import { TRADING_RULES } from "@investdojo/core";
import { cn, formatMoney, formatPercent, getPriceColor } from "../lib/utils";

export interface OrderPanelProps {
  /** 当前选中股票代码 */
  symbol: string;
  /** 股票名称 */
  symbolName: string;
  /** 当日 K 线（获取当前价格） */
  currentKline: KLine | null;
  /** 该股票的持仓信息 */
  position: Position | null;
  /** 可用现金 */
  availableCash: number;
  /** 买入回调 */
  onBuy: (symbol: string, symbolName: string, quantity: number) => void;
  /** 卖出回调 */
  onSell: (symbol: string, symbolName: string, quantity: number) => void;
}

export function OrderPanel({
  symbol,
  symbolName,
  currentKline,
  position,
  availableCash,
  onBuy,
  onSell,
}: OrderPanelProps) {
  const [direction, setDirection] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState<number>(100);

  const currentPrice = currentKline?.close ?? 0;
  const lotSize = TRADING_RULES.LOT_SIZE;

  // 可买数量（最大手数）
  const maxBuyQuantity = Math.floor(availableCash / currentPrice / lotSize) * lotSize;
  // 可卖数量
  const maxSellQuantity = position?.availableQuantity ?? 0;

  const maxQuantity = direction === "buy" ? maxBuyQuantity : maxSellQuantity;

  const handleSubmit = useCallback(() => {
    if (quantity <= 0 || !currentKline) return;
    if (direction === "buy") {
      onBuy(symbol, symbolName, quantity);
    } else {
      onSell(symbol, symbolName, quantity);
    }
  }, [direction, quantity, symbol, symbolName, currentKline, onBuy, onSell]);

  // 快捷比例按钮
  const quickRatios = [
    { label: "1/4", ratio: 0.25 },
    { label: "1/3", ratio: 0.33 },
    { label: "1/2", ratio: 0.5 },
    { label: "全仓", ratio: 1 },
  ];

  const handleQuickRatio = (ratio: number) => {
    const raw = Math.floor((maxQuantity * ratio) / lotSize) * lotSize;
    setQuantity(Math.max(raw, 0));
  };

  if (!currentKline) {
    return (
      <div className="p-4 rounded-lg bg-gray-800/50 border border-gray-700">
        <p className="text-sm text-gray-400">请选择股票查看交易信息</p>
      </div>
    );
  }

  const changePercent = currentKline.changePercent;

  return (
    <div className="rounded-lg bg-gray-800/50 border border-gray-700 overflow-hidden">
      {/* 股票信息头 */}
      <div className="px-4 py-3 border-b border-gray-700">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold text-white">{symbolName}</span>
          <span className="text-sm text-gray-400">{symbol}</span>
        </div>
        <div className="flex items-baseline gap-3 mt-1">
          <span className={cn("text-2xl font-mono font-bold", getPriceColor(changePercent))}>
            ¥{currentPrice.toFixed(2)}
          </span>
          <span className={cn("text-sm font-mono", getPriceColor(changePercent))}>
            {formatPercent(changePercent)}
          </span>
        </div>
      </div>

      {/* 买入/卖出切换 */}
      <div className="flex border-b border-gray-700">
        <button
          onClick={() => setDirection("buy")}
          className={cn(
            "flex-1 py-2 text-center font-medium transition-colors",
            direction === "buy"
              ? "bg-red-500/20 text-red-400 border-b-2 border-red-500"
              : "text-gray-400 hover:text-gray-200",
          )}
        >
          买入
        </button>
        <button
          onClick={() => setDirection("sell")}
          className={cn(
            "flex-1 py-2 text-center font-medium transition-colors",
            direction === "sell"
              ? "bg-green-500/20 text-green-400 border-b-2 border-green-500"
              : "text-gray-400 hover:text-gray-200",
          )}
        >
          卖出
        </button>
      </div>

      {/* 下单区域 */}
      <div className="p-4 space-y-4">
        {/* 委托价格（当前价） */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">委托价格</label>
          <div className="flex items-center bg-gray-900 rounded px-3 py-2 border border-gray-600">
            <span className="text-white font-mono">¥{currentPrice.toFixed(2)}</span>
            <span className="ml-2 text-xs text-gray-500">（市价委托）</span>
          </div>
        </div>

        {/* 委托数量 */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label className="text-xs text-gray-400">
              委托数量<span className="text-gray-500">（最小 {lotSize} 股）</span>
            </label>
            <span className="text-xs text-gray-500">
              可{direction === "buy" ? "买" : "卖"} {maxQuantity} 股
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setQuantity(Math.max(0, quantity - lotSize))}
              className="w-8 h-8 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 flex items-center justify-center"
            >
              −
            </button>
            <input
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Math.max(0, Math.floor(Number(e.target.value) / lotSize) * lotSize))}
              className="flex-1 bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white text-center font-mono"
              step={lotSize}
              min={0}
              max={maxQuantity}
            />
            <button
              onClick={() => setQuantity(Math.min(maxQuantity, quantity + lotSize))}
              className="w-8 h-8 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 flex items-center justify-center"
            >
              +
            </button>
          </div>
        </div>

        {/* 快捷比例 */}
        <div className="flex gap-2">
          {quickRatios.map(({ label, ratio }) => (
            <button
              key={label}
              onClick={() => handleQuickRatio(ratio)}
              className="flex-1 py-1.5 text-xs rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              {label}
            </button>
          ))}
        </div>

        {/* 预估金额 */}
        <div className="flex justify-between text-sm text-gray-400">
          <span>预估金额</span>
          <span className="text-white font-mono">
            {formatMoney(currentPrice * quantity)}
          </span>
        </div>

        {/* 可用资金 */}
        <div className="flex justify-between text-sm text-gray-400">
          <span>可用资金</span>
          <span className="text-white font-mono">{formatMoney(availableCash)}</span>
        </div>

        {/* 下单按钮 */}
        <button
          onClick={handleSubmit}
          disabled={quantity <= 0 || quantity > maxQuantity}
          className={cn(
            "w-full py-3 rounded-lg font-bold text-white transition-all",
            direction === "buy"
              ? "bg-red-500 hover:bg-red-600 disabled:bg-red-500/30"
              : "bg-green-500 hover:bg-green-600 disabled:bg-green-500/30",
            "disabled:cursor-not-allowed disabled:text-gray-500",
          )}
        >
          {direction === "buy"
            ? `买入 ${symbolName} ${quantity} 股`
            : `卖出 ${symbolName} ${quantity} 股`}
        </button>
      </div>

      {/* 持仓信息 */}
      {position && (
        <div className="px-4 py-3 border-t border-gray-700 bg-gray-900/50">
          <div className="text-xs text-gray-400 mb-2">当前持仓</div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500">持仓</span>
              <span className="ml-2 text-white font-mono">{position.quantity}股</span>
            </div>
            <div>
              <span className="text-gray-500">可卖</span>
              <span className="ml-2 text-white font-mono">{position.availableQuantity}股</span>
            </div>
            <div>
              <span className="text-gray-500">成本</span>
              <span className="ml-2 text-white font-mono">¥{position.avgCost.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-gray-500">盈亏</span>
              <span className={cn("ml-2 font-mono", getPriceColor(position.profitLoss))}>
                {formatMoney(position.profitLoss)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
