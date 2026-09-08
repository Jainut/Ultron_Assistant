import { randomUUID } from "node:crypto";
import { isMainEntry, runCli } from "./cli.ts";
import type { InstanceControl } from "./system/instance-control.ts";
import type { RemoteCommand } from "./system/remote-command-inbox.ts";
import { applicationResolver } from "./system/application-resolver.ts";
import { fileSystem } from "./filesystem/file-system-service.ts";
import { androidTvRemote } from "./automation/android-tv-remote.ts";

import { OllamaService, parseDirectAutomationCommand } from "./ai/ollama.service.ts";
import { TextToSpeechService } from "./speech/text-to-speech.ts";
import { SpeechToTextService } from "./speech/speech-to-text.ts";
import { SpeechQueue } from "./speech/speech-queue.ts";
import { SpeechChunker } from "./speech/speech_chunker.ts";
import { perf } from "./utils/performance.ts";
import { HudServer } from "./interface/hud-server.ts";
import { debugLog } from "./utils/debug.ts";
import {
    startAutomaticDeviceDiscovery,
    stopAutomaticDeviceDiscovery,
} from "./automation/device-discovery.ts";
import { FastIntentRouter } from "./intent/fast-intent-router.ts";
import { stopLightService } from "../tools/light.tool.ts";
import { tuyaCloudClient, tuyaHomeClient } from "./automation/tuya-cloud-client.ts";
import { personalProviderRuntime } from "./tools/core-tool-registry.ts";
import { createCoreSupervision, startCoreServices } from "./system/core-supervision.ts";
import { checkLocalOllamaHealth, publicServiceHealth, runtimeHealthSummary, waitForServiceReady } from "./system/runtime-health.ts";
import { TerminalInput } from "./system/terminal-input.ts";
import { runtimeConfig } from "./config/runtime.ts";
import { obsidianIndex } from "./memory/runtime.ts";
import {
    automationEngine,
    registerToolActions,
    startAutomationRuntime,
    stopAutomationRuntime,
} from "./automation-engine/runtime.ts";
import {
    requestPerformanceTimelines,
    type RequestTimelineSnapshot,
} from "./utils/request-performance-timeline.ts";
import {
    deliverNotification,
    notificationCenter,
    type NotificationRecord,
    type NotificationTrust,
} from "./notifications/index.ts";


const tts = new TextToSpeechService();
const stt = new SpeechToTextService();
const ai = new OllamaService();
const hud = new HudServer();
const fastRouter = new FastIntentRouter(parseDirectAutomationCommand);
const lifecycleController = new AbortController();
const conversationId = randomUUID();
const terminalInput = new TerminalInput();
const { supervisor, backgroundServices } = createCoreSupervision({
    stt, tts, tuya: tuyaCloudClient, tuyaHome: tuyaHomeClient,
    legacyLightProcess: process.env.ULTRON_TUYA_LEGACY_PROCESS === "1",
    discoveryDisabled: process.env.ULTRON_DISABLE_DISCOVERY === "1",
    automation: {
        start: startAutomationRuntime, stop: stopAutomationRuntime,
        isRunning: () => automationEngine.scheduler.isRunning,
    },
    ollamaHealth: signal => checkLocalOllamaHealth(runtimeConfig.ollamaModel, signal),
    providers: {
        gmail: personalProviderRuntime?.mail,
        "google-tasks": personalProviderRuntime?.tasks,
        "google-calendar": personalProviderRuntime?.calendar,
    },
});
let instanceControl: InstanceControl | null = null;
let runtimeStarted = false;
let nextRemoteCommandPromise: Promise<RemoteCommand> | null = null;


type AssistantMode =
    | "active"
    | "sleeping";

let currentTurnInterrupted = false;
let currentTurnController: AbortController | null = null;
let interruptionDuringPlayback = false;
let lastAssistantSpeech = "";

let nextCommandPromise:
    Promise<string> | null = null;
