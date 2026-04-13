// ============================================================
// AI 服务路由 — LLM 网关 + SSE 流式输出
// ============================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export const aiRoutes = new Hono();

// ------ AI 复盘分析（SSE 流式） ------
aiRoutes.post("/review", async (c) => {
  const body = await c.req.json();
  const { scenarioId, tradeHistory, portfolio, metrics } = body;

  // 构建 Prompt
  const prompt = buildReviewPrompt(scenarioId, tradeHistory, portfolio, metrics);

  return streamSSE(c, async (stream) => {
    try {
      // 调用 DeepSeek API（流式）
      const response = await callLLMStream(prompt);

      for await (const chunk of response) {
        await stream.writeSSE({ data: chunk });
      }

      await stream.writeSSE({ data: "[DONE]" });
    } catch (error) {
      console.error("[AI Review Error]", error);
      await stream.writeSSE({ data: JSON.stringify({ error: "AI 分析失败" }) });
      await stream.writeSSE({ data: "[DONE]" });
    }
  });
});

// ------ LLM 调用封装 ------

async function* callLLMStream(prompt: string): AsyncGenerator<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  if (!apiKey) {
    // 开发模式：返回模拟数据
    const mockResponse = generateMockReview();
    for (const char of mockResponse) {
      yield char;
      await sleep(20); // 模拟流式延迟
    }
    return;
  }

  // 生产模式：调用 DeepSeek API
  const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "你是一位资深的投资分析师，专长于A股市场分析。你需要对用户的模拟交易进行复盘分析，指出操作的优缺点，并给出改进建议。分析要结合历史事件背景，语言专业但易懂。请用中文回答。",
        },
        { role: "user", content: prompt },
      ],
      stream: true,
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`DeepSeek API error: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.startsWith("data: ") && line !== "data: [DONE]") {
        try {
          const json = JSON.parse(line.slice(6));
          const content = json.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // 忽略解析错误
        }
      }
    }
  }
}

// ------ Prompt 构建 ------

function buildReviewPrompt(
  scenarioId: string,
  tradeHistory: unknown[],
  portfolio: unknown,
  metrics: unknown,
): string {
  return `
## 模拟交易复盘请求

### 场景信息
- 场景 ID: ${scenarioId}

### 交易记录
${JSON.stringify(tradeHistory, null, 2)}

### 最终投资组合
${JSON.stringify(portfolio, null, 2)}

### 绩效指标
${JSON.stringify(metrics, null, 2)}

### 要求
请对以上模拟交易进行复盘分析，包括：
1. **总体评价**：给出1-5分的评级和一句话总结
2. **做得好的地方**：列出2-3个亮点
3. **需要改进的地方**：列出2-3个不足
4. **关键决策分析**：对3-5个重要交易节点进行分析
5. **改进建议**：给出2-3条具体可行的改进方向

请用专业但易懂的中文回答。
  `.trim();
}

// ------ Mock 数据 ------

function generateMockReview(): string {
  return `## 📊 模拟交易复盘报告

### 总体评价：⭐⭐⭐ (3/5)

本轮模拟交易整体表现中规中矩。在市场剧烈波动期间，你保持了一定的纪律性，但在关键转折点的把握上仍有提升空间。

### ✅ 做得好的地方

1. **风险控制意识**：在市场大幅下跌时没有恐慌性抛售，保持了相对冷静的心态
2. **仓位管理**：没有满仓操作，保留了一定的现金缓冲
3. **交易纪律**：每次交易都有明确的操作逻辑，没有频繁追涨杀跌

### ⚠️ 需要改进的地方

1. **入场时机**：部分买入操作偏早，可以等待更明确的右侧信号
2. **止盈意识**：浮盈回撤较大，缺乏明确的止盈策略
3. **行业研究**：对持仓标的的基本面研究可以更深入

### 📌 改进建议

1. 建立明确的买入/卖出信号体系，减少主观判断
2. 设定动态止盈线，保护已有利润
3. 关注宏观政策变化对持仓行业的影响

> 💡 投资是一场终身学习的旅程，每一次复盘都是进步的机会。继续保持学习的心态！`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
