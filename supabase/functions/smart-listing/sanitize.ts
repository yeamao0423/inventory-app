// ============================================================
// AI 回傳消毒層 — 零依賴純函式（不碰 Deno API，vitest 可直接 import 測試）
// 原則：AI 的輸出一律不可信；不合法的值寧可回 null 留空，絕不讓幻覺進表單。
// ============================================================

// 與 src/constants/currency.js 同步維護（Deno 不能 import src，故複製一份）
export const SUPPORTED_CURRENCIES = [
  "TWD",
  "JPY", "KRW", "THB", "VND", "IDR", "CNY", "HKD", "MYR", "PHP", "SGD",
  "USD", "EUR",
];

const NAME_MAX = 200;
const DESC_MAX = 2000;
const NOTES_MAX = 500;
const TAGS_MAX = 5;
const NEW_NAME_MAX = 30;   // 新分類/標籤名：短才通用，過長多半是幻覺
const NEW_TAGS_MAX = 3;
const COST_MAX = 1_000_000_000;

export interface AiSuggestion {
  name: string | null;
  source: string | null;           // 品牌名（店家把品牌當採購來源用）
  desc_zh: string | null;
  cost: number | null;
  currency: string | null;
  category_suggestion: string | null;
  category_new: string | null;     // 清單沒有合適分類時的新分類提議（店家點「建立並套用」才生效）
  tag_suggestions: string[];
  tag_new_suggestions: string[];   // 新標籤提議，同上
  notes: string | null;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.slice(0, max) : t;
}

// Claude 常把 JSON 包在 ```json 圍欄或夾在文字裡 → 擷取第一段 {...} 解析
export function parseClaudeJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function sanitizeSuggestion(
  raw: unknown,
  categories: unknown,
  tags: unknown,
): AiSuggestion {
  const empty: AiSuggestion = {
    name: null,
    source: null,
    desc_zh: null,
    cost: null,
    currency: null,
    category_suggestion: null,
    category_new: null,
    tag_suggestions: [],
    tag_new_suggestions: [],
    notes: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const r = raw as Record<string, unknown>;

  const catList = Array.isArray(categories)
    ? categories.filter((c): c is string => typeof c === "string")
    : [];
  const tagList = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === "string")
    : [];

  // cost/currency 成對處理：任一不合法就雙雙留空。
  // 只填 cost 不填 currency 會讓 498(JPY) 被當成 498(TWD)，訂價事故比留空嚴重。
  let cost: number | null =
    typeof r.cost === "number" && Number.isFinite(r.cost) &&
      r.cost > 0 && r.cost < COST_MAX
      ? r.cost
      : null;
  let currency: string | null = null;
  if (typeof r.currency === "string") {
    const cur = r.currency.trim().toUpperCase();
    if (SUPPORTED_CURRENCIES.includes(cur)) currency = cur;
  }
  if (cost === null || currency === null) {
    cost = null;
    currency = null;
  }

  // 既有分類/標籤只能從傳入清單挑選（原文完全比對），杜絕幻覺；
  // 清單沒有的走 category_new / tag_new_suggestions 提議通道，由店家決定要不要建立
  const catRaw = cleanText(r.category_suggestion, NAME_MAX);
  let category = catRaw && catList.includes(catRaw) ? catRaw : null;

  // AI 把「其實已存在的分類」放進新分類提議 → 轉成一般建議，不重複建立
  let categoryNew = cleanText(r.category_new, NEW_NAME_MAX);
  if (categoryNew && catList.includes(categoryNew)) {
    if (!category) category = categoryNew;
    categoryNew = null;
  }

  const tagSuggestions = Array.isArray(r.tag_suggestions)
    ? [...new Set(
      r.tag_suggestions
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => tagList.includes(t)),
    )]
    : [];

  const tagNew: string[] = [];
  if (Array.isArray(r.tag_new_suggestions)) {
    for (const t of r.tag_new_suggestions) {
      const nm = cleanText(t, NEW_NAME_MAX);
      if (!nm) continue;
      if (tagList.includes(nm)) {
        // 已存在的標籤 → 併入一般建議
        if (!tagSuggestions.includes(nm)) tagSuggestions.push(nm);
      } else if (!tagNew.includes(nm) && tagNew.length < NEW_TAGS_MAX) {
        tagNew.push(nm);
      }
    }
  }

  return {
    name: cleanText(r.name, NAME_MAX),
    source: cleanText(r.source, 100),
    desc_zh: cleanText(r.desc_zh, DESC_MAX),
    cost,
    currency,
    category_suggestion: category,
    category_new: categoryNew,
    tag_suggestions: tagSuggestions.slice(0, TAGS_MAX),
    tag_new_suggestions: tagNew,
    notes: cleanText(r.notes, NOTES_MAX),
  };
}
