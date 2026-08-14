import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import type { ToolResult } from '../shared/types.js';
import { applicationResolver } from '../src/system/application-resolver.ts';
import type { ToolContext } from '../src/tools/tool.ts';
import { debugLog } from '../src/utils/debug.ts';
import { perf } from '../src/utils/performance.ts';

export function warmApplicationIndex(): void {
    applicationResolver.start();
}

export async function openApp(
    appName: string,
    context: ToolContext = {},
): Promise<ToolResult> {
    const match = await perf.measure(
        "Application resolution",
        () => applicationResolver.resolve(appName, context.signal),
    );

    if (!match) {
        return {
            success: false,
            message: `Não encontrei o aplicativo ${appName}.`,
        };
    }

    if (match.alternatives.length > 0 && match.score < 0.92) {
        const choices = [match.entry, ...match.alternatives]
            .map(entry => entry.name)
            .filter((name, index, values) => values.indexOf(name) === index);

        if (choices.length > 1) {
            return {
                success: false,
                message: `Encontrei mais de uma opção: ${choices.join(" ou ")}?`,
                data: { ambiguous: true, choices },
            };
        }
    }

    context.signal?.throwIfAborted();
    debugLog("[APP RESOLVER]", {
        query: appName,
        match: match.entry.name,
        source: match.entry.source,
        score: Number(match.score.toFixed(2)),
    });

    return new Promise((resolve) => {
        const startedAt = performance.now();
        const child = spawn(match.entry.command, match.entry.args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });

        child.once("spawn", () => {
            child.unref();
            perf.record("Process spawn", performance.now() - startedAt);

            resolve({
                success: true,
                message: `Abrindo ${match.entry.name}.`,
                speech: "Abrindo.",
                data: {
                    application: match.entry.name,
                    source: match.entry.source,
                    score: match.score,
                },
            });
        });

        child.once("error", () => {
            resolve({
                success: false,
                message: `Não consegui abrir ${match.entry.name}.`,
            });
        });
    });
}

export async function closeApp(
    appName: string,
    context: ToolContext = {},
): Promise<ToolResult> {
    const match = await perf.measure(
        "Application resolution",
        () => applicationResolver.resolve(appName, context.signal),
    );
    const executable = match?.entry.executable;

    if (!match || !executable) {
        return {
            success: false,
            message: `Não encontrei um processo seguro para fechar ${appName}.`,
        };
    }

    context.signal?.throwIfAborted();
    return await new Promise(resolve => {
        execFile(
            "taskkill.exe",
            ["/IM", path.basename(executable), "/T"],
            { windowsHide: true },
            (error, stdout, stderr) => {
                resolve(error
                    ? { success: false, message: stderr.trim() || stdout.trim() || `Não consegui fechar ${match.entry.name}.` }
                    : { success: true, message: `${match.entry.name} fechado.`, speech: "Fechado." });
            },
        );
    });
}
