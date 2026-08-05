import type { ToolResult } from "../shared/types.ts";

export function clearTerminal(): ToolResult {
  console.clear();

  return {
    success: true,
    message: "",
  };
}