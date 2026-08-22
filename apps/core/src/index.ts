import { randomUUID } from "node:crypto";

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
import {
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


type AssistantMode =
    | "active"
    | "sleeping";

let currentTurnInterrupted = false;
let currentTurnController: AbortController | null = null;
let interruptionDuringPlayback = false;
let lastAssistantSpeech = "";

let nextCommandPromise:
    Promise<string> | null = null;
let nextCommandRequestId: string | null = null;
let currentRequestId: string | null = null;
let nextNotificationPromise: Promise<NotificationRecord> | null = null;
let notificationDeliveryDisabled = false;
const attemptedNotificationIds = new Set<string>();
let activeNotificationTrust: NotificationTrust | null = null;
let interruptedUntrustedNotification = false;
let activeNotificationDeliveryFailed = false;

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

        nextCommandPromise =
            stt.listen();
    }

    return nextCommandPromise;
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

        if (activeNotificationTrust === "untrusted-derived") {
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
        void speechQueue.interrupt();
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
    currentTurnInterrupted = false;
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
        lifecycleController.abort(new DOMException("Ultron encerrado", "AbortError"));

        const stops: Array<() => void> = [
            () => stt.stop(),
            () => tts.stop(),
            () => hud.stop(),
            () => stopAutomaticDeviceDiscovery(),
            () => stopLightService(),
        ];
        for (const stop of stops) {
            try {
                stop();
            } catch (error) {
                debugLog("[SHUTDOWN] Falha ao encerrar serviço:", error);
            }
        }

        try {
            await stopAutomationRuntime();
        } catch (error) {
            debugLog("[SHUTDOWN] Falha ao persistir Automation Core:", error);
        }
    })();

    return shutdownPromise;
}

async function main(): Promise<void> {
    console.log(
        "Inicializando Ultron...\n"
    );

    try {
        await hud.start();
        console.log(`Interface: ${hud.url()}`);
        hud.openInBrowser();

        debugLog(
            "Carregando sistema de voz..."
        );

        perf.start(
            "TTS startup",
        );

        await tts.start();

        perf.end(
            "TTS startup",
        );

        debugLog(
            "Serviço de voz carregado."
        );

        debugLog(
            "Carregando reconhecimento de voz..."
        );

        perf.start(
            "STT startup",
        );

        await stt.start();

        perf.end(
            "STT startup",
        );

        // Registra as tools determinísticas antes de aceitar o primeiro comando.
        // O carregamento dos jobs persistidos continua em background.
        registerToolActions();
        fastRouter.start();

        console.log(
            "\nUltron iniciado."
        );

        // Serviços de fundo só entram depois do caminho crítico de voz/tools.
        startAutomaticDeviceDiscovery();
        void startAutomationRuntime(lifecycleController.signal).catch(error => {
            debugLog("[AUTOMATION] Serviço degradado:", error);
        });


        hud.update({
            state: "listening",
            message: "Aguardando comando de voz",
        });

        let assistantMode:
            AssistantMode = "active";

        while (true) {
            perf.start(
                "STT listen",
            );
            const commandPromise =
                nextCommandPromise
                ?? ensureListening();
            const requestId = nextCommandRequestId ?? randomUUID();


            let inputEvent:
                | { kind: "command"; command: string }
                | { kind: "notification"; notification: NotificationRecord }
                | { kind: "notification-error"; error: unknown };
            try {
                inputEvent = await Promise.race([
                    commandPromise.then(command => ({ kind: "command" as const, command })),
                    ensureNotificationWait().then(
                        notification => ({ kind: "notification" as const, notification }),
                        error => ({ kind: "notification-error" as const, error }),
                    ),
                ]);
            } catch (error) {
                finishRequestTimeline(requestId);
                nextCommandPromise = null;
                nextCommandRequestId = null;
                throw error;
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

            const command = inputEvent.command;
            nextCommandPromise = null;
            nextCommandRequestId = null;
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
                interruptionDuringPlayback
                && interruptedUntrustedNotification
            ) {
                interruptionDuringPlayback = false;
                interruptedUntrustedNotification = false;
                debugLog("[BARGE] Transcrição durante aviso externo descartada por segurança.");
                hud.update({
                    state: "listening",
                    message: "Aviso interrompido; repita o comando",
                });
                finishRequestTimeline(requestId);
                if (currentRequestId === requestId) currentRequestId = null;
                continue;
            }

            if (
                interruptionDuringPlayback
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

            interruptionDuringPlayback = false;
            interruptedUntrustedNotification = false;

            perf.startRequest();
            currentTurnController = new AbortController();
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

                if (fastResult) {
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
                    console.log(`Ultron> ${response}`);
                    if (!fastResult.needsInterpretation) {
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


                    perf.end(
                        "AI",
                    );


                    console.log(
                        `Ultron> ${response}`
                    );


                    speechQueue.enqueue(
                        response,
                    );
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

                        speechQueue.enqueue(
                            chunk
                        );
                    }
                }

                if (
                    !currentTurnInterrupted
                ) {
                    for (
                        const chunk
                        of chunker.flush()
                    ) {
                        speechQueue.enqueue(
                            chunk
                        );
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

                throw error;
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

process.once("SIGINT", () => {
    void shutdownServices().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
    void shutdownServices().finally(() => process.exit(0));
});

main().catch(
    (error: unknown) => {
        console.error(
            "FATAL ERROR:",
            error,
        );

        process.exitCode = 1;
    },
);