let nextCommandFailed = false;
let nextCommandRequestId: string | null = null;
let currentRequestId: string | null = null;
let nextNotificationPromise: Promise<NotificationRecord> | null = null;
let notificationDeliveryDisabled = false;
const attemptedNotificationIds = new Set<string>();
let activeNotificationTrust: NotificationTrust | null = null;
let currentResponseFromMemory = false;
let interruptedUntrustedNotification = false;
let activeNotificationDeliveryFailed = false;

function ensureRemoteCommandWait(): Promise<RemoteCommand> {
    if (!nextRemoteCommandPromise) {
        if (!instanceControl) throw new Error("O controle de instância ainda não foi adquirido.");
        nextRemoteCommandPromise = instanceControl.nextCommand();
    }
    return nextRemoteCommandPromise;
}

function interruptForRemoteCommand(): void {
    // Typed input is an explicit user request, never acoustic echo or a tool bypass.
    currentTurnInterrupted = true;
    currentTurnController?.abort(new DOMException("Novo comando recebido pelo terminal", "AbortError"));
    ai.abortCurrentResponse();
    void speechQueue.interrupt().catch(() => debugLog("[VOICE] Limpeza de áudio interrompida."));
}

function ensureNotificationWait(): Promise<NotificationRecord> {
    if (notificationDeliveryDisabled) {
        return new Promise<NotificationRecord>(() => undefined);
    }
    if (!nextNotificationPromise) {
        nextNotificationPromise = notificationCenter.waitForNext({
            signal: lifecycleController.signal,
            excludeIds: [...attemptedNotificationIds],
        });
    }
    return nextNotificationPromise;
}

function listeningTimeline() {
    return nextCommandRequestId
        ? requestPerformanceTimelines.get(nextCommandRequestId)
        : undefined;
}

function finishRequestTimeline(requestId: string | null): RequestTimelineSnapshot | undefined {
    if (!requestId) return undefined;
    const snapshot = requestPerformanceTimelines.finish(requestId);
    if (snapshot) {
        const timings = Object.fromEntries(
            snapshot.metrics.map(metric => [metric.name, Math.round(metric.valueMs)]),
        );
        debugLog("[PERF][REQUEST]", {
            ...snapshot.correlation,
            metrics: timings,
        });
        if (snapshot.metrics.length > 0) {
            // Publica apenas telemetria; o merge do HUD preserva state/message.
            hud.update({ timings });
        }
    }
    return snapshot;
}

function ensureListening(): Promise<string> {
    if (!nextCommandPromise) {
        nextCommandRequestId = randomUUID();
        requestPerformanceTimelines.start({
            requestId: nextCommandRequestId,
            conversationId,
        });
        debugLog(
            "[BARGE] STT armado."
        );

        nextCommandFailed = false;
        const listening = waitForServiceReady(supervisor, "stt", lifecycleController.signal)
            .then(() => stt.listen(lifecycleController.signal));
        nextCommandPromise = listening;
        // Playback may arm STT before the loop is awaiting it. Observe failures
        // now without replacing the promise or losing the next transcription.
        void listening.catch(() => {
            if (nextCommandPromise !== listening) return;
            nextCommandFailed = true;
            rearmRecoveredVoiceDuringPlayback();
        });
    }

    return nextCommandPromise;
}

function rearmRecoveredVoiceDuringPlayback(): void {
    if (lifecycleController.signal.aborted || !speechQueue.isSpeaking()
        || supervisor.snapshot("stt").state !== "ready") return;
    if (nextCommandFailed) {
        finishRequestTimeline(nextCommandRequestId);
        nextCommandPromise = null;
        nextCommandRequestId = null;
        nextCommandFailed = false;
    }
    void ensureListening();
}

