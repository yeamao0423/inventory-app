// ============================================================
// LINE 登入（消費者側，統一入口）
//   兩條入口收斂到同一段核心（docs/line-login-plan.md §1-2）：
//     LIFF     → 前端送 { id_token }
//     Web OAuth → 前端送 { code, redirect_uri }，本函式用 Channel Secret 換 id_token
//   核心分支（§2）：
//     A. line_user_id 已綁 consumer → 直接簽發 session
//     B. 未綁且無 email → 回 need_email（乾淨版：不建帳號、不發 session）
//     C. 有 email → 查 consumers：
//        命中（既有原生會員）→ 回 needs_verification（先驗證再合併，防接管；
//          前端走 signInWithPassword 或 signInWithOtp，成功後呼叫既有 line-bind 綁定）
//        未命中 → 建 auth user + consumers + 綁 line_user_id → 簽發 session
//   乾淨版（決策 7）：不建佔位帳號；email 沒填完成前 DB 零殘留。
//
// 環境變數：LINE_LOGIN_CHANNEL_ID（fallback；優先讀 stores.settings.line_channel_id）
//          LINE_LOGIN_CHANNEL_SECRET（fallback；優先讀 store_line_secrets 表，
//            該表零 client policy、僅 service role 可讀，店主由後台 RPC 寫入）
//          SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 由平台注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { exchangeCode, verifyIdToken } from "../_shared/lineVerify.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// 與 DB 的 normalize_email(lower(trim())) 對齊
const normalizeEmail = (e: string) => e.trim().toLowerCase();
const isValidEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function randomPassword() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 讀店家 settings：功能閘門（平台開通＋店家啟用）與 Channel ID 都由後端解析，
// 防前端偽造 client_id、也防繞過 UI 直打 API
async function getStoreSettings(storeId: number | null): Promise<Record<string, unknown> | null> {
  if (!storeId) return null;
  const { data } = await admin
    .from("stores").select("settings").eq("id", storeId).maybeSingle();
  return (data?.settings as Record<string, unknown>) ?? null;
}

