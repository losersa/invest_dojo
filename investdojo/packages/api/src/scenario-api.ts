// ============================================================
// @investdojo/api — 场景数据 API
// ============================================================

import type { ScenarioData, ScenarioMeta } from "@investdojo/core";

function getApiBase(): string {
  const env = (globalThis as unknown as { process?: { env?: Record<string, string> } })?.process?.env;
  return env?.NEXT_PUBLIC_API_URL ?? "/api";
}

/**
 * 获取场景列表
 */
export async function fetchScenarioList(): Promise<ScenarioMeta[]> {
  const res = await fetch(`${getApiBase()}/scenarios`);
  if (!res.ok) throw new Error("Failed to fetch scenario list");
  return res.json();
}

/**
 * 获取场景完整数据包
 */
export async function fetchScenarioData(scenarioId: string): Promise<ScenarioData> {
  const res = await fetch(`${getApiBase()}/scenarios/${scenarioId}`);
  if (!res.ok) throw new Error(`Failed to fetch scenario: ${scenarioId}`);
  return res.json();
}

/**
 * 保存模拟进度到服务端
 */
export async function saveProgress(progress: {
  scenarioId: string;
  currentDate: string;
  portfolio: unknown;
  tradeHistory: unknown[];
}): Promise<void> {
  const res = await fetch(`${getApiBase()}/simulation/progress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(progress),
  });
  if (!res.ok) throw new Error("Failed to save progress");
}

/**
 * AI 复盘 — SSE 流式请求
 */
export async function* streamAIReview(params: {
  scenarioId: string;
  tradeHistory: unknown[];
  portfolio: unknown;
  metrics: unknown;
}): AsyncGenerator<string, void, undefined> {
  const res = await fetch(`${getApiBase()}/simulation/ai-review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });

  if (!res.ok) throw new Error("AI review request failed");

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") return;
        yield data;
      }
    }
  }
}
