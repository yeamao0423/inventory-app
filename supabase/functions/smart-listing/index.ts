// ============================================================
// 智慧上架 Edge Function — 照片 → Claude 多模態 → 商品資料草稿
//   驗 JWT → 導出 store_id → 每店每日限流 → Claude 辨識 → 消毒 → 記 log
//
// 本專案第一支驗證使用者 JWT 的 Edge Function：
//   store_id 一律由後端從 user_store_roles 導出，前端不傳（杜絕跨店冒用）。
//
// 需要的環境變數（Supabase Function Secrets）：
//   ANTHROPIC_API_KEY（LINE 客服已設定，沿用）
//   （選填）SMART_LISTING_MODEL、SMART_LISTING_RATE_PER_MONTH、SERPER_API_KEY
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY 由平台自動注入
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  parseClaudeJson,
  sanitizeSuggestion,
  SUPPORTED_CURRENCIES,
} from "./sanitize.ts";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const MODEL = Deno.env.get("SMART_LISTING_MODEL") ?? "claude-haiku-4-5-20251001";
// 品牌驗證搜尋（Serper）：沒設 key 就整層跳過，功能照常
const SERPER_KEY = Deno.env.get("SERPER_API_KEY") ?? "";
// 每店每月免費額度（UTC 月界、count 有輕微併發競態）— 帳單保險絲，不是硬保證
const MONTHLY_LIMIT = Number(Deno.env.get("SMART_LISTING_RATE_PER_MONTH") ?? "100");

// consumer/viewer 不能上架，也就不該燒 AI 額度
const ALLOWED_ROLES = ["super_admin", "admin", "editor"];
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGES = 3;
const MAX_IMAGE_B64 = 6_800_000; // base64 約 6.8MB ≈ 原檔 5MB（Anthropic 單圖上限）

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

// 注意：來源清單「刻意不進 prompt」——實測會把模型錨定成清單裡的相似品牌
// （UNÚN MEOMEO 被硬湊成 UNIQLO）。白名單比對改在程式碼做（normalizeBrand）。
function buildPrompt(categories: string[], tags: string[]): string {
  return `你是代購商城的商品上架助手。店家人在國外實體店，拍了商品／包裝／價標的照片，請辨識照片並輸出 JSON（只輸出 JSON，不要任何其他文字）：
{
  "name": 繁體中文商品名，含品牌與規格（如容量、入數）；品牌部分以照片原文為準；辨識不出就回 null,
  "source": 品牌名（店家把品牌當採購來源記錄）：把照片上印刷的品牌文字「一個字母一個字母照抄」。特別警告：若品牌字樣「近似」某個知名品牌（如 UNIQLO、Nike）但字母不完全一致，那它就「不是」那個知名品牌——照抄照片上的字母，絕不「更正」成你認識的品牌；辨識不出就回 null,
  "product_code": 吊牌/標籤上的款號、貨號（如「UM-SOMI BOXY 0123」這類編號，原文照抄）；沒有就回 null,
  "desc_zh": 商品描述：第一行一句短介紹，接著 2-4 行特點（每行一個特點，不用符號開頭）；寫不出就回 null,
  "cost": 照片價標上的數字；日本「稅込/稅抜」雙價一律取「稅込」含稅價；照片沒拍到價標就回 null,
  "currency": 價標幣別的 ISO 代碼，只能從這個清單挑：${SUPPORTED_CURRENCIES.join("、")}；cost 為 null 時也回 null,
  "category_suggestion": 從「分類清單」挑一個最合適的（照原文），清單為空或都不合適就回 null,
  "category_new": 只有在分類清單完全沒有合適選項時，提議「一個」簡短通用的新分類名（例：「食品」「美妝」，不要過細像「希臘優格」）；清單有合適的就回 null,
  "tag_suggestions": 從「標籤清單」挑 0-5 個合適的（照原文，陣列），沒有就回 [],
  "tag_new_suggestions": 標籤清單沒有合適的、且對這個商品有幫助時，提議 0-3 個簡短的新標籤名（陣列，例：「日本代購」「零食」），沒有就回 [],
  "notes": 給店家的辨識備註（例：「照片無標價，成本未填」「包裝為韓文，品名為音譯」），沒有就回 null
}
分類清單：${categories.length ? categories.join("、") : "（無）"}
標籤清單：${tags.length ? tags.join("、") : "（無）"}
規則：不確定的欄位一律回 null，絕不猜測或編造；分類與標籤只能從清單原文挑選；cost 只能是照片上實際看得到的數字。`;
}

