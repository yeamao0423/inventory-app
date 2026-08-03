// 通知店主：即時（Realtime Broadcast）＋ PWA 推播。
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendPush, vapidConfigured } from "../_shared/webpush.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * 推一則 Broadcast 給某個頻道。
 * 訪客端頻道名＝訪客識別碼（ADR-0002：猜不到就聽不到），
 * 所以識別碼等同能力型鑰匙，不可放進 URL 或任何會被記錄的地方。
 */
export async function broadcast(topic: string, event: string, payload: unknown) {
  try {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload }] }),
    });
    if (!res.ok) console.error("broadcast failed", res.status, await res.text().catch(() => ""));
  } catch (e) {
    // 推不出去不該讓整條訊息失敗（前端還有輪詢兜底）
    console.error("broadcast error", e);
  }
}

/** 推播給該店所有已訂閱的後台成員。失效的訂閱順手清掉。 */
export async function notifyStore(
  admin: SupabaseClient,
  { storeId, title, body, conversationId }: {
    storeId: number;
    title: string;
    body: string;
    conversationId: number;
  },
) {
  if (!vapidConfigured()) {
    console.warn("VAPID 未設定，略過推播");
    return;
  }
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("store_id", storeId);

  if (!subs?.length) return;

  const results = await Promise.all(
    subs.map((s: { endpoint: string; p256dh: string; auth: string }) =>
      sendPush(s, {
        title,
        body: body.slice(0, 120),
        conversationId,
        url: `/inbox?c=${conversationId}`,
      }).catch((e) => {
        console.error("sendPush error", e);
        return { endpoint: s.endpoint, ok: false, status: 0, gone: false };
      })
    ),
  );

  const gone = results.filter((r) => r.gone).map((r) => r.endpoint);
  if (gone.length) {
    await admin.from("push_subscriptions").delete().in("endpoint", gone);
  }
}
