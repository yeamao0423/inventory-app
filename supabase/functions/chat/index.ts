// ============================================================
// 商城站內聊天 —— 消費者端唯一入口（service role）
//
//   訪客 → 驗 Turnstile（開新對話時）→ 兩層限流 → 寫入訊息
//        → status='bot' 才跑客服助理；waiting_human／human 只寫入並通知店主
//        → 回覆寫入後透過 Realtime Broadcast 推給該訪客
//
// 消費者端不直接連資料庫（ADR-0002），所以這支用 service role，
// 每一次讀寫都自己把 store_id 與訪客識別碼對起來，不能少。
//
// 需要的環境變數（Supabase Function Secrets）：
//   ANTHROPIC_API_KEY、TURNSTILE_SECRET_KEY
//   （選填）ANTHROPIC_MODEL、CHAT_RATE_PER_MIN、CHAT_RATE_PER_DAY、CHAT_MEMORY_LIMIT
//   （選填，推播用）VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DEFAULT_MEMORY_LIMIT,
  isValidVisitorToken,
  nextStatusOnConsumerMessage,
  nextStatusOnRequestHuman,
  rateLimitDecision,
  shouldRunAssistant,
} from "../_shared/assistant/policy.ts";
import type { ConversationStatus } from "../_shared/assistant/policy.ts";
import { loadMemory } from "../_shared/assistant/memory.ts";
import { buildSystemPrompt } from "../_shared/assistant/prompt.ts";
import { askAssistant } from "../_shared/assistant/engine.ts";
import type { BoundConsumer, ToolContext } from "../_shared/assistant/types.ts";
import { broadcast, notifyStore } from "./notify.ts";

const RATE_PER_MIN = Number(Deno.env.get("CHAT_RATE_PER_MIN") ?? "6");
const RATE_PER_DAY = Number(Deno.env.get("CHAT_RATE_PER_DAY") ?? "300");
const MEMORY_LIMIT = Number(Deno.env.get("CHAT_MEMORY_LIMIT") ?? String(DEFAULT_MEMORY_LIMIT));
const MAX_TEXT = 2000;

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// 訪客端頻道名＝訪客識別碼
const visitorTopic = (token: string) => `chat:${token}`;

interface ConversationRow {
  id: number;
  store_id: number;
  status: ConversationStatus;
  consumer_id: string | null;
  visitor_token: string | null;
  unread_for_store: number;
}

// ── Turnstile（開新對話時的主防線）─────────────────────────
async function verifyTurnstile(token: unknown, ip: string): Promise<boolean> {
  const secret = Deno.env.get("TURNSTILE_SECRET_KEY");
  // 沒設 secret 就一律擋（fail closed）—— 公開網路上的匿名入口不能沒有人機驗證
  if (!secret) {
    console.error("TURNSTILE_SECRET_KEY 未設定，拒絕建立新對話");
    return false;
  }
  if (!token || typeof token !== "string") return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
    });
    const verify = await res.json();
    return !!verify.success;
  } catch (e) {
    console.error("turnstile verify error", e);
    return false;
  }
}

// ── 兩層限流：每訪客每分鐘、每店每日 ────────────────────────
// 擋下時「不呼叫 Anthropic API」—— 匿名訪客能直接觸發 AI，這是帳單風險。
async function checkRateLimit(storeId: number, visitorKey: string) {
  const minAgo = new Date(Date.now() - 60_000).toISOString();
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

  const [{ count: perVisitor }, { count: perStore }] = await Promise.all([
    admin.from("chat_rate_log").select("*", { count: "exact", head: true })
      .eq("visitor_key", visitorKey).gte("created_at", minAgo),
    admin.from("chat_rate_log").select("*", { count: "exact", head: true })
      .eq("store_id", storeId).gte("created_at", dayAgo),
  ]);

  return rateLimitDecision({
    perVisitorCount: perVisitor ?? 0,
    perStoreCount: perStore ?? 0,
    perVisitorLimit: RATE_PER_MIN,
    perStoreLimit: RATE_PER_DAY,
  });
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
      store_id: conv.store_id, // 冗餘欄位，讓後台 RLS 不用 join
      sender,
      content: content.slice(0, MAX_TEXT),
    })
    .select("id, sender, content, created_at")
    .single();
  if (error) throw new Error(`寫入訊息失敗：${error.message}`);
  return data;
}

