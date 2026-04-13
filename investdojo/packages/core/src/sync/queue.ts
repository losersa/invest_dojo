// ============================================================
// @investdojo/core — 离线操作队列
// 网络断开时缓存操作，恢复后按序重放
// ============================================================

import { nanoid } from "nanoid";

export type OperationType = "trade" | "advance_day" | "save_progress" | "save_setting";

export interface OfflineOperation {
  id: string;
  type: OperationType;
  payload: unknown;
  timestamp: number;
  status: "pending" | "synced" | "conflict" | "failed";
  retryCount: number;
}

export interface SyncResult {
  success: boolean;
  conflictOps: OfflineOperation[];
  syncedCount: number;
  failedCount: number;
}

/**
 * 离线操作队列
 *
 * 使用方式：
 * 1. 网络断开时，操作入队
 * 2. 网络恢复时，flush() 按时间顺序重放
 * 3. 冲突操作标记后由上层处理
 */
export class OfflineQueue {
  private queue: OfflineOperation[] = [];
  private storageKey: string;
  private maxRetries = 3;

  constructor(userId: string) {
    this.storageKey = `investdojo_offline_queue_${userId}`;
    this.loadFromStorage();
  }

  /** 操作入队 */
  enqueue(type: OperationType, payload: unknown): string {
    const op: OfflineOperation = {
      id: nanoid(),
      type,
      payload,
      timestamp: Date.now(),
      status: "pending",
      retryCount: 0,
    };
    this.queue.push(op);
    this.persistToStorage();
    return op.id;
  }

  /** 网络恢复后重放所有待处理操作 */
  async flush(
    syncFn: (op: OfflineOperation) => Promise<{ success: boolean; conflict?: boolean }>,
  ): Promise<SyncResult> {
    const pending = this.queue
      .filter((op) => op.status === "pending")
      .sort((a, b) => a.timestamp - b.timestamp);

    let syncedCount = 0;
    let failedCount = 0;
    const conflictOps: OfflineOperation[] = [];

    for (const op of pending) {
      try {
        const result = await syncFn(op);
        if (result.success) {
          op.status = "synced";
          syncedCount++;
        } else if (result.conflict) {
          op.status = "conflict";
          conflictOps.push(op);
        } else {
          op.retryCount++;
          if (op.retryCount >= this.maxRetries) {
            op.status = "failed";
            failedCount++;
          }
        }
      } catch {
        op.retryCount++;
        if (op.retryCount >= this.maxRetries) {
          op.status = "failed";
          failedCount++;
        }
      }
    }

    // 清理已同步的操作
    this.queue = this.queue.filter((op) => op.status !== "synced");
    this.persistToStorage();

    return { success: conflictOps.length === 0 && failedCount === 0, conflictOps, syncedCount, failedCount };
  }

  /** 获取队列大小 */
  size(): number {
    return this.queue.filter((op) => op.status === "pending").length;
  }

  /** 清空队列 */
  clear(): void {
    this.queue = [];
    this.persistToStorage();
  }

  /** 获取所有操作 */
  getAll(): readonly OfflineOperation[] {
    return this.queue;
  }

  // ------ 持久化（浏览器端使用 localStorage，原生端需适配） ------

  private persistToStorage(): void {
    if (typeof globalThis.localStorage !== "undefined") {
      globalThis.localStorage.setItem(this.storageKey, JSON.stringify(this.queue));
    }
  }

  private loadFromStorage(): void {
    if (typeof globalThis.localStorage !== "undefined") {
      const raw = globalThis.localStorage.getItem(this.storageKey);
      if (raw) {
        try {
          this.queue = JSON.parse(raw);
        } catch {
          this.queue = [];
        }
      }
    }
  }
}
