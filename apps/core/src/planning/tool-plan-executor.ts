import type { ToolResult } from "../../shared/types.ts";

export interface PlannedToolStep {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
    /** Dependencies must point to earlier steps. They are semantic, not just locks. */
    readonly dependsOn?: readonly string[];
    /** Steps sharing a key never overlap, but an order-only lock does not imply success. */
    readonly serialKey?: string;
}

export interface ToolPlanExecution {
    readonly step: PlannedToolStep;
    readonly state: "executed" | "blocked";
    readonly result: ToolResult;
}

export type PlannedToolExecutor = (step: PlannedToolStep, index: number) => Promise<ToolResult>;

const MAX_PLAN_STEPS = 12;

/**
 * Executes a bounded, forward-only DAG. Independent branches run in parallel;
 * dependency and resource ordering remain deterministic.
 */
export async function executeToolPlan(
    steps: readonly PlannedToolStep[],
    execute: PlannedToolExecutor,
    signal?: AbortSignal,
): Promise<readonly ToolPlanExecution[]> {
    validatePlan(steps);
    signal?.throwIfAborted();

    const executions = new Map<string, Promise<ToolPlanExecution>>();
    const resourceTails = new Map<string, Promise<ToolPlanExecution>>();

    for (const [index, step] of steps.entries()) {
        const dependencies = (step.dependsOn ?? []).map((id) => executions.get(id)!);
        const resourceTail = step.serialKey ? resourceTails.get(step.serialKey) : undefined;
        const pending = (async (): Promise<ToolPlanExecution> => {
            const resolved = await Promise.all(dependencies);
            if (resourceTail) await resourceTail;
            signal?.throwIfAborted();

            const blocked = resolved.find((item) => !item.result.success);
            if (blocked) {
                const message = `Não executei ${step.name} porque a etapa ${blocked.step.name} não foi concluída.`;
                return {
                    step,
                    state: "blocked",
                    result: {
                        success: false,
                        status: "failed",
                        message,
                        speech: message,
                        data: {
                            blockedBy: blocked.step.id,
                            blockedTool: blocked.step.name,
                        },
                        error: {
                            code: "PLAN_DEPENDENCY_BLOCKED",
                            message,
                            retryable: false,
                        },
                    },
                };
            }

            return { step, state: "executed", result: await execute(step, index) };
        })();
        executions.set(step.id, pending);
        if (step.serialKey) resourceTails.set(step.serialKey, pending);
    }

    return Promise.all(steps.map((step) => executions.get(step.id)!));
}

function validatePlan(steps: readonly PlannedToolStep[]): void {
    if (steps.length > MAX_PLAN_STEPS) {
        throw new RangeError(`Um plano pode ter no máximo ${MAX_PLAN_STEPS} etapas.`);
    }
    const seen = new Set<string>();
    for (const step of steps) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(step.id) || seen.has(step.id)) {
            throw new TypeError("O plano contém um ID de etapa inválido ou duplicado.");
        }
        if (!step.name.trim() || step.name.length > 128) {
            throw new TypeError("O plano contém uma ferramenta inválida.");
        }
        const dependencies = step.dependsOn ?? [];
        if (
            new Set(dependencies).size !== dependencies.length ||
            dependencies.some((id) => !seen.has(id))
        ) {
            throw new TypeError(
                "Dependências precisam ser únicas e apontar para etapas anteriores.",
            );
        }
        seen.add(step.id);
    }
}

/** Contextual actions depend on the previous action sharing their serial key. */
export function planSerialDependencies<
    T extends {
        readonly name: string;
        readonly input: Record<string, unknown>;
        readonly serialKey?: string;
    },
>(actions: readonly T[], prefix = "step"): PlannedToolStep[] {
    const previousByKey = new Map<string, string>();
    return actions.map((action, index) => {
        const id = `${prefix}-${index + 1}`;
        const previous = action.serialKey ? previousByKey.get(action.serialKey) : undefined;
        if (action.serialKey) previousByKey.set(action.serialKey, id);
        return {
            id,
            name: action.name,
            input: action.input,
            serialKey: action.serialKey,
            ...(previous ? { dependsOn: [previous] } : {}),
        };
    });
}
