import type { ToolResult } from "../../shared/types.js";
import { getTime } from "../../tools/clock.tool.js";
import { openApp } from "../../tools/open-app.tool.js";
import { clearTerminal } from "../../tools/clear-terminal.tool.ts";

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

    const clearTerminalExpressions = [
        "clear",
        "cls",
    ].map(normalizeCommand);

    const openMatch = normalizedCommand.match(
        /^(?:abra|abre|inicie|inicia) (?:o |a )?(.+)$/,
    );

    const isTimeCommand = timeExpressions.some((expression) => { return normalizedCommand.includes(normalizeCommand(expression)); });
    const isClearTerminalCommand = clearTerminalExpressions.some((expression) => { return normalizedCommand.includes(expression); });

    if (isTimeCommand) {
        return getTime();
    }

    if (openMatch) {
        const appName = openMatch[1];

        return openApp(appName);
    }

    if (isClearTerminalCommand) {
        return clearTerminal();
    }

    return {
        success: true,
        message: `Comando não reconhecido: ${command}`,
    }
}