import { fileSystem } from "../../src/filesystem/file-system-service.ts";
import type { Tool, ToolContext } from "../../src/tools/tool.ts";
import type { ToolResult } from "../../shared/types.ts";

type PathInput = { path?: string; name?: string; query?: string };

function tool(
    name: string,
    description: string,
    execute: (input: PathInput, context?: ToolContext) => Promise<ToolResult> | ToolResult,
): Tool<PathInput, ToolResult> {
    return { name, description, category: "filesystem", execute: async (input, context) => execute(input, context) };
}

export const filesystemTools = [
    tool("get_current_directory", "Informa a pasta de trabalho atual.", () => fileSystem.getCurrentDirectory()),
    tool("list_directory", "Lista arquivos e pastas.", (input, context) => fileSystem.listDirectory(input.path, context)),
    tool("change_directory", "Muda a pasta de trabalho contextual.", (input, context) => fileSystem.changeDirectory(input.path ?? "", context)),
    tool("create_directory", "Cria uma pasta sem sobrescrever conteúdo.", (input, context) => fileSystem.createDirectory(input.name ?? "", context)),
    tool("find_directory", "Procura uma pasta no índice local.", (input, context) => fileSystem.findDirectory(input.query ?? "", context)),
    tool("find_file", "Procura um arquivo no índice local.", (input, context) => fileSystem.findFile(input.query ?? "", context)),
    tool("open_directory", "Abre uma pasta no Explorer.", (input, context) => fileSystem.openDirectory(input.path, context)),
    tool("open_file", "Abre um arquivo no aplicativo padrão.", (input, context) => fileSystem.openFile(input.path ?? "", context)),
    tool("open_in_editor", "Abre um caminho no Visual Studio Code.", (input, context) => fileSystem.openInEditor(input.path, context)),
    tool("open_in_explorer", "Mostra um arquivo ou pasta no Explorer.", (input, context) => fileSystem.openInExplorer(input.path, context)),
    tool("open_project", "Localiza, abre e torna um projeto a pasta atual.", (input, context) => fileSystem.openProject(input.query ?? "", context)),
] satisfies Array<Tool<PathInput, ToolResult>>;
