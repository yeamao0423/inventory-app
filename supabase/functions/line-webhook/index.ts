// ============================================================
// LINE 智慧客服 webhook
//   LINE → 驗簽 → 限流 → 找/建對話（已綁定才建）→ 共用引擎(tool use) → 回覆
//
// 跟 web 客服（chat function）共用 _shared/assistant 的 engine/dispatch/policy/
// prompt/tools registry —— 本檔只負責「LINE 傳輸層＋已綁定/未綁定的分流」。
// 已綁定：對話併入 conversations/messages，跟站內對話在後台收件匣收斂成同一組。
// 未綁定：一般問題仍即時回答，不落地儲存、無多輪記憶。
//
// 需要的環境變數（Supabase Function Secrets）：
//   LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN / ANTHROPIC_API_KEY
//   （選填）ANTHROPIC_MODEL、LINE_STORE_ID(預設 1)、LINE_RATE_PER_MIN、LINE_RATE_PER_DAY、
//   LINE_MEMORY_LIMIT、LINE_BIND_URL
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DEFAULT_MEMORY_LIMIT,
  initialStatus,
  nextStatusOnConsumerMessage,
  nextStatusOnRequestHuman,
  shouldRunAssistant,
} from "../_shared/assistant/policy.ts";
import type { ConversationStatus } from "../_shared/assistant/policy.ts";
import { loadMemory } from "../_shared/assistant/memory.ts";
import { buildSystemPrompt } from "../_shared/assistant/prompt.ts";
import { askAssistant } from "../_shared/assistant/engine.ts";
import type { BoundConsumer, ConversationTurn, ToolContext } from "../_shared/assistant/types.ts";
import { notifyStore } from "../_shared/notify.ts";

const LINE_SECRET = Deno.env.get("LINE_CHANNEL_SECRET")!;
const LINE_TOKEN = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN")!;
const STORE_ID = Number(Deno.env.get("LINE_STORE_ID") ?? "1");
const STORE_NAME = "LikeDaigo 代購商城";
// 限流：每 user 每分鐘上限、全站每日上限（保護 API 帳單），可用 env 調整
const RATE_PER_MIN = Number(Deno.env.get("LINE_RATE_PER_MIN") ?? "8");
const RATE_PER_DAY = Number(Deno.env.get("LINE_RATE_PER_DAY") ?? "500");
// 已綁定使用者的對話記憶則數（不限時間，跟 web 客服同一套 loadMemory）
const MEMORY_LIMIT = Number(Deno.env.get("LINE_MEMORY_LIMIT") ?? String(DEFAULT_MEMORY_LIMIT));
// 會員綁定連結（LIFF）：未綁定顧客問個人資料/問題超出範圍時，bot 遞出這個讓他一點進來綁
const BIND_URL = Deno.env.get("LINE_BIND_URL") ?? "https://liff.line.me/2010616155-bJSaanw4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

interface ConversationRow {
  id: number;
  store_id: number;
  status: ConversationStatus;
  consumer_id: string | null;
  unread_for_store: number;
  last_message_at: string;
}

const CONV_COLS = "id, store_id, status, consumer_id, unread_for_store, last_message_at";

// ── LINE 回覆（純文字，reply token 限用一次）─────────────────
async function lineReply(replyToken: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LINE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
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

// 由 LINE userId 反查已綁定的消費者（null＝未綁定）。
// consumers 是平台級身分（一個帳號可能是多店會員），line_user_id 唯一索引也是全站唯一，
// 這裡不能也不需要加 store_id 過濾——跨店紅線在下一層：get_stock/search_products/
// get_my_orders 本來就用 ctx.storeId 限定查詢範圍，同一人問到 Daigogo 的 bot 只查得到 Daigogo。
async function resolveConsumer(userId: string): Promise<BoundConsumer | null> {
  const { data } = await admin
    .from("consumers")
    .select("id, name, phone, email")
    .eq("line_user_id", userId)
    .maybeSingle();
  return (data as BoundConsumer) ?? null;
}

// 找這位已綁定會員在本店、channel='line' 的對話；沒有就開一條新的。
async function findOrCreateLineConversation(
  consumerId: string,
): Promise<ConversationRow> {
  const { data: existing } = await admin
    .from("conversations")
    .select(CONV_COLS)
    .eq("store_id", STORE_ID)
    .eq("consumer_id", consumerId)
    .eq("channel", "line")
    .neq("status", "closed")
    .order("last_message_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return existing as ConversationRow;

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      store_id: STORE_ID,
      channel: "line",
      consumer_id: consumerId,
      status: initialStatus({ aiEnabled: true }),
    })
    .select(CONV_COLS)
    .single();
  if (error) throw new Error(`建立 LINE 對話失敗：${error.message}`);
  return created as ConversationRow;
}

async function insertMessage(
  conv: ConversationRow,
  sender: "consumer" | "assistant",
  content: string,
) {
  const { data, error } = await admin
    .from("messages")
    .insert({
      conversation_id: conv.id,
      store_id: conv.store_id,
      sender,
      content: content.slice(0, 4000),
    })
    .select("id, sender, content, created_at")
    .single();
  if (error) throw new Error(`寫入訊息失敗：${error.message}`);
  return data;
}

// 該對話最後一則真人客服訊息的時間（判斷接管後是否閒置逾時）
async function lastStaffAt(conversationId: number): Promise<string | null> {
  const { data } = await admin
    .from("messages")
    .select("created_at")
    .eq("conversation_id", conversationId)
    .eq("sender", "staff")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ?? null;
}

const FALLBACK_BOUND = "目前暫時無法回答這個問題，已經幫你通知客服，會盡快回覆你 🙏";
const FALLBACK_UNBOUND = "這個問題我這邊沒辦法直接查詢，建議你先登入會員綁定 LINE，或透過網站客服聯絡我們 🙏";

