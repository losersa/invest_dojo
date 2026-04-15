// ============================================================
// 模拟相关 API 路由
// 支持从 Supabase klines_all 统一表查询多周期数据
// ============================================================

import { Hono } from "hono";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function getSupabase() {
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, supabaseKey);
}

export const simulationRoutes = new Hono();

// 获取场景列表
simulationRoutes.get("/scenarios", async (c) => {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from("scenarios")
      .select("id, name, description, category, difficulty, date_start, date_end, symbols, initial_capital, tags")
      .order("id");

    if (error) throw error;

    return c.json(
      (data ?? []).map((s) => ({
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
    const supabase = getSupabase();

    // 加载场景元信息
    const { data: scenario, error: sErr } = await supabase
      .from("scenarios")
      .select("*")
      .eq("id", scenarioId)
      .single();

    if (sErr || !scenario) {
      return c.json({ error: "场景不存在" }, 404);
    }

    // 加载日K数据
    const { data: klineRows, error: kErr } = await supabase
      .from("klines_all")
      .select("*")
      .eq("scenario_id", scenarioId)
      .eq("timeframe", "1d")
      .order("dt", { ascending: true });

    if (kErr) throw kErr;

    // 加载新闻
    const { data: newsRows, error: nErr } = await supabase
      .from("news")
      .select("*")
      .eq("scenario_id", scenarioId)
      .order("date", { ascending: true });

    if (nErr) throw nErr;

    // 组装返回数据
    const klines: Record<string, unknown[]> = {};
    for (const row of klineRows ?? []) {
      const symbol = row.symbol;
      if (!klines[symbol]) klines[symbol] = [];
      klines[symbol].push({
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
      news: newsRows ?? [],
      policies: (newsRows ?? []).filter((n: { category?: string }) => n.category === "policy"),
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

  try {
    const supabase = getSupabase();

    let query = supabase
      .from("klines_all")
      .select("*")
      .eq("scenario_id", scenarioId)
      .eq("symbol", symbol)
      .eq("timeframe", timeframe === "15m" || timeframe === "1h" || timeframe === "4h" ? "5m" : timeframe)
      .order("dt", { ascending: true });

    if (dateStart) query = query.gte("dt", `${dateStart}T00:00:00`);
    if (dateEnd) query = query.lte("dt", `${dateEnd}T23:59:59`);

    // 分页加载
    const allRows: unknown[] = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    // 转换为前端格式
    const klines = allRows.map((row: unknown) => {
      const r = row as Record<string, unknown>;
      const unixSec = Math.floor(new Date(String(r.dt)).getTime() / 1000);
      return {
        date: String(unixSec),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
        turnover: Number(r.turnover ?? 0),
      };
    });

    return c.json({
      scenarioId,
      symbol,
      timeframe,
      count: klines.length,
      klines,
    });
  } catch (e) {
    console.error("[API] K线数据错误:", e);
    return c.json({ error: "加载K线数据失败" }, 500);
  }
});

// 保存模拟进度
simulationRoutes.post("/progress", async (c) => {
  const body = await c.req.json();
  console.log("[Save Progress]", body.scenarioId, body.currentDate);
  // TODO: 写入 Supabase user_progress 表
  return c.json({ success: true });
});

// 获取用户的模拟历史
simulationRoutes.get("/history", (c) => {
  // TODO: 从 Supabase 读取
  return c.json([]);
});
