"use client";

// ============================================================
// 收益曲线组件 — 展示用户累计收益 vs 基准
// ============================================================

import React, { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  ColorType,
  type Time,
} from "lightweight-charts";

export interface EquityCurveProps {
  /** 每日收益率数据 */
  dailyReturns: { date: string; cumReturn: number }[];
  /** 基准收益率（可选） */
  benchmarkReturns?: { date: string; cumReturn: number }[];
  /** 图表高度 */
  height?: number;
  /** 暗色模式 */
  darkMode?: boolean;
}

export function EquityCurve({
  dailyReturns,
  benchmarkReturns,
  height = 250,
  darkMode = true,
}: EquityCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

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
      rightPriceScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
      },
      timeScale: {
        borderColor: darkMode ? "#2d2d44" : "#d1d5db",
      },
    });

    // 用户收益曲线
    const userSeries = chart.addAreaSeries({
      lineColor: "#3b82f6",
      topColor: "rgba(59, 130, 246, 0.4)",
      bottomColor: "rgba(59, 130, 246, 0.0)",
      lineWidth: 2,
    });

    userSeries.setData(
      dailyReturns.map((d) => ({
        time: d.date as Time,
        value: d.cumReturn,
      })),
    );

    // 基准线
    if (benchmarkReturns && benchmarkReturns.length > 0) {
      const benchSeries = chart.addLineSeries({
        color: "#6b7280",
        lineWidth: 1,
        lineStyle: 2, // dashed
      });
      benchSeries.setData(
        benchmarkReturns.map((d) => ({
          time: d.date as Time,
          value: d.cumReturn,
        })),
      );
    }

    // 零线
    const zeroSeries = chart.addLineSeries({
      color: darkMode ? "#4b5563" : "#9ca3af",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    if (dailyReturns.length > 0) {
      zeroSeries.setData([
        { time: dailyReturns[0].date as Time, value: 0 },
        { time: dailyReturns.at(-1)!.date as Time, value: 0 },
      ]);
    }

    chart.timeScale().fitContent();
    chartRef.current = chart;

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [dailyReturns, benchmarkReturns, height, darkMode]);

  return (
    <div className="w-full rounded-lg overflow-hidden border border-gray-700">
      <div className="px-3 py-2 flex justify-between items-center border-b border-gray-700">
        <span className="text-sm font-medium text-gray-300">累计收益曲线</span>
        <div className="flex gap-3 text-xs">
          <span className="flex items-center gap-1">
            <span className="w-3 h-0.5 bg-blue-500 inline-block" />
            我的收益
          </span>
          {benchmarkReturns && (
            <span className="flex items-center gap-1">
              <span className="w-3 h-0.5 bg-gray-500 inline-block" style={{ borderTop: "1px dashed #6b7280" }} />
              基准
            </span>
          )}
        </div>
      </div>
      <div ref={containerRef} />
    </div>
  );
}
