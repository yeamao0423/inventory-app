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
// AI 自動回覆預設關閉，逐店開通（stores.settings.ai_reply === true）。關著的店走的是
// 「純人工客服」：訊息照常寫入、照常推播店主，對話直接排進 waiting_human 等真人回覆。
// 平台端另有一個急停開關 ASSISTANT_KILL_SWITCH，設成 1 就無視所有店家設定全部關掉。
//
// 需要的環境變數（Supabase Function Secrets）：
//   ANTHROPIC_API_KEY、TURNSTILE_SECRET_KEY
//   （選填）ANTHROPIC_MODEL、CHAT_RATE_PER_MIN、CHAT_RATE_PER_DAY、CHAT_MEMORY_LIMIT
//   （選填，急停）ASSISTANT_KILL_SWITCH=1
//   （選填，推播用）VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  DEFAULT_MEMORY_LIMIT,
  initialStatus,
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

// 平台急停：出事時一秒關掉全平台的 AI 回覆，不用改任何店家設定、不用等快取。
// 沒設 = 不啟用（各店照自己的 settings.ai_reply 走）。
const KILL_SWITCH = Deno.env.get("ASSISTANT_KILL_SWITCH") === "1";

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

interface StoreRow {
  name: string;
  isActive: boolean;
  aiEnabled: boolean;
}

// 店家設定。aiEnabled 一律走「明確設 true 才開」——
// 新開的店、settings 沒這個鍵、整包 settings 是 null，全部視為關。
async function loadStore(storeId: number): Promise<StoreRow | null> {
  const { data } = await admin
    .from("stores").select("name, is_active, settings").eq("id", storeId).maybeSingle();
  if (!data) return null;
  const settings = (data.settings ?? {}) as Record<string, unknown>;
  return {
    name: data.name ?? "本店",
    isActive: !!data.is_active,
    aiEnabled: !KILL_SWITCH && settings.ai_reply === true,
  };
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

// ── 身分與對話歸屬 ──────────────────────────────────────────
// 對話屬於「人」，裝置只是他從哪裡連進來。找對話的順序因此變成
// 「登入身分優先、訪客識別碼次之」，而存取權也不能再靠 visitor_token 一個條件擋。

const CONV_COLS = "id, store_id, status, consumer_id, visitor_token, unread_for_store";

// JWT 的 payload 只拿來當「不必問了」的快篩，不當憑據 —— 真正的驗證一律走 getUser()。
// 商城未登入時送的是 anon key（role=anon），格式也是 JWT；沒有這道快篩的話，
// 每 6 秒一次的輪詢都會多打一次 auth 伺服器。解不開就回 true，讓 getUser() 去判。
function looksAuthenticated(jwt: string): boolean {
  try {
    const payload = JSON.parse(
      atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    );
    return payload?.role === "authenticated" && !!payload?.sub;
  } catch {
    return true;
  }
}

// 由消費者自己的 access token 證明身分，不能讓呼叫端直接指定 consumer_id。
// 沒帶 token、token 過期、不是消費者 → 一律回 null，走訪客那條路。
// 對話不該因為登入過期就斷掉。
async function resolveConsumerId(req: Request): Promise<string | null> {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt || !looksAuthenticated(jwt)) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const { data: consumer } = await admin
    .from("consumers").select("id").eq("id", data.user.id).maybeSingle();
  return consumer?.id ?? null;
}

// 這位客人又從一台新裝置來了。失敗不影響訊息寫入 —— 少一筆對照只是下次要重新認一次。
async function rememberDevice(conv: ConversationRow, visitorToken: string) {
  const { error } = await admin
    .from("conversation_devices")
    .upsert(
      { conversation_id: conv.id, visitor_token: visitorToken, store_id: conv.store_id },
      { onConflict: "conversation_id,visitor_token", ignoreDuplicates: true },
    );
  if (error) console.error("rememberDevice failed", error.message);
}

/** 這個訪客識別碼登記在哪些對話底下（用來反查與推播）。 */
async function conversationIdsForToken(storeId: number, visitorToken: string): Promise<number[]> {
  const { data } = await admin
    .from("conversation_devices")
    .select("conversation_id")
    .eq("store_id", storeId)
    .eq("visitor_token", visitorToken);
  return (data ?? []).map((r) => r.conversation_id as number);
}

/**
 * 能不能讀寫這條對話。
 *
 * 原本靠 .eq("visitor_token", …) 把「猜 conversationId 讀別人對話」擋在查詢裡；
 * 一條對話能掛多個裝置之後那個條件不再成立，必須換成這裡的兩條規則。
 * 少了它，任何人都能用自己的識別碼去讀任意對話。
 */
