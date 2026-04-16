"use client";

// ============================================================
// 模拟交易主页面 — 核心游戏循环
// K线回放 + 新闻 + 交易面板 + 持仓 + 推进日期
// 支持自动播放（5分钟逐帧 / 1小时跳帧 / 日推进）
// ============================================================

import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
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
  scenarioId,
}: {
  scenarioId: string;
}) {
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
  const [minuteKlinesMap, setMinuteKlinesMap] = useState<Record<string, KLine[]>>({});
  const [has5min, setHas5min] = useState(false);

  // ---- 自动播放状态 ----
  const [playMode, setPlayMode] = useState<PlayMode>("stopped");
  const [playSpeed, setPlaySpeed] = useState<PlaySpeed>(1);
  const [stepSize, setStepSize] = useState<StepSize>("5m");
  // 分钟级自动播放：追踪当前已展示到的 5m 柱索引
  const [minutePlayIndex, setMinutePlayIndex] = useState<number>(-1);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 用 ref 追踪最新值（setInterval 闭包需要）
  const latestRef = useRef({
    playMode, playSpeed, stepSize, minutePlayIndex, isLastDay, currentDate,
    scenarioId, selectedSymbol, minuteKlinesMap,
  });
  useEffect(() => {
    latestRef.current = {
      playMode, playSpeed, stepSize, minutePlayIndex, isLastDay, currentDate,
      scenarioId, selectedSymbol, minuteKlinesMap,
    };
  });

  // 加载场景数据（Supabase 优先，mock 降级）
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const supabaseData = await loadScenarioFromSupabase(scenarioId);
      if (cancelled) return;

      if (supabaseData) {
        loadScenario(supabaseData);
        setSelectedSymbol(supabaseData.meta.symbols[0] ?? "");

        const h5 = await has5minData(scenarioId);
        if (!cancelled) {
          setHas5min(h5);
          setAvailableTimeFrames(h5 ? ["5m", "15m", "1h", "4h", "1d", "1w", "1M"] : ["1d", "1w", "1M"]);
        }
      } else {
        const data = generateMockScenario(scenarioId);
        loadScenario(data);
        setSelectedSymbol(data.meta.symbols[0] ?? "");
      }
    }

    load();
    return () => { cancelled = true; reset(); };
  }, [scenarioId, loadScenario, reset]);

  // ---- 当 currentDate 变化时，重置分钟播放索引 ----
  const currentDateRef = useRef(currentDate);
  useEffect(() => {
    // 仅当 currentDate 真的变了才重置（避免初始化竞争）
    if (currentDate && currentDate !== currentDateRef.current) {
      currentDateRef.current = currentDate;
      const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
      const raw = minuteKlinesMap[cacheKey];
      if (raw) {
        const clipped = clipMinuteKlines(raw, currentDate);
        setMinutePlayIndex(clipped.length);
      } else {
        setMinutePlayIndex(-1);
      }
    }
  }, [currentDate, scenarioId, selectedSymbol, minuteKlinesMap]);

  // ---- 自动播放定时器 ----
  useEffect(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (playMode !== "playing") return;

    const intervalMs = Math.max(100, 1000 / playSpeed);

    timerRef.current = setInterval(() => {
      const s = latestRef.current;
      if (s.isLastDay && s.stepSize === "1d") {
        setPlayMode("stopped");
        return;
      }

      if (s.stepSize === "1d") {
        advanceDay();
      } else {
        const barsPerStep = s.stepSize === "1h" ? 12 : 1;
        setMinutePlayIndex((prev) => {
          const cacheKey = `${s.scenarioId}:${s.selectedSymbol}:5m`;
          const raw = s.minuteKlinesMap[cacheKey];
          if (!raw) return prev;
          const clipped = clipMinuteKlines(raw, s.currentDate);
          const next = prev + barsPerStep;
          if (next >= clipped.length) {
            if (!s.isLastDay) {
              // 不要在 setState 回调里调另一个 setState，用 setTimeout 推到下一个微任务
              setTimeout(() => advanceDay(), 0);
            }
            return 0;
          }
          return next;
        });
      }
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
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
    const raw = minuteKlinesMap[cacheKey];
    if (!raw || !currentDate) { advanceDay(); return; }
    const clipped = clipMinuteKlines(raw, currentDate);
    const next = minutePlayIndex + 12;
    if (next >= clipped.length) {
      advanceDay();
    } else {
      setMinutePlayIndex(next);
    }
  }, [scenarioId, selectedSymbol, minuteKlinesMap, currentDate, minutePlayIndex, advanceDay]);

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
        if (!minuteKlinesMap[cacheKey]) {
          const data = await loadMinuteKlines(scenarioId, selectedSymbol);
          setMinuteKlinesMap((prev) => ({ ...prev, [cacheKey]: data }));
        }
      }
    },
    [scenarioId, selectedSymbol, minuteKlinesMap],
  );

  // 切换股票时也加载分钟数据
  const handleSelectSymbol = useCallback(
    async (symbol: string) => {
      setSelectedSymbol(symbol);
      if (["5m", "15m", "1h", "4h"].includes(timeFrame)) {
        const cacheKey = `${scenarioId}:${symbol}:5m`;
        if (!minuteKlinesMap[cacheKey]) {
          const data = await loadMinuteKlines(scenarioId, symbol);
          setMinuteKlinesMap((prev) => ({ ...prev, [cacheKey]: data }));
        }
      }
    },
    [scenarioId, timeFrame, minuteKlinesMap],
  );

  // 场景结束
  const handleFinish = useCallback(() => {
    setPlayMode("stopped");
    calculateMetrics();
  }, [calculateMetrics]);

  // ---- 用 useMemo 计算图表数据（不在 render 中执行 IIFE）----
  const chartKlines = useMemo(() => {
    if (["5m", "15m", "1h", "4h"].includes(timeFrame)) {
      const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
      const raw5m = minuteKlinesMap[cacheKey] ?? [];
      if (raw5m.length === 0 || !currentDate) return [];

      let clipped = clipMinuteKlines(raw5m, currentDate);
      if (minutePlayIndex >= 0 && minutePlayIndex < clipped.length) {
        clipped = clipped.slice(0, minutePlayIndex);
      }
      if (clipped.length === 0) return [];
      if (timeFrame === "5m") return clipped;
      return aggregateMinuteKlines(clipped, timeFrame as "15m" | "1h" | "4h");
    }
    return visibleKlines[selectedSymbol] ?? [];
  }, [timeFrame, scenarioId, selectedSymbol, minuteKlinesMap, currentDate, minutePlayIndex, visibleKlines]);

  // 分钟进度信息
  const minuteProgressInfo = useMemo(() => {
    if (!has5min || !["5m", "15m", "1h", "4h"].includes(timeFrame)) return null;
    const cacheKey = `${scenarioId}:${selectedSymbol}:5m`;
    const raw = minuteKlinesMap[cacheKey];
    if (!raw || !currentDate) return null;
    const clipped = clipMinuteKlines(raw, currentDate);
    const shown = Math.min(minutePlayIndex >= 0 ? minutePlayIndex : clipped.length, clipped.length);
    if (shown > 0 && shown <= clipped.length) {
      const lastBar = clipped[shown - 1];
      const ts = Number(lastBar.date);
      const d = new Date(ts * 1000);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return { shown, total: clipped.length, time: `${hh}:${mm}` };
    }
    return { shown, total: clipped.length, time: "09:30" };
  }, [has5min, timeFrame, scenarioId, selectedSymbol, minuteKlinesMap, currentDate, minutePlayIndex]);

  if (!scenarioMeta || !progress) {
    return (
      <div className="min-h-screen bg-rc-bg flex items-center justify-center">
        <div className="text-rc-text-muted text-[15px] tracking-[0.2px]">加载场景数据中...</div>
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

  return (
    <div className="min-h-screen bg-rc-bg">
      {/* Toast */}
      {toast && (
        <div className={cn(
          "fixed top-14 left-1/2 -translate-x-1/2 z-[60] px-5 py-2.5 rounded-[6px] shadow-[rgba(1,1,32,0.4)_0px_4px_20px] text-[13px] font-medium tracking-[0.2px]",
          toast.type === "success" ? "bg-stock-down text-white" : "bg-stock-up text-white",
        )}>
          {toast.msg}
        </div>
      )}

      {/* ---- Header (Dark Surface) ---- */}
      <header className="sticky top-0 z-50 bg-rc-surface-100 border-b border-rc-border">
        <div className="max-w-[1920px] mx-auto px-6 py-2.5">
          <div className="flex items-center justify-between">
            {/* Left: Scene info */}
            <div className="flex items-center gap-4">
              <Link href="/simulation" className="text-[14px] text-rc-text-muted hover:text-white transition-opacity duration-150 tracking-[0.2px]">
                ← 返回
              </Link>
              <div>
                <h1 className="text-[16px] font-medium text-white tracking-[0.2px]">{scenarioMeta.name}</h1>
                <div className="flex items-center gap-3 text-[11px] text-rc-text-muted font-rc-mono">
                  <span>{currentDate}{minuteProgressInfo ? ` ${minuteProgressInfo.time}` : ""}</span>
                  <span>DAY {progress.dayIndex + 1}/{progress.totalDays}</span>
                  {minuteProgressInfo && (
                    <span className="text-rc-blue">{minuteProgressInfo.shown}/{minuteProgressInfo.total}</span>
                  )}
                </div>
              </div>
            </div>

            {/* Center: Portfolio overview */}
            <div className="hidden md:flex items-center gap-6">
              <div className="text-center">
                <div className="text-[10px] text-rc-text-muted font-rc-mono">TOTAL</div>
                <div className="text-[14px] font-medium text-white font-mono tracking-[0.2px]">{formatMoney(portfolio.totalAssets)}</div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-rc-text-muted font-rc-mono">P&L</div>
                <div className={cn("text-[14px] font-medium font-mono tracking-[0.2px]", getPriceColor(portfolio.totalProfitLoss))}>
                  {formatMoney(portfolio.totalProfitLoss)}
                  <span className="text-[11px] ml-1">({formatPercent(portfolio.totalProfitLossPercent)})</span>
                </div>
              </div>
              <div className="text-center">
                <div className="text-[10px] text-rc-text-muted font-rc-mono">CASH</div>
                <div className="text-[14px] font-mono text-white tracking-[0.2px]">{formatMoney(portfolio.cash)}</div>
              </div>
            </div>

            {/* Right: Actions */}
            <div className="flex items-center gap-2">
              {!isLastDay ? (
                <>
                  {has5min && (
                    <button
                      onClick={handleAdvanceHour}
                      className="rc-btn-glass text-[12px] px-3 py-1.5"
                    >
                      +1h
                    </button>
                  )}
                  <button
                    onClick={handleAdvanceDay}
                    className="bg-rc-blue text-rc-btn-fg text-[13px] font-medium px-4 py-1.5 rounded-[6px] hover:opacity-60 transition-opacity duration-150"
                  >
                    +1天
                  </button>
                </>
              ) : (
                <button
                  onClick={handleFinish}
                  className="bg-rc-blue text-rc-btn-fg text-[13px] font-medium px-4 py-1.5 rounded-[6px] hover:opacity-60 transition-opacity duration-150"
                >
                  🏁 结束复盘
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Play Control Bar */}
        {has5min && !isLastDay && (
          <div className="max-w-[1920px] mx-auto px-6 py-1.5 flex items-center gap-3 border-t border-rc-border">
            <button
              onClick={togglePlay}
              className={cn(
                "w-7 h-7 rounded-[6px] flex items-center justify-center text-[12px] transition-opacity duration-150",
                playMode === "playing"
                  ? "bg-rc-blue text-rc-btn-fg"
                  : "bg-stock-down text-white",
              )}
            >
              {playMode === "playing" ? "⏸" : "▶"}
            </button>

            <div className="flex items-center gap-1">
              <span className="text-[10px] text-rc-text-muted font-rc-mono">STEP</span>
              {(["5m", "1h", "1d"] as StepSize[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setStepSize(s)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] rounded-[6px] transition-opacity duration-150",
                    stepSize === s ? "bg-rc-blue text-rc-btn-fg" : "bg-white/[0.04] text-rc-text-secondary border border-rc-border hover:bg-white/[0.08]",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1">
              <span className="text-[10px] text-rc-text-muted font-rc-mono">SPEED</span>
              {([0.5, 1, 2, 5, 10] as PlaySpeed[]).map((sp) => (
                <button
                  key={sp}
                  onClick={() => setPlaySpeed(sp)}
                  className={cn(
                    "px-2 py-0.5 text-[11px] rounded-[6px] transition-opacity duration-150",
                    playSpeed === sp ? "bg-rc-blue text-rc-btn-fg" : "bg-white/[0.04] text-rc-text-secondary border border-rc-border hover:bg-white/[0.08]",
                  )}
                >
                  {sp}x
                </button>
              ))}
            </div>

            {playMode === "playing" && (
              <div className="flex items-center gap-1 text-[11px] text-rc-blue font-rc-mono">
                <span className="animate-pulse">●</span>
                <span>PLAYING</span>
              </div>
            )}
          </div>
        )}

        {/* Progress Bar */}
        <div className="h-[2px] bg-rc-surface-card">
          <div
            className="h-full bg-rc-blue transition-all duration-300"
            style={{ width: `${((progress.dayIndex + 1) / progress.totalDays) * 100}%` }}
          />
        </div>
      </header>

      {/* ---- Main Content ---- */}
      <div className="max-w-[1920px] mx-auto">
        <div className="flex flex-col lg:flex-row">
          {/* Left: K-line + Stock tabs */}
          <div className="flex-1 min-w-0 p-4 space-y-3">
            {/* Stock Tabs */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {scenarioMeta.symbols.map((symbol) => {
                const kline = todayKlines[symbol];
                const change = kline?.changePercent ?? 0;
                return (
                  <button
                    key={symbol}
                    onClick={() => handleSelectSymbol(symbol)}
                    className={cn(
                      "flex-shrink-0 px-4 py-2 rounded-[6px] border transition-opacity duration-150 text-[13px] tracking-[0.2px]",
                      selectedSymbol === symbol
                        ? "border-rc-blue bg-rc-blue/[0.08] text-white"
                        : "border-rc-border bg-white/[0.04] text-rc-text-secondary hover:bg-white/[0.08]",
                    )}
                  >
                    <div className="font-medium">{symbolNames[symbol] ?? symbol}</div>
                    {kline && (
                      <div className={cn("text-[11px] font-mono", getPriceColor(change))}>
                        ¥{kline.close.toFixed(2)} {formatPercent(change)}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* K-Line Chart */}
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

            {/* Mobile: Tabs + Panels */}
            <div className="lg:hidden space-y-3">
              <div className="flex p-1 bg-rc-surface-card rounded-[6px]">
                {[
                  { key: "order", label: "交易" },
                  { key: "position", label: "持仓" },
                  { key: "history", label: "记录" },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setActiveTab(key as typeof activeTab)}
                    className={cn(
                      "flex-1 py-1.5 text-[13px] text-center rounded-[6px] transition-opacity duration-150 tracking-[0.2px]",
                      activeTab === key
                        ? "bg-rc-surface-card text-white"
                        : "text-rc-text-secondary",
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

          {/* Right Panel (Desktop) */}
          <div className="hidden lg:block w-[380px] xl:w-[420px] border-l border-rc-border min-h-screen">
            <div className="sticky top-[88px] p-4 space-y-3 max-h-[calc(100vh-88px)] overflow-y-auto">
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
