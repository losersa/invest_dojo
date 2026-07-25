import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Tailwind className 合并工具 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 格式化金额（中国习惯） */
export function formatMoney(value: number, precision = 2): string {
  const abs = Math.abs(value);
  const formatted = abs >= 100_000_000
    ? `${(abs / 100_000_000).toFixed(2)}亿`
    : abs >= 10_000
      ? `${(abs / 10_000).toFixed(2)}万`
      : abs.toFixed(precision);
  return value < 0 ? `-¥${formatted}` : `¥${formatted}`;
}

/** 格式化百分比 */
export function formatPercent(value: number, precision = 2): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(precision)}%`;
}

/** 涨跌颜色（A 股习惯：涨红跌绿 — Raycast Red/Green） */
export function getPriceColor(value: number): string {
  if (value > 0) return "text-stock-up";
  if (value < 0) return "text-stock-down";
  return "text-stock-flat";
}

/** 涨跌背景色 */
export function getPriceBgColor(value: number): string {
  if (value > 0) return "bg-stock-up-bg";
  if (value < 0) return "bg-stock-down-bg";
  return "bg-rc-surface-100";
}