async function canAccess(
  conv: ConversationRow,
  consumerId: string | null,
  visitorToken: string,
): Promise<boolean> {
  if (consumerId && conv.consumer_id === consumerId) return true;
  const { data } = await admin
    .from("conversation_devices").select("conversation_id")
    .eq("conversation_id", conv.id).eq("visitor_token", visitorToken).maybeSingle();
  return !!data;
}

/**
 * 找出這次該用哪一條對話。
 *   帶了 conversationId → 撈出來並驗存取權（見 canAccess）
 *   已登入             → 該店該會員最近一條未關閉的
 *   其餘               → 該訪客識別碼登記過的最近一條未關閉的
 * 找不到回 null（呼叫端決定要不要建新的）。
 */
async function findConversation(
  { storeId, consumerId, visitorToken, conversationId }: {
    storeId: number;
    consumerId: string | null;
    visitorToken: string;
    conversationId?: number;
  },
): Promise<ConversationRow | null> {
  if (conversationId && Number.isInteger(conversationId) && conversationId > 0) {
    const { data } = await admin
      .from("conversations").select(CONV_COLS)
      .eq("id", conversationId).eq("store_id", storeId).maybeSingle();
    const conv = data as ConversationRow | null;
    if (!conv) return null;
    return (await canAccess(conv, consumerId, visitorToken)) ? conv : null;
  }

  if (consumerId) {
    const { data } = await admin
      .from("conversations").select(CONV_COLS)
      .eq("store_id", storeId).eq("consumer_id", consumerId).neq("status", "closed")
      .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
    if (data) return data as ConversationRow;
  }

  const ids = await conversationIdsForToken(storeId, visitorToken);
  if (ids.length === 0) return null;
  const { data } = await admin
    .from("conversations").select(CONV_COLS)
    .eq("store_id", storeId).in("id", ids).neq("status", "closed")
    .order("last_message_at", { ascending: false }).limit(1).maybeSingle();
  return (data as ConversationRow | null) ?? null;
}

// ── GET：載入歷史／輪詢新訊息 ───────────────────────────────
async function handleGet(req: Request, url: URL) {
  const storeId = Number(url.searchParams.get("storeId"));
  const visitorToken = url.searchParams.get("visitorToken");
  const conversationId = Number(url.searchParams.get("conversationId"));
  const sinceId = Number(url.searchParams.get("sinceId") ?? "0");

  if (!Number.isInteger(storeId) || storeId <= 0) return json({ error: "缺少 storeId" }, 400);
  if (!isValidVisitorToken(visitorToken)) return json({ error: "訪客識別碼格式錯誤" }, 400);

  // 首次載入才撈店家設定：widget 要靠 aiEnabled 決定標題寫「客服助理」還是「客服訊息」。
  // 之後的輪詢（sinceId > 0）不撈 —— 開關不會在一次對話中途改，不值得每幾秒多一次查詢。
  const store = sinceId > 0 ? null : await loadStore(storeId);
  const aiFields = store ? { aiEnabled: store.aiEnabled } : {};

  // 登入身分優先、訪客識別碼次之。沒帶對話時仍會找回最近一條，
  // 讓「重新整理後歷史還在」以及「換一台裝置登入後接得上」同時成立。
  const consumerId = await resolveConsumerId(req);
  const conv = await findConversation({
    storeId,
    consumerId,
    visitorToken: visitorToken as string,
    conversationId: Number.isInteger(conversationId) && conversationId > 0
      ? conversationId
      : undefined,
  });

  // 存取權不足時 findConversation 回 null，走的是這條「回空」的路 ——
  // 回 403 等於告訴對方「這條對話存在」。
  if (!conv) return json({ conversationId: null, status: null, messages: [], ...aiFields });

  const { data: msgs } = await admin
    .from("messages")
    .select("id, sender, content, created_at")
    .eq("conversation_id", conv.id)
    .gt("id", sinceId)
    .order("id", { ascending: true })
    .limit(200);

  return json({ conversationId: conv.id, status: conv.status, messages: msgs ?? [], ...aiFields });
}

