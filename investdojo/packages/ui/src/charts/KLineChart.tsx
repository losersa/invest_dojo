"use client";

// ============================================================
// K 线图组件 — 基于 TradingView Lightweight Charts
// 支持：日K回放、新闻标记、涨跌停标注、缩放
// ============================================================

import React, { useEffect, useRef, useCallback } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type LineData,
  ColorType,
} from "lightweight-charts";
import type { KLine, NewsItem } from "@investdojo/core";

export interface KLineChartProps {
  /** K 线数据（截止当前模拟日期） */
  klines: KLine[];
  /** 新闻标记数据 */
  news?: NewsItem[];
  /** 5 日均线 */
  showMA5?: boolean;
  /** 20 日均线 */
  showMA20?: boolean;
  /** 图表高度 */
  height?: number;
  /** 当前模拟日期（高亮标注） */
  currentDate?: string;
  /** 暗色模式 */
  darkMode?: boolean;
  /** 点击 K 线时的回调 */
  onKlineClick?: (kline: KLine) => void;
}

export function KLineChart({
  klines,
  news = [],
  showMA5 = true,
  showMA20 = true,
  height = 400,
  currentDate,
  darkMode = true,
  onKlineClick,
}: KLineChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const ma5SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ma20SeriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  // 初始化图表
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: darkMode ? "#1a1a2e" : "#ffffff" },
        textColor: darkMode ? "#d1d5db" : "#374151",
      },
      grid: {
        vertLines: { color: darkMode ? "#2d2d44" : "#e5e7eb" },
        horzLines: { color: darkMode ? "#2d2d44" : "#e5e7eb" },
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
      },
      timeScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
        timeVisible: false,
      },
    });

    // K 线系列（中国习惯：涨红跌绿）
    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ef4444",       // 涨 → 红色
      downColor: "#22c55e",     // 跌 → 绿色
      borderUpColor: "#ef4444",
      borderDownColor: "#22c55e",
      wickUpColor: "#ef4444",
      wickDownColor: "#22c55e",
    });

    // 成交量系列
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    // MA5 均线
    const ma5Series = chart.addLineSeries({
      color: "#f59e0b",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // MA20 均线
    const ma20Series = chart.addLineSeries({
      color: "#8b5cf6",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ma5SeriesRef.current = ma5Series;
    ma20SeriesRef.current = ma20Series;

    // 响应式
    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
    };
  }, [height, darkMode]);

  // 更新数据
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    // K 线数据
    const candleData: CandlestickData[] = klines.map((k) => ({
      time: k.date as Time,
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
    }));
    candleSeriesRef.current.setData(candleData);

    // 成交量数据
    const volumeData = klines.map((k) => ({
      time: k.date as Time,
      value: k.volume,
      color: k.close >= k.open
        ? "rgba(239, 68, 68, 0.5)"  // 涨 → 红
        : "rgba(34, 197, 94, 0.5)", // 跌 → 绿
    }));
    volumeSeriesRef.current.setData(volumeData);

    // MA5
    if (showMA5 && ma5SeriesRef.current) {
      ma5SeriesRef.current.setData(calcMA(klines, 5));
    }

    // MA20
    if (showMA20 && ma20SeriesRef.current) {
      ma20SeriesRef.current.setData(calcMA(klines, 20));
    }

    // 新闻标记
    if (news.length > 0 && candleSeriesRef.current) {
      const markers = news
        .filter((n) => klines.some((k) => k.date === n.date))
        .map((n) => ({
          time: n.date as Time,
          position: "aboveBar" as const,
          color: n.sentiment === "positive"
            ? "#ef4444"
            : n.sentiment === "negative"
              ? "#22c55e"
              : "#6b7280",
          shape: n.category === "policy" ? ("square" as const) : ("circle" as const),
          text: n.title.slice(0, 8),
        }));
      candleSeriesRef.current.setMarkers(markers);
    }

    // 滚动到最新
    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }
  }, [klines, news, showMA5, showMA20]);

  return (
    <div className="relative w-full rounded-lg overflow-hidden border border-gray-700">
      {/* 图例 */}
      <div className="absolute top-2 left-2 z-10 flex gap-3 text-xs">
        {showMA5 && (
          <span className="text-amber-400">MA5</span>
        )}
        {showMA20 && (
          <span className="text-violet-400">MA20</span>
        )}
      </div>
      {/* 当前日期标签 */}
      {currentDate && (
        <div className="absolute top-2 right-2 z-10 bg-blue-600/80 text-white text-xs px-2 py-1 rounded">
          {currentDate}
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}

// ------ 工具函数 ------

/** 计算移动平均线 */
function calcMA(klines: KLine[], period: number): LineData[] {
  const result: LineData[] = [];
  for (let i = period - 1; i < klines.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += klines[j].close;
    }
    result.push({
      time: klines[i].date as Time,
      value: Math.round((sum / period) * 100) / 100,
    });
  }
  return result;
}
