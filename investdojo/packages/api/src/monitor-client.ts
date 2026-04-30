/**
 * MonitorClient · 对应 monitor-svc（:8005）
 */
import { BaseClient, type ClientOptions } from "./base-client";
import type {
  InfraHealth,
  ServiceHealth,
  StatsData,
  SystemOverview,
} from "./types";

export class MonitorClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  ping(): Promise<{ ok: boolean; service: string; timestamp: string }> {
    return this.get("/api/v1/monitor/ping");
  }

  listServices(): Promise<{
    data: ServiceHealth[];
    meta: { total: number; ok: number; probe_elapsed_ms: number };
  }> {
    return this.get("/api/v1/monitor/services");
  }

  getStats(): Promise<{
    data: StatsData;
    meta: { source: string; elapsed_ms: number; timestamp: string };
  }> {
    return this.get("/api/v1/monitor/stats");
  }

  getOverview(): Promise<{
    data: SystemOverview;
    meta: { elapsed_ms: number; timestamp: string };
  }> {
    return this.get("/api/v1/monitor/overview");
  }

  /**
   * 获取 Prometheus /metrics 纯文本
   */
  async getMetricsText(): Promise<string> {
    const resp = await this.fetchImpl(`${this.baseURL}/metrics`, {
      headers: { Accept: "text/plain" },
    });
    if (!resp.ok) {
      throw new Error(`metrics failed: ${resp.status}`);
    }
    return resp.text();
  }
}
