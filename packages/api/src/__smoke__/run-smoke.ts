/**
 * SDK smoke test — 对真实 backend 打接口，验证类型和调用路径
 *
 * 前置条件：所有 6 个 svc 正在运行（make dev）
 * 运行：
 *   pnpm --filter @investdojo/api exec tsx src/__smoke__/run-smoke.ts
 * 或：
 *   npx tsx packages/api/src/__smoke__/run-smoke.ts
 */
import {
  ApiError,
  createInvestDojoClient,
} from "../index";

const sdk = createInvestDojoClient();

function title(s: string) {
  console.log("\n\x1b[36m" + "═".repeat(60) + "\x1b[0m");
  console.log("\x1b[36m" + s + "\x1b[0m");
  console.log("\x1b[36m" + "═".repeat(60) + "\x1b[0m");
}

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    console.log(`  ✅ ${name}`);
    return r;
  } catch (e) {
    if (e instanceof ApiError) {
      console.log(`  ❌ ${name} · ApiError ${e.status} ${e.code}: ${e.message}`);
    } else {
      console.log(`  ❌ ${name} · ${(e as Error).message}`);
    }
    return undefined;
  }
}

async function main() {
  title("1. Monitor · overview");
  const ov = await safe("monitor.getOverview", () => sdk.monitor.getOverview());
  if (ov) {
    console.log(`     overall=${ov.data.summary.overall}`);
    console.log(`     services ok=${ov.data.summary.services_ok}/${ov.data.summary.services_total}`);
    console.log(`     symbols=${ov.data.stats.symbols}  factors=${ov.data.stats.factor_definitions}`);
  }

  title("2. Data · getSymbol / getKlines / getMarketSnapshot");
  const sym = await safe("data.getSymbol(600519)", () => sdk.data.getSymbol("600519"));
  if (sym) console.log(`     ${sym.data.code} ${sym.data.name} ${sym.data.industry}`);

  const kl = await safe("data.getKlines 茅台 2024-01-02~01-05", () =>
    sdk.data.getKlines({
      symbols: ["600519"],
      start: "2024-01-02",
      end: "2024-01-05",
    }),
  );
  if (kl) {
    console.log(`     got ${kl.data.length} bars, dt=${kl.data[0]?.dt} close=${kl.data[0]?.close}`);
  }

  const ms = await safe("data.getMarketSnapshot 2020-03-23", () =>
    sdk.data.getMarketSnapshot({ date: "2020-03-23" }),
  );
  if (ms) {
    console.log(`     上证 close=${ms.data.indexes?.sh000001?.close} north=${ms.data.north_capital}`);
    console.log(`     advance/decline: ${JSON.stringify(ms.data.advance_decline)}`);
  }

  title("3. Factor · listCategories / listFactors");
  const cats = await safe("factors.listCategories", () => sdk.factors.listCategories());
  if (cats) {
    for (const c of cats.data) {
      if (c.count > 0) console.log(`     ${c.category} ${c.label}: ${c.count}`);
    }
  }
  const factors = await safe('factors.listFactors tags=["趋势"]', () =>
    sdk.factors.listFactors({ tags: ["趋势"] }),
  );
  if (factors) {
    console.log(`     total=${factors.pagination.total}`);
    for (const f of factors.data) console.log(`     ${f.id} ${f.name}`);
  }

  title("4. Inference · listMockModels / predict");
  const models = await safe("inference.listMockModels", () => sdk.inference.listMockModels());
  if (models) console.log(`     models=${models.data.map((m) => m.model_id).join(", ")}`);

  const pred = await safe("inference.predict 茅台+平安 as_of=2024-03-15", () =>
    sdk.inference.predict({
      model_id: "mock_momentum_v1",
      symbols: ["600519", "000001"],
      as_of: "2024-03-15T15:00:00Z",
      include_explanation: true,
    }),
  );
  if (pred) {
    for (const s of pred.data.signals) {
      console.log(
        `     ${s.symbol} ${s.action} score=${s.score} conf=${s.confidence} thesis=${s.explanation?.thesis}`,
      );
    }
  }

  // ApiError 测试：缺 as_of
  try {
    await sdk.inference.predict({
      model_id: "mock_momentum_v1",
      symbols: ["600519"],
      as_of: "",
    });
    console.log("  ❌ 应该抛异常");
  } catch (e) {
    console.log(`  ✅ 缺 as_of 被客户端拦下: ${(e as Error).message}`);
  }

  title("5. Backtest · runFast / listBacktests");
  const bt = await safe("backtests.runFast", () =>
    sdk.backtests.runFast({
      mode: "fast",
      strategy: { type: "model", model_id: "mock_momentum_v1" },
      start: "2023-01-01",
      end: "2023-03-31",
      universe: "hs300",
    }),
  );
  if (bt) {
    console.log(`     id=${bt.data.id}`);
    console.log(
      `     total_return=${bt.data.summary.total_return} sharpe=${bt.data.summary.sharpe} mdd=${bt.data.summary.max_drawdown}`,
    );
    console.log(`     equity_curve ${bt.data.equity_curve.dates.length} 天`);
  }

  const bts = await safe("backtests.listBacktests", () =>
    sdk.backtests.listBacktests({ page_size: 3 }),
  );
  if (bts) console.log(`     total=${bts.pagination.total}`);

  title("6. Train · createJob + 轮询 getJob");
  const created = await safe("training.createJob (dummy)", () =>
    sdk.training.createJob({
      config: { algorithm: "dummy", simulated_duration_sec: 2 },
    }),
  );
  if (created) {
    console.log(`     job_id=${created.data.job_id}`);
    // 等 3 秒让它跑完
    await new Promise((r) => setTimeout(r, 3500));
    const job = await safe("training.getJob", () => sdk.training.getJob(created.data.job_id));
    if (job) {
      console.log(`     status=${job.data.status} stage=${job.data.stage} progress=${job.data.progress}`);
    }
  }

  title("7. Monitor · stats / services");
  const stats = await safe("monitor.getStats", () => sdk.monitor.getStats());
  if (stats) console.log(`     snapshot: symbols=${stats.data.symbols} fundamentals=${stats.data.fundamentals}`);

  const svcs = await safe("monitor.listServices", () => sdk.monitor.listServices());
  if (svcs) {
    for (const s of svcs.data) {
      const icon = s.status === "ok" ? "✅" : "❌";
      console.log(`     ${icon} ${s.name.padEnd(14)}:${s.port}  ${s.status}  latency=${s.latency_ms}ms`);
    }
  }

  console.log("\n\x1b[32m" + "✓ smoke done" + "\x1b[0m\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
