import { spawn } from 'node:child_process';
import { applications } from '../config/config.ts';
import type { ToolResult } from '../shared/types.js';

export async function openApp(appName: string): Promise<ToolResult> {
    const normalizedName = appName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

    const app = applications[normalizedName];

    if (!app) {
        return {
            success: false,
            message: `Aplicativo não encontrado: ${appName}`,
        };
    }

    return new Promise((resolve) => {
        const child = spawn(app.command, app.args, { detached: true, stdio: "ignore", windowsHide: true });

        child.once("spawn", () => {
            child.unref();

            resolve({
                success: true,
                message: `Ok senhor, abrindo: ${appName}`,
            });
        });

        child.once("error", (err) => {
            console.error(`Erro ao abrir o aplicativo: ${err.message}`);

            resolve({
                success: false,
                message: `Não consegui abrir o aplicativo: ${err.message}, senhor`,
            });
        });
    });
}