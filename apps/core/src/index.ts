import { OllamaService } from "./ai/ollama.service.ts";
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


const tts = new TextToSpeechService();
const stt = new SpeechToTextService();
const ai = new OllamaService();
const hud = new HudServer();


type AssistantMode =
    | "active"
    | "sleeping";

let currentTurnInterrupted = false;

let nextCommandPromise:
    Promise<string> | null = null;
function ensureListening(): Promise<string> {
    if (!nextCommandPromise) {
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
            onFirstPlayback() {
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
        },
    );

stt.onSpeechStart(
    () => {
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

        currentTurnInterrupted = true;
        hud.update({
            state: "listening",
            message: "Interrupção detectada",
        });
        void speechQueue.interrupt();
    },
);

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

async function speak(
    text: string,
): Promise<void> {
    currentTurnInterrupted = false;

    speechQueue.reset();

    speechQueue.enqueue(
        text,
    );

    await speechQueue.waitUntilIdle();
}

async function main(): Promise<void> {
    console.log(
        "Inicializando Ultron...\n"
    );

    try {
        await hud.start();
        console.log(`Interface: ${hud.url()}`);
        hud.openInBrowser();
        startAutomaticDeviceDiscovery();

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

        console.log(
            "\nUltron iniciado."
        );


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
                ?? stt.listen();

            nextCommandPromise = null;


            const command =
                await commandPromise;

            hud.update({
                state: "thinking",
                message: "Interpretando solicitação",
                transcript: command,
            });


            perf.end(
                "STT listen",
            );

            perf.startRequest();


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
                            command
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
                        command
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

                throw error;
            }
        }

    } finally {
        stt.stop();
        tts.stop();
        hud.stop();
        stopAutomaticDeviceDiscovery();
    }
}


main().catch(
    (error: unknown) => {
        console.error(
            "FATAL ERROR:",
            error,
        );

        process.exitCode = 1;
    },
);
