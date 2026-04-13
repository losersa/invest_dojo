// ============================================================
// @investdojo/core — 冲突解决策略
// ============================================================

import type { Portfolio, SimulationProgress } from "../simulation/types";

export type ConflictStrategy = "server_wins" | "client_wins" | "latest_wins";

export interface ConflictRecord {
  field: string;
  localValue: unknown;
  serverValue: unknown;
  resolvedValue: unknown;
  strategy: ConflictStrategy;
  resolvedAt: number;
}

/**
 * 冲突解决器
 * 
 * 规则：
 * - 交易相关数据（持仓、余额）→ Server Authoritative
 * - 用户设置 → Latest Wins (Last-Write-Wins)
 * - 场景进度 → 取更靠前的日期（防止跳过交易日）
 */
export class ConflictResolver {
  /**
   * 解决 Portfolio 冲突 — 始终以服务端为准
   */
  resolvePortfolio(local: Portfolio, server: Portfolio): {
    resolved: Portfolio;
    conflicts: ConflictRecord[];
  } {
    const conflicts: ConflictRecord[] = [];

    if (local.cash !== server.cash) {
      conflicts.push({
        field: "cash",
        localValue: local.cash,
        serverValue: server.cash,
        resolvedValue: server.cash,
        strategy: "server_wins",
        resolvedAt: Date.now(),
      });
    }

    return {
      resolved: server, // Portfolio 始终以服务端为准
      conflicts,
    };
  }

  /**
   * 解决场景进度冲突 — 取较早的日期
   */
  resolveProgress(
    local: SimulationProgress,
    server: SimulationProgress,
  ): {
    resolved: SimulationProgress;
    conflicts: ConflictRecord[];
  } {
    const conflicts: ConflictRecord[] = [];

    // 进度取较靠前（较小）的日期，防止跳过交易日
    const resolvedDate = local.currentDate <= server.currentDate
      ? local.currentDate
      : server.currentDate;

    if (local.currentDate !== server.currentDate) {
      conflicts.push({
        field: "currentDate",
        localValue: local.currentDate,
        serverValue: server.currentDate,
        resolvedValue: resolvedDate,
        strategy: local.currentDate <= server.currentDate ? "client_wins" : "server_wins",
        resolvedAt: Date.now(),
      });
    }

    // Portfolio 始终以服务端为准
    const { resolved: resolvedPortfolio } = this.resolvePortfolio(
      local.portfolio,
      server.portfolio,
    );

    return {
      resolved: {
        ...server,
        currentDate: resolvedDate,
        portfolio: resolvedPortfolio,
      },
      conflicts,
    };
  }

  /**
   * 解决通用键值设置冲突 — Last Write Wins
   */
  resolveSettings<T extends Record<string, unknown>>(
    local: { data: T; updatedAt: number },
    server: { data: T; updatedAt: number },
  ): { resolved: T; strategy: ConflictStrategy } {
    if (local.updatedAt >= server.updatedAt) {
      return { resolved: local.data, strategy: "client_wins" };
    }
    return { resolved: server.data, strategy: "server_wins" };
  }
}
