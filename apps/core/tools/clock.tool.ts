import type { ToolResult } from "../shared/types.js";

export function getTime(): ToolResult<{ hour: number; minute: number }> {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    return {
        success: true,
        message: `Agora são ${hour} e ${minute}`,
        data: { hour, minute },
    }
}