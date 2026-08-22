import type { AutomationEngine } from "../../automation-engine/automation-engine.ts";
import type {
    Automation,
    AutomationCreateInput,
    AutomationId,
    Job,
    JobId,
} from "../../automation-engine/types.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type { ToolDefinition } from "../tool.ts";

interface AutomationCreateToolInput extends Omit<AutomationCreateInput, "id"> {}
interface AutomationReferenceInput { automationId: string }
interface JobReferenceInput { jobId: string }

export function createAutomationTools(engine: AutomationEngine) {
    const list: ToolDefinition<Record<string, never>, { automations: Automation[] }> = {
        name: "automation.list",
        description: "Lista as automações persistentes configuradas no Ultron.",
        category: "automation",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        capabilities: ["automation.read"],
        confirmationLevel: "none",
        executionMode: "sync",
        successStatus: "confirmed",
        responsePolicy: { deterministic: false },
        async execute() {
            const automations = await engine.listAutomations();
            return {
                success: true,
                status: "confirmed",
                message: `${automations.length} automação(ões) configurada(s).`,
                data: { automations },
            };
        },
    };

    const create: ToolDefinition<AutomationCreateToolInput, Automation> = {
        name: "automation.create",
        description: "Cria uma automação persistente composta por trigger, conditions e actions registradas.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", minLength: 1 },
                description: { type: "string" },
                trigger: {
                    type: "object",
                    properties: {
                        type: { type: "string" },
                        config: { type: "object" },
                    },
                    required: ["type", "config"],
                },
                conditions: { type: "array", items: { type: "object" } },
                actions: { type: "array", minItems: 1, items: { type: "object" } },
                status: { type: "string", enum: ["enabled", "paused", "disabled"] },
                timezone: { type: "string" },
                metadata: { type: "object" },
            },
            required: ["name", "trigger", "actions"],
            additionalProperties: false,
        },
        capabilities: ["automation.write"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        responsePolicy: {
            deterministic: true,
            format: result => result.success ? "Automação criada." : result.message,
        },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            const automation = await engine.createAutomation(input);
            return {
                success: true,
                status: "confirmed",
                message: `Automação ${automation.name} criada e persistida.`,
                speech: "Automação criada.",
                data: automation,
            };
        },
    };

    const run: ToolDefinition<AutomationReferenceInput, Job> = {
        name: "automation.run",
        description: "Agenda a execução imediata de uma automação existente.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: { automationId: { type: "string" } },
            required: ["automationId"],
            additionalProperties: false,
        },
        capabilities: ["automation.run"],
        confirmationLevel: "none",
        executionMode: "background",
        successStatus: "accepted",
        responsePolicy: {
            deterministic: true,
            format: result => result.success ? "Execução agendada." : result.message,
        },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            const job = await engine.runNow(input.automationId as AutomationId);
            return {
                success: true,
                status: "accepted",
                message: "A execução da automação foi agendada.",
                speech: "Execução agendada.",
                data: job,
            };
        },
    };

    const remove: ToolDefinition<AutomationReferenceInput, { automationId: string }> = {
        name: "automation.delete",
        description: "Exclui uma automação persistente e seus jobs após confirmação explícita.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: { automationId: { type: "string" } },
            required: ["automationId"],
            additionalProperties: false,
        },
        capabilities: ["automation.delete"],
        confirmationLevel: "dangerous",
        executionMode: "async",
        successStatus: "confirmed",
        responsePolicy: {
            deterministic: true,
            format: result => result.success ? "Automação excluída." : result.message,
        },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            const deleted = await engine.deleteAutomation(input.automationId as AutomationId);
            return deleted
                ? {
                    success: true,
                    status: "confirmed",
                    message: "Automação excluída.",
                    speech: "Automação excluída.",
                    data: { automationId: input.automationId },
                }
                : {
                    success: false,
                    status: "failed",
                    message: "Automação não encontrada.",
                    error: { code: "AUTOMATION_NOT_FOUND", message: "Automação não encontrada." },
                };
        },
    };

    const cancelJob: ToolDefinition<JobReferenceInput, { jobId: string }> = {
        name: "automation.cancelJob",
        description: "Cancela um job de automação agendado ou em execução.",
        category: "automation",
        inputSchema: {
            type: "object",
            properties: { jobId: { type: "string" } },
            required: ["jobId"],
            additionalProperties: false,
        },
        capabilities: ["automation.write"],
        confirmationLevel: "none",
        executionMode: "async",
        successStatus: "confirmed",
        responsePolicy: { deterministic: true },
        async execute(input, context) {
            context.signal?.throwIfAborted();
            const cancelled = await engine.cancelJob(input.jobId as JobId);
            return cancelled
                ? {
                    success: true,
                    status: "confirmed",
                    message: "Job cancelado.",
                    speech: "Job cancelado.",
                    data: { jobId: input.jobId },
                }
                : {
                    success: false,
                    status: "failed",
                    message: "Job não encontrado.",
                    error: { code: "JOB_NOT_FOUND", message: "Job não encontrado." },
                };
        },
    };

    return [list, create, run, remove, cancelJob] as const;
}

export function registerAutomationTools(
    registry: ToolRegistry,
    engine: AutomationEngine,
): void {
    for (const tool of createAutomationTools(engine) as readonly ToolDefinition<any, any>[]) {
        if (!registry.has(tool.name)) registry.register(tool);
    }
}
