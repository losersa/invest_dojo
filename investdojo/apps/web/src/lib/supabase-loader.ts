// ============================================================
// Supabase 场景数据加载器（统一版）
// 从 klines_all 统一表加载所有周期的 K 线数据
// ============================================================

import { createClient } from "@supabase/supabase-js";
import type { ScenarioData, KLine, NewsItem } from "@investdojo/core";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

// ============ 场景数据加载 ============

/**
 * 从 Supabase 加载完整场景数据（日K + 场景元信息 + 新闻）
 */
export async function loadScenarioFromSupabase(
  scenarioId: string,
): Promise<ScenarioData | null> {
  console.log(`[Supabase] 加载场景: ${scenarioId}`);

  // 1. 加载场景元信息
  const { data: scenario, error: scenarioError } = await supabase
    .from("scenarios")
    .select("*")
    .eq("id", scenarioId)
    .single();

  if (scenarioError || !scenario) {
    console.error("[Supabase] 场景加载失败:", scenarioError?.message);
    return null;
  }

  // 2. 从 klines_all 加载日 K 数据
  const { data: klineRows, error: klineError } = await supabase
    .from("klines_all")
    .select("*")
    .eq("scenario_id", scenarioId)
    .eq("timeframe", "1d")
    .order("dt", { ascending: true });

  if (klineError) {
    console.error("[Supabase] K线加载失败:", klineError.message);
    return null;
  }

  // 3. 加载新闻数据
  const { data: newsRows, error: newsError } = await supabase
    .from("news")
    .select("*")
    .eq("scenario_id", scenarioId)
    .order("date", { ascending: true });

  if (newsError) {
    console.error("[Supabase] 新闻加载失败:", newsError.message);
    return null;
  }

  // 4. 转换日K数据
  const klines: Record<string, KLine[]> = {};
  for (const row of klineRows ?? []) {
    const symbol = row.symbol as string;
    if (!klines[symbol]) klines[symbol] = [];

    // dt 是 timestamptz，提取日期部分作为 date
    const dtStr = String(row.dt);
    const dateOnly = dtStr.slice(0, 10); // "2020-01-02"

    klines[symbol].push({
      date: dateOnly,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      turnover: Number(row.turnover),
      preClose: Number(row.pre_close ?? row.open),
      change: Number(row.change_amount ?? 0),
      changePercent: Number(row.change_percent ?? 0),
    });
  }

  // 5. 转换新闻数据
  const news: NewsItem[] = (newsRows ?? []).map((row) => ({
    id: row.id as string,
    date: row.date as string,
    title: row.title as string,
    content: (row.content ?? "") as string,
    source: (row.source ?? "") as string,
    category: (row.category ?? "news") as NewsItem["category"],
    sentiment: (row.sentiment ?? "neutral") as NewsItem["sentiment"],
    impactLevel: (row.impact_level ?? 2) as NewsItem["impactLevel"],
    relatedSymbols: row.related_symbols as string[] | undefined,
  }));

  const policies = news.filter((n) => n.category === "policy");
  const symbols = scenario.symbols as string[];

  const result: ScenarioData = {
    meta: {
      id: scenario.id,
      name: scenario.name,
      description: scenario.description ?? "",
      category: scenario.category,
      difficulty: scenario.difficulty ?? "medium",
      dateRange: {
        start: scenario.date_start,
        end: scenario.date_end,
      },
      symbols,
      initialCapital: Number(scenario.initial_capital),
      tags: scenario.tags ?? [],
    },
    klines,
    news,
    policies,
  };

  const totalKlines = Object.values(klines).reduce(
    (sum, arr) => sum + arr.length,
    0,
  );
  console.log(
    `[Supabase] ✅ 日K加载完成: ${totalKlines} 条, ${news.length} 条新闻`,
  );

  return result;
}

// ============ 分钟级 K 线加载 ============

/**
 * 从 klines_all 加载 5 分钟 K 线数据
 * 返回的 date 字段使用 Unix 时间戳（秒），兼容 Lightweight Charts
 */
