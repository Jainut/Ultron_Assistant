import { fileSystem } from "../../src/filesystem/file-system-service.ts";
import type { ToolContext, ToolDefinition } from "../../src/tools/tool.ts";
import type { ToolResult } from "../../shared/types.ts";

type PathInput = { path?: string; name?: string; query?: string };

function tool(
    name: string,
    description: string,
    execute: (input: PathInput, context?: ToolContext) => Promise<ToolResult> | ToolResult,
    options: {
        properties?: Record<string, unknown>;
        required?: string[];
        capability?: "filesystem.read" | "filesystem.write";
        successStatus?: "accepted" | "confirmed";
    } = {},
): ToolDefinition<PathInput, unknown> {
    return {
        name,
        description,
        category: "filesystem",
        inputSchema: {
            type: "object",
            properties: options.properties ?? {},
            required: options.required ?? [],
            additionalProperties: false,
        },
        capabilities: [options.capability ?? "filesystem.read"],
        confirmationLevel: "none",
        executionMode: "sync",
        successStatus: options.successStatus ?? "confirmed",
        serializeKey: () => "filesystem",
        responsePolicy: { deterministic: true },
        execute: async (input, context) => execute(input, context),
    };
}

export const filesystemTools = [
    tool("get_current_directory", "Informa a pasta de trabalho atual.", () => fileSystem.getCurrentDirectory()),
    tool("list_directory", "Lista arquivos e pastas.", (input, context) => fileSystem.listDirectory(input.path, context), { properties: { path: { type: "string" } } }),
    tool("change_directory", "Muda a pasta de trabalho contextual.", (input, context) => fileSystem.changeDirectory(input.path ?? "", context), { properties: { path: { type: "string" } }, required: ["path"] }),
    tool("create_directory", "Cria uma pasta sem sobrescrever conteúdo.", (input, context) => fileSystem.createDirectory(input.name ?? "", context), { properties: { name: { type: "string" } }, required: ["name"], capability: "filesystem.write" }),
    tool("find_directory", "Procura uma pasta no índice local.", (input, context) => fileSystem.findDirectory(input.query ?? "", context), { properties: { query: { type: "string" } }, required: ["query"] }),
    tool("find_file", "Procura um arquivo no índice local.", (input, context) => fileSystem.findFile(input.query ?? "", context), { properties: { query: { type: "string" } }, required: ["query"] }),
    tool("open_directory", "Abre uma pasta no Explorer.", (input, context) => fileSystem.openDirectory(input.path, context), { properties: { path: { type: "string" } }, successStatus: "accepted" }),
    tool("open_file", "Abre um arquivo no aplicativo padrão.", (input, context) => fileSystem.openFile(input.path ?? "", context), { properties: { path: { type: "string" } }, required: ["path"], successStatus: "accepted" }),
    tool("open_in_editor", "Abre um caminho no Visual Studio Code.", (input, context) => fileSystem.openInEditor(input.path, context), { properties: { path: { type: "string" } }, successStatus: "accepted" }),
    tool("open_in_explorer", "Mostra um arquivo ou pasta no Explorer.", (input, context) => fileSystem.openInExplorer(input.path, context), { properties: { path: { type: "string" } }, successStatus: "accepted" }),
    tool("open_project", "Localiza, abre e torna um projeto a pasta atual.", (input, context) => fileSystem.openProject(input.query ?? "", context), { properties: { query: { type: "string" } }, required: ["query"], successStatus: "accepted" }),
] satisfies Array<ToolDefinition<PathInput, unknown>>;