const speechQueue =
    new SpeechQueue(
        tts,
        {
            onSynthesisStart() {
                if (currentRequestId) {
                    requestPerformanceTimelines.get(currentRequestId)?.mark("tts_start");
                }
            },
            onFirstPlayback() {
                if (currentRequestId) {
                    requestPerformanceTimelines.get(currentRequestId)?.mark("audio_start");
                }
                stt.setPlaybackActive(true);
                perf.markVoiceStart();
                hud.update({
                    state: "speaking",
                    message: "Sintetizando resposta",
                });

                debugLog(
                    "\n[BARGE] Ultron começou a falar; armando STT."
                );
                rearmRecoveredVoiceDuringPlayback();
                void ensureListening();
            },
            onPlaybackEnd() {
                stt.setPlaybackActive(false);
                if (currentRequestId) {
                    requestPerformanceTimelines.get(currentRequestId)?.mark("audio_end");
                    finishRequestTimeline(currentRequestId);
                }
            },
            onPlaybackChunkStart(reference) {
                stt.startPlaybackReference(reference);
            },
            onPlaybackChunkEnd(reference) {
                stt.endPlaybackReference(reference);
            },
            onSynthesisError() {
                if (activeNotificationTrust !== null) {
                    activeNotificationDeliveryFailed = true;
                }
            },
            onPlaybackError() {
                if (activeNotificationTrust !== null) {
                    activeNotificationDeliveryFailed = true;
                }
            },
        },
    );

stt.onSpeechStart(
    () => {
        listeningTimeline()?.mark("speech_start", { overwrite: true });
        debugLog(
            "[BARGE] callback speech_start."
        );
        if (
            !speechQueue.isSpeaking()
        ) {
            debugLog(
                "[BARGE] Ignorado: Ultron não está falando."
            );

            return;
        }

        debugLog(
            "[VOICE] Interrupção detectada."
        );

        if (activeNotificationTrust === "untrusted-derived" || currentResponseFromMemory) {
            // A primeira transcrição pode ser eco do próprio aviso externo.
            // Ela só interrompe a fala; nunca pode virar uma ação/tool.
            interruptedUntrustedNotification = true;
        }

        currentTurnInterrupted = true;
        interruptionDuringPlayback = true;
        currentTurnController?.abort();
        ai.abortCurrentResponse();
        hud.update({
            state: "listening",
            message: "Interrupção detectada",
        });
        void speechQueue.interrupt().catch(() => debugLog("[VOICE] Limpeza de áudio interrompida."));
    },
);

stt.onSpeechEnd(metrics => {
    const timeline = listeningTimeline();
    if (!timeline) return;

    if (!metrics) {
        // Compatibilidade com mensagens de captura legadas sem telemetria.
        timeline.mark("speech_end", { overwrite: true });
        return;
    }

    const endpointDetected = timeline.mark("endpoint_detected", {
        overwrite: true,
    });
    timeline.mark("speech_end", {
        atMs: endpointDetected.atMs - metrics.endpointDelayMs,
        overwrite: true,
    });
});

stt.onTranscriptionStart(() => {
    listeningTimeline()?.mark("transcription_start", { overwrite: true });
});

stt.onTranscriptionEnd(() => {
    listeningTimeline()?.mark("transcription_end", { overwrite: true });
});

function normalizeText(
    text: string,
): string {
    return text
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}


function isSleepCommand(
    text: string,
): boolean {
    const normalized =
        normalizeText(text);

    const expressions = [
        "vai dormir",
        "pode dormir",
        "dorme",
        "fica quieto",
        "fica em silencio",
        "silencio",
        "para de falar",
        "pare de falar",
        "pode ficar quieto",
        "fica na sua",
        "descansa",
        "pode descansar",
    ];

    return expressions.some(
        expression =>
            normalized.includes(
                expression
            ),
    );
}


function isWakeCommand(
    text: string,
): boolean {
    const normalized =
        normalizeText(text);

    const expressions = [
        "ultron",
        "ultron acorda",
        "acorda ultron",
        "ultron ta ai",
        "ultron esta ai",
        "ei ultron",
        "ultron volta",
        "volta ultron",
        "acorda ai ultron",
    ];

    return expressions.some(
        expression =>
            normalized.includes(
                expression
            ),
    );
}

function isStopCommand(text: string): boolean {
    return /^(?:ultron[ ,]*)?(?:para|pare|cancela|cancele|esquece isso|esqueça isso)$/i.test(
        text.trim(),
    );
}

