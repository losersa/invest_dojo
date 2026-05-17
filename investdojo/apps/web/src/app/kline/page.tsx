"use client";

/**
 * 股票 K 线浏览页
 *
 * 路由：/kline?symbol=600519&tf=5m&start=2026-02-01&end=2026-02-10
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { KLineChart, type TimeFrame } from "@investdojo/ui/charts";
import type { KLine, Timeframe } from "@investdojo/api";
import { sdk } from "@/lib/sdk";
import { MainNav } from "@/components/MainNav";
import { useFavoriteFactors } from "@/hooks/useFavoriteFactors";
import { Suspense } from "react";

// ── 工具函数 ──

function dtToBeijingUnix(dt: string): number {
  const ms = new Date(dt).getTime();
  return Math.floor(ms / 1000) + 8 * 3600;
}

function dtToDate(dt: string): string {
  if (dt.includes("+08:00") || dt.includes("T")) {
    const d = new Date(dt);
    const bj = new Date(d.getTime() + 8 * 3600000);
    return bj.toISOString().slice(0, 10);
  }
  return dt.slice(0, 10);
}

function aggregate5mTo(klines: KLine[], targetTf: TimeFrame): KLine[] {
  if (klines.length === 0) return [];

  let groupKeyFn: (dt: string) => string;
  switch (targetTf) {
    case "15m":
      groupKeyFn = (dt) => {
        const d = new Date(dt);
        const bj = new Date(d.getTime() + 8 * 3600000);
        const h = bj.getUTCHours();
        const m = Math.floor(bj.getUTCMinutes() / 15) * 15;
        return `${bj.toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      };
      break;
    case "1h":
      groupKeyFn = (dt) => {
        const d = new Date(dt);
        const bj = new Date(d.getTime() + 8 * 3600000);
        const h = bj.getUTCHours();
        return `${bj.toISOString().slice(0, 10)}T${String(h).padStart(2, "0")}:00`;
      };
      break;
    case "1d":
      groupKeyFn = (dt) => dtToDate(dt);
      break;
    case "1w":
      groupKeyFn = (dt) => {
        const d = new Date(dtToDate(dt));
        const day = d.getDay();
        const mondayOffset = day === 0 ? -6 : 1 - day;
        const monday = new Date(d.getTime() + mondayOffset * 86400000);
        return monday.toISOString().slice(0, 10);
      };
      break;
    default:
      return klines;
  }

  const groups = new Map<string, KLine[]>();
  for (const k of klines) {
    const key = groupKeyFn(k.dt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(k);
  }

  const result: KLine[] = [];
  for (const [, bars] of groups) {
    if (bars.length === 0) continue;
    result.push({
      symbol: bars[0].symbol,
      timeframe: targetTf as Timeframe,
      dt: bars[0].dt,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((s, b) => s + b.volume, 0),
    });
  }
  return result;
}

const DEFAULT_START = "2026-02-01";
const DEFAULT_END = "2026-02-28";
const STORAGE_KEY = "investdojo_kline_state";

/** 从 localStorage 读取上次的状态 */
function loadSavedState(): { symbol: string; tf: string; start: string; end: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

/** 保存状态到 localStorage */
function saveState(sym: string, tf: string, start: string, end: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ symbol: sym, tf, start, end }));
  } catch {}
}

function KlinePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 优先从 URL 读取，其次从 localStorage，最后用默认值
  const saved = loadSavedState();
  const hasUrlParams = searchParams.has("symbol") || searchParams.has("tf");
  const initSymbol = hasUrlParams ? (searchParams.get("symbol") || "600519") : (saved?.symbol || "600519");
  const initTf = hasUrlParams ? ((searchParams.get("tf") as TimeFrame) || "5m") : ((saved?.tf as TimeFrame) || "5m");
  const initStart = hasUrlParams ? (searchParams.get("start") || DEFAULT_START) : (saved?.start || DEFAULT_START);
  const initEnd = hasUrlParams ? (searchParams.get("end") || DEFAULT_END) : (saved?.end || DEFAULT_END);

  const [symbolInput, setSymbolInput] = useState(initSymbol);
  const [symbol, setSymbol] = useState(initSymbol);
  const [symbolName, setSymbolName] = useState("");
  const [timeframe, setTimeframe] = useState<TimeFrame>(initTf);
  const [startDate, setStartDate] = useState(initStart);
  const [endDate, setEndDate] = useState(initEnd);

  const [rawKlines, setRawKlines] = useState<KLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 同步状态到 URL
  const syncUrl = useCallback(
    (sym: string, tf: string, start: string, end: string) => {
      const params = new URLSearchParams({ symbol: sym, tf, start, end });
      router.replace(`/kline?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  const fetchSymbolName = useCallback(async (code: string) => {
    try {
      const resp = await fetch(`http://192.168.1.3:8006/api/v1/data/symbols/${code}`);
      if (resp.ok) {
        const data = await resp.json();
        setSymbolName(data.data?.name || "");
      } else {
        setSymbolName("");
      }
    } catch {
      setSymbolName("");
    }
  }, []);

  // 每种时间框架的合理最大查询天数
  const maxDaysMap: Record<string, number> = {
    "5m": 60, "15m": 90, "1h": 120, "1d": 365, "1w": 730,
  };

  const fetchKlines = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      const totalDays = (endMs - startMs) / 86400000;
      const maxDays = maxDaysMap[timeframe] || 30;

      // 如果范围过大，从结束日期往前截取
      let queryStart = startDate;
      if (totalDays > maxDays) {
        queryStart = new Date(endMs - maxDays * 86400000).toISOString().slice(0, 10);
      }

      // 分页拉取
      let allData: KLine[] = [];
      for (let page = 1; page <= 5; page++) {
        if (page > 1) await new Promise((r) => setTimeout(r, 100));
        try {
          const result = await sdk.data.getKlines({
            symbols: [symbol], timeframe: "5m",
            start: queryStart, end: endDate,
            page_size: 1000, page,
          });
          const d = result.data || [];
          allData = allData.concat(d);
          if (d.length < 1000) break;
        } catch { break; }
      }

      setRawKlines(allData);

      if (totalDays > maxDays) {
        setError(`${timeframe} 模式下最多展示 ${maxDays} 天数据，已自动加载 ${queryStart} ~ ${endDate}`);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setRawKlines([]);
    } finally {
      setLoading(false);
    }
  }, [symbol, startDate, endDate, timeframe]);

  useEffect(() => {
    fetchKlines();
    fetchSymbolName(symbol);
  }, [symbol, startDate, endDate, fetchKlines, fetchSymbolName]);

  // 状态变化 → 同步 URL + localStorage
  useEffect(() => {
    syncUrl(symbol, timeframe, startDate, endDate);
    saveState(symbol, timeframe, startDate, endDate);
  }, [symbol, timeframe, startDate, endDate, syncUrl]);

  // 切换时间频率：只改 timeframe，不重置日期
  const handleTimeFrameChange = (tf: TimeFrame) => {
    setTimeframe(tf);
  };

  const handleSearch = () => {
    const code = symbolInput.trim();
    if (code && code !== symbol) {
      setSymbol(code);
    }
  };

  const chartKlines = useMemo(() => {
    const aggregated = timeframe === "5m" ? rawKlines : aggregate5mTo(rawKlines, timeframe);
    const isMinute = ["5m", "15m", "1h"].includes(timeframe);
    return aggregated.map((k) => {
      const date = isMinute ? dtToBeijingUnix(k.dt) : dtToDate(k.dt);
      return { ...k, date } as unknown as KLine;
    });
  }, [rawKlines, timeframe]);

  const availableTimeFrames: TimeFrame[] = ["5m", "15m", "1h", "1d", "1w"];

  return (
    <div className="min-h-screen bg-black text-white">
      <MainNav />

      <div className="max-w-[1400px] mx-auto px-6 py-6">
        {/* 搜索区 */}
        <div className="flex items-center gap-4 mb-6 flex-wrap">
          <div className="flex items-center gap-2">
            <input
              value={symbolInput}
              onChange={(e) => setSymbolInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="输入股票代码"
              className="bg-[#111] border border-[#333] rounded px-3 py-2 text-white font-mono text-sm w-32 focus:border-[#555] focus:outline-none"
            />
            <button
              onClick={handleSearch}
              className="bg-[#1e3a5a] text-[#7fa8e3] border border-[#2c5580] px-4 py-2 rounded text-sm hover:bg-[#254a6e] transition"
            >
              查询
            </button>
          </div>

          <div className="text-lg font-medium">
            <span className="text-white font-mono">{symbol}</span>
            {symbolName && <span className="text-[#888] ml-2">{symbolName}</span>}
          </div>

          <div className="flex-1" />

          {/* 日期选择器 - 深色主题适配 */}
          <div className="flex items-center gap-2 text-sm">
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="bg-[#111] border border-[#333] rounded px-2 py-1.5 text-white text-xs [color-scheme:dark]"
            />
            <span className="text-[#555]">~</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="bg-[#111] border border-[#333] rounded px-2 py-1.5 text-white text-xs [color-scheme:dark]"
            />
          </div>
        </div>

        {/* 数据信息 */}
        <div className="flex items-center gap-1 mb-4">
          <span className="text-[#555] text-xs">
            {loading
              ? "加载中..."
              : `${chartKlines.length} 根K线 (原始 ${rawKlines.length} 条 5m 数据)`}
          </span>
        </div>

        {error && (
          <div className={`rounded p-3 mb-4 text-sm ${
            error.includes("最多展示")
              ? "bg-[#2a2a10] border border-[#5a5a20] text-[#e8d44d]"
              : "bg-[#2a1010] border border-[#5a2020] text-[#ff9b9b]"
          }`}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="border border-[#1a1a1a] rounded-lg bg-[#0a0a0a] h-[560px] flex items-center justify-center">
            <div className="text-center">
              <div className="inline-block w-8 h-8 border-2 border-[#333] border-t-[#7fa8e3] rounded-full animate-spin mb-3" />
              <p className="text-[#555] text-sm">加载 K 线数据中...</p>
            </div>
          </div>
        ) : chartKlines.length > 0 ? (
          <div className="border border-[#1a1a1a] rounded-lg overflow-hidden bg-[#0a0a0a]">
            <KLineChart
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              klines={chartKlines as any}
              height={560}
              timeFrame={timeframe}
              availableTimeFrames={availableTimeFrames}
              onTimeFrameChange={handleTimeFrameChange}
              visibleBars={
                ["5m", "15m"].includes(timeframe) ? 120
                  : ["1h", "4h"].includes(timeframe) ? 80
                  : timeframe === "1d" ? 60
                  : 52
              }
            />
          </div>
        ) : (
          !loading && !error && (
            <div className="text-center py-20 text-[#555]">
              <p className="text-lg mb-2">暂无数据</p>
              <p className="text-sm">当前只有 5 分钟线数据（2026-02 月），请调整日期范围</p>
            </div>
          )
        )}

        {/* 已收藏因子信号 */}
        <FavoriteFactorsPanel symbol={symbol} start={startDate} end={endDate} />

        {/* 常用股票 */}
        <div className="mt-6 flex items-center gap-2 flex-wrap">
          <span className="text-[#555] text-xs">常用：</span>
          {[
            { code: "600519", name: "贵州茅台" },
            { code: "000001", name: "平安银行" },
            { code: "300750", name: "宁德时代" },
            { code: "600036", name: "招商银行" },
            { code: "000858", name: "五粮液" },
            { code: "601318", name: "中国平安" },
            { code: "002594", name: "比亚迪" },
            { code: "600276", name: "恒瑞医药" },
          ].map((s) => (
            <button
              key={s.code}
              onClick={() => { setSymbolInput(s.code); setSymbol(s.code); }}
              className={`px-2 py-1 rounded text-xs transition ${
                symbol === s.code
                  ? "bg-[#1e3a5a] text-[#7fa8e3] border border-[#2c5580]"
                  : "bg-[#111] text-[#888] border border-[#222] hover:text-white hover:border-[#444]"
              }`}
            >
              {s.code} {s.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 收藏因子信号面板 ──
function FavoriteFactorsPanel({ symbol, start, end }: { symbol: string; start: string; end: string }) {
  const { favorites } = useFavoriteFactors();
  const [results, setResults] = useState<Record<string, { name: string; triggered: boolean; value?: number }>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (favorites.length === 0) { setResults({}); return; }

    const compute = async () => {
      setLoading(true);
      const newResults: typeof results = {};

      for (const factorId of favorites) {
        try {
          const resp = await fetch(`http://192.168.1.3:8001/api/v1/factors/compute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              factor_id: factorId,
              symbols: [symbol],
              start: end, // 只算最后一天
              end: end,
            }),
          });
          if (resp.ok) {
            const json = await resp.json();
            const rows = json.data || [];
            const lastRow = rows[rows.length - 1];
            // 获取因子名称
            const metaResp = await fetch(`http://192.168.1.3:8001/api/v1/factors/${factorId}`);
            const metaJson = metaResp.ok ? await metaResp.json() : null;
            const name = metaJson?.data?.name || factorId;

            if (lastRow) {
              newResults[factorId] = {
                name,
                triggered: lastRow.value === true,
                value: typeof lastRow.value === "number" ? lastRow.value : undefined,
              };
            } else {
              newResults[factorId] = { name, triggered: false };
            }
          }
        } catch {
          // 跳过失败的因子
        }
      }
      setResults(newResults);
      setLoading(false);
    };

    compute();
  }, [favorites, symbol, end]);

  if (favorites.length === 0) return null;

  return (
    <div className="mt-4 border border-[#1a1a1a] rounded-lg bg-[#0a0a0a] p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm text-white font-medium">已收藏因子信号</h3>
        <span className="text-[#555] text-xs">
          {loading ? "计算中..." : `${favorites.length} 个因子 · ${end}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {favorites.map((fid) => {
          const r = results[fid];
          if (!r) return (
            <span key={fid} className="px-3 py-1.5 rounded text-xs bg-[#111] border border-[#222] text-[#555]">
              {fid}
            </span>
          );
          return (
            <span
              key={fid}
              className={`px-3 py-1.5 rounded text-xs border ${
                r.triggered
                  ? "bg-red-900/30 border-red-700/50 text-red-300"
                  : r.value !== undefined
                  ? "bg-blue-900/20 border-blue-700/40 text-blue-300"
                  : "bg-[#111] border-[#333] text-[#888]"
              }`}
              title={r.value !== undefined ? `值: ${r.value.toFixed(4)}` : r.triggered ? "触发" : "未触发"}
            >
              {r.triggered && "● "}
              {r.name}
              {r.value !== undefined && ` = ${r.value.toFixed(2)}`}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export default function KlinePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-black" />}>
      <KlinePageInner />
    </Suspense>
  );
}