async function loadConsumer(consumerId: string | null): Promise<BoundConsumer | null> {
  if (!consumerId) return null;
  const { data } = await admin
    .from("consumers")
    .select("id, name, phone, email")
    .eq("id", consumerId)
    .maybeSingle();
  return (data as BoundConsumer) ?? null;
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

// ── GET：載入歷史／輪詢新訊息 ───────────────────────────────
async function handleGet(url: URL) {
  const storeId = Number(url.searchParams.get("storeId"));
  const visitorToken = url.searchParams.get("visitorToken");
  const conversationId = Number(url.searchParams.get("conversationId"));
  const sinceId = Number(url.searchParams.get("sinceId") ?? "0");

  if (!Number.isInteger(storeId) || storeId <= 0) return json({ error: "缺少 storeId" }, 400);
  if (!isValidVisitorToken(visitorToken)) return json({ error: "訪客識別碼格式錯誤" }, 400);

  // 沒帶對話就以 (店, 訪客識別碼) 找最近一條，讓「重新整理後歷史還在」成立
  let conv: ConversationRow | null = null;
  if (Number.isInteger(conversationId) && conversationId > 0) {
    const { data } = await admin
      .from("conversations")
      .select("id, store_id, status, consumer_id, visitor_token, unread_for_store")
      .eq("id", conversationId)
      .eq("store_id", storeId)
      .eq("visitor_token", visitorToken) // 對不上就查不到 → 別人的對話讀不走
      .maybeSingle();
    conv = data as ConversationRow | null;
  } else {
    const { data } = await admin
      .from("conversations")
      .select("id, store_id, status, consumer_id, visitor_token, unread_for_store")
      .eq("store_id", storeId)
      .eq("visitor_token", visitorToken)
      .neq("status", "closed")
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    conv = data as ConversationRow | null;
  }

  if (!conv) return json({ conversationId: null, status: null, messages: [] });

  const { data: msgs } = await admin
    .from("messages")
    .select("id, sender, content, created_at")
    .eq("conversation_id", conv.id)
    .gt("id", sinceId)
    .order("id", { ascending: true })
    .limit(200);

  return json({ conversationId: conv.id, status: conv.status, messages: msgs ?? [] });
}

// ── POST action=claim：認領 ─────────────────────────────────
// 訪客登入或下單、身分揭曉時，把該訪客識別碼底下、屬於該店的對話填上 consumer_id。
async function handleClaim(req: Request, body: Record<string, unknown>) {
  const storeId = Number(body.storeId);
  const visitorToken = body.visitorToken;
  if (!Number.isInteger(storeId) || storeId <= 0) return json({ error: "缺少 storeId" }, 400);
  if (!isValidVisitorToken(visitorToken)) return json({ error: "訪客識別碼格式錯誤" }, 400);

  // 身分由消費者自己的 access token 證明，不能讓呼叫端直接指定 consumer_id
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "需要登入" }, 401);
  const { data: userRes, error } = await admin.auth.getUser(jwt);
  if (error || !userRes?.user) return json({ error: "登入狀態無效" }, 401);

  const { data: updated } = await admin
    .from("conversations")
    .update({ consumer_id: userRes.user.id })
    .eq("store_id", storeId)
    .eq("visitor_token", visitorToken)
    .is("consumer_id", null)
    .select("id");

  return json({ ok: true, claimed: updated?.length ?? 0 });
}