export async function loadMinuteKlines(
  scenarioId: string,
  symbol: string,
  dateStart?: string,
  dateEnd?: string,
): Promise<KLine[]> {
  console.log(`[Supabase] 加载分钟K线: ${symbol} (${scenarioId})`);

  let query = supabase
    .from("klines_all")
    .select("*")
    .eq("scenario_id", scenarioId)
    .eq("symbol", symbol)
    .eq("timeframe", "5m")
    .order("dt", { ascending: true });

  if (dateStart) query = query.gte("dt", `${dateStart}T00:00:00`);
  if (dateEnd) query = query.lte("dt", `${dateEnd}T23:59:59`);

  // 分页加载（Supabase 默认 1000 行限制）
  const allRows: Array<Record<string, unknown>> = [];
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error) {
      console.error("[Supabase] 分钟K线加载失败:", error.message);
      break;
    }
    if (!data || data.length === 0) break;
    allRows.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  console.log(`[Supabase] 分钟K线: ${symbol} 共 ${allRows.length} 条`);

  // 关键：将 timestamptz 转为 Unix 秒数（Lightweight Charts 要求）
  return allRows.map((row) => {
    const dtStr = String(row.dt);
    // Supabase timestamptz 格式：2020-01-02T09:35:00+00:00
    const unixSec = Math.floor(new Date(dtStr).getTime() / 1000);

    return {
      date: String(unixSec), // Lightweight Charts 接受 number 或 string 的 unix timestamp
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      turnover: Number(row.turnover ?? 0),
      preClose: Number(row.open), // 分钟级无前收盘价
      change: 0,
      changePercent: 0,
    };
  });
}

/**
 * 检查某个场景是否有 5 分钟数据
 */
export async function has5minData(scenarioId: string): Promise<boolean> {
  const { count, error } = await supabase
    .from("klines_all")
    .select("id", { count: "exact", head: true })
    .eq("scenario_id", scenarioId)
    .eq("timeframe", "5m")
    .limit(1);

  const result = !error && (count ?? 0) > 0;
  console.log(`[Supabase] 5min数据检查 ${scenarioId}: ${result ? "✅ 有" : "❌ 无"} (${count ?? 0} 条)`);
  return result;
}

// ============ 分钟数据聚合工具 ============

/**
 * 将 5 分钟 K 线聚合为 15m / 1h / 4h
 * 输入的 klines.date 是 Unix 秒数字符串
 */
export function aggregateMinuteKlines(
  klines5m: KLine[],
  targetTimeframe: "15m" | "1h" | "4h",
): KLine[] {
  if (klines5m.length === 0) return [];

  // 每个目标周期包含多少个 5 分钟柱
  const barsPerGroup = { "15m": 3, "1h": 12, "4h": 48 }[targetTimeframe];

  const groups: Map<number, KLine[]> = new Map();

  for (const k of klines5m) {
    const unixSec = Number(k.date);
    const intervalSec = barsPerGroup * 5 * 60; // 聚合间隔秒数
    const groupKey = Math.floor(unixSec / intervalSec) * intervalSec;

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(k);
  }

  const result: KLine[] = [];
  const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);

  for (const key of sortedKeys) {
    const arr = groups.get(key)!;
    result.push({
      date: String(key), // Unix 秒
      open: arr[0].open,
      high: Math.max(...arr.map((a) => a.high)),
      low: Math.min(...arr.map((a) => a.low)),
      close: arr[arr.length - 1].close,
      volume: arr.reduce((s, a) => s + a.volume, 0),
      turnover: arr.reduce((s, a) => s + a.turnover, 0),
      preClose: arr[0].open,
      change: arr[arr.length - 1].close - arr[0].open,
      changePercent:
        arr[0].open > 0
          ? Math.round(
              ((arr[arr.length - 1].close - arr[0].open) / arr[0].open) * 10000,
            ) / 100
          : 0,
    });
  }

  console.log(`[聚合] 5m → ${targetTimeframe}: ${klines5m.length} → ${result.length} 条`);
  return result;
}
