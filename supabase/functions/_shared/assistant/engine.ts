// Claude tool-use 對話迴圈 —— 與管道無關。
// 呼叫端負責：載入記憶、寫入訊息、把回覆送到該管道去。這裡只負責「問出一段回答」。
import { dispatchTool } from "./dispatch.ts";
import { toolDefs } from "./tools/registry.ts";
import type { ToolContext } from "./types.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const MAX_TURNS = 5;

// 純文字聊天視窗不渲染 Markdown → 清掉常見語法符號，避免原樣顯示
export function toPlainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "・")
    .trim();
}

export async function askAssistant(
  systemPrompt: string,
  ctx: ToolContext,
): Promise<string> {
  if (!ANTHROPIC_KEY) {
    console.error("ANTHROPIC_API_KEY 未設定");
    return "抱歉，客服助理暫時無法回應，我先幫你找真人客服 🙏";
  }

  // history 已含本次訊息（呼叫端先寫入 consumer 訊息才進來）
  const messages: unknown[] = ctx.history.map((h) => ({ role: h.role, content: h.content }));
  if (messages.length === 0) return "不好意思，我沒有收到你的訊息，可以再說一次嗎？ 🙏";

  for (let i = 0; i < MAX_TURNS; i++) {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt,
        tools: toolDefs,
        messages,
      }),
    });

    if (!resp.ok) {
      console.error("anthropic error", resp.status, await resp.text());
      return "抱歉，系統忙線中，請稍後再問一次，或稍候由真人客服協助你 🙏";
    }

    const data = await resp.json();

    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === "tool_use") {
          const result = await dispatchTool(block.name, block.input ?? {}, ctx);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 沒有再呼叫工具 → 收斂為最終回覆
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .trim();
    return toPlainText(text) || "不好意思，我不太確定你的意思，可以再說一次嗎？ 🙏";
  }

  return "抱歉，這題我查了幾次還是卡住，稍候由真人客服幫你確認 🙏";
}
