"use client";

/**
 * SDK Demo 页 - 展示 @investdojo/api SDK 的端到端能力
 *
 * 前置：本地所有 6 个 svc 运行中
 *   cd investdojo/python-services && make dev
 *
 * 访问：http://localhost:3000/sdk-demo
 */
import { useEffect, useState } from "react";
import {
  ApiError,
  createInvestDojoClient,
  type BacktestResult,
  type Factor,
  type KLine,
  type MarketSnapshot,
  type Signal,
  type SystemOverview,
} from "@investdojo/api";

const sdk = createInvestDojoClient({
  baseURLs: {
    data: "http://localhost:8000",
    feature: "http://localhost:8001",
    train: "http://localhost:8002",
    infer: "http://localhost:8003",
    backtest: "http://localhost:8004",
    monitor: "http://localhost:8005",
  },
  timeoutMs: 10_000,
});

type Box<T> = { loading: boolean; error?: string; data?: T };

function useCall<T>(fn: () => Promise<T>, deps: unknown[] = []): Box<T> {
  const [state, setState] = useState<Box<T>>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fn()
      .then((data) => {
        if (alive) setState({ loading: false, data });
      })
      .catch((e: unknown) => {
        if (alive) {
          const msg =
            e instanceof ApiError
              ? `[${e.code}] ${e.message}`
              : (e as Error).message;
          setState({ loading: false, error: msg });
        }
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

// ─── 展示组件 ────
function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: 4,
        background: ok ? "#16532d" : "#5a1e1e",
        color: ok ? "#7fe3a0" : "#ff9b9b",
        fontSize: 12,
        fontFamily: "monospace",
      }}
    >
      {children}
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: "1px solid #2a2a2a",
        borderRadius: 8,
        padding: 20,
        marginBottom: 16,
        background: "#0e0e0e",
      }}
    >
      <h3 style={{ margin: 0, color: "#fff", fontSize: 18 }}>{title}</h3>
      {description && (
        <p style={{ margin: "6px 0 14px", color: "#888", fontSize: 13 }}>
          {description}
        </p>
      )}
      {children}
    </section>
  );
}

