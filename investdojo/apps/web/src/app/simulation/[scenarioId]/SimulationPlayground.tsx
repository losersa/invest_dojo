"use client";

// ============================================================
// 模拟交易主页面 — 核心游戏循环
// K线回放 + 新闻 + 交易面板 + 持仓 + 推进日期
// ============================================================

import React, { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { useSimulationStore } from "@/stores/simulation";
import { KLineChart } from "@investdojo/ui/charts";
import { OrderPanel, PositionList, NewsTimeline, TradeHistory } from "@investdojo/ui/trading";
import { formatMoney, formatPercent, getPriceColor, cn } from "@investdojo/ui";
import { generateMockScenario } from "@/lib/mock-data";

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

  // 加载场景数据
  useEffect(() => {
    const data = generateMockScenario(scenarioId);
    loadScenario(data);
    setSelectedSymbol(data.meta.symbols[0] ?? "");

    return () => reset();
  }, [scenarioId, loadScenario, reset]);

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

  // 推进日期
  const handleAdvance = useCallback(() => {
    advanceDay();
  }, [advanceDay]);

  // 场景结束
  const handleFinish = useCallback(() => {
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

  // 获取当前选中的股票名称
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
                  <span>📅 {currentDate}</span>
                  <span>
                    第 {progress.dayIndex + 1} / {progress.totalDays} 天
                  </span>
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
                <button
                  onClick={handleAdvance}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-1"
                >
                  下一天 →
                </button>
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
                    onClick={() => setSelectedSymbol(symbol)}
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
              klines={visibleKlines[selectedSymbol] ?? []}
              news={visibleNews.filter((n) =>
                n.relatedSymbols?.includes(selectedSymbol) || !n.relatedSymbols,
              )}
              currentDate={currentDate}
              height={460}
            />

            {/* 移动端：新闻 + 交易（折叠） */}
            <div className="lg:hidden space-y-4">
              {/* 移动端 Tab 切换 */}
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
              {/* 交易面板 */}
              <OrderPanel
                symbol={selectedSymbol}
                symbolName={selectedName}
                currentKline={selectedKline}
                position={selectedPosition}
                availableCash={portfolio.cash}
                onBuy={handleBuy}
                onSell={handleSell}
              />

              {/* 持仓列表 */}
              <PositionList
                portfolio={portfolio}
                selectedSymbol={selectedSymbol}
                onSelectPosition={setSelectedSymbol}
              />

              {/* 新闻时间线 */}
              <NewsTimeline news={visibleNews} maxItems={15} />

              {/* 交易记录 */}
              <TradeHistory trades={tradeHistory} maxItems={20} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
