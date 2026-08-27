import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { runtimeConfig } from "./config/runtime.ts";
import {
    InstanceControl,
    InstanceControlError,
    instanceAddress,
    isInstanceAbsent,
    isLocalHudUrl,
    requestInstance,
    validateRemoteText,
    type InstanceAddress,
    type InstanceReply,
    type InstanceStatus,
} from "./system/instance-control.ts";

type CliAction =
    | { operation: "start" | "status" | "stop" | "restart" | "hud" | "help" }
    | { operation: "command"; text: string };

export function parseCliArguments(args: readonly string[]): CliAction {
    if (args.length === 0) return { operation: "start" };
    if (args.length === 1 && ["-h", "--help", "help"].includes(args[0])) return { operation: "help" };
    if (args.length === 1 && ["start", "status", "stop", "restart", "hud"].includes(args[0].toLowerCase())) {
        return { operation: args[0].toLowerCase() as "start" | "status" | "stop" | "restart" | "hud" };
    }
    const text = (args[0] === "--" ? args.slice(1) : args).join(" ").trim();
    if (!validateRemoteText(text)) throw new InstanceControlError("Informe um comando de até 8 KiB, sem caracteres de controle.", "INVALID_REQUEST");
    return { operation: "command", text };
}

export function isMainEntry(moduleUrl: string): boolean {
    try {
        const entry = process.argv[1];
        if (!entry) return false;
        const canonicalEntry = realpathSync(entry);
        const canonicalModule = realpathSync(fileURLToPath(moduleUrl));
        return process.platform === "win32"
            ? canonicalEntry.toLowerCase() === canonicalModule.toLowerCase()
            : canonicalEntry === canonicalModule;
    } catch { return false; }
}

function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** A legacy instance or orphaned Whisper must not cause a second microphone/runtime. */
export function assertVoicePortAvailable(port: number, timeoutMs = 600): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const socket = createConnection({ host: "127.0.0.1", port });
        const finish = (error?: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => finish(new InstanceControlError(
            "Não consegui verificar se o serviço de voz anterior encerrou. Nenhum segundo runtime foi iniciado.", "VOICE_PORT_UNCERTAIN",
        )), timeoutMs);
        socket.once("connect", () => finish(new InstanceControlError(
            `Já existe um serviço na porta do Whisper (${port}). Encerre a instância anterior antes de iniciar esta versão; nenhum segundo microfone foi aberto.`,
            "VOICE_PORT_IN_USE",
        )));
        socket.once("error", (error: NodeJS.ErrnoException) => {
            if (error.code === "ECONNREFUSED") finish();
            else finish(new InstanceControlError("A porta de voz está em estado desconhecido. Não é seguro iniciar outra instância.", "VOICE_PORT_UNCERTAIN", { cause: error }));
        });
    });
}

async function lookup(address: InstanceAddress): Promise<InstanceStatus | null> {
    try {
        const reply = await requestInstance(address, "status");
        if (!reply.ok || !reply.status) throw new InstanceControlError("Resposta de status inválida; não é seguro iniciar outra instância.", "INVALID_INSTANCE_REPLY");
        return reply.status;
    } catch (error) {
        if (isInstanceAbsent(error)) return null;
        throw error;
    }
}

function formatStatus(status: InstanceStatus): string {
    const phase = {
        starting: "inicializando",
        ready: "pronto",
        degraded: "funcionando parcialmente",
        stopping: "encerrando",
    }[status.phase];
    return [
        `Ultron ${phase} (PID ${status.pid}).`,
        status.hudUrl ? `Interface: ${status.hudUrl}` : "",
        status.queuedCommands ? `Comandos aguardando: ${status.queuedCommands}.` : "",
        status.detail ?? "",
    ].filter(Boolean).join("\n");
}

/** Opening is limited to the locally reported HUD URL; no arbitrary shell input. */
export function openLocalHud(url: string): void {
    if (!isLocalHudUrl(url)) throw new InstanceControlError("Endereço do HUD inválido.", "INVALID_HUD_URL");
    const child = process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/c", "start", "", url], { stdio: "ignore", detached: true, windowsHide: true })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore", detached: true });
    child.on("error", () => { console.error(`Não consegui abrir o navegador. Acesse ${url}`); });
    child.unref();
}

export interface CliDependencies {
    readonly projectRoot?: string;
    readonly address?: InstanceAddress;
    readonly output?: (message: string) => void;
    readonly error?: (message: string) => void;
    readonly openHud?: (url: string) => void;
    readonly isProcessAlive?: (pid: number) => boolean;
    readonly stopTimeoutMs?: number;
    /** Test seam: production imports the existing runtime only AFTER acquiring the singleton. */
    readonly startRuntime?: (instance: InstanceControl, initialCommand?: string) => Promise<void>;
}