// ─── 1. 系统总览 ────
function OverviewPanel() {
  const s = useCall<{ data: SystemOverview }>(() => sdk.monitor.getOverview(), []);
  if (s.loading) return <p style={{ color: "#888" }}>loading...</p>;
  if (s.error)
    return (
      <p style={{ color: "#ff9b9b" }}>
        ❌ {s.error}
        <br />
        <span style={{ color: "#888", fontSize: 12 }}>
          （请确认 monitor-svc 在 :8005 上运行）
        </span>
      </p>
    );
  const ov = s.data!.data;
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        总体状态：
        <Badge ok={ov.summary.overall === "ok"}>
          {ov.summary.overall}
        </Badge>
        {" · 服务："}
        <code style={{ color: "#7fe3a0" }}>
          {ov.summary.services_ok}/{ov.summary.services_total}
        </code>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <h4 style={{ color: "#ccc", margin: "8px 0", fontSize: 14 }}>服务健康</h4>
          {ov.services.map((s) => (
            <div
              key={s.name}
              style={{ fontFamily: "monospace", fontSize: 13, margin: "4px 0", color: "#ccc" }}
            >
              <Badge ok={s.status === "ok"}>{s.status}</Badge> {s.name}:{s.port}
              <span style={{ color: "#666" }}> {s.latency_ms}ms</span>
            </div>
          ))}
        </div>
        <div>
          <h4 style={{ color: "#ccc", margin: "8px 0", fontSize: 14 }}>业务数据</h4>
          <div style={{ fontFamily: "monospace", fontSize: 13, color: "#ccc" }}>
            {Object.entries(ov.stats)
              .filter(([, v]) => v !== undefined && v !== -1)
              .map(([k, v]) => (
                <div key={k} style={{ margin: "2px 0" }}>
                  <span style={{ color: "#888" }}>{k}:</span>{" "}
                  <span style={{ color: "#7fa8e3" }}>{v?.toLocaleString()}</span>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── 2. 茅台 K 线 ────
function KlinePanel() {
  const [symbol, setSymbol] = useState("600519");
  const s = useCall<{ data: KLine[]; meta: Record<string, unknown> }>(
    () =>
      sdk.data.getKlines({
        symbols: [symbol],
        timeframe: "1d",
        start: "2024-01-01",
        end: "2024-01-15",
      }),
    [symbol],
  );
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        股票代码：
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          style={{
            background: "#1a1a1a",
            color: "#fff",
            border: "1px solid #444",
            padding: "4px 10px",
            borderRadius: 4,
            fontFamily: "monospace",
            width: 100,
          }}
        />
        <span style={{ color: "#666", fontSize: 12, marginLeft: 8 }}>
          （600519 茅台 / 000001 平安银行 / 300750 宁德时代）
        </span>
      </div>
      {s.loading && <p style={{ color: "#888" }}>loading...</p>}
      {s.error && <p style={{ color: "#ff9b9b" }}>❌ {s.error}</p>}
      {s.data && (
        <div>
          <p style={{ color: "#888", fontSize: 13 }}>
            {s.data.data.length} 根日 K（meta.total_rows={(s.data.meta as { total_rows: number }).total_rows}）
          </p>
          <div style={{ maxHeight: 240, overflowY: "auto", fontFamily: "monospace", fontSize: 12 }}>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead style={{ position: "sticky", top: 0, background: "#1a1a1a" }}>
                <tr>
                  <th style={thStyle}>dt</th>
                  <th style={thStyle}>open</th>
                  <th style={thStyle}>close</th>
                  <th style={thStyle}>change%</th>
                  <th style={thStyle}>volume</th>
                </tr>
              </thead>
              <tbody>
                {s.data.data.map((k) => (
                  <tr key={k.dt}>
                    <td style={tdStyle}>{k.dt}</td>
                    <td style={tdStyle}>{k.open}</td>
                    <td style={tdStyle}>{k.close}</td>
                    <td
                      style={{
                        ...tdStyle,
                        color: (k.change_percent ?? 0) > 0 ? "#ff6b6b" : "#7fe3a0",
                      }}
                    >
                      {k.change_percent?.toFixed(2)}%
                    </td>
                    <td style={tdStyle}>{k.volume.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left" as const,
  color: "#888",
  padding: "4px 8px",
  borderBottom: "1px solid #2a2a2a",
  fontWeight: "normal" as const,
};

const tdStyle = {
  color: "#ccc",
  padding: "3px 8px",
  borderBottom: "1px solid #1a1a1a",
};

// ─── 3. 市场快照（2020-03-23 熔断底） ────
function SnapshotPanel() {
  const [date, setDate] = useState("2020-03-23");
  const s = useCall<{ data: MarketSnapshot }>(
    () => sdk.data.getMarketSnapshot({ date }),
    [date],
  );
  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        日期：
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ background: "#1a1a1a", color: "#fff", border: "1px solid #444", padding: "4px 10px", borderRadius: 4 }}
        />
        <span style={{ color: "#666", fontSize: 12, marginLeft: 8 }}>
          试试 2020-03-23 熔断底 / 2015-06-12 牛市顶 / 2022-04-26
        </span>
      </div>
      {s.loading && <p style={{ color: "#888" }}>loading...</p>}
      {s.error && <p style={{ color: "#ff9b9b" }}>❌ {s.error}</p>}
      {s.data && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
          <div>
            <h4 style={{ color: "#ccc", margin: "4px 0 8px", fontSize: 13 }}>指数</h4>
            {s.data.data.indexes &&
              Object.entries(s.data.data.indexes).map(([code, v]) => (
                <div key={code} style={{ fontFamily: "monospace", fontSize: 12, color: "#ccc" }}>
                  <span style={{ color: "#888" }}>{code}:</span>{" "}
                  <span>close={v.close?.toFixed(2)}</span>{" "}
                  <span
                    style={{ color: (v.change_pct ?? 0) > 0 ? "#ff6b6b" : "#7fe3a0" }}
                  >
                    {v.change_pct?.toFixed(2)}%
                  </span>
                </div>
              ))}
            <div style={{ marginTop: 8, fontSize: 12, color: "#888" }}>
              北向资金净流入（万元）：
              <span style={{ color: "#fff" }}>
                {" "}{s.data.data.north_capital?.toFixed(2) ?? "--"}
              </span>
            </div>
          </div>
          <div>
            <h4 style={{ color: "#ccc", margin: "4px 0 8px", fontSize: 13 }}>涨跌家数</h4>
            {s.data.data.advance_decline ? (
              <div style={{ fontFamily: "monospace", fontSize: 12, color: "#ccc" }}>
                <div>上涨：<span style={{ color: "#ff6b6b" }}>{s.data.data.advance_decline.advance}</span></div>
                <div>下跌：<span style={{ color: "#7fe3a0" }}>{s.data.data.advance_decline.decline}</span></div>
                <div>涨停：<span style={{ color: "#ff6b6b" }}>{s.data.data.advance_decline.limit_up}</span></div>
                <div>跌停：<span style={{ color: "#7fe3a0" }}>{s.data.data.advance_decline.limit_down}</span></div>
                <div style={{ color: "#666" }}>
                  共 {s.data.data.advance_decline.total} 只
                </div>
              </div>
            ) : (
              <p style={{ color: "#666", fontSize: 12 }}>该日无涨跌聚合</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 4. 因子列表 ────
function FactorsPanel() {
  const s = useCall<{ data: Factor[] }>(() => sdk.factors.listFactors(), []);
  return (
    <div>
      {s.loading && <p style={{ color: "#888" }}>loading...</p>}
      {s.error && <p style={{ color: "#ff9b9b" }}>❌ {s.error}</p>}
      {s.data && (
        <div style={{ fontFamily: "monospace", fontSize: 12 }}>
          {s.data.data.map((f) => (
            <div
              key={f.id}
              style={{
                padding: "8px 12px",
                borderBottom: "1px solid #1a1a1a",
              }}
            >
              <div style={{ color: "#fff" }}>
                {f.name} <span style={{ color: "#666" }}>({f.id})</span>
              </div>
              <div style={{ color: "#888", fontSize: 11, marginTop: 2 }}>
                {f.description}
              </div>
              <div style={{ marginTop: 4 }}>
                {f.tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      display: "inline-block",
                      padding: "1px 6px",
                      background: "#1e3a5a",
                      color: "#7fa8e3",
                      borderRadius: 3,
                      marginRight: 4,
                      fontSize: 11,
                    }}
                  >
                    {t}
                  </span>
                ))}
                <span style={{ color: "#666", fontSize: 11 }}>
                  · category={f.category} · formula={f.formula}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 5. 推理 mock_momentum_v1 ────
function InferencePanel() {
  const [asOf, setAsOf] = useState("2024-03-15T15:00:00Z");
  const s = useCall<{ data: { signals: Signal[] } }>(
    () =>
      sdk.inference.predict({
        model_id: "mock_momentum_v1",
        symbols: ["600519", "000001", "300750"],
        as_of: asOf,
        include_explanation: true,
      }),
    [asOf],
  );

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        as_of（防未来函数）：
        <input
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          style={{
            background: "#1a1a1a",
            color: "#fff",
            border: "1px solid #444",
            padding: "4px 10px",
            borderRadius: 4,
            width: 220,
            fontFamily: "monospace",
          }}
        />
        <button
          onClick={() => setAsOf("2099-01-01T00:00:00Z")}
          style={{
            marginLeft: 8,
            background: "#5a1e1e",
            color: "#ff9b9b",
            border: "1px solid #7a3232",
            padding: "4px 10px",
            borderRadius: 4,
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          试未来时间（应 403）
        </button>
      </div>
      {s.loading && <p style={{ color: "#888" }}>loading...</p>}
      {s.error && <p style={{ color: "#ff9b9b" }}>❌ {s.error}</p>}
      {s.data &&
        s.data.data.signals.map((sig) => (
          <div
            key={sig.symbol}
            style={{
              padding: 12,
              background: "#0a0a0a",
              borderRadius: 6,
              marginBottom: 8,
              border: "1px solid #2a2a2a",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "monospace", fontWeight: 700, color: "#fff" }}>
                {sig.symbol}
              </span>
              <span
                style={{
                  padding: "2px 10px",
                  background:
                    sig.action === "BUY"
                      ? "#5a1e1e"
                      : sig.action === "SELL"
                      ? "#1e5a2a"
                      : "#333",
                  color:
                    sig.action === "BUY"
                      ? "#ff9b9b"
                      : sig.action === "SELL"
                      ? "#7fe3a0"
                      : "#999",
                  borderRadius: 4,
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {sig.action}
              </span>
              <span style={{ color: "#888", fontSize: 12 }}>
                score={sig.score?.toFixed(3)} conf={sig.confidence.toFixed(2)}
              </span>
            </div>
            <div style={{ color: "#888", fontSize: 12, marginTop: 6 }}>
              {sig.explanation?.thesis}
            </div>
          </div>
        ))}
    </div>
  );
}

// ─── 6. 回测 ────
function BacktestPanel() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await sdk.backtests.runFast({
        mode: "fast",
        strategy: { type: "model", model_id: "mock_momentum_v1" },
        start: "2023-01-01",
        end: "2023-06-30",
        universe: "hs300",
      });
      setResult(r.data);
    } catch (e: unknown) {
      setError(e instanceof ApiError ? `[${e.code}] ${e.message}` : (e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button
        onClick={run}
        disabled={loading}
        style={{
          background: "#1e3a5a",
          color: "#7fa8e3",
          border: "1px solid #2c5580",
          padding: "6px 16px",
          borderRadius: 4,
          cursor: loading ? "wait" : "pointer",
          marginBottom: 12,
        }}
      >
        {loading ? "回测中..." : "跑一次 mock 回测（2023 上半年 / 沪深 300）"}
      </button>
      {error && <p style={{ color: "#ff9b9b", fontSize: 13 }}>❌ {error}</p>}
      {result && (
        <div>
          <div style={{ color: "#888", fontSize: 12, marginBottom: 10 }}>
            id: <code style={{ color: "#ccc" }}>{result.id}</code> · duration:{" "}
            {result.duration_ms}ms
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <Stat label="总收益" value={`${(result.summary.total_return * 100).toFixed(2)}%`}
                  color={result.summary.total_return > 0 ? "#ff6b6b" : "#7fe3a0"} />
            <Stat label="Sharpe" value={result.summary.sharpe.toFixed(2)} />
            <Stat label="最大回撤" value={`${(result.summary.max_drawdown * 100).toFixed(2)}%`} color="#7fe3a0" />
            <Stat label="胜率" value={`${(result.summary.win_rate * 100).toFixed(1)}%`} />
          </div>
          <div
            style={{
              fontSize: 11,
              color: "#666",
              fontFamily: "monospace",
              padding: 8,
              background: "#0a0a0a",
              borderRadius: 4,
              border: "1px solid #1a1a1a",
            }}
          >
            equity_curve {result.equity_curve.dates.length} 个点 · 起点
            {" "}¥{result.equity_curve.portfolio[0]?.toLocaleString()} → 终点 ¥
            {result.equity_curve.portfolio[
              result.equity_curve.portfolio.length - 1
            ]?.toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ padding: 10, background: "#0a0a0a", borderRadius: 6, border: "1px solid #2a2a2a" }}>
      <div style={{ color: "#666", fontSize: 11 }}>{label}</div>
      <div style={{ color: color ?? "#fff", fontFamily: "monospace", fontSize: 18, marginTop: 4 }}>
        {value}
      </div>
    </div>
  );
}

// ─── 主页面 ────
export default function SDKDemoPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#000", padding: "24px 32px", color: "#fff" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, margin: 0, letterSpacing: 0.5 }}>
          InvestDojo SDK Demo
          <span
            style={{
              marginLeft: 12,
              fontSize: 12,
              padding: "2px 8px",
              background: "#16532d",
              color: "#7fe3a0",
              borderRadius: 4,
              fontFamily: "monospace",
              verticalAlign: "middle",
            }}
          >
            @investdojo/api
          </span>
        </h1>
        <p style={{ color: "#888", fontSize: 13, marginTop: 4 }}>
          Sprint 0 / T-2.06 验证 · 前端直连 6 个本地微服务（data/feature/train/infer/backtest/monitor）
        </p>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4, maxWidth: 1080 }}>
        <Section
          title="1. 系统总览"
          description="monitor-svc 聚合：5 个 svc 健康 + 3 个基础设施 + 12 项业务指标"
        >
          <OverviewPanel />
        </Section>

        <Section title="2. K 线（data-svc）" description="从 klines_all 查日 K，支持时区 / 分页 / as_of 截断">
          <KlinePanel />
        </Section>

        <Section title="3. 市场快照（data-svc）" description="2014-01-02 起全覆盖的指数 + 涨跌家数 + 北向资金">
          <SnapshotPanel />
        </Section>

        <Section title="4. 因子库（feature-svc）" description="5 个示范因子（MA/MACD/RSI/量能）">
          <FactorsPanel />
        </Section>

        <Section title="5. 推理（infer-svc）" description="mock_momentum_v1 推理 3 只股票，决定性 + as_of 防护">
          <InferencePanel />
        </Section>

        <Section title="6. 回测（backtest-svc）" description="run-fast 同步回测，展示 summary + equity_curve">
          <BacktestPanel />
        </Section>
      </div>

      <footer style={{ marginTop: 40, paddingTop: 16, borderTop: "1px solid #2a2a2a", color: "#666", fontSize: 12 }}>
        如果所有接口都 ❌，请先启动后端：
        <code style={{ marginLeft: 6, color: "#aaa" }}>
          cd investdojo/python-services && make dev
        </code>
      </footer>
    </div>
  );
}
