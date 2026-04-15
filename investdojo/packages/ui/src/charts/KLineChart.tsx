"use client";

// ============================================================
// K 线图组件 — 基于 TradingView Lightweight Charts
// 支持：多时间周期、技术指标、最高最低标记、副图面板
// ============================================================

import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type LineData,
  type HistogramData,
  ColorType,
  CrosshairMode,
} from "lightweight-charts";
import type { KLine, NewsItem } from "@investdojo/core";

// ============ 类型定义 ============

export type TimeFrame = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w" | "1M";

export type MainIndicator = "MA" | "EMA" | "BOLL" | "NONE";

export type SubIndicator = "VOL" | "MACD" | "KDJ" | "RSI";

export interface KLineChartProps {
  klines: KLine[];
  news?: NewsItem[];
  height?: number;
  currentDate?: string;
  darkMode?: boolean;
  /** 当前选择的时间周期 */
  timeFrame?: TimeFrame;
  /** 可用的时间周期列表 */
  availableTimeFrames?: TimeFrame[];
  /** 时间周期变更回调 */
  onTimeFrameChange?: (tf: TimeFrame) => void;
  onKlineClick?: (kline: KLine) => void;
}

// ============ 时间周期配置 ============

const TIME_FRAME_LABELS: Record<TimeFrame, string> = {
  "1m": "1分",
  "5m": "5分",
  "15m": "15分",
  "1h": "1时",
  "4h": "4时",
  "1d": "日K",
  "1w": "周K",
  "1M": "月K",
};

// ============ 指标计算 ============

/** 将 kline.date 转为 Lightweight Charts Time
 *  日级："2020-01-02" → 直接用字符串
 *  分钟级："1577947500" → 转为 number
 *  也支持传入 number 类型（已经是 Unix 秒数）
 */
function toChartTime(dateInput: string | number): Time {
  if (typeof dateInput === "number") {
    return dateInput as unknown as Time;
  }
  // 如果全是数字字符串，认为是 Unix 秒数
  if (/^\d+$/.test(dateInput)) {
    return Number(dateInput) as unknown as Time;
  }
  return dateInput as Time;
}

/** 判断当前 klines 是否为分钟级数据（date 字段是 Unix 秒数） */
function isMinuteData(klines: KLine[]): boolean {
  if (klines.length === 0) return false;
  return /^\d{9,}$/.test(String(klines[0].date));
}

/** 排序 markers — 同时兼容 string 和 number 类型的 time */
function compareTime(a: Time, b: Time): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/** 从 Unix 秒数提取日期 "YYYY-MM-DD" */
function unixToDate(unix: string | number): string {
  const ts = typeof unix === "number" ? unix : Number(unix);
  const d = new Date(ts * 1000);
  return d.toISOString().slice(0, 10);
}

function calcMA(klines: KLine[], period: number): LineData[] {
  const result: LineData[] = [];
  for (let i = period - 1; i < klines.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += klines[j].close;
    result.push({ time: toChartTime(klines[i].date), value: round(sum / period) });
  }
  return result;
}

function calcEMA(klines: KLine[], period: number): LineData[] {
  if (klines.length === 0) return [];
  const result: LineData[] = [];
  const multiplier = 2 / (period + 1);
  let ema = klines[0].close;
  result.push({ time: toChartTime(klines[0].date), value: round(ema) });
  for (let i = 1; i < klines.length; i++) {
    ema = (klines[i].close - ema) * multiplier + ema;
    result.push({ time: toChartTime(klines[i].date), value: round(ema) });
  }
  return result;
}

function calcBOLL(klines: KLine[], period = 20, multiplier = 2): { upper: LineData[]; mid: LineData[]; lower: LineData[] } {
  const upper: LineData[] = [];
  const mid: LineData[] = [];
  const lower: LineData[] = [];
  for (let i = period - 1; i < klines.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += klines[j].close;
    const ma = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (klines[j].close - ma) ** 2;
    const std = Math.sqrt(variance / period);
    const t = toChartTime(klines[i].date);
    mid.push({ time: t, value: round(ma) });
    upper.push({ time: t, value: round(ma + multiplier * std) });
    lower.push({ time: t, value: round(ma - multiplier * std) });
  }
  return { upper, mid, lower };
}

function calcMACD(klines: KLine[], fast = 12, slow = 26, signal = 9) {
  if (klines.length === 0) return { dif: [], dea: [], histogram: [] };
  const emaFast = calcEMAValues(klines.map((k) => k.close), fast);
  const emaSlow = calcEMAValues(klines.map((k) => k.close), slow);
  const dif: number[] = emaFast.map((v, i) => v - emaSlow[i]);
  const dea = calcEMAValues(dif, signal);
  const difLine: LineData[] = [];
  const deaLine: LineData[] = [];
  const hist: HistogramData[] = [];
  for (let i = 0; i < klines.length; i++) {
    const t = toChartTime(klines[i].date);
    difLine.push({ time: t, value: round(dif[i], 4) });
    deaLine.push({ time: t, value: round(dea[i], 4) });
    const bar = 2 * (dif[i] - dea[i]);
    hist.push({ time: t, value: round(bar, 4), color: bar >= 0 ? "rgba(239,68,68,0.7)" : "rgba(34,197,94,0.7)" });
  }
  return { dif: difLine, dea: deaLine, histogram: hist };
}

function calcKDJ(klines: KLine[], period = 9, kSmooth = 3, dSmooth = 3) {
  const kLine: LineData[] = [];
  const dLine: LineData[] = [];
  const jLine: LineData[] = [];
  let k = 50, d = 50;
  for (let i = 0; i < klines.length; i++) {
    const start = Math.max(0, i - period + 1);
    let high = -Infinity, low = Infinity;
    for (let j = start; j <= i; j++) {
      if (klines[j].high > high) high = klines[j].high;
      if (klines[j].low < low) low = klines[j].low;
    }
    const rsv = high === low ? 50 : ((klines[i].close - low) / (high - low)) * 100;
    k = ((kSmooth - 1) * k + rsv) / kSmooth;
    d = ((dSmooth - 1) * d + k) / dSmooth;
    const j = 3 * k - 2 * d;
    const t = toChartTime(klines[i].date);
    kLine.push({ time: t, value: round(k) });
    dLine.push({ time: t, value: round(d) });
    jLine.push({ time: t, value: round(j) });
  }
  return { k: kLine, d: dLine, j: jLine };
}

function calcRSI(klines: KLine[], period = 14): LineData[] {
  if (klines.length < 2) return [];
  const result: LineData[] = [];
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= Math.min(period, klines.length - 1); i++) {
    const change = klines[i].close - klines[i - 1].close;
    if (change > 0) avgGain += change; else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;
  if (period < klines.length) {
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: toChartTime(klines[period].date), value: round(100 - 100 / (1 + rs)) });
  }
  for (let i = period + 1; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? -change : 0)) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    result.push({ time: toChartTime(klines[i].date), value: round(100 - 100 / (1 + rs)) });
  }
  return result;
}

function calcEMAValues(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const result: number[] = [data[0]];
  const m = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) result.push((data[i] - result[i - 1]) * m + result[i - 1]);
  return result;
}

function round(v: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/** 找到可见 K 线中的最高最低价 */
function findHighLow(klines: KLine[]): { high: KLine | null; low: KLine | null } {
  if (klines.length === 0) return { high: null, low: null };
  let high = klines[0], low = klines[0];
  for (const k of klines) {
    if (k.high > high.high) high = k;
    if (k.low < low.low) low = k;
  }
  return { high, low };
}

/** 聚合 K 线到周/月级别 */
function aggregateKlines(klines: KLine[], period: "1w" | "1M"): KLine[] {
  if (klines.length === 0) return [];
  const groups: Map<string, KLine[]> = new Map();
  for (const k of klines) {
    let key: string;
    if (period === "1w") {
      const d = new Date(k.date);
      const day = d.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(d.getTime() + mondayOffset * 86400000);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = k.date.slice(0, 7) + "-01";
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(k);
  }
  const result: KLine[] = [];
  for (const [key, arr] of groups) {
    result.push({
      date: key,
      open: arr[0].open,
      high: Math.max(...arr.map((a) => a.high)),
      low: Math.min(...arr.map((a) => a.low)),
      close: arr[arr.length - 1].close,
      volume: arr.reduce((s, a) => s + a.volume, 0),
      turnover: arr.reduce((s, a) => s + a.turnover, 0),
      preClose: arr[0].preClose,
      change: arr[arr.length - 1].close - arr[0].open,
      changePercent: round(((arr[arr.length - 1].close - arr[0].open) / arr[0].open) * 100),
    });
  }
  return result;
}

// ============ 组件 ============

export function KLineChart({
  klines: rawKlines,
  news = [],
  height = 400,
  currentDate,
  darkMode = true,
  timeFrame = "1d",
  availableTimeFrames = ["1d", "1w", "1M"],
  onTimeFrameChange,
  onKlineClick,
}: KLineChartProps) {
  const mainChartRef = useRef<HTMLDivElement>(null);
  const subChartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<IChartApi | null>(null);
  const subChartApiRef = useRef<IChartApi | null>(null);

  const [mainIndicator, setMainIndicator] = useState<MainIndicator>("MA");
  const [subIndicator, setSubIndicator] = useState<SubIndicator>("VOL");
  const [maParams] = useState({ ma5: true, ma10: true, ma20: true, ma60: false });
  const [emaParams] = useState({ ema12: true, ema26: true });

  // 根据时间周期聚合数据（只处理周K和月K，分钟级聚合由外部完成）
  const klines = useMemo(() => {
    if (timeFrame === "1w" || timeFrame === "1M") {
      return aggregateKlines(rawKlines, timeFrame);
    }
    return rawKlines;
  }, [rawKlines, timeFrame]);

  // 最高最低标记
  const { high: highPoint, low: lowPoint } = useMemo(() => findHighLow(klines), [klines]);

  // ==================== 主图 ====================
  useEffect(() => {
    if (!mainChartRef.current) return;

    const chart = createChart(mainChartRef.current, {
      width: mainChartRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: darkMode ? "#0f0f1a" : "#ffffff" },
        textColor: darkMode ? "#9ca3af" : "#374151",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: darkMode ? "#1f1f35" : "#e5e7eb" },
        horzLines: { color: darkMode ? "#1f1f35" : "#e5e7eb" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
        scaleMargins: { top: 0.05, bottom: 0.1 },
      },
      timeScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
        timeVisible: timeFrame !== "1d" && timeFrame !== "1w" && timeFrame !== "1M",
        rightOffset: 5,
        barSpacing: 8,
      },
    });

    // K 线（涨红跌绿）
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ef4444",
      downColor: "#22c55e",
      borderUpColor: "#ef4444",
      borderDownColor: "#22c55e",
      wickUpColor: "#ef4444",
      wickDownColor: "#22c55e",
    });

    // K 线数据
    const candleData: CandlestickData[] = klines.map((k) => ({
      time: toChartTime(k.date),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    candleSeries.setData(candleData);

    // ---- 最高/最低价标记 ----
    const markers: Array<{
      time: Time;
      position: "aboveBar" | "belowBar";
      color: string;
      shape: "arrowDown" | "arrowUp" | "circle" | "square";
      text: string;
    }> = [];

    if (highPoint) {
      markers.push({
        time: toChartTime(highPoint.date),
        position: "aboveBar",
        color: "#ef4444",
        shape: "arrowDown",
        text: `▲ ${highPoint.high.toFixed(2)}`,
      });
    }
    if (lowPoint && lowPoint !== highPoint) {
      markers.push({
        time: toChartTime(lowPoint.date),
        position: "belowBar",
        color: "#22c55e",
        shape: "arrowUp",
        text: `▼ ${lowPoint.low.toFixed(2)}`,
      });
    }

    // 新闻标记
    const isMinute = isMinuteData(klines);
    for (const n of news) {
      if (isMinute) {
        // 分钟模式：新闻日期 "2020-01-20" 匹配当天第一根 K 线
        const matchK = klines.find((k) => unixToDate(k.date) === n.date);
        if (matchK) {
          markers.push({
            time: toChartTime(matchK.date),
            position: "aboveBar",
            color: n.sentiment === "positive" ? "#ef4444" : n.sentiment === "negative" ? "#22c55e" : "#6b7280",
            shape: n.category === "policy" ? "square" : "circle",
            text: n.title.slice(0, 6),
          });
        }
      } else {
        // 日K模式：直接日期匹配
        if (klines.some((k) => k.date === n.date)) {
          markers.push({
            time: toChartTime(n.date),
            position: "aboveBar",
            color: n.sentiment === "positive" ? "#ef4444" : n.sentiment === "negative" ? "#22c55e" : "#6b7280",
            shape: n.category === "policy" ? "square" : "circle",
            text: n.title.slice(0, 6),
          });
        }
      }
    }

    markers.sort((a, b) => compareTime(a.time, b.time));
    candleSeries.setMarkers(markers);

    // ---- 主图指标 ----
    const indicatorSeries: ISeriesApi<"Line">[] = [];

    if (mainIndicator === "MA") {
      const colors = { 5: "#f59e0b", 10: "#3b82f6", 20: "#8b5cf6", 60: "#ec4899" };
      if (maParams.ma5) { const s = chart.addLineSeries({ color: colors[5], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcMA(klines, 5)); indicatorSeries.push(s); }
      if (maParams.ma10) { const s = chart.addLineSeries({ color: colors[10], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcMA(klines, 10)); indicatorSeries.push(s); }
      if (maParams.ma20) { const s = chart.addLineSeries({ color: colors[20], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcMA(klines, 20)); indicatorSeries.push(s); }
      if (maParams.ma60) { const s = chart.addLineSeries({ color: colors[60], lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcMA(klines, 60)); indicatorSeries.push(s); }
    } else if (mainIndicator === "EMA") {
      if (emaParams.ema12) { const s = chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcEMA(klines, 12)); indicatorSeries.push(s); }
      if (emaParams.ema26) { const s = chart.addLineSeries({ color: "#8b5cf6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s.setData(calcEMA(klines, 26)); indicatorSeries.push(s); }
    } else if (mainIndicator === "BOLL") {
      const boll = calcBOLL(klines);
      const s1 = chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s1.setData(boll.upper); indicatorSeries.push(s1);
      const s2 = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s2.setData(boll.mid); indicatorSeries.push(s2);
      const s3 = chart.addLineSeries({ color: "#22c55e", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }); s3.setData(boll.lower); indicatorSeries.push(s3);
    }

    chart.timeScale().fitContent();
    chartApiRef.current = chart;

    // 响应式
    const handleResize = () => {
      if (mainChartRef.current) chart.applyOptions({ width: mainChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartApiRef.current = null;
    };
  }, [klines, news, height, darkMode, mainIndicator, maParams, emaParams, highPoint, lowPoint, timeFrame]);

  // ==================== 副图 ====================
  useEffect(() => {
    if (!subChartRef.current) return;

    const subHeight = 150;
    const chart = createChart(subChartRef.current, {
      width: subChartRef.current.clientWidth,
      height: subHeight,
      layout: {
        background: { type: ColorType.Solid, color: darkMode ? "#0f0f1a" : "#ffffff" },
        textColor: darkMode ? "#9ca3af" : "#374151",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: darkMode ? "#1f1f35" : "#e5e7eb" },
        horzLines: { color: darkMode ? "#1f1f35" : "#e5e7eb" },
      },
      rightPriceScale: { borderColor: darkMode ? "#2d2d44" : "#d1d5db" },
      timeScale: { visible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });

    if (subIndicator === "VOL") {
      const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" } });
      vol.setData(
        klines.map((k) => ({
          time: toChartTime(k.date),
          value: k.volume,
          color: k.close >= k.open ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)",
        })),
      );
    } else if (subIndicator === "MACD") {
      const macd = calcMACD(klines);
      const histSeries = chart.addHistogramSeries({ priceFormat: { type: "price", precision: 4, minMove: 0.0001 } });
      histSeries.setData(macd.histogram);
      const difSeries = chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      difSeries.setData(macd.dif);
      const deaSeries = chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      deaSeries.setData(macd.dea);
    } else if (subIndicator === "KDJ") {
      const kdj = calcKDJ(klines);
      chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(kdj.k);
      chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(kdj.d);
      chart.addLineSeries({ color: "#ef4444", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(kdj.j);
    } else if (subIndicator === "RSI") {
      chart.addLineSeries({ color: "#8b5cf6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(calcRSI(klines, 6));
      chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(calcRSI(klines, 12));
      chart.addLineSeries({ color: "#3b82f6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }).setData(calcRSI(klines, 24));
      // 超买超卖参考线
      const refData70 = klines.map((k) => ({ time: toChartTime(k.date), value: 70 }));
      const refData30 = klines.map((k) => ({ time: toChartTime(k.date), value: 30 }));
      chart.addLineSeries({ color: "rgba(239,68,68,0.3)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }).setData(refData70);
      chart.addLineSeries({ color: "rgba(34,197,94,0.3)", lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false }).setData(refData30);
    }

    chart.timeScale().fitContent();
    subChartApiRef.current = chart;

    const handleResize = () => {
      if (subChartRef.current) chart.applyOptions({ width: subChartRef.current.clientWidth });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      subChartApiRef.current = null;
    };
  }, [klines, darkMode, subIndicator]);

  // 同步主图副图的时间轴滚动
  useEffect(() => {
    const mainChart = chartApiRef.current;
    const subChart = subChartApiRef.current;
    if (!mainChart || !subChart) return;
    const handler = () => {
      const range = mainChart.timeScale().getVisibleLogicalRange();
      if (range) subChart.timeScale().setVisibleLogicalRange(range);
    };
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => mainChart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
  });

  return (
    <div className="relative w-full rounded-lg overflow-hidden border border-gray-700/50 bg-[#0f0f1a]">
      {/* ===== 顶部工具栏 ===== */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-700/50 bg-[#141428]">
        {/* 时间周期选择器 */}
        <div className="flex items-center gap-0.5">
          {availableTimeFrames.map((tf) => (
            <button
              key={tf}
              onClick={() => onTimeFrameChange?.(tf)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                timeFrame === tf
                  ? "bg-blue-600 text-white font-medium"
                  : "text-gray-400 hover:text-white hover:bg-gray-700/50"
              }`}
            >
              {TIME_FRAME_LABELS[tf]}
            </button>
          ))}
        </div>

        {/* 当前日期 */}
        {currentDate && (
          <span className="text-xs text-gray-500 font-mono">{currentDate}</span>
        )}

        {/* 主图指标选择 */}
        <div className="flex items-center gap-0.5">
          {(["MA", "EMA", "BOLL", "NONE"] as MainIndicator[]).map((ind) => (
            <button
              key={ind}
              onClick={() => setMainIndicator(ind)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                mainIndicator === ind
                  ? "bg-gray-600 text-white font-medium"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {ind === "NONE" ? "隐藏" : ind}
            </button>
          ))}
        </div>
      </div>

      {/* 指标图例 */}
      <div className="absolute top-[38px] left-3 z-10 flex gap-3 text-[10px]">
        {mainIndicator === "MA" && (
          <>
            {maParams.ma5 && <span className="text-amber-400">MA5</span>}
            {maParams.ma10 && <span className="text-blue-400">MA10</span>}
            {maParams.ma20 && <span className="text-violet-400">MA20</span>}
            {maParams.ma60 && <span className="text-pink-400">MA60</span>}
          </>
        )}
        {mainIndicator === "EMA" && (
          <>
            {emaParams.ema12 && <span className="text-amber-400">EMA12</span>}
            {emaParams.ema26 && <span className="text-violet-400">EMA26</span>}
          </>
        )}
        {mainIndicator === "BOLL" && (
          <>
            <span className="text-amber-400">上轨</span>
            <span className="text-blue-400">中轨</span>
            <span className="text-green-400">下轨</span>
          </>
        )}
        {/* 最高最低价显示 */}
        {highPoint && <span className="text-red-400 ml-2">H:{highPoint.high.toFixed(2)}</span>}
        {lowPoint && <span className="text-green-400">L:{lowPoint.low.toFixed(2)}</span>}
      </div>

      {/* ===== 主图 ===== */}
      <div ref={mainChartRef} />

      {/* ===== 副图指标选择器 ===== */}
      <div className="flex items-center gap-0.5 px-3 py-1 border-t border-gray-700/50 bg-[#141428]">
        {(["VOL", "MACD", "KDJ", "RSI"] as SubIndicator[]).map((ind) => (
          <button
            key={ind}
            onClick={() => setSubIndicator(ind)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              subIndicator === ind
                ? "bg-blue-600/80 text-white font-medium"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {ind}
          </button>
        ))}
        {/* 副图指标图例 */}
        <div className="ml-auto flex gap-2 text-[10px]">
          {subIndicator === "MACD" && (
            <>
              <span className="text-blue-400">DIF</span>
              <span className="text-amber-400">DEA</span>
              <span className="text-gray-400">MACD柱</span>
            </>
          )}
          {subIndicator === "KDJ" && (
            <>
              <span className="text-blue-400">K</span>
              <span className="text-amber-400">D</span>
              <span className="text-red-400">J</span>
            </>
          )}
          {subIndicator === "RSI" && (
            <>
              <span className="text-violet-400">RSI6</span>
              <span className="text-amber-400">RSI12</span>
              <span className="text-blue-400">RSI24</span>
            </>
          )}
        </div>
      </div>

      {/* ===== 副图 ===== */}
      <div ref={subChartRef} />
    </div>
  );
}
