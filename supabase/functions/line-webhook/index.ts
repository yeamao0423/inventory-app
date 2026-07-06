// ============================================================
// LINE 智慧客服 webhook
//   LINE → 驗簽 → 限流 → 載入對話記憶 → Claude(tool use) → 查 Supabase → 回覆 → 寫回記憶
//
// 工具箱式架構：本檔只負責「傳輸層＋對話迴圈」，
// 各工具的宣告與實作在 tools/，統一由 core/dispatch 執行。
// 新增能力＝在 tools/ 建一支檔、加進 tools/registry.ts，主流程不動。
//
// 需要的環境變數（Supabase Function Secrets）：
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY
//   （選填）ANTHROPIC_MODEL、LINE_STORE_ID(預設 1)、LINE_RATE_PER_MIN、LINE_RATE_PER_DAY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { ConversationTurn, ToolContext } from "./core/types.ts";
import { toolDefs } from "./tools/registry.ts";
import { dispatchTool } from "./core/dispatch.ts";

const LINE_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001";
const STORE_ID = Number(Deno.env.get("LINE_STORE_ID") ?? "1");
// 限流：每 user 每分鐘上限、全站每日上限（保護 API 帳單），可用 env 調整
const RATE_PER_MIN = Number(Deno.env.get("LINE_RATE_PER_MIN") ?? "8");
const RATE_PER_DAY = Number(Deno.env.get("LINE_RATE_PER_DAY") ?? "500");
// 對話記憶：載入每人最近 N 則、且在 session 內（逾時視為新對話）。保留天數由 pg_cron 控制。
const MEMORY_LIMIT = Number(Deno.env.get("LINE_MEMORY_LIMIT") ?? "8");
const SESSION_GAP_MS = Number(Deno.env.get("LINE_SESSION_GAP_MIN") ?? "30") * 60_000;

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
- search_products 只會回傳「已上架」的商品；若真的找不到就當作沒有，引導真人客服，不要臆測。
- 預購/可預訂商品：工具結果的 skip_stock_check 為 true 時，即使庫存為 0 也要回「可預訂／可下單」，「不要」說缺貨。
- 不代表公司做退款、折扣或補償承諾；任何涉及金錢的要求一律請對方稍候由真人客服處理。
- 回覆盡量在 3 句內，適度用 emoji，但別浮誇。
- 重要：LINE 訊息是純文字，不支援 Markdown。回覆「不要」使用 **粗體**、# 標題、- 或 * 項目符號等語法（會原樣顯示成符號）；要條列就用「・」或直接分行，強調就用文字或 emoji。`;

// ── Claude tool-use 迴圈 ────────────────────────────────────
async function askClaude(userText: string, ctx: ToolContext): Promise<string> {
  // 以近期對話當前綴，再接本次訊息（history 已保證以 user 開頭、user/assistant 交替）
  const messages: unknown[] = [
    ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: userText },
  ];

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

// ── 限流：每 user 每分鐘 + 全站每日 ─────────────────────────
async function checkRateLimit(userId: string): Promise<{ ok: boolean; message?: string }> {
  const minAgo = new Date(Date.now() - 60_000).toISOString();
  const { count: perUser } = await admin
    .from("line_rate_log")
    .select("*", { count: "exact", head: true })
    .eq("line_user_id", userId)
    .gte("created_at", minAgo);
  if ((perUser ?? 0) >= RATE_PER_MIN) {
    return { ok: false, message: "你問得有點快，稍等幾秒再傳一次好嗎 🙏" };
  }

  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const { count: total } = await admin
    .from("line_rate_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", dayAgo);
  if ((total ?? 0) >= RATE_PER_DAY) {
    return { ok: false, message: "今天客服量比較滿，稍後再來找我問喔 🙏" };
  }
  return { ok: true };
}

// ── 對話記憶：載入近期、寫回本輪 ────────────────────────────
async function loadHistory(userId: string): Promise<ConversationTurn[]> {
  const since = new Date(Date.now() - SESSION_GAP_MS).toISOString();
  const { data } = await admin
    .from("line_messages")
    .select("role, content")
    .eq("line_user_id", userId)
    .gte("created_at", since) // 只取 session 內（逾時＝新對話）
    .order("created_at", { ascending: false })
    .limit(MEMORY_LIMIT);
  const rows = ((data ?? []) as ConversationTurn[]).reverse();
  // Anthropic 要求首則為 user；截斷可能導致開頭是 assistant，先剔除
  while (rows.length && rows[0].role !== "user") rows.shift();
  return rows;
}

async function saveTurn(userId: string, userText: string, answer: string) {
  await admin.from("line_messages").insert([
    { line_user_id: userId, role: "user", content: userText.slice(0, 4000) },
    { line_user_id: userId, role: "assistant", content: answer.slice(0, 4000) },
  ]);
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
      const userId = ev.source?.userId ?? "unknown";
      try {
        // 限流：超過就回提示並跳過（不呼叫 Claude，省成本）
        const gate = await checkRateLimit(userId);
        if (!gate.ok) {
          await lineReply(ev.replyToken, gate.message!);
          continue;
        }
        await admin.from("line_rate_log").insert({ line_user_id: userId });

        const history = await loadHistory(userId);
        const ctx: ToolContext = { admin, storeId: STORE_ID, lineUserId: userId, history };
        const answer = await askClaude(ev.message.text, ctx);
        await lineReply(ev.replyToken, answer);
        await saveTurn(userId, ev.message.text, answer); // 寫回本輪，供下次載入

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