// 品牌正規化比對：小寫＋去空白＋去變音符（UNÚN ≈ UNUN ≈ unun）
function normalizeBrand(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "").toLowerCase();
}

// ── 品牌驗證：來源清單沒命中＋模型自己說沒把握 → 才花一次搜尋 ──
async function searchWeb(query: string): Promise<{ title: string; snippet: string }[]> {
  const resp = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": SERPER_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 5 }),
  });
  if (!resp.ok) throw new Error(`serper ${resp.status}`);
  const data = await resp.json();
  return (data.organic ?? []).slice(0, 5).map((r: { title?: string; snippet?: string }) => ({
    title: r.title ?? "",
    snippet: r.snippet ?? "",
  }));
}

// 用搜尋結果讓模型修正品牌拼寫（純文字第二次呼叫，不重傳圖，成本極低）
async function verifyBrand(
  raw: Record<string, unknown>,
  results: { title: string; snippet: string }[],
): Promise<Record<string, unknown> | null> {
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
      messages: [{
        role: "user",
        content: `你是商品資料校對員。以下 JSON 草稿是從商品照片辨識的，其中品牌拼寫（source 欄位與 name 中的品牌部分）可能有誤。
任務：只根據下方搜尋結果修正品牌拼寫——若搜尋結果顯示該品牌有官方或最常用的正式寫法，採用之。注意：草稿的品牌可能被「誤認成外觀相似的知名品牌」；若搜尋結果（尤其款號命中的結果）一致指向另一個不同品牌，就以搜尋結果的品牌為準修正 source 與 name。若搜尋結果與這個商品無關、或無法佐證，就維持原值。除 source 與 name 外，其餘欄位一律原樣保留。只輸出修正後的完整 JSON，不要其他文字。

草稿：
${JSON.stringify(raw)}

搜尋結果：
${results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}`).join("\n")}`,
      }],
    }),
  });
  if (!resp.ok) {
    console.error("verifyBrand anthropic error", resp.status, await resp.text());
    return null;
  }
  const data = await resp.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("\n");
  return parseClaudeJson(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { images, categories, tags, sources } = await req.json();

    // 輸入驗證：1-3 張 base64 圖，格式與大小都要合法
    if (!Array.isArray(images) || images.length === 0 || images.length > MAX_IMAGES) {
      return json({ error: `請提供 1-${MAX_IMAGES} 張照片` }, 400);
    }
    for (const img of images) {
      if (
        !img || typeof img.data !== "string" || !img.data ||
        !ALLOWED_MEDIA.includes(img.media_type)
      ) {
        return json({ error: "照片格式不支援" }, 400);
      }
      if (img.data.length > MAX_IMAGE_B64) {
        return json({ error: "照片檔案過大" }, 400);
      }
    }

    // 驗 JWT：以 anon client 帶入使用者 Authorization 解出身分
    const authHeader = req.headers.get("Authorization") ?? "";
    const anon = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } = { user: null } } = await anon.auth.getUser();
    if (!user) return json({ error: "請先登入" }, 401);

    // store_id 由後端導出，不信任前端
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: roleRow } = await admin
      .from("user_store_roles")
      .select("store_id")
      .eq("user_id", user.id)
      .in("role", ALLOWED_ROLES)
      .limit(1)
      .maybeSingle();
    if (!roleRow) return json({ error: "沒有上架權限" }, 403);
    const storeId = roleRow.store_id;

    // 每店每月限流（查 ai_usage_log）
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const { count } = await admin
      .from("ai_usage_log")
      .select("*", { count: "exact", head: true })
      .eq("store_id", storeId)
      .gte("created_at", monthStart.toISOString());
    if ((count ?? 0) >= MONTHLY_LIMIT) {
      return json({ error: "本月 AI 額度已用完" }, 429);
    }

    // 呼叫 Claude 多模態
    const catList = Array.isArray(categories)
      ? categories.filter((c: unknown): c is string => typeof c === "string").slice(0, 100)
      : [];
    const tagList = Array.isArray(tags)
      ? tags.filter((t: unknown): t is string => typeof t === "string").slice(0, 100)
      : [];
    const srcList = Array.isArray(sources)
      ? sources.filter((s: unknown): s is string => typeof s === "string").slice(0, 100)
      : [];

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
        messages: [{
          role: "user",
          content: [
            ...images.map((img: { data: string; media_type: string }) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.media_type,
                data: img.data,
              },
            })),
            { type: "text", text: buildPrompt(catList, tagList) },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      console.error("anthropic error", resp.status, await resp.text());
      return json({ error: "AI 服務暫時無法使用，請稍後再試" }, 502);
    }

    const data = await resp.json();
    const text = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n");

    const raw = parseClaudeJson(text);
    if (!raw) {
      console.error("claude non-json response", text?.slice(0, 500));
      return json({ error: "AI 回應格式錯誤，請再試一次" }, 502);
    }

    // 品牌驗證閘門：來源清單命中（程式碼比對，非 prompt）→ 不搜（$0）。
    // 不在清單就一律搜——模型會把 UNÚN 自信誤認成 UNIQLO，它的信心不可靠；
    // 查詢優先帶款號（獨一無二，能把誤認的品牌搜回正軌）
    let verified = raw;
    const brandGuess = typeof raw.source === "string" ? raw.source.trim() : "";
    const listHit = brandGuess
      ? srcList.find((s) => normalizeBrand(s) === normalizeBrand(brandGuess))
      : undefined;
    if (listHit) {
      // 命中白名單 → 統一用店家慣用的清單原文
      verified = { ...raw, source: listHit };
    }
    const needVerify = !!brandGuess && !listHit;
    if (needVerify && SERPER_KEY) {
      try {
        const code = typeof raw.product_code === "string" ? raw.product_code.trim() : "";
        const query = `${brandGuess} ${code || (typeof raw.name === "string" ? raw.name : "")}`.trim();
        const results = await searchWeb(query);
        if (results.length > 0) {
          const corrected = await verifyBrand(raw, results);
          if (corrected) verified = corrected;
        }
      } catch (e) {
        // 搜尋掛了不擋流程：用視覺辨識結果，notes 註明未驗證
        console.error("brand verify failed", e);
        const prevNotes = typeof raw.notes === "string" ? raw.notes : "";
        verified = { ...raw, notes: [prevNotes, "品牌拼寫未經網路驗證"].filter(Boolean).join("；") };
      }
    }

    const suggestion = sanitizeSuggestion(verified, catList, tagList);

    // 記用量 log（存 AI 原始輸出供保留率抽樣），回傳 log id 供 products.ai_log_id
    const { data: logRow, error: logErr } = await admin
      .from("ai_usage_log")
      .insert({ store_id: storeId, model: MODEL, ai_output: verified })
      .select("id")
      .single();
    if (logErr) console.error("ai_usage_log insert error", logErr);

    return json({ ok: true, log_id: logRow?.id ?? null, suggestion });
  } catch (e) {
    console.error("smart-listing error", e);
    return json({ error: "伺服器錯誤" }, 500);
  }
});