function looksLikePlaybackEcho(command: string): boolean {
    if (!lastAssistantSpeech) return false;
    const heard = normalizeText(command);
    const spoken = normalizeText(lastAssistantSpeech);

    if (heard.length < 4 || isStopCommand(command)) return false;
    if (spoken.includes(heard)) return true;

    const heardTokens = new Set(heard.split(/\s+/).filter(token => token.length > 2));
    const spokenTokens = new Set(spoken.split(/\s+/).filter(token => token.length > 2));
    const overlap = [...heardTokens].filter(token => spokenTokens.has(token)).length;
    return heardTokens.size > 0 && overlap / heardTokens.size >= 0.8;
}

async function speak(
    text: string,
): Promise<void> {
    currentTurnController?.signal.throwIfAborted();
    currentTurnInterrupted = false;
    if (!tts.isReady()) {
        if (activeNotificationTrust !== null) activeNotificationDeliveryFailed = true;
        return; // The response is still available in the terminal and HUD.
    }
    lastAssistantSpeech = text;

    speechQueue.reset();

    speechQueue.enqueue(
        text,
    );

    await speechQueue.waitUntilIdle();
}

let shutdownPromise: Promise<void> | null = null;

function shutdownServices(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
        instanceControl?.update({ phase: "stopping", detail: "Encerrando serviços e persistindo automações." });
        lifecycleController.abort(new DOMException("Ultron encerrado", "AbortError"));
        currentTurnInterrupted = true;
        currentTurnController?.abort(new DOMException("Ultron encerrado", "AbortError"));
        ai.abortCurrentResponse();
        terminalInput.stop();
        // Disable recovery before stopping owned processes, so shutdown cannot
        // race a worker restart. Existing cleanup remains idempotent.
        const supervisedStop = supervisor.stopAll();
        const interrupted = speechQueue.interrupt().catch(error => {
            debugLog("[SHUTDOWN] Falha ao limpar fila de voz:", error);
        });

        const stops: Array<() => void> = [
            () => stt.stop(),
            () => tts.stop(),
            () => hud.stop(),
            () => stopAutomaticDeviceDiscovery(),
            () => stopLightService(),
            () => androidTvRemote.stop(),
            () => applicationResolver.stop(),
            () => fileSystem.stop(),
            () => obsidianIndex.stop(),
        ];
        for (const stop of stops) {
            try {
                stop();
            } catch (error) {
                debugLog("[SHUTDOWN] Falha ao encerrar serviço:", error);
            }
        }

        // The supervisor already drains Automation Core within its stop deadline.
        // Do not add an unbounded second await after that deadline.
        await supervisedStop;
        await interrupted;
        // Release the atomic singleton only after service teardown was requested.
        await instanceControl?.close();
    })();

    return shutdownPromise;
}

