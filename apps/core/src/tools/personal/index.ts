import {
    OperationalContext,
    operationalContext,
} from "../../context/operational-context.ts";
import {
    createPersonalProviderRuntimeFromEnv,
    type GooglePersonalProviderRuntimeOptions,
    type PersonalProviderRuntime,
} from "../../providers/personal-provider-runtime.ts";
import type { ToolRegistry } from "../tool-registry.ts";
import type { ToolDefinition } from "../tool.ts";
import { createCalendarTools } from "./calendar.tools.ts";
import { createMailTools } from "./mail.tools.ts";
import { createGoogleConnectTool } from "./provider.tools.ts";
import { createTaskTools } from "./task.tools.ts";

export * from "./calendar.tools.ts";
export * from "./mail.tools.ts";
export * from "./personal-tool-helpers.ts";
export * from "./provider.tools.ts";
export * from "./task.tools.ts";

export interface PersonalToolRegistrationOptions {
    readonly runtime?: PersonalProviderRuntime;
    readonly runtimeOptions?: GooglePersonalProviderRuntimeOptions;
    readonly contextStore?: OperationalContext;
}

type AnyPersonalTool = ToolDefinition<any, any>;

export function createPersonalProviderTools(
    runtime: PersonalProviderRuntime,
    contextStore: OperationalContext = operationalContext,
): readonly AnyPersonalTool[] {
    return [
        createGoogleConnectTool(runtime),
        ...createMailTools(runtime, contextStore),
        ...createTaskTools(runtime, contextStore),
        ...createCalendarTools(runtime, contextStore),
    ];
}

/**
 * Registers the complete personal-provider catalog in an existing registry.
 * It never authenticates automatically. The returned runtime can be retained
 * by bootstrap code for health/status inspection or explicit connect flows.
 */
export function registerPersonalProviderTools(
    registry: ToolRegistry,
    options: PersonalToolRegistrationOptions = {},
): PersonalProviderRuntime {
    const runtime = options.runtime
        ?? createPersonalProviderRuntimeFromEnv(options.runtimeOptions);
    for (const tool of createPersonalProviderTools(
        runtime,
        options.contextStore ?? operationalContext,
    )) {
        if (!registry.has(tool.name)) registry.register(tool);
    }
    return runtime;
}
