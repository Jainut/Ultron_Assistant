import { spawn } from "node:child_process";
import path from "node:path";
import { servicePath } from "../src/config/runtime.ts";
import type { ToolContext } from "../src/tools/tool.ts";
import { tuyaCloudClient } from "../src/automation/tuya-cloud-client.ts";
import { perf } from "../src/utils/performance.ts";
import { debugLog } from "../src/utils/debug.ts";


export type LightAction =
    | "on"
    | "off"
    | "color"
    | "brightness"
    | "white"
    | "status";


interface LightOptions {
    action: LightAction;

    red?: number;
    green?: number;
    blue?: number;

    brightness?: number;

    temperature?: number;
}


// Depois que a nuvem for usada com sucesso, nao repete o timeout da conexao
// local em todos os comandos seguintes desta execucao do Ultron.
let preferCloudTransport = false;


export async function controlLight(
    options: LightOptions,
    context: ToolContext = {},
): Promise<string> {
    context.signal?.throwIfAborted();
    const serviceDir = servicePath("light-tuya");

    const pythonExe = path.join(
        serviceDir,
        ".venv",
        "Scripts",
        "python.exe",
    );

    const script = path.join(
        serviceDir,
        "src",
        "light_service.py",
    );


    const args = [
        script,
        options.action,
    ];


    if (options.action === "color") {
        args.push(
            String(options.red ?? 255),
            String(options.green ?? 255),
            String(options.blue ?? 255),
        );
    }


    if (
        options.action ===
        "brightness"
    ) {
        args.push(
            String(
                options.brightness ?? 100
            )
        );
    }


    if (options.action === "white") {
        args.push(
            String(
                options.brightness ?? 100
            ),

            String(
                options.temperature ?? 50
            ),
        );
    }

    if (preferCloudTransport) {
        try {
            return await perf.measure(
                "Light API request",
                () => tuyaCloudClient.request(args.slice(1), context.signal),
            );
        } catch (error) {
            if (context.signal?.aborted) throw error;
            preferCloudTransport = false;
            debugLog("[LIGHT] Sessão persistente falhou; usando fluxo compatível.", error);
        }
    }


    return new Promise(
        (resolve, reject) => {
            let aborted = false;
            const processStartedAt = performance.now();
            const childProcess =
                spawn(
                    pythonExe,
                    args,
                    {
                        cwd: serviceDir,
                        windowsHide: true,
                        env: {
                            ...process.env,
                            PYTHONIOENCODING: "utf-8",
                            PYTHONUTF8: "1",
                            ULTRON_TUYA_SKIP_LOCAL:
                                preferCloudTransport
                                    ? "1"
                                    : process.env.ULTRON_TUYA_SKIP_LOCAL,
                        },
                    },
                );

            const abort = (): void => {
                aborted = true;
                childProcess.kill();
            };
            context.signal?.addEventListener("abort", abort, { once: true });


            let stdout = "";
            let stderr = "";


            childProcess.stdout.on(
                "data",
                data => {
                    stdout +=
                        data.toString();
                },
            );


            childProcess.stderr.on(
                "data",
                data => {
                    stderr +=
                        data.toString();
                },
            );


            childProcess.on(
                "error",
                reject,
            );


            childProcess.on(
                "close",
                code => {
                    context.signal?.removeEventListener("abort", abort);

                    if (aborted) {
                        reject(new DOMException("Controle da lâmpada cancelado.", "AbortError"));
                        return;
                    }

                    if (code !== 0) {
                        reject(
                            new Error(
                                stderr ||
                                stdout ||
                                `Light service finalizou com código ${code}`
                            )
                        );

                        return;
                    }

                    try {
                        const result = JSON.parse(stdout) as {
                            transport?: string;
                        };

                        preferCloudTransport =
                            result.transport === "tuya_cloud";

                        if (preferCloudTransport) {
                            tuyaCloudClient.start();
                        }
                    } catch {
                        // Compatibilidade com respostas antigas do servico.
                    }

                    perf.record("Light process + API", performance.now() - processStartedAt);
                    resolve(
                        stdout.trim()
                    );
                },
            );
        },
    );
}

export function stopLightService(): void {
    tuyaCloudClient.stop();
}
