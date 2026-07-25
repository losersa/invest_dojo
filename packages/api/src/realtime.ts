// ============================================================
// @investdojo/api — Realtime 同步管理
// 多端数据同步的核心连接管理
// ============================================================

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";
import type { Order, Portfolio, SimulationProgress } from "@investdojo/core";

export type RealtimeEvent = "trade_update" | "portfolio_update" | "progress_update";

export interface RealtimeCallbacks {
  onTradeUpdate?: (trade: Order) => void;
  onPortfolioUpdate?: (portfolio: Portfolio) => void;
  onProgressUpdate?: (progress: SimulationProgress) => void;
}

/**
 * Realtime 同步管理器
 * 管理 Supabase Realtime 频道的生命周期
 */
export class RealtimeSync {
  private channel: RealtimeChannel | null = null;
  private userId: string;
  private callbacks: RealtimeCallbacks;

  constructor(userId: string, callbacks: RealtimeCallbacks) {
    this.userId = userId;
    this.callbacks = callbacks;
  }

  /**
   * 开始监听
   */
  subscribe(): void {
    const supabase = getSupabase();

    this.channel = supabase.channel(`user:${this.userId}`);

    // 监听交易记录变更
    this.channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "simulation_trades",
        filter: `user_id=eq.${this.userId}`,
      },
      (payload) => {
        if (this.callbacks.onTradeUpdate && payload.new) {
          this.callbacks.onTradeUpdate(payload.new as unknown as Order);
        }
      },
    );

    // 监听持仓变更
    this.channel.on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "portfolios",
        filter: `user_id=eq.${this.userId}`,
      },
      (payload) => {
        if (this.callbacks.onPortfolioUpdate && payload.new) {
          this.callbacks.onPortfolioUpdate(payload.new as unknown as Portfolio);
        }
      },
    );

    // 监听场景进度变更
    this.channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "scenario_progress",
        filter: `user_id=eq.${this.userId}`,
      },
      (payload) => {
        if (this.callbacks.onProgressUpdate && payload.new) {
          this.callbacks.onProgressUpdate(payload.new as unknown as SimulationProgress);
        }
      },
    );

    this.channel.subscribe((status) => {
      console.log(`[RealtimeSync] Channel status: ${status}`);
    });
  }

  /**
   * 停止监听
   */
  unsubscribe(): void {
    if (this.channel) {
      const supabase = getSupabase();
      supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  /**
   * 更新回调
   */
  updateCallbacks(callbacks: Partial<RealtimeCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }
}