async function main(): Promise<void> {
    console.log(
        "Inicializando Ultron...\n"
    );

    try {
        lifecycleController.signal.throwIfAborted();
        await hud.start();
        instanceControl?.update({ hudUrl: hud.url() });
        lifecycleController.signal.throwIfAborted();
        console.log(`Interface: ${hud.url()}`);
        hud.openInBrowser();

        // Registra as tools determinísticas antes de aceitar o primeiro comando.
        // O carregamento dos jobs persistidos continua em background.
        registerToolActions();
        supervisor.onStateChange(snapshot => {
            if (lifecycleController.signal.aborted) return;
            const snapshots = supervisor.snapshots();
            hud.update({ services: publicServiceHealth(snapshots) });
            instanceControl?.update(runtimeHealthSummary(snapshots));
            debugLog("[SERVICE]", { name: snapshot.name, state: snapshot.state, restarts: snapshot.restarts });
            if (snapshot.state === "failed") {
                console.warn(`[SERVICE] ${snapshot.name} indisponível. O terminal continua disponível.`);
            }
            if (snapshot.name === "tts" && (snapshot.state === "degraded" || snapshot.state === "failed")) {
                void speechQueue.interrupt().catch(() => debugLog("[VOICE] Limpeza de áudio interrompida."));
            }
            if (snapshot.name === "stt" && snapshot.state === "ready") rearmRecoveredVoiceDuringPlayback();
        });
        instanceControl?.update(runtimeHealthSummary(supervisor.snapshots()));
        hud.update({ services: publicServiceHealth(supervisor.snapshots()) });

        if (process.stdin.isTTY) {
            terminalInput.start({
                input: process.stdin,
                accept: text => instanceControl!.acceptInitialCommand(text),
                onError: message => console.warn(message),
                onInterrupt: () => { void shutdownServices(); },
            });
        }
        const startup = startCoreServices({
            supervisor, backgroundServices, signal: lifecycleController.signal,
            onBackgroundStart: () => {
                fastRouter.start();
                startAutomaticDeviceDiscovery();
                obsidianIndex.start();
            },
        });
        void startup.voice.then(() => {
            if (lifecycleController.signal.aborted) return;
            console.log(stt.isReady() && tts.isReady()
                ? "Voz pronta. Ultron está ouvindo."
                : "Ultron disponível pelo terminal; consulte ultron status para verificar a voz.");
        }).catch(() => debugLog("[SERVICE] Inicialização de voz interrompida."));
        void startup.background.catch(() => {
            if (!lifecycleController.signal.aborted) debugLog("[SERVICE] Inicialização de fundo degradada.");
        });
        console.log("Ultron disponível pelo CMD. Carregando voz em segundo plano.");

        hud.update({
            state: "listening",
            message: "Carregando voz; comandos pelo terminal disponíveis",
        });

        let assistantMode:
            AssistantMode = "active";

        while (!lifecycleController.signal.aborted) {
            perf.start(
                "STT listen",
            );
            const commandPromise =
                nextCommandPromise
                ?? ensureListening();
            const voiceRequestId = nextCommandRequestId ?? randomUUID();


            let inputEvent:
                | { kind: "command"; command: string }
                | { kind: "voice-error"; error: unknown }
                | { kind: "remote-command"; remote: RemoteCommand }
                | { kind: "notification"; notification: NotificationRecord }
                | { kind: "notification-error"; error: unknown };
            try {
                inputEvent = await Promise.race([
                    ensureRemoteCommandWait().then(remote => ({ kind: "remote-command" as const, remote })),
                    commandPromise.then(
                        command => ({ kind: "command" as const, command }),
                        error => ({ kind: "voice-error" as const, error }),
                    ),
                    ensureNotificationWait().then(
                        notification => ({ kind: "notification" as const, notification }),
                        error => ({ kind: "notification-error" as const, error }),
                    ),
                ]);
            } catch (error) {
                finishRequestTimeline(voiceRequestId);
                nextCommandPromise = null;
                nextCommandRequestId = null;
                if (lifecycleController.signal.aborted) break;
                throw error;
            }

            if (inputEvent.kind === "voice-error") {
                finishRequestTimeline(voiceRequestId);
                // Recovery may already have rearmed STT while the old turn was
                // speaking. Do not lose that new microphone promise here.
                if (nextCommandPromise === commandPromise) {
                    nextCommandPromise = null;
                    nextCommandRequestId = null;
                    nextCommandFailed = false;
                }
                perf.end("STT listen");
                if (lifecycleController.signal.aborted) break;
                debugLog("[STT] Escuta interrompida; aguardando recuperação do serviço.");
                hud.update({
                    state: "listening",
                    message: "Voz indisponível; comandos pelo terminal disponíveis",
                });
                continue;
            }

            if (inputEvent.kind === "notification-error") {
                nextNotificationPromise = null;
                notificationDeliveryDisabled = true;
                perf.end("STT listen");
                debugLog("[NOTIFICATION] Entrega em voz degradada:", inputEvent.error);
                continue;
            }

            if (inputEvent.kind === "notification") {
                nextNotificationPromise = null;
                attemptedNotificationIds.add(inputEvent.notification.id);
                perf.end("STT listen");
                const { notification } = inputEvent;
                console.log(
                    notification.trust === "system"
                        ? `[NOTIFICATION] ${notification.title}: ${notification.message}`
                        : "[NOTIFICATION] Novo aviso externo.",
                );
                debugLog("[NOTIFICATION]", {
                    id: notification.id,
                    source: notification.source,
                    priority: notification.priority,
                    trust: notification.trust,
                });
                hud.update({
                    state: assistantMode === "sleeping" ? "sleeping" : "speaking",
                    message: notification.title,
                    response: notification.message,
                });

                try {
                    const outcome = await deliverNotification(notification, {
                        speak: assistantMode === "active"
                            ? async message => {
                                activeNotificationTrust = notification.trust;
                                activeNotificationDeliveryFailed = false;
                                try {
                                    await speak(message);
                                    if (activeNotificationDeliveryFailed) {
                                        throw new Error("A fila de voz não concluiu a notificação.");
                                    }
                                } finally {
                                    activeNotificationTrust = null;
                                    activeNotificationDeliveryFailed = false;
                                }
                            }
                            : undefined,
                        wasInterrupted: () => currentTurnInterrupted,
                        markDelivered: id => notificationCenter.markDelivered(id),
                        signal: lifecycleController.signal,
                    });
                    if (outcome.status === "delivered") {
                        attemptedNotificationIds.delete(notification.id);
                    } else {
                        debugLog("[NOTIFICATION] Entrega interrompida; aviso mantido pendente.", {
                            id: notification.id,
                        });
                    }
                } catch (error) {
                    // O ID fica excluído somente nesta execução e será tentado
                    // novamente após restart, sem derrubar STT/TTS.
                    activeNotificationTrust = null;
                    debugLog("[NOTIFICATION] Falha na entrega ou confirmação:", error);
                }
                hud.update({
                    state: assistantMode === "sleeping" ? "sleeping" : "listening",
                    message: assistantMode === "sleeping"
                        ? "Em espera"
                        : "Aguardando comando de voz",
                });
                continue;
            }

            const remoteInput = inputEvent.kind === "remote-command";
            const command = inputEvent.kind === "remote-command" ? inputEvent.remote.text : inputEvent.command;
            const requestId = inputEvent.kind === "remote-command" ? inputEvent.remote.requestId : voiceRequestId;
            if (remoteInput) {
                nextRemoteCommandPromise = null;
                requestPerformanceTimelines.start({ requestId, conversationId });
                // Keep the already armed STT promise: never open a second microphone/listen.
                if (!isSleepCommand(command)) assistantMode = "active";
            } else {
                nextCommandPromise = null;
                nextCommandRequestId = null;
            }
            currentRequestId = requestId;

            hud.update({
                state: "thinking",
                message: "Interpretando solicitação",
                transcript: command,
            });


            perf.end(
                "STT listen",
            );

            if (
                !remoteInput && interruptionDuringPlayback
                && interruptedUntrustedNotification
            ) {
                interruptionDuringPlayback = false;
                interruptedUntrustedNotification = false;
                debugLog("[BARGE] Transcrição durante aviso externo descartada por segurança.");
                hud.update({
                    state: "listening",
                    message: "Leitura interrompida; repita o comando",
                });
                finishRequestTimeline(requestId);
                if (currentRequestId === requestId) currentRequestId = null;
                continue;
            }

            if (
                !remoteInput && interruptionDuringPlayback
                && looksLikePlaybackEcho(command)
            ) {
                interruptionDuringPlayback = false;
                debugLog("[BARGE] Eco do playback ignorado.");
                hud.update({
                    state: "listening",
                    message: "Aguardando comando de voz",
                });
                finishRequestTimeline(requestId);
                if (currentRequestId === requestId) currentRequestId = null;
                continue;
            }

            if (!remoteInput) {
                interruptionDuringPlayback = false;
                interruptedUntrustedNotification = false;
            }

            perf.startRequest();
            currentTurnController = new AbortController();
            currentResponseFromMemory = false;
            const turnSignal = currentTurnController.signal;


            try {
                if (
                    assistantMode ===
                    "sleeping"
                ) {
                    if (
                        !isWakeCommand(
                            command
                        )
                    ) {
                        perf.endRequest();

                        hud.update({
                            state: "sleeping",
                            message: "Modo de espera",
                        });

                        continue;
                    }


                    assistantMode =
                        "active";


                    console.log(
                        `Me> ${command}`
                    );


                    const response =
                        "Estou aqui, senhor.";


                    console.log(
                        `Ultron> ${response}`
                    );


                    ai.rememberExchange(
                        command,
                        response,
                    );


                    await speak(
                        response,
                    );

                    hud.update({
                        state: "listening",
                        message: "Aguardando comando de voz",
                        response,
                    });


                    perf.endRequest();

                    continue;
                }


                console.log(
                    `Me> ${command}`
                );

                if (
                    isStopCommand(command)
                    && fastRouter.hasPendingConfirmation(conversationId)
                ) {
                    const cancellation = await fastRouter.execute(command, {
                        signal: turnSignal,
                        requestId,
                        conversationId,
                    });
                    if (cancellation) {
                        const response = cancellation.response;
                        console.log(`Ultron> ${response}`);
                        ai.rememberExchange(command, response);
                        await speak(response);
                        hud.update({
                            state: "listening",
                            message: "Aguardando comando de voz",
                            response,
                        });
                        perf.endRequest();
                        continue;
                    }
                }

                if (isStopCommand(command)) {
                    const response = "Certo.";
                    console.log(`Ultron> ${response}`);
                    ai.rememberExchange(command, response);
                    await speak(response);
                    hud.update({
                        state: "listening",
                        message: "Aguardando comando de voz",
                        response,
                    });
                    perf.endRequest();
                    continue;
                }

                if (
                    isSleepCommand(
                        command
                    )
                ) {
                    assistantMode =
                        "sleeping";


                    const response =
                        "Como desejar, senhor.";


                    console.log(
                        `Ultron> ${response}`
                    );


                    ai.rememberExchange(
                        command,
                        response,
                    );


                    await speak(
                        response,
                    );

                    hud.update({
                        state: "sleeping",
                        message: "Modo de espera",
                        response,
                    });


                    perf.endRequest();

                    continue;
                }

                const fastResult = await fastRouter.execute(
                    command,
                    {
                        signal: turnSignal,
                        requestId,
                        conversationId,
                    },
                );
                turnSignal.throwIfAborted();

                if (fastResult) {
                    currentResponseFromMemory = fastResult.actions.some(action => action.name.startsWith("memory."));
                    const response = fastResult.needsInterpretation
                        ? await ai.interpretToolResults(
                            command,
                            fastResult.actions.map((action, index) => ({
                                name: action.name,
                                input: action.input,
                                result: fastResult.results[index],
                            })),
                            turnSignal,
                        )
                        : fastResult.response;
                    turnSignal.throwIfAborted();
                    console.log(`Ultron> ${response}`);
                    if (!fastResult.needsInterpretation && !currentResponseFromMemory) {
                        ai.rememberExchange(command, response);
                    }
                    await speak(response);
                    hud.update({
                        state: "listening",
                        message: "Aguardando comando de voz",
                        response,
                    });
                    perf.endRequest();
                    continue;
                }

                if (
                    ai.usesToolPath(
                        command
                    )
                ) {
                    currentTurnInterrupted =
                        false;

                    speechQueue.reset();


                    perf.start(
                        "AI",
                    );


                    const response =
                        await ai.chat(
                            command,
                            turnSignal,
                            { requestId, conversationId },
                        );
                    turnSignal.throwIfAborted();


                    perf.end(
                        "AI",
                    );


                    console.log(
                        `Ultron> ${response}`
                    );


                    currentResponseFromMemory = ai.lastResponseFromMemory;
                    if (tts.isReady()) speechQueue.enqueue(response);
                    lastAssistantSpeech = response;

                    hud.update({ response });


                    await speechQueue
                        .waitUntilIdle();

                    hud.update({
                        state: "listening",
                        message: "Aguardando comando de voz",
                    });


                    perf.endRequest();

                    continue;
                }

                currentTurnInterrupted =
                    false;

                const chunker =
                    new SpeechChunker();


                speechQueue.reset();


                let firstToken = true;
                let streamedResponse = "";


                perf.start(
                    "AI total",
                );

                perf.start(
                    "AI first token",
                );


                process.stdout.write(
                    "Ultron> "
                );


                for await (
                    const token
                    of ai.chatStream(
                        command,
                        turnSignal,
                    )
                ) {
                    if (
                        currentTurnInterrupted
                    ) {
                        break;
                    }


                    if (
                        firstToken
                    ) {
                        firstToken =
                            false;

                        perf.end(
                            "AI first token",
                        );
                    }


                    process.stdout.write(
                        token
                    );

                    streamedResponse += token;
                    lastAssistantSpeech = streamedResponse;
                    hud.update({ response: streamedResponse });


                    const chunks =
                        chunker.push(
                            token
                        );


                    for (
                        const chunk
                        of chunks
                    ) {
                        if (
                            currentTurnInterrupted
                        ) {
                            break;
                        }

                        if (tts.isReady()) speechQueue.enqueue(chunk);
                    }
                }

                if (
                    !currentTurnInterrupted
                ) {
                    for (
                        const chunk
                        of chunker.flush()
                    ) {
                        if (tts.isReady()) speechQueue.enqueue(chunk);
                    }
                }


                perf.end(
                    "AI total",
                );


                process.stdout.write(
                    "\n"
                );


                /*
                 * Se houve interrupção, a queue
                 * será esvaziada pelo interrupt().
                 */
                await speechQueue
                    .waitUntilIdle();

                hud.update({
                    state: "listening",
                    message: "Aguardando comando de voz",
                    response: streamedResponse.trim(),
                });


                perf.endRequest();

            } catch (error) {
                perf.endRequest();

                if (
                    error instanceof DOMException
                    && error.name === "AbortError"
                ) {
                    hud.update({
                        state: "listening",
                        message: "Processando interrupção",
                    });
                    continue;
                }

                // A failed request must not bring down voice, IPC or subsequent
                // commands. Never replay an action whose outcome is uncertain.
                await speechQueue.interrupt().catch(() => undefined);
                const response = "A solicitação falhou. Se uma ação já foi enviada, confira o resultado antes de repetir.";
                console.warn(`Ultron> ${response}`);
                debugLog("[REQUEST] Falha isolada.", { requestId, conversationId });
                hud.update({ state: "error", message: "Solicitação não concluída", response });
            } finally {
                finishRequestTimeline(requestId);
                if (currentRequestId === requestId) currentRequestId = null;
                if (currentTurnController?.signal === turnSignal) {
                    currentTurnController = null;
                }
            }
        }

    } finally {
        await shutdownServices();
    }
}

export async function startUltron(owner: InstanceControl, initialCommand?: string): Promise<void> {
    if (runtimeStarted) throw new Error("O runtime Ultron já foi iniciado neste processo.");
    runtimeStarted = true;
    instanceControl = owner;
    let explicitlyStopped = false;
    const exitAfterShutdown = (): void => {
        explicitlyStopped = true;
        void shutdownServices().finally(() => process.exit(0));
    };
    owner.onShutdown(exitAfterShutdown);
    owner.onCommandAccepted(interruptForRemoteCommand);
    if (initialCommand) owner.acceptInitialCommand(initialCommand);
    process.once("SIGINT", exitAfterShutdown);
    process.once("SIGTERM", exitAfterShutdown);
    try {
        await main();
    } catch (error) {
        if (!explicitlyStopped) throw error;
    } finally {
        process.removeListener("SIGINT", exitAfterShutdown);
        process.removeListener("SIGTERM", exitAfterShutdown);
    }
}

// Preserve npm run dev/start and direct index.js invocation. The CMD launcher
// uses cli.js, so an existing instance never imports this voice/tool runtime.
if (isMainEntry(import.meta.url)) {
    void runCli().then(code => { process.exitCode = code; });
}