// 2026-08-19 臨時停用：AI 回覆內容異常，先整個關掉 tool-use 回答，只保留「寫入＋轉真人」。
// 對應 web 客服的 ASSISTANT_KILL_SWITCH，同樣不用改程式碼、不用等快取，設 remote secret 即生效。
// 問題排除後把 LINE_AI_PAUSED 這個 secret 刪掉或設回非 "1" 即可恢復，不用重新部署。
const AI_PAUSED = Deno.env.get("LINE_AI_PAUSED") === "1";
const PAUSED_BOUND = "客服助理目前維護中，已經幫你通知客服，會盡快回覆你 🙏";
const PAUSED_UNBOUND = "客服助理目前維護中，建議稍後再問，或透過網站客服聯絡我們 🙏";

// 處理一則文字訊息：找/建對話（已綁定才建）→ 共用引擎 → 回覆 → 寫回訊息（已綁定才寫）
async function handleTextMessage(userId: string, text: string, replyToken: string) {
  const consumer = await resolveConsumer(userId);

  let conv: ConversationRow | null = null;
  let history: ConversationTurn[];

  if (consumer) {
    conv = await findOrCreateLineConversation(consumer.id);

    const lastStaff = conv.status === "human" ? await lastStaffAt(conv.id) : null;
    const status = nextStatusOnConsumerMessage({
      status: conv.status,
      lastStaffAt: lastStaff,
      lastMessageAt: conv.last_message_at,
      aiEnabled: true,
    });
    const consumerMsg = await insertMessage(conv, "consumer", text);
    await admin.from("conversations").update({
      status,
      last_message_at: consumerMsg.created_at,
      unread_for_store: (conv.unread_for_store ?? 0) + 1,
    }).eq("id", conv.id);
    conv.status = status;

    if (AI_PAUSED) {
      await admin.from("conversations")
        .update({ status: nextStatusOnRequestHuman(conv.status) }).eq("id", conv.id);
      await notifyStore(admin, {
        storeId: STORE_ID,
        title: `${STORE_NAME}｜LINE 客服訊息（AI 暫停中）`,
        body: text,
        conversationId: conv.id,
      });
      await lineReply(replyToken, PAUSED_BOUND);
      await insertMessage(conv, "assistant", PAUSED_BOUND);
      return;
    }

    if (!shouldRunAssistant(status, { aiEnabled: true })) {
      // 真人已在處理／正在等真人：訊息已寫入，回覆管道是 LINE 官方帳號後台，不是這裡。
      // 不回 LINE（reply token 過期即可，無副作用），只通知店主有新訊息。
      await notifyStore(admin, {
        storeId: STORE_ID,
        title: `${STORE_NAME}｜新的 LINE 客服訊息`,
        body: text,
        conversationId: conv.id,
      });
      return;
    }

    history = await loadMemory(admin, { storeId: STORE_ID, consumerId: consumer.id, limit: MEMORY_LIMIT });
  } else {
    // 未綁定：AI 暫停中就直接回固定文案，不落地也不用進共用引擎
    if (AI_PAUSED) {
      await lineReply(replyToken, PAUSED_UNBOUND);
      return;
    }
    // 未綁定：不落地儲存，單輪即時回答
    history = [{ role: "user", content: text }];
  }

  let raisedHand = false;
  const ctx: ToolContext = {
    admin,
    storeId: STORE_ID,
    channel: "line",
    conversationId: conv ? conv.id : null,
    visitorToken: null,
    consumer,
    history,
    requestHuman: async (reason: string) => {
      if (raisedHand) return;
      raisedHand = true;
      if (!conv) return; // 未綁定：沒有對話可轉，也沒有人會被通知
      await admin.from("conversations")
        .update({ status: nextStatusOnRequestHuman(conv.status) }).eq("id", conv.id);
      await notifyStore(admin, {
        storeId: STORE_ID,
        title: `${STORE_NAME}｜LINE 客服轉真人`,
        body: reason,
        conversationId: conv.id,
      });
    },
  };

  const prompt = buildSystemPrompt({
    storeName: STORE_NAME,
    identified: !!consumer,
    consumerName: consumer?.name ?? null,
    channel: "line",
    bindUrl: BIND_URL,
  });
  const rawAnswer = await askAssistant(prompt, ctx);
  // 轉真人的話用固定文案覆蓋 LLM 自己的措辭：已綁定/未綁定講的話不一樣（見 spec），
  // 這件事的正確性不能賭 LLM 每次都照 system prompt 的指示講對。
  const answer = raisedHand ? (conv ? FALLBACK_BOUND : FALLBACK_UNBOUND) : rawAnswer;

  await lineReply(replyToken, answer);

  if (conv) {
    const assistantMsg = await insertMessage(conv, "assistant", answer);
    await admin.from("conversations").update({ last_message_at: assistantMsg.created_at }).eq("id", conv.id);
  }
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

  for (const ev of body.events ?? []) {
    if (ev.type === "message" && ev.message?.type === "text" && ev.replyToken) {
      const userId = ev.source?.userId ?? "unknown";
      try {
        const gate = await checkRateLimit(userId);
        if (!gate.ok) {
          await lineReply(ev.replyToken, gate.message!);
          continue;
        }
        await admin.from("line_rate_log").insert({ line_user_id: userId });

        await handleTextMessage(userId, ev.message.text, ev.replyToken);
      } catch (e) {
        console.error("handle event error", e);
        try {
          await lineReply(ev.replyToken, "抱歉，系統出了點狀況，請稍後再試 🙏");
        } catch (_) { /* ignore */ }
      }
    }
  }

  return new Response("ok");
});
