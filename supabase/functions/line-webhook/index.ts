// ============================================================
// LINE 智慧客服 webhook（Phase 1：庫存問答）
//   LINE → 驗簽 → Claude(tool use) → 查 Supabase → 回覆
//
// 架構刻意做成「工具箱」：Claude 只負責語意理解＋決定呼叫哪支工具，
// 未來要加 RAG(search_knowledge) / 訂單查詢 / 協助下單，
// 只需在 TOOLS 陣列與 runTool() 各加一筆，主流程不動。
//
// 需要的環境變數（Supabase Function Secrets）：
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY
//   （選填）ANTHROPIC_MODEL、LINE_STORE_ID(預設 1)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const LINE_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const STORE_ID = Number(Deno.env.get("LINE_STORE_ID") ?? "1");

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ── 系統提示：鎖定人設與行為邊界 ────────────────────────────
const SYSTEM_PROMPT = `你是 LikeDaigo 代購商城的 LINE 客服助理，個性親切、回答簡短口語（繁體中文）。

規則：
- 商品庫存、售價一律用工具即時查詢，「絕對不要」自己猜或編數字。
- 使用者問某商品時，先用 search_products 找出對應商品；有多個相近結果就簡短反問是哪一個。
- 查到庫存後：有規格的商品要說明各規格的剩餘數量；沒規格的看整體數量。有貨就明確說有、剩幾件；沒貨就說目前缺貨。
- 只透露庫存與售價，「不可以」透露成本、進價、利潤等內部資訊。
- 查不到商品或問題超出你能查的範圍（例如退換貨爭議、客訴），就禮貌引導對方稍候由真人客服協助，不要硬掰。
- 回覆盡量在 3 句內，適度用 emoji，但別浮誇。
- 重要：LINE 訊息是純文字，不支援 Markdown。回覆「不要」使用 **粗體**、# 標題、- 或 * 項目符號等語法（會原樣顯示成符號）；要條列就用「・」或直接分行，強調就用文字或 emoji。`;

// ── 工具箱：新增能力就在這裡加 ──────────────────────────────
const TOOLS = [
  {
    name: "search_products",
    description:
      "依商品名稱或關鍵字模糊搜尋商品，找出使用者可能指的是哪個商品。當你需要某商品的 product_id 卻還不知道時使用。回傳候選商品清單。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "商品名稱或關鍵字" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_stock",
    description:
      "查詢指定商品的即時庫存與售價（含各規格）。需要 product_id，通常先用 search_products 取得。",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "integer", description: "商品 ID" },
      },
      required: ["product_id"],
    },
  },
];

// 工具實作：回傳值會原封不動當作 tool_result 丟回給 Claude
async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  if (name === "search_products") {
    const q = String(input.query ?? "").slice(0, 100);
    const { data, error } = await admin.rpc("line_search_products", {
      p_store_id: STORE_ID,
      p_query: q,
    });
    if (error) return { error: error.message };
    return { results: data ?? [] };
  }
  if (name === "get_stock") {
    const { data, error } = await admin.rpc("line_get_stock", {
      p_product_id: Number(input.product_id),
    });
    if (error) return { error: error.message };
    return data ?? { error: "查無此商品" };
  }
  return { error: `unknown tool: ${name}` };
}

// ── Claude tool-use 迴圈 ────────────────────────────────────
async function askClaude(userText: string): Promise<string> {
  const messages: unknown[] = [{ role: "user", content: userText }];

  for (let i = 0; i < 5; i++) {
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
        system: SYSTEM_PROMPT,
        tools: TOOLS,
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
          const result = await runTool(block.name, block.input ?? {});
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
    return text || "不好意思，我不太確定你的意思，可以再說一次嗎？ 🙏";
  }

  return "抱歉，這題我查了幾次還是卡住，稍候由真人客服幫你確認 🙏";
}

// LINE 純文字不支援 Markdown → 清掉常見語法符號，避免原樣顯示
function toPlainText(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1") // **粗體**
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "$1") // *斜體*
    .replace(/`([^`]+)`/g, "$1") // `程式碼`
    .replace(/^#{1,6}\s+/gm, "") // # 標題
    .replace(/^\s*[-*]\s+/gm, "・") // - 項目符號 → ・
    .trim();
}

// ── LINE 回覆 ───────────────────────────────────────────────
async function lineReply(replyToken: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: toPlainText(text).slice(0, 4900) }],
    }),
  });
  if (!res.ok) console.error("line reply error", res.status, await res.text());
}

// ── 驗簽：X-Line-Signature = base64(HMAC-SHA256(channelSecret, rawBody)) ──
async function verifySignature(body: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(LINE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === signature;
}

// ── 進入點 ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok"); // 健康檢查

  const bodyText = await req.text();
  const signature = req.headers.get("x-line-signature") ?? "";
  if (!(await verifySignature(bodyText, signature))) {
    return new Response("bad signature", { status: 401 });
  }

  let body: { events?: any[] };
  try {
    body = JSON.parse(bodyText || "{}");
  } catch {
    return new Response("bad body", { status: 400 });
  }

  // 逐一處理事件；只回應文字訊息，其餘（加好友/貼圖/postback…）先忽略
  for (const ev of body.events ?? []) {
    if (ev.type === "message" && ev.message?.type === "text" && ev.replyToken) {
      try {
        const answer = await askClaude(ev.message.text);
        await lineReply(ev.replyToken, answer);
      } catch (e) {
        console.error("handle event error", e);
        try {
          await lineReply(ev.replyToken, "抱歉，系統出了點狀況，請稍後再試 🙏");
        } catch (_) { /* ignore */ }
      }
    }
  }

  // LINE 要求 webhook 快速回 200（含它的 Verify 驗證）
  return new Response("ok");
});
