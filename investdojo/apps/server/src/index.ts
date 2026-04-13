// ============================================================
// InvestDojo API Server — Hono + Node.js
// ============================================================

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { simulationRoutes } from "./routes/simulation";
import { aiRoutes } from "./routes/ai";

const app = new Hono();

// ------ 中间件 ------
app.use("*", logger());
app.use("*", cors({
  origin: ["http://localhost:3000", "http://localhost:3001"],
  allowMethods: ["GET", "POST", "PUT", "DELETE"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

// ------ 健康检查 ------
app.get("/health", (c) => c.json({ status: "ok", service: "investdojo-api", version: "0.1.0" }));

// ------ 路由 ------
app.route("/api/simulation", simulationRoutes);
app.route("/api/ai", aiRoutes);

// ------ 启动服务 ------
const port = parseInt(process.env.PORT ?? "4000", 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`🥋 InvestDojo API running at http://localhost:${info.port}`);
});

export default app;
