// ============================================================
// 模拟相关 API 路由
// ============================================================

import { Hono } from "hono";

export const simulationRoutes = new Hono();

// 获取场景列表
simulationRoutes.get("/scenarios", (c) => {
  // TODO: 从数据库/文件系统读取场景列表
  return c.json([
    {
      id: "covid_2020",
      name: "2020 新冠疫情",
      category: "black_swan",
      difficulty: "medium",
      dateRange: { start: "2020-01-02", end: "2020-06-30" },
    },
    {
      id: "bull_2014",
      name: "2014-2015 疯牛行情",
      category: "bull_market",
      difficulty: "hard",
      dateRange: { start: "2014-07-01", end: "2015-09-30" },
    },
  ]);
});

// 获取场景详细数据
simulationRoutes.get("/scenarios/:id", async (c) => {
  const id = c.req.param("id");
  // TODO: 从 CDN / S3 / 本地加载预打包的场景数据
  return c.json({ id, message: "场景数据加载功能待实现（当前使用前端 mock 数据）" });
});

// 保存模拟进度
simulationRoutes.post("/progress", async (c) => {
  const body = await c.req.json();
  // TODO: 写入 Supabase
  console.log("[Save Progress]", body.scenarioId, body.currentDate);
  return c.json({ success: true });
});

// 获取用户的模拟历史
simulationRoutes.get("/history", (c) => {
  // TODO: 从 Supabase 读取
  return c.json([]);
});