// ── POST：送出訊息 / 要求真人 ───────────────────────────────
async function handlePost(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "格式錯誤" }, 400);
  }

  const action = String(body.action ?? "send");
  if (action === "claim") return handleClaim(req, body);

  const storeId = Number(body.storeId);
  const visitorToken = body.visitorToken;
  const text = String(body.text ?? "").trim();

  if (!Number.isInteger(storeId) || storeId <= 0) return json({ error: "缺少 storeId" }, 400);
  if (!isValidVisitorToken(visitorToken)) return json({ error: "訪客識別碼格式錯誤" }, 400);
  if (action === "send") {
    if (!text) return json({ error: "訊息不可為空" }, 400);
    if (text.length > MAX_TEXT) return json({ error: "訊息太長了" }, 400);
  }

  const ip = req.headers.get("CF-Connecting-IP") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  // ── 限流：任何會產生成本的動作之前先擋 ──
  const gate = await checkRateLimit(storeId, visitorToken);
  if (!gate.ok) {
    return json({ error: gate.message, rateLimited: true, reason: gate.reason }, 429);
  }
  await admin.from("chat_rate_log").insert({ store_id: storeId, visitor_key: visitorToken });

  // ── 找出或建立對話 ──
  const conversationId = Number(body.conversationId ?? 0);
  let conv: ConversationRow | null = null;

  if (Number.isInteger(conversationId) && conversationId > 0) {
    const { data } = await admin
      .from("conversations")
      .select("id, store_id, status, consumer_id, visitor_token, unread_for_store")
      .eq("id", conversationId)
      .eq("store_id", storeId)
      .eq("visitor_token", visitorToken)
      .maybeSingle();
    conv = data as ConversationRow | null;
    if (!conv) return json({ error: "找不到這條對話" }, 404);
  } else {
    // 建立新對話才驗 Turnstile（每則訊息都驗會擋掉正常對話節奏）
    const ok = await verifyTurnstile(body.turnstileToken, ip);
    if (!ok) return json({ error: "人機驗證失敗，請重新整理再試" }, 403);

    const { data: store } = await admin
      .from("stores").select("id, name, is_active").eq("id", storeId).maybeSingle();
    if (!store?.is_active) return json({ error: "店家不存在或未營運" }, 404);

    const { data, error } = await admin
      .from("conversations")
      .insert({ store_id: storeId, channel: "web", visitor_token: visitorToken, status: "bot" })
      .select("id, store_id, status, consumer_id, visitor_token, unread_for_store")
      .single();
    if (error) return json({ error: "建立對話失敗" }, 500);
    conv = data as ConversationRow;
  }

  const { data: store } = await admin
    .from("stores").select("name").eq("id", conv.store_id).maybeSingle();
  const storeName = store?.name ?? "本店";

  // ── 消費者要求真人 ──
  if (action === "request_human") {
    const status = nextStatusOnRequestHuman(conv.status);
    await admin.from("conversations")
      .update({ status, last_message_at: new Date().toISOString() })
      .eq("id", conv.id);
    await notifyStore(admin, {
      storeId: conv.store_id,
      title: `${storeName}｜顧客要求真人客服`,
      body: "有顧客在商城聊天視窗要求真人客服",
      conversationId: conv.id,
    });
    await broadcast(visitorTopic(visitorToken), "status", { conversationId: conv.id, status });
    return json({ conversationId: conv.id, status, messages: [] });
  }

  // ── 寫入消費者訊息 ──
  // 接管後閒置逾時會自動交還給助理；已關閉的對話由消費者重新開啟
  const status = nextStatusOnConsumerMessage({
    status: conv.status,
    lastStaffAt: conv.status === "human" ? await lastStaffAt(conv.id) : null,
  });

  const consumerMsg = await insertMessage(conv, "consumer", text);
  await admin.from("conversations")
    .update({
      status,
      last_message_at: consumerMsg.created_at,
      unread_for_store: (conv.unread_for_store ?? 0) + 1,
    })
    .eq("id", conv.id);

  const out = [consumerMsg];

  if (shouldRunAssistant(status)) {
    const consumer = await loadConsumer(conv.consumer_id);
    const history = await loadMemory(admin, {
      storeId: conv.store_id,
      consumerId: conv.consumer_id,
      visitorToken: conv.consumer_id ? null : visitorToken,
      limit: MEMORY_LIMIT,
    });

    // 助理舉手時要做的事：改狀態、通知店主。用 flag 避免同一輪重複通知。
    let raisedHand = false;
    const ctx: ToolContext = {
      admin,
      storeId: conv.store_id,
      channel: "web",
      conversationId: conv.id,
      visitorToken: conv.consumer_id ? null : visitorToken,
      consumer,
      history,
      requestHuman: async (reason: string) => {
        if (raisedHand) return;
        raisedHand = true;
        await admin.from("conversations")
          .update({ status: "waiting_human" }).eq("id", conv!.id);
        await notifyStore(admin, {
          storeId: conv!.store_id,
          title: `${storeName}｜助理轉真人`,
          body: reason,
          conversationId: conv!.id,
        });
      },
    };

    console.log(
      `[chat] conv=${conv.id} store=${conv.store_id} status=${status} ` +
        `identified=${!!consumer} memory=${history.length}`,
    );
    const prompt = buildSystemPrompt({
      storeName,
      identified: !!consumer,
      consumerName: consumer?.name ?? null,
    });
    const answer = await askAssistant(prompt, ctx);
    const assistantMsg = await insertMessage(conv, "assistant", answer);
    await admin.from("conversations")
      .update({ last_message_at: assistantMsg.created_at })
      .eq("id", conv.id);
    out.push(assistantMsg);

    await broadcast(visitorTopic(visitorToken), "message", {
      conversationId: conv.id,
      message: assistantMsg,
      status: raisedHand ? "waiting_human" : status,
    });

    return json({
      conversationId: conv.id,
      status: raisedHand ? "waiting_human" : status,
      messages: out,
    });
  }

  // 助理靜音中（等真人／真人接管中）：只寫入並通知店主
  await notifyStore(admin, {
    storeId: conv.store_id,
    title: `${storeName}｜新的客服訊息`,
    body: text,
    conversationId: conv.id,
  });

  return json({ conversationId: conv.id, status, messages: out });
}

// ── 進入點 ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    if (req.method === "GET") return await handleGet(url);
    if (req.method === "POST") return await handlePost(req);
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("chat error", e);
    return json({ error: "伺服器錯誤" }, 500);
  }
});
