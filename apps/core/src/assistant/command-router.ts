import type { ToolResult } from "../../shared/types.js";
import { getTime } from "../../tools/clock.tool.js";

function normalizeCommand(command: string): string {
    return command.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

export async function routeCommand(command: string): Promise<ToolResult> {
    const normalizedCommand = normalizeCommand(command);

    if (!normalizedCommand) {
        return {
            success: false,
            message: "Comando não informado",
        };
    }

    const timeExpressions = [
        "que horas são",
        "me diga as horas",
        "me diga a hora",
        "me diga o horário",
        "me diga o horário atual",
        "me diga a hora atual",
        "me diga as horas agora",
        "qual o horário",
        "qual a hora",
        "qual o horário atual",
    ];

    const isTimeCommand = timeExpressions.some((expression) => { return normalizedCommand.includes(normalizeCommand(expression)); } );

    if (isTimeCommand) {
        return getTime();
    }

    return {
        success: true,
        message: `Comando não reconhecido: ${command}`,
    }
}