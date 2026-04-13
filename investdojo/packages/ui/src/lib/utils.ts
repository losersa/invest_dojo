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

/** 涨跌颜色（中国习惯：涨红跌绿） */
export function getPriceColor(value: number): string {
  if (value > 0) return "text-red-500";
  if (value < 0) return "text-green-500";
  return "text-gray-500";
}

/** 涨跌背景色 */
export function getPriceBgColor(value: number): string {
  if (value > 0) return "bg-red-500/10";
  if (value < 0) return "bg-green-500/10";
  return "bg-gray-500/10";
}
