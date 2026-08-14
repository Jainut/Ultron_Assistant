import type { Tool, ToolContext } from "./tool.ts";

type RegisteredTool = Tool<unknown, unknown>;

export class ToolRegistry {
    private readonly tools = new Map<string, RegisteredTool>();

    register<TInput, TOutput>(tool: Tool<TInput, TOutput>): this {
        this.tools.set(tool.name, tool as RegisteredTool);
        return this;
    }

    has(name: string): boolean {
        return this.tools.has(name);
    }

    async execute<TOutput>(
        name: string,
        input: unknown,
        context?: ToolContext,
    ): Promise<TOutput> {
        const tool = this.tools.get(name);

        if (!tool) {
            throw new Error(`Ferramenta desconhecida: ${name}`);
        }

        return await tool.execute(input, context) as TOutput;
    }

    list(): ReadonlyArray<Pick<RegisteredTool, "name" | "description" | "category">> {
        return [...this.tools.values()].map(({ name, description, category }) => ({
            name,
            description,
            category,
        }));
    }
}