async function awaitStopped(
    address: InstanceAddress,
    previous: InstanceStatus,
    isAlive: (pid: number) => boolean,
    timeoutMs: number,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        let current: InstanceStatus | null;
        try { current = await lookup(address); }
        catch (error) {
            // The read-only status probe can race the owner's pipe teardown.
            // This never retries stop or a user command after an uncertain write.
            if (!["INSTANCE_DISCONNECTED", "EPIPE", "ECONNRESET"].includes((error as InstanceControlError).code)) throw error;
            await delay(75);
            continue;
        }
        if ((!current || current.instanceId !== previous.instanceId) && !isAlive(previous.pid)) return;
        await delay(100);
    }
    throw new InstanceControlError("A instância anterior ainda não confirmou o encerramento. Não iniciarei outra nem forçarei a parada.", "STOP_TIMEOUT");
}

function requireAccepted(reply: InstanceReply): void {
    if (!reply.ok) throw new InstanceControlError(reply.message ?? "O Ultron recusou o comando.", reply.code ?? "REQUEST_REJECTED");
    if (reply.disposition !== "accepted") throw new InstanceControlError("A instância não confirmou o recebimento.", "INVALID_INSTANCE_REPLY");
}

export async function runCli(args: readonly string[] = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
    const output = dependencies.output ?? console.log;
    const reportError = dependencies.error ?? console.error;
    try {
        const action = parseCliArguments(args);
        if (action.operation === "help") {
            output([
                "Ultron — uma instância, voz contínua e comandos pelo terminal.",
                "  ultron                 inicia ou abre a instância existente",
                "  ultron status          mostra o estado sem carregar os modelos",
                "  ultron stop            encerra a instância de forma coordenada",
                "  ultron restart         espera encerrar antes de iniciar novamente",
                "  ultron hud             abre a interface da instância existente",
                "  ultron \"liga a luz\"   envia texto ao mesmo fluxo de voz/tools",
                "  ultron -- \"stop\"      envia a palavra reservada como texto",
                "Comandos recebidos não significam ação concluída. A resposta aparece no HUD/voz.",
            ].join("\n"));
            return 0;
        }
        const address = dependencies.address ?? instanceAddress(dependencies.projectRoot ?? runtimeConfig.projectRoot);
        let status = await lookup(address);
        if (action.operation === "status") {
            output(status ? formatStatus(status) : "Ultron não está em execução.");
            return status ? 0 : 3;
        }
        if (action.operation === "hud") {
            if (!status) { output("Ultron não está em execução. Inicie com ultron."); return 3; }
            if (!status.hudUrl) { output("Ultron ainda está inicializando a interface. Tente novamente em instantes."); return 0; }
            (dependencies.openHud ?? openLocalHud)(status.hudUrl);
            output(`Interface: ${status.hudUrl}`);
            return 0;
        }
        if (action.operation === "stop" || action.operation === "restart") {
            if (status) {
                if (status.phase !== "stopping") requireAccepted(await requestInstance(address, "stop"));
                output("Aguardando encerramento da instância...");
                await awaitStopped(address, status, dependencies.isProcessAlive ?? processAlive, dependencies.stopTimeoutMs ?? 15_000);
                status = null;
            }
            if (action.operation === "stop") { output("Ultron encerrado."); return 0; }
        }
        const initialText = action.operation === "command" ? action.text : undefined;
        if (status) {
            if (initialText !== undefined) {
                const reply = await requestInstance(address, "command", initialText);
                requireAccepted(reply);
                output(reply.message ?? "Comando recebido; execução ainda não confirmada.");
            } else {
                output(formatStatus(status));
                if (status.hudUrl && process.env.ULTRON_OPEN_HUD !== "0") (dependencies.openHud ?? openLocalHud)(status.hudUrl);
            }
            return 0;
        }

        const instance = await InstanceControl.acquire({ address });
        if (!instance) {
            // Another launcher won the atomic bind. Never load a second runtime.
            const winner = await lookup(address);
            if (!winner) throw new InstanceControlError("O canal estava ocupado, mas a instância não respondeu. Tente novamente; nenhum modelo foi carregado.", "INSTANCE_UNCERTAIN");
            if (initialText !== undefined) {
                const reply = await requestInstance(address, "command", initialText);
                requireAccepted(reply);
                output(reply.message ?? "Comando recebido; execução ainda não confirmada.");
            } else {
                output(formatStatus(winner));
                if (winner.hudUrl && process.env.ULTRON_OPEN_HUD !== "0") (dependencies.openHud ?? openLocalHud)(winner.hudUrl);
            }
            return 0;
        }
        try {
            const start = dependencies.startRuntime ?? (async (owner: InstanceControl, text?: string) => {
                await assertVoicePortAvailable(runtimeConfig.whisperPort);
                const { startUltron } = await import("./index.ts");
                await startUltron(owner, text);
            });
            await start(instance, initialText);
        } finally {
            await instance.close();
        }
        return 0;
    } catch (error) {
        reportError(error instanceof Error ? error.message : String(error));
        return 1;
    }
}

if (isMainEntry(import.meta.url)) {
    void runCli().then(code => { process.exitCode = code; });
}