// 簽發 session：magiclink 的 token_hash（generateLink 不寄信），前端 verifyOtp 換 session
async function issueSession(email: string) {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error || !data?.properties?.hashed_token) return null;
  return data.properties.hashed_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { id_token, code, redirect_uri, mode, email, p_store_id } = body;
    if (mode !== "login" && mode !== "create") return json({ error: "無效的模式" }, 400);
    if (!id_token && !code) return json({ error: "缺少 LINE 驗證資訊" }, 400);

    // 功能閘門：需平台開通（line_login_provisioned）＋店家啟用（line_login_enabled）
    const storeId = Number.isFinite(Number(p_store_id)) ? Number(p_store_id) : null;
    const settings = await getStoreSettings(storeId);
    if (!settings?.line_login_provisioned || !settings?.line_login_enabled) {
      return json({ error: "此商店尚未啟用 LINE 登入" }, 403);
    }
    const channelId = settings.line_channel_id
      ? String(settings.line_channel_id)
      : (Deno.env.get("LINE_LOGIN_CHANNEL_ID") ?? null);
    if (!channelId) return json({ error: "LINE 登入尚未設定，請聯絡店家" }, 500);

    // (1) 取得已驗證的 LINE 身分（兩條入口收斂）
    let effectiveIdToken: string = id_token ?? "";
    if (!effectiveIdToken && code) {
      let secret: string | null = null;
      if (storeId) {
        const { data: secretRow } = await admin
          .from("store_line_secrets")
          .select("channel_secret")
          .eq("store_id", storeId)
          .maybeSingle();
        secret = secretRow?.channel_secret ?? null;
      }
      secret = secret ?? Deno.env.get("LINE_LOGIN_CHANNEL_SECRET") ?? null;
      if (!secret) return json({ error: "LINE 登入尚未設定（缺少密鑰），請聯絡店家" }, 500);
      if (!redirect_uri) return json({ error: "缺少 redirect_uri" }, 400);
      const exchanged = await exchangeCode(code, redirect_uri, channelId, secret);
      if (!exchanged) return json({ error: "LINE 授權已失效，請重新登入" }, 403);
      effectiveIdToken = exchanged;
    }
    const identity = await verifyIdToken(effectiveIdToken, channelId);
    if (!identity) return json({ error: "LINE 驗證失敗，請重新操作" }, 403);
    const { lineUserId, name: lineName } = identity;

    // (2) A：此 LINE 是否已綁 consumer → 直接登入
    //（同樣不用 maybeSingle：髒資料重複時取最早一筆，登入不因此中斷）
    const { data: boundRows, error: qErr } = await admin
      .from("consumers")
      .select("id, email")
      .eq("line_user_id", lineUserId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (qErr) return json({ error: "查詢失敗，請稍後再試" }, 500);
    const bound = boundRows?.[0] ?? null;

    if (bound) {
      const tokenHash = await issueSession(bound.email);
      if (!tokenHash) return json({ error: "登入簽發失敗，請稍後再試" }, 500);
      return json({ ok: true, status: "logged_in", token_hash: tokenHash, line_name: lineName });
    }

    // (3) B：未綁定。login 模式一律回 need_email（前端顯示 email 關卡，
    //     LINE 有給 email 就預填讓使用者確認/修改；Web 流把 id_token 回傳供第二輪使用，
    //     因為 authorization code 只能用一次）
    if (mode === "login") {
      return json({
        ok: true,
        status: "need_email",
        line_name: lineName,
        line_email: identity.email,
        id_token: effectiveIdToken,
      });
    }

    // (4) create 模式：強制要有 email（乾淨版——沒 email 不建任何東西）
    const finalEmail = typeof email === "string" ? normalizeEmail(email) : "";
    if (!finalEmail || !isValidEmail(finalEmail)) {
      return json({
        ok: true,
        status: "need_email",
        line_name: lineName,
        line_email: identity.email,
        id_token: effectiveIdToken,
      });
    }

    // (5) C：email 對到既有原生會員 → 先驗證再合併（防帳號接管）。
    //     乾淨版不產生佔位帳號，所以任何命中都視為「需要證明本人」；
    //     驗證成功後由既有 line-bind 函式（帶本人 session）完成綁定。
    //     email 理論上唯一，但 DB 無約束、髒資料可能多筆（如孤兒列撞名）：
    //     只要有一筆還沒綁 LINE 就放行本人驗證（line-bind 會綁到本人 session 那筆）；
    //     全部都綁了別的 LINE 才擋。
    const { data: existingRows, error: eErr } = await admin
      .from("consumers")
      .select("id, line_user_id")
      .eq("email", finalEmail);
    if (eErr) return json({ error: "查詢失敗，請稍後再試" }, 500);

    if (existingRows && existingRows.length > 0) {
      const bindable = existingRows.some((r) => !r.line_user_id || r.line_user_id === lineUserId);
      if (!bindable) {
        return json({ error: "這個 Email 的帳號已綁定其他 LINE 帳號" }, 409);
      }
      return json({
        ok: true,
        status: "needs_verification",
        line_name: lineName,
        id_token: effectiveIdToken,
      });
    }

    // (6) 全新會員：建 auth user（真實 email）→ consumers ＋ 綁定 → 簽發 session
    const { data: created, error: cErr } = await admin.auth.admin.createUser({
      email: finalEmail,
      password: randomPassword(),
      email_confirm: true,
      user_metadata: { name: lineName ?? "LINE 會員", line_login: true },
    });

    if (cErr) {
      // email 已存在於 auth 但 consumers 沒有（歷史殘料或並發）→ 一樣走本人驗證
      const already = /already|registered|exists|duplicate/i.test(cErr.message ?? "");
      if (already) {
        return json({
          ok: true,
          status: "needs_verification",
          line_name: lineName,
          id_token: effectiveIdToken,
        });
      }
      return json({ error: "帳號建立失敗，請稍後再試" }, 500);
    }

    const userId = created.user.id;
    const { error: insErr } = await admin.from("consumers").insert({
      id: userId,
      email: finalEmail,
      name: lineName ?? "LINE 會員",
      line_user_id: lineUserId,
    });
    if (insErr) {
      // 綁定衝突（極端並發：同 LINE 同時 create）：清掉剛建的 auth user，改用既有帳號
      await admin.auth.admin.deleteUser(userId).catch(() => {});
      const { data: againRows } = await admin
        .from("consumers")
        .select("id, email")
        .eq("line_user_id", lineUserId)
        .order("created_at", { ascending: true })
        .limit(1);
      const again = againRows?.[0] ?? null;
      if (again) {
        const tokenHash = await issueSession(again.email);
        if (!tokenHash) return json({ error: "登入簽發失敗，請稍後再試" }, 500);
        return json({ ok: true, status: "logged_in", token_hash: tokenHash, line_name: lineName });
      }
      return json({ error: "帳號建立失敗，請稍後再試" }, 500);
    }

    const tokenHash = await issueSession(finalEmail);
    if (!tokenHash) return json({ error: "登入簽發失敗，請稍後再試" }, 500);
    return json({ ok: true, status: "created", token_hash: tokenHash, line_name: lineName });
  } catch (_e) {
    return json({ error: "伺服器錯誤" }, 500);
  }
});
