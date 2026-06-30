import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { name, email, message, hp, token } = await req.json();

    // (a) honeypot：hp 是前端隱藏欄位，真人不會填。被填 = bot → 假裝成功直接丟掉
    if (hp) return json({ ok: true });

    // (b) 必填 + 長度上限（擋超長灌注）
    const nm = (name ?? "").trim();
    const em = (email ?? "").trim();
    const msg = (message ?? "").trim();
    if (!nm || !em || !msg) return json({ error: "缺少必填欄位" }, 400);
    if (nm.length > 100 || em.length > 200 || msg.length > 2000) {
      return json({ error: "內容過長" }, 400);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      return json({ error: "Email 格式不正確" }, 400);
    }

    // 訪客 IP（Cloudflare/代理會帶）
    const ip = req.headers.get("CF-Connecting-IP") ??
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

    // (c) Turnstile 驗證（主防線）：沒有有效 token = 機器人 → 擋
    if (!token) return json({ error: "缺少驗證" }, 400);
    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: Deno.env.get("TURNSTILE_SECRET_KEY")!,
          response: token,
          ...(ip ? { remoteip: ip } : {}),
        }),
      },
    );
    const verify = await verifyRes.json();
    if (!verify.success) return json({ error: "驗證失敗，請重新整理再試" }, 403);

    // service role：唯一能繞過 RLS 寫入 contact_submissions 的身分
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // (d) 同 IP 限流：1 小時內 ≥ 5 筆就擋
    if (ip) {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await admin
        .from("contact_submissions")
        .select("*", { count: "exact", head: true })
        .eq("ip", ip)
        .gte("created_at", since);
      if ((count ?? 0) >= 5) return json({ error: "送出太頻繁，請稍後再試" }, 429);
    }

    // (e) 寫入
    const { error } = await admin
      .from("contact_submissions")
      .insert({ name: nm, email: em, message: msg, ip });
    if (error) return json({ error: "寫入失敗，請稍後再試" }, 500);

    return json({ ok: true });
  } catch (_e) {
    return json({ error: "伺服器錯誤" }, 500);
  }
});
