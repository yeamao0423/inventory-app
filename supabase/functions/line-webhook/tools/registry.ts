// 工具登記處：新增能力 = 建一個 tools/xxx.ts，再 import 加進 tools[] 即可。
import type { AnthropicToolDef, Tool } from "../core/types.ts";
import { searchProducts } from "./search-products.ts";
import { getStock } from "./get-stock.ts";

export const tools: Tool[] = [
  searchProducts,
  getStock,
  // 之後：searchKnowledge(RAG) / getOrderStatus / createOrder(action)...
];

// 名稱 → 工具，供 dispatch 查找
export const toolMap: Record<string, Tool> = Object.fromEntries(
  tools.map((t) => [t.name, t]),
);

// 轉成 Anthropic messages API 需要的宣告格式（每次呼叫送出）
export const toolDefs: AnthropicToolDef[] = tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));
