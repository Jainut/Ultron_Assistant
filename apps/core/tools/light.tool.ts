import { spawn } from "node:child_process";
import path from "node:path";
import { servicePath } from "../src/config/runtime.ts";


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
    options: LightOptions
): Promise<string> {
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


    return new Promise(
        (resolve, reject) => {
            const childProcess =
                spawn(
                    pythonExe,
                    args,
                    {
                        cwd: serviceDir,
                        windowsHide: true,
                        env: {
                            ...process.env,
                            ULTRON_TUYA_SKIP_LOCAL:
                                preferCloudTransport
                                    ? "1"
                                    : process.env.ULTRON_TUYA_SKIP_LOCAL,
                        },
                    },
                );


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
                    } catch {
                        // Compatibilidade com respostas antigas do servico.
                    }

                    resolve(
                        stdout.trim()
                    );
                },
            );
        },
    );
}