// ── POST action=claim：認領 ─────────────────────────────────
// 訪客登入或下單、身分揭曉時，把該訪客識別碼底下、屬於該店的對話填上 consumer_id。
async function handleClaim(req: Request, body: Record<string, unknown>) {
  const storeId = Number(body.storeId);
  const visitorToken = body.visitorToken;
  if (!Number.isInteger(storeId) || storeId <= 0) return json({ error: "缺少 storeId" }, 400);
  if (!isValidVisitorToken(visitorToken)) return json({ error: "訪客識別碼格式錯誤" }, 400);

  // 身分由消費者自己的 access token 證明，不能讓呼叫端直接指定 consumer_id
  const consumerId = await resolveConsumerId(req);
  if (!consumerId) return json({ error: "需要登入" }, 401);

  const { data: updated } = await admin
    .from("conversations")
    .update({ consumer_id: consumerId })
    .eq("store_id", storeId)
    .eq("visitor_token", visitorToken)
    .is("consumer_id", null)
    .select(CONV_COLS);

  // 被認領的對話也要記上這台裝置 —— 舊版商城只呼叫 claim、不一定會馬上發訊息，
  // 少了這一筆的話這台裝置就反查不到自己剛認領的對話。
  const claimed = (updated ?? []) as ConversationRow[];
  await Promise.all(claimed.map((c) => rememberDevice(c, visitorToken as string)));

  return json({ ok: true, claimed: claimed.length });
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

  // ── 店家設定 ──
  // 對話一定屬於這家店（下面每個查詢都 .eq("store_id", storeId)），所以撈一次就夠，
  // 名稱（推播標題用）與 AI 開關都從這裡來。
  const store = await loadStore(storeId);
  if (!store) return json({ error: "店家不存在或未營運" }, 404);
  const storeName = store.name;
  const aiEnabled = store.aiEnabled;

  // ── 找出或建立對話 ──
  const consumerId = await resolveConsumerId(req);
  const conversationId = Number(body.conversationId ?? 0);
  const hasConversationId = Number.isInteger(conversationId) && conversationId > 0;
  let conv = await findConversation({
    storeId,
    consumerId,
    visitorToken: visitorToken as string,
    conversationId: hasConversationId ? conversationId : undefined,
  });

  // 帶了 conversationId 卻找不到 = 不存在或不是你的，兩種都回 404（不區分，避免探測）
  if (!conv && hasConversationId) return json({ error: "找不到這條對話" }, 404);

  if (!conv) {
    // 建立新對話才驗 Turnstile（每則訊息都驗會擋掉正常對話節奏）
    const ok = await verifyTurnstile(body.turnstileToken, ip);
    if (!ok) return json({ error: "人機驗證失敗，請重新整理再試" }, 403);

    if (!store.isActive) return json({ error: "店家不存在或未營運" }, 404);

    const { data, error } = await admin
      .from("conversations")
      .insert({
        store_id: storeId,
        channel: "web",
        visitor_token: visitorToken, // 建立這條對話的第一個裝置
        consumer_id: consumerId, // 一開始就知道是誰的話直接填上
        status: initialStatus({ aiEnabled }),
      })
      .select(CONV_COLS)
      .single();
    if (error) return json({ error: "建立對話失敗" }, 500);
    conv = data as ConversationRow;
  }

  // 每次都登記：這就是「同一個人又換了一台裝置」的紀錄點
  await rememberDevice(conv, visitorToken as string);

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
    return json({ conversationId: conv.id, status, messages: [], aiEnabled });
  }

  // ── 寫入消費者訊息 ──
  // 接管後閒置逾時會自動交還給助理；已關閉的對話由消費者重新開啟。
  // AI 關著的店不會落到 bot，一律進 waiting_human 等真人。
  const status = nextStatusOnConsumerMessage({
    status: conv.status,
    lastStaffAt: conv.status === "human" ? await lastStaffAt(conv.id) : null,
    aiEnabled,
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

  if (shouldRunAssistant(status, { aiEnabled })) {
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
      aiEnabled,
    });
  }

  // 助理靜音中（等真人／真人接管中／整店關閉 AI）：只寫入並通知店主。
  // 關閉 AI 的店每一則訊息都走這裡 —— 推播是店主唯一會知道有人在等的管道。
  await notifyStore(admin, {
    storeId: conv.store_id,
    title: `${storeName}｜新的客服訊息`,
    body: text,
    conversationId: conv.id,
  });

  return json({ conversationId: conv.id, status, messages: out, aiEnabled });
}

// ── 進入點 ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const url = new URL(req.url);
    if (req.method === "GET") return await handleGet(req, url);
    if (req.method === "POST") return await handlePost(req);
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    console.error("chat error", e);
    return json({ error: "伺服器錯誤" }, 500);
  }
});
