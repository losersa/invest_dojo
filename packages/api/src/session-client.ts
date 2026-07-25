/**
 * SessionClient · 占位（Epic 6 T-6.01+ 完善）
 *
 * 目前只暴露 TypeScript 类型和未实现的方法签名，让 Epic 6 接入时只改实现。
 */
import { BaseClient, type ClientOptions } from "./base-client";

export interface SessionCreateRequest {
  mode: "copilot" | "pk" | "classroom";
  scenario_id?: string;
  participants: string[];
  initial_capital?: number;
}

export interface Session {
  id: string;
  mode: string;
  status: "pending" | "active" | "paused" | "completed";
  scenario_id?: string | null;
  participants: string[];
  created_at: string;
  started_at?: string | null;
  ended_at?: string | null;
}

export class SessionClient extends BaseClient {
  constructor(opts: ClientOptions) {
    super(opts);
  }

  // Epic 6 T-6.01：创建联动会话
  createSession(_req: SessionCreateRequest): Promise<{ data: Session }> {
    throw new Error("SessionClient.createSession: to be implemented in Epic 6 (T-6.01)");
  }

  // Epic 6 T-6.03：打开时钟广播 WebSocket
  openTickStream(_sessionId: string): WebSocket {
    throw new Error("SessionClient.openTickStream: to be implemented in Epic 6 (T-6.03)");
  }
}
