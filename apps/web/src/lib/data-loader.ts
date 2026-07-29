// ============================================================
// 场景数据加载器（统一版）
// 从 data-svc 加载场景 / K线 / 新闻（替代原 Supabase PostgREST 直读）。
// 统一前缀：/svc/data/api/v1/data（经 Next 中间件代理到 data-svc :8006）
// ============================================================

import type { ScenarioData, KLine, NewsItem } from "@investdojo/core";

const DATA = "/svc/data/api/v1/data";

async function getJSON<T = any>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const enc = encodeURIComponent;

/**
 * 从 data-svc 加载完整场景数据（日K + 场景元信息 + 新闻）
 */
export async function loadScenarioData(
  scenarioId: string,
): Promise<ScenarioData | null> {
  const metaRes = await getJSON<{ data: Record<string, any> }>(
    `${DATA}/scenarios/${enc(scenarioId)}`,
  );
  const s = metaRes?.data;
  if (!s) return null;

  const symbols: string[] = s.symbols ?? [];

  // 1. 日 K 数据（分页拉全）
  const klines: Record<string, KLine[]> = {};
  let page = 1;
  const pageSize = 1000;
  let total = Infinity;
  let fetched = 0;
  while (fetched < total) {
    const url =
      `${DATA}/klines?symbols=${enc(symbols.join(","))}&timeframe=1d` +
      `&scenario_id=${enc(scenarioId)}&page=${page}&page_size=${pageSize}`;
    const klRes = await getJSON<{ data: Record<string, any>[]; pagination: { total: number } }>(url);
    const rows = klRes?.data ?? [];
    total = klRes?.pagination?.total ?? rows.length;
    for (const row of rows) {
      const sym = row.symbol as string;
      if (!klines[sym]) klines[sym] = [];
      klines[sym].push({
        date: String(row.dt).slice(0, 10),
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
    fetched += rows.length;
    if (rows.length === 0) break;
    page++;
  }

  // 2. 新闻数据（分页拉全）
  const news: NewsItem[] = [];
  page = 1;
  total = Infinity;
  fetched = 0;
  while (fetched < total) {
    const url =
      `${DATA}/news?scenario_id=${enc(scenarioId)}&page=${page}&page_size=${pageSize}`;
    const nRes = await getJSON<{ data: Record<string, any>[]; pagination: { total: number } }>(url);
    const rows = nRes?.data ?? [];
    total = nRes?.pagination?.total ?? rows.length;
    for (const row of rows) {
      news.push({
        id: String(row.id),
        date: String(row.published_at ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        source: String(row.source ?? ""),
        category: (row.category ?? "news") as NewsItem["category"],
        sentiment: (row.sentiment ?? "neutral") as NewsItem["sentiment"],
        impactLevel: Number(row.impact_level ?? 2) as NewsItem["impactLevel"],
        relatedSymbols: row.related_symbols as string[] | undefined,
      });
    }
    fetched += rows.length;
    if (rows.length === 0) break;
    page++;
  }

  const policies = news.filter((n) => n.category === "policy");

  const result: ScenarioData = {
    meta: {
      id: s.id,
      name: s.name,
      description: s.description ?? "",
      category: s.category,
      difficulty: s.difficulty ?? "medium",
      dateRange: { start: s.date_start, end: s.date_end },
      symbols,
      initialCapital: Number(s.initial_capital),
      tags: s.tags ?? [],
    },
    klines,
    news,
    policies,
  };

  return result;
}

/**
 * 从 data-svc 加载 5 分钟 K 线数据（用于模拟盘日内播放）
 */
export async function loadMinuteKlines(
  scenarioId: string,
  symbol: string,
  dateStart?: string,
  dateEnd?: string,
): Promise<KLine[]> {
  const params = new URLSearchParams({
    symbols: symbol,
    timeframe: "5m",
    scenario_id: scenarioId,
  });
  if (dateStart) params.set("start", dateStart);
  if (dateEnd) params.set("end", dateEnd);

  const res = await getJSON<{ data: Record<string, any>[] }>(
    `${DATA}/klines?${params.toString()}`,
  );
  const rows = res?.data ?? [];

  // 将 timestamptz 转为 Unix 秒数（Lightweight Charts 要求）
  return rows.map((row) => {
    const dtStr = String(row.dt);
    const unixSec = Math.floor(new Date(dtStr).getTime() / 1000);
    return {
      date: String(unixSec),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      turnover: Number(row.turnover ?? 0),
      preClose: Number(row.open),
      change: 0,
      changePercent: 0,
    };
  });
}

/**
 * 检查某个场景是否有 5 分钟数据
 */
export async function has5minData(scenarioId: string): Promise<boolean> {
  try {
    // 先取场景元信息拿股票列表
    const metaRes = await getJSON<{ data: Record<string, any> }>(
      `${DATA}/scenarios/${enc(scenarioId)}`,
    );
    const symbols: string[] = metaRes?.data?.symbols ?? [];
    if (symbols.length === 0) return false;

    const params = new URLSearchParams({
      symbols: symbols.join(","),
      timeframe: "5m",
      scenario_id: scenarioId,
      page_size: "1",
    });
    const res = await getJSON<{ pagination: { total: number } }>(
      `${DATA}/klines?${params.toString()}`,
    );
    return (res?.pagination?.total ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 将 5 分钟 K 线聚合为 15m / 1h / 4h（纯函数，与后端无关）
 * 输入的 klines.date 是 Unix 秒数字符串
 */
export function aggregateMinuteKlines(
  klines5m: KLine[],
  targetTimeframe: "15m" | "1h" | "4h" | "1d" | "1w" | "1M",
): KLine[] {
  if (klines5m.length === 0) return [];

  // 高频周期：按固定 5m 柱数量分组
  if (targetTimeframe === "15m" || targetTimeframe === "1h" || targetTimeframe === "4h") {
    const barsPerGroup = { "15m": 3, "1h": 12, "4h": 48 }[targetTimeframe];
    const groups: Map<number, KLine[]> = new Map();

    for (const k of klines5m) {
      const unixSec = Number(k.date);
      const intervalSec = barsPerGroup * 5 * 60;
      const groupKey = Math.floor(unixSec / intervalSec) * intervalSec;
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey)!.push(k);
    }

    const result: KLine[] = [];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => a - b);

    for (const key of sortedKeys) {
      const arr = groups.get(key)!;
      result.push({
        date: String(key),
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

    return result;
  }

  // 日/周/月 K：按日期字符串分组
  const groups: Map<string, KLine[]> = new Map();

  for (const k of klines5m) {
    const unixSec = Number(k.date);
    const d = new Date(unixSec * 1000);
    let key: string;

    if (targetTimeframe === "1d") {
      key = d.toISOString().slice(0, 10);
    } else if (targetTimeframe === "1w") {
      const day = d.getDay();
      const mondayOffset = day === 0 ? -6 : 1 - day;
      const monday = new Date(d.getTime() + mondayOffset * 86400000);
      key = monday.toISOString().slice(0, 10);
    } else {
      key = d.toISOString().slice(0, 7) + "-01";
    }

    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(k);
  }

  const result: KLine[] = [];
  const sortedKeys = Array.from(groups.keys()).sort();

  for (const key of sortedKeys) {
    const arr = groups.get(key)!;
    result.push({
      date: key,
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

  return result;
}
