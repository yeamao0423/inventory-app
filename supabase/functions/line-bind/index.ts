// ============================================================
// LINE 帳號綁定（消費者側）
//   LIFF 頁面送來：①消費者的 Supabase access token ②LINE 的 id_token
//   本函式：驗 Supabase token → 確認是哪個 consumer
//          驗 LINE id_token → 取回「已驗證的 userId」（前端無法偽造）
//          → 寫入 consumers.line_user_id（service role）
//
// 環境變數：LINE_LOGIN_CHANNEL_ID（fallback；優先讀 stores.settings.line_channel_id，
//            與 line-login 一致——多租戶下每店各有自己的 LINE Login channel）
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const LINE_LOGIN_CHANNEL_ID = Deno.env.get("LINE_LOGIN_CHANNEL_ID") ?? "2010616155";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    // (1) 驗消費者的 Supabase 登入 → 取得 consumer id
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "尚未登入" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "登入狀態無效，請重新登入" }, 401);
    const consumerId = userData.user.id;

    // (2) 驗 LINE id_token → 取回已驗證的 userId(sub)
    const { id_token, p_store_id } = await req.json().catch(() => ({}));
    if (!id_token) return json({ error: "缺少 LINE 驗證資訊" }, 400);

    // channel id 以店家 settings 為準（每店各有自己的 channel），env 只當 fallback
    let channelId = LINE_LOGIN_CHANNEL_ID;
    const storeId = Number.isFinite(Number(p_store_id)) ? Number(p_store_id) : null;
    if (storeId) {
      const { data: storeRow } = await admin
        .from("stores").select("settings").eq("id", storeId).maybeSingle();
      const cid = (storeRow?.settings as Record<string, unknown> | null)?.line_channel_id;
      if (cid) channelId = String(cid);
    }

    const verifyRes = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token, client_id: channelId }),
    });
    const verify = await verifyRes.json();
    if (!verifyRes.ok || !verify.sub) {
      return json({ error: "LINE 驗證失敗，請重新操作" }, 403);
    }
    const lineUserId = verify.sub as string;

    // (3) 此 LINE 帳號是否已綁到別的消費者
    //（不用 maybeSingle：它遇重複列會報錯，原寫法錯誤被忽略時衝突檢查會被跳過）
    const { data: existingRows, error: exErr } = await admin
      .from("consumers")
      .select("id")
      .eq("line_user_id", lineUserId);
    if (exErr) return json({ error: "查詢失敗，請稍後再試" }, 500);
    if (existingRows?.some((r) => r.id !== consumerId)) {
      return json({ error: "這個 LINE 帳號已綁定其他會員帳號" }, 409);
    }

    // (4) 寫入綁定（service role 繞過 RLS 與保護 trigger）。
    //     新用戶（email 驗證碼流程）此時還沒有 consumers 列：update 影響 0 列
    //     時直接建立，避免綁定默默遺失。
    const { data: updRows, error: updErr } = await admin
      .from("consumers")
      .update({ line_user_id: lineUserId })
      .eq("id", consumerId)
      .select("id");
    if (updErr) return json({ error: "綁定寫入失敗，請稍後再試" }, 500);
    if (!updRows || updRows.length === 0) {
      const meta = (userData.user.user_metadata ?? {}) as Record<string, unknown>;
      const { error: insErr } = await admin.from("consumers").insert({
        id: consumerId,
        email: userData.user.email,
        name: (meta.name as string | undefined) ?? "LINE 會員",
        line_user_id: lineUserId,
      });
      if (insErr) return json({ error: "綁定寫入失敗，請稍後再試" }, 500);
    }

    return json({ ok: true, line_name: verify.name ?? null });
  } catch (_e) {
    return json({ error: "伺服器錯誤" }, 500);
  }
});
