"use client";

// ============================================================
// 模拟交易主页面 — 核心游戏循环
// K线回放 + 新闻 + 交易面板 + 持仓 + 推进日期
// 支持自动播放（5分钟逐帧 / 1小时跳帧 / 日推进）
// ============================================================

import React, { useEffect, useState, useCallback, useRef, use } from "react";
import Link from "next/link";
import { useSimulationStore } from "@/stores/simulation";
import { KLineChart, type TimeFrame } from "@investdojo/ui/charts";
import { OrderPanel, PositionList, NewsTimeline, TradeHistory } from "@investdojo/ui/trading";
import { formatMoney, formatPercent, getPriceColor, cn } from "@investdojo/ui";
import { loadScenarioFromSupabase, loadMinuteKlines, has5minData, aggregateMinuteKlines } from "@/lib/supabase-loader";
import { generateMockScenario } from "@/lib/mock-data";
import type { KLine } from "@investdojo/core";

// 播放速度选项
type PlaySpeed = 0.5 | 1 | 2 | 5 | 10;
type PlayMode = "stopped" | "playing";
// 推进步长
type StepSize = "5m" | "1h" | "1d";

/** 将 currentDate "YYYY-MM-DD" 转为当天结束的 Unix 秒数 */
function dateToDayEndUnix(dateStr: string): number {
  return Math.floor(new Date(`${dateStr}T23:59:59+08:00`).getTime() / 1000);
}

/** 裁剪分钟 K 线：只保留 <= currentDate 当天结束的数据 */
function clipMinuteKlines(raw: KLine[], currentDate: string): KLine[] {
  const endUnix = dateToDayEndUnix(currentDate);
  return raw.filter((k) => Number(k.date) <= endUnix);
}

