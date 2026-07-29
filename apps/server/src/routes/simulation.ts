// ============================================================
// 模拟相关 API 路由
// 从 data-svc（:8006）读取场景 / K线 / 新闻，替代原 Supabase PostgREST 直读。
// ============================================================

import { Hono } from "hono";

const DATA_SVC = process.env.DATA_SVC_URL ?? "http://localhost:8006";
const enc = encodeURIComponent;

export const simulationRoutes = new Hono();

// 获取场景列表
simulationRoutes.get("/scenarios", async (c) => {
  try {
    const res = await fetch(`${DATA_SVC}/api/v1/data/scenarios`);
    if (!res.ok) throw new Error(`data-svc ${res.status}`);
    const json = (await res.json()) as { data: Record<string, any>[] };
    const rows = json.data ?? [];
    return c.json(
      rows.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        category: s.category,
        difficulty: s.difficulty,
        dateRange: { start: s.date_start, end: s.date_end },
        symbols: s.symbols,
        initialCapital: Number(s.initial_capital),
        tags: s.tags ?? [],
      })),
    );
  } catch (e) {
    console.error("[API] 场景列表错误:", e);
    return c.json({ error: "加载场景列表失败" }, 500);
  }
});

// 获取场景详细数据（日K）
simulationRoutes.get("/scenarios/:id", async (c) => {
  const scenarioId = c.req.param("id");
  try {
    const res = await fetch(`${DATA_SVC}/api/v1/data/scenarios/${enc(scenarioId)}`);
    if (!res.ok) return c.json({ error: "场景不存在" }, 404);
    const json = (await res.json()) as { data: Record<string, any> };
    const scenario = json.data;
    if (!scenario) return c.json({ error: "场景不存在" }, 404);

    // 日K数据（分页拉全）
    const klines: Record<string, any[]> = {};
    let page = 1;
    const pageSize = 1000;
    let total = Infinity;
    let fetched = 0;
    while (fetched < total) {
      const url =
        `${DATA_SVC}/api/v1/data/klines?symbols=${enc((scenario.symbols ?? []).join(","))}` +
        `&timeframe=1d&scenario_id=${enc(scenarioId)}&page=${page}&page_size=${pageSize}`;
      const klRes = await fetch(url);
      if (!klRes.ok) break;
      const klJson = (await klRes.json()) as { data: any[]; pagination: { total: number } };
      const rows = klJson.data ?? [];
      total = klJson.pagination?.total ?? rows.length;
      for (const row of rows) {
        const sym = row.symbol;
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

    return c.json({
      meta: {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        category: scenario.category,
        difficulty: scenario.difficulty,
        dateRange: { start: scenario.date_start, end: scenario.date_end },
        symbols: scenario.symbols,
        initialCapital: Number(scenario.initial_capital),
        tags: scenario.tags ?? [],
      },
      klines,
      news: [],
      policies: [],
    });
  } catch (e) {
    console.error("[API] 场景数据错误:", e);
    return c.json({ error: "加载场景数据失败" }, 500);
  }
});

// 获取分钟级K线（5m/15m/1h/4h 等）
simulationRoutes.get("/klines/:scenarioId/:symbol", async (c) => {
  const { scenarioId, symbol } = c.req.param();
  const timeframe = c.req.query("timeframe") ?? "5m";
  const dateStart = c.req.query("start");
  const dateEnd = c.req.query("end");

  const params = new URLSearchParams({
    symbols: symbol,
    timeframe: ["15m", "1h", "4h"].includes(timeframe) ? "5m" : timeframe,
    scenario_id: scenarioId,
  });
  if (dateStart) params.set("start", dateStart);
  if (dateEnd) params.set("end", dateEnd);

  try {
    const res = await fetch(`${DATA_SVC}/api/v1/data/klines?${params.toString()}`);
    if (!res.ok) return c.json({ error: "加载K线数据失败" }, 500);
    const json = (await res.json()) as { data: any[] };
    const allRows = json.data ?? [];
    const klines = allRows.map((row) => {
      const unixSec = Math.floor(new Date(String(row.dt)).getTime() / 1000);
      return {
        date: String(unixSec),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume),
        turnover: Number(row.turnover ?? 0),
      };
    });

    return c.json({ scenarioId, symbol, timeframe, count: klines.length, klines });
  } catch (e) {
    console.error("[API] K线数据错误:", e);
    return c.json({ error: "加载K线数据失败" }, 500);
  }
});

// 保存模拟进度
simulationRoutes.post("/progress", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  console.log("[Save Progress]", body.scenarioId, body.currentDate);
  // TODO: 写入用户进度表（待接入自建鉴权后的用户体系）
  return c.json({ success: true });
});

// 获取用户的模拟历史
simulationRoutes.get("/history", (c) => {
  // TODO: 从用户进度表读取
  return c.json([]);
});
