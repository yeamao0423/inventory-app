// 統一的工具執行入口：查表 → 執行 → 計時/log/錯誤包裝。
// 所有工具共用同一套錯誤與觀測邏輯，個別工具只寫查詢本身。
import type { ToolContext } from "./types.ts";
import { toolMap } from "../tools/registry.ts";

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = toolMap[name];
  if (!tool) return { error: `unknown tool: ${name}` };

  const started = Date.now();
  try {
    const result = await tool.handler(input ?? {}, ctx);
    console.log(`[tool] ${name} ok ${Date.now() - started}ms`);
    return result;
  } catch (e) {
    console.error(`[tool] ${name} error`, e);
    return { error: `工具執行失敗：${name}` };
  }
}