export function SimulationPlayground({
  paramsPromise,
}: {
  paramsPromise: Promise<{ scenarioId: string }>;
}) {
  const { scenarioId } = use(paramsPromise);

  const {
    scenarioMeta,
    progress,
    currentDate,
    isLastDay,
    visibleKlines,
    visibleNews,
    todayKlines,
    tradeHistory,
    loadScenario,
    advanceDay,
    buy,
    sell,
    calculateMetrics,
    reset,
  } = useSimulationStore();

  const [selectedSymbol, setSelectedSymbol] = useState<string>("");
  const [activeTab, setActiveTab] = useState<"order" | "position" | "history">("order");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [timeFrame, setTimeFrame] = useState<TimeFrame>("1d");
  const [availableTimeFrames, setAvailableTimeFrames] = useState<TimeFrame[]>(["1d", "1w", "1M"]);
  const [minuteKlines, setMinuteKlines] = useState<Record<string, KLine[]>>({});
  const [has5min, setHas5min] = useState(false);

  // ---- 自动播放状态 ----
  const [playMode, setPlayMode] = useState<PlayMode>("stopped");
  const [playSpeed, setPlaySpeed] = useState<PlaySpeed>(1);
  const [stepSize, setStepSize] = useState<StepSize>("5m");
  // 分钟级自动播放：追踪当前已展示到的 5m 柱索引
  const [minutePlayIndex, setMinutePlayIndex] = useState<number>(-1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 用 ref 追踪最新状态（因为 setInterval 闭包问题）
  const playStateRef = useRef({ playMode, playSpeed, stepSize, minutePlayIndex, isLastDay, currentDate });
  useEffect(() => {
    playStateRef.current = { playMode, playSpeed, stepSize, minutePlayIndex, isLastDay, currentDate };
  }, [playMode, playSpeed, stepSize, minutePlayIndex, isLastDay, currentDate]);

  // 加载场景数据（Supabase 优先，mock 降级）
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabaseData = await loadScenarioFromSupabase(scenarioId);

      if (cancelled) return;

      if (supabaseData) {
        console.log("[SimulationPlayground] 使用 Supabase 真实数据");
        loadScenario(supabaseData);
        setSelectedSymbol(supabaseData.meta.symbols[0] ?? "");

        const h5 = await has5minData(scenarioId);
        setHas5min(h5);
        if (h5) {
          setAvailableTimeFrames(["5m", "15m", "1h", "4h", "1d", "1w", "1M"]);
        } else {
          setAvailableTimeFrames(["1d", "1w", "1M"]);
        }
      } else {
        console.log("[SimulationPlayground] Supabase 不可用，使用 mock 数据");
        const data = generateMockScenario(scenarioId);
        loadScenario(data);
        setSelectedSymbol(data.meta.symbols[0] ?? "");
      }
    }

    load();
    return () => {
      cancelled = true;
      reset();
    };
  }, [scenarioId, loadScenario, reset]);

  // ---- 当 currentDate 变化时，重置分钟播放索引 ----
  useEffect(() => {
    if (!currentDate) return;
    // 计算截止当天的 5m 柱数量，直接设为最后一根（即显示到当天结束）
    const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
    const raw = minuteKlines[cacheKey];
    if (raw) {
      const clipped = clipMinuteKlines(raw, currentDate);
      setMinutePlayIndex(clipped.length);
    } else {
      setMinutePlayIndex(-1);
    }
  }, [currentDate, scenarioId, selectedSymbol, minuteKlines]);

  // ---- 自动播放定时器 ----
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (playMode !== "playing") return;

    const intervalMs = Math.max(100, 1000 / playSpeed);

    timerRef.current = setInterval(() => {
      const ps = playStateRef.current;
      if (ps.isLastDay && ps.stepSize === "1d") {
        setPlayMode("stopped");
        return;
      }

      if (ps.stepSize === "1d") {
        // 日推进
        advanceDay();
      } else if (ps.stepSize === "1h") {
        // 每次跳 12 根 5m 柱（= 1 小时）
        setMinutePlayIndex((prev) => {
          const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
          const raw = minuteKlines[cacheKey];
          if (!raw) return prev;
          const clipped = clipMinuteKlines(raw, ps.currentDate);
          const next = prev + 12;
          if (next >= clipped.length) {
            // 当天分钟数据播完，推进到下一天
            if (!ps.isLastDay) advanceDay();
            return 0;
          }
          return next;
        });
      } else {
        // 5m: 每次 +1 根
        setMinutePlayIndex((prev) => {
          const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
          const raw = minuteKlines[cacheKey];
          if (!raw) return prev;
          const clipped = clipMinuteKlines(raw, ps.currentDate);
          const next = prev + 1;
          if (next >= clipped.length) {
            if (!ps.isLastDay) advanceDay();
            return 0;
          }
          return next;
        });
      }
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // 依赖只放 playMode 和 playSpeed，其他用 ref 读取
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playMode, playSpeed]);

  // 交易操作
  const handleBuy = useCallback(
    (symbol: string, name: string, qty: number) => {
      try {
        const order = buy(symbol, name, qty);
        setToast({
          msg: order.status === "filled"
            ? `✅ 买入 ${name} ${qty}股 成功`
            : `❌ 买入失败`,
          type: order.status === "filled" ? "success" : "error",
        });
      } catch (e: unknown) {
        setToast({ msg: `❌ ${(e as Error).message}`, type: "error" });
      }
      setTimeout(() => setToast(null), 3000);
    },
    [buy],
  );

  const handleSell = useCallback(
    (symbol: string, name: string, qty: number) => {
      try {
        const order = sell(symbol, name, qty);
        setToast({
          msg: order.status === "filled"
            ? `✅ 卖出 ${name} ${qty}股 成功`
            : `❌ 卖出失败`,
          type: order.status === "filled" ? "success" : "error",
        });
      } catch (e: unknown) {
        setToast({ msg: `❌ ${(e as Error).message}`, type: "error" });
      }
      setTimeout(() => setToast(null), 3000);
    },
    [sell],
  );

  // 手动推进
  const handleAdvanceDay = useCallback(() => {
    setPlayMode("stopped");
    advanceDay();
  }, [advanceDay]);

  const handleAdvanceHour = useCallback(() => {
    setPlayMode("stopped");
    const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
    const raw = minuteKlines[cacheKey];
    if (!raw || !currentDate) { advanceDay(); return; }
    const clipped = clipMinuteKlines(raw, currentDate);
    const next = minutePlayIndex + 12;
    if (next >= clipped.length) {
      advanceDay();
    } else {
      setMinutePlayIndex(next);
    }
  }, [scenarioId, selectedSymbol, minuteKlines, currentDate, minutePlayIndex, advanceDay]);

  // 播放/暂停
  const togglePlay = useCallback(() => {
    setPlayMode((prev) => (prev === "playing" ? "stopped" : "playing"));
  }, []);

  // 时间周期切换
  const handleTimeFrameChange = useCallback(
    async (tf: TimeFrame) => {
      setTimeFrame(tf);
      if (["5m", "15m", "1h", "4h"].includes(tf) && selectedSymbol) {
        const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
        if (!minuteKlines[cacheKey]) {
          console.log(`[SimulationPlayground] 加载 5 分钟数据: ${selectedSymbol}`);
          const data = await loadMinuteKlines(scenarioId, selectedSymbol);
          setMinuteKlines((prev) => ({ ...prev, [cacheKey]: data }));
        }
      }
    },
    [scenarioId, selectedSymbol, minuteKlines],
  );

  // 切换股票时也加载分钟数据
  const handleSelectSymbol = useCallback(
    async (symbol: string) => {
      setSelectedSymbol(symbol);
      if (["5m", "15m", "1h", "4h"].includes(timeFrame)) {
        const cacheKey = `${scenarioId}:${symbol}:5m`;
        if (!minuteKlines[cacheKey]) {
          const data = await loadMinuteKlines(scenarioId, symbol);
          setMinuteKlines((prev) => ({ ...prev, [cacheKey]: data }));
        }
      }
    },
    [scenarioId, timeFrame, minuteKlines],
  );

  // 场景结束
  const handleFinish = useCallback(() => {
    setPlayMode("stopped");
    calculateMetrics();
  }, [calculateMetrics]);

  if (!scenarioMeta || !progress) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-gray-400">加载场景数据中...</div>
      </div>
    );
  }

  const portfolio = progress.portfolio;
  const selectedPosition = portfolio.positions.find((p) => p.symbol === selectedSymbol) ?? null;
  const selectedKline = todayKlines[selectedSymbol] ?? null;

  const symbolNames: Record<string, string> = {
    "000001": "平安银行",
    "600519": "贵州茅台",
    "300750": "宁德时代",
    "601318": "中国平安",
    "600036": "招商银行",
    "000858": "五粮液",
    "002594": "比亚迪",
    "601012": "隆基绿能",
  };
  const selectedName = symbolNames[selectedSymbol] ?? selectedSymbol;

  // ---- 计算要传给 KLineChart 的 klines ----
  const chartKlines = (() => {
    if (["5m", "15m", "1h", "4h"].includes(timeFrame)) {
      const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
      const raw5m = minuteKlines[cacheKey] ?? [];
      if (raw5m.length === 0) return [];

      // 关键修复：按 currentDate 裁剪分钟数据
      let clipped = clipMinuteKlines(raw5m, currentDate);

      // 如果正在分钟级自动播放，进一步裁剪到 minutePlayIndex
      if (minutePlayIndex >= 0 && minutePlayIndex < clipped.length) {
        clipped = clipped.slice(0, minutePlayIndex);
      }

      if (clipped.length === 0) return [];

      if (timeFrame === "5m") return clipped;
      return aggregateMinuteKlines(clipped, timeFrame as "15m" | "1h" | "4h");
    }
    return visibleKlines[selectedSymbol] ?? [];
  })();

  // 分钟进度信息
  const minuteProgressInfo = (() => {
    if (!has5min || !["5m", "15m", "1h", "4h"].includes(timeFrame)) return null;
    const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
    const raw = minuteKlines[cacheKey];
    if (!raw) return null;
    const clipped = clipMinuteKlines(raw, currentDate);
    const shown = Math.min(minutePlayIndex >= 0 ? minutePlayIndex : clipped.length, clipped.length);
    // 计算当前时间
    if (shown > 0 && shown <= clipped.length) {
      const lastBar = clipped[shown - 1];
      const ts = Number(lastBar.date);
      const d = new Date(ts * 1000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return { shown, total: clipped.length, time: `${hh}:${mm}` };
    }
    return { shown, total: clipped.length, time: "09:30" };
  })();

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Toast */}
      {toast && (
        <div className={cn(
          "fixed top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg shadow-lg text-sm font-medium",
          toast.type === "success" ? "bg-green-600 text-white" : "bg-red-600 text-white",
        )}>
          {toast.msg}
        </div>
      )}

      {/* 顶部状态栏 */}
      <header className="sticky top-0 z-40 bg-gray-900/95 backdrop-blur-sm border-b border-gray-800">
        <div className="max-w-[1920px] mx-auto px-4 py-2">
          <div className="flex items-center justify-between">
            {/* 左：场景信息 */}
            <div className="flex items-center gap-4">
              <Link href="/simulation" className="text-gray-500 hover:text-gray-300 text-sm">
                ← 返回
              </Link>
              <div>
                <h1 className="text-sm font-bold text-white">{scenarioMeta.name}</h1>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>📅 {currentDate}{minuteProgressInfo ? ` ${minuteProgressInfo.time}` : ""}</span>
                  <span>
                    第 {progress.dayIndex + 1} / {progress.totalDays} 天
                  </span>
                  {minuteProgressInfo && (
                    <span className="text-blue-400">
                      {minuteProgressInfo.shown}/{minuteProgressInfo.total} 根
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* 中：组合概览 */}
            <div className="hidden md:flex items-center gap-6">
              <div className="text-center">
                <div className="text-xs text-gray-500">总资产</div>
                <div className="text-sm font-bold text-white font-mono">
                  {formatMoney(portfolio.totalAssets)}
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500">总盈亏</div>
                <div className={cn("text-sm font-bold font-mono", getPriceColor(portfolio.totalProfitLoss))}>
                  {formatMoney(portfolio.totalProfitLoss)}
                  <span className="text-xs ml-1">
                    ({formatPercent(portfolio.totalProfitLossPercent)})
                  </span>
                </div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-500">可用现金</div>
                <div className="text-sm font-mono text-white">{formatMoney(portfolio.cash)}</div>
              </div>
            </div>

            {/* 右：操作按钮 */}
            <div className="flex items-center gap-2">
              {!isLastDay ? (
                <>
                  {has5min && (
                    <button
                      onClick={handleAdvanceHour}
                      className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white text-xs font-medium rounded-lg transition-colors"
                      title="推进 1 小时"
                    >
                      +1h
                    </button>
                  )}
                  <button
                    onClick={handleAdvanceDay}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    +1天
                  </button>
                </>
              ) : (
                <button
                  onClick={handleFinish}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  🏁 结束 & 复盘
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 播放控制栏 */}
        {has5min && !isLastDay && (
          <div className="max-w-[1920px] mx-auto px-4 py-1.5 flex items-center gap-3 border-t border-gray-800/50">
            {/* 播放/暂停 */}
            <button
              onClick={togglePlay}
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-sm transition-colors",
                playMode === "playing"
                  ? "bg-amber-500 hover:bg-amber-600 text-black"
                  : "bg-green-500 hover:bg-green-600 text-black",
              )}
              title={playMode === "playing" ? "暂停" : "播放"}
            >
              {playMode === "playing" ? "⏸" : "▶"}
            </button>

            {/* 步长选择 */}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-500">步长:</span>
              {(["5m", "1h", "1d"] as StepSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStepSize(s)}
                  className={cn(
                    "px-2 py-0.5 rounded transition-colors",
                    stepSize === s
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* 速度选择 */}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-500">速度:</span>
              {([0.5, 1, 2, 5, 10] as PlaySpeed[]).map((sp) => (
                <button
                  key={sp}
                  onClick={() => setPlaySpeed(sp)}
                  className={cn(
                    "px-2 py-0.5 rounded transition-colors",
                    playSpeed === sp
                      ? "bg-blue-600 text-white"
                      : "bg-gray-800 text-gray-400 hover:bg-gray-700",
                  )}
                >
                  {sp}x
                </button>
              ))}
            </div>

            {/* 状态指示 */}
            {playMode === "playing" && (
              <div className="flex items-center gap-1 text-xs text-green-400">
                <span className="animate-pulse">●</span>
                <span>自动播放中 ({stepSize} / {playSpeed}x)</span>
              </div>
            )}
          </div>
        )}

        {/* 进度条 */}
        <div className="h-0.5 bg-gray-800">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${((progress.dayIndex + 1) / progress.totalDays) * 100}%` }}
          />
        </div>
      </header>

      {/* 主体内容 */}
      <div className="max-w-[1920px] mx-auto">
        <div className="flex flex-col lg:flex-row">
          {/* 左侧：K线 + 股票切换 */}
          <div className="flex-1 min-w-0 p-4 space-y-4">
            {/* 股票切换 Tab */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {scenarioMeta.symbols.map((symbol) => {
                const kline = todayKlines[symbol];
                const change = kline?.changePercent ?? 0;
                return (
                  <button
                    key={symbol}
                    onClick={() => handleSelectSymbol(symbol)}
                    className={cn(
                      "flex-shrink-0 px-3 py-2 rounded-lg border transition-colors text-sm",
                      selectedSymbol === symbol
                        ? "border-blue-500 bg-blue-500/10 text-white"
                        : "border-gray-700 bg-gray-800/50 text-gray-400 hover:border-gray-600",
                    )}
                  >
                    <div className="font-medium">{symbolNames[symbol] ?? symbol}</div>
                    {kline && (
                      <div className={cn("text-xs font-mono", getPriceColor(change))}>
                        ¥{kline.close.toFixed(2)} {formatPercent(change)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* K 线图表 */}
            <KLineChart
              klines={chartKlines}
              news={visibleNews.filter((n) =>
                n.relatedSymbols?.includes(selectedSymbol) || !n.relatedSymbols,
              )}
              currentDate={currentDate}
              height={460}
              timeFrame={timeFrame}
              availableTimeFrames={availableTimeFrames}
              onTimeFrameChange={handleTimeFrameChange}
            />

            {/* 移动端：新闻 + 交易（折叠） */}
            <div className="lg:hidden space-y-4">
              <div className="flex border-b border-gray-700">
                {[
                  { key: "order", label: "交易" },
                  { key: "position", label: "持仓" },
                  { key: "history", label: "记录" },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key as typeof activeTab)}
                    className={cn(
                      "flex-1 py-2 text-sm text-center transition-colors",
                      activeTab === key
                        ? "text-blue-400 border-b-2 border-blue-500"
                        : "text-gray-500",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeTab === "order" && (
                <OrderPanel
                  symbol={selectedSymbol}
                  symbolName={selectedName}
                  currentKline={selectedKline}
                  position={selectedPosition}
                  availableCash={portfolio.cash}
                  onBuy={handleBuy}
                  onSell={handleSell}
                />
              )}
              {activeTab === "position" && (
                <PositionList
                  portfolio={portfolio}
                  selectedSymbol={selectedSymbol}
                  onSelectPosition={setSelectedSymbol}
                />
              )}
              {activeTab === "history" && <TradeHistory trades={tradeHistory} />}
            </div>
          </div>

          {/* 右侧面板（桌面端） */}
          <div className="hidden lg:block w-[380px] xl:w-[420px] border-l border-gray-800 min-h-screen">
            <div className="sticky top-[73px] p-4 space-y-4 max-h-[calc(100vh-73px)] overflow-y-auto">
              <OrderPanel
                symbol={selectedSymbol}
                symbolName={selectedName}
                currentKline={selectedKline}
                position={selectedPosition}
                availableCash={portfolio.cash}
                onBuy={handleBuy}
                onSell={handleSell}
              />
              <PositionList
                portfolio={portfolio}
                selectedSymbol={selectedSymbol}
                onSelectPosition={setSelectedSymbol}
              />
              <NewsTimeline news={visibleNews} maxItems={15} />
              <TradeHistory trades={tradeHistory} maxItems={20} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
