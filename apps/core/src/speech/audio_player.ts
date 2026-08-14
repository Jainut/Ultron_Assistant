import {
    spawn,
    type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";

interface ActivePlayback {
    child: ChildProcessByStdio<null, null, Readable>;
    interrupted: boolean;
}

let activePlayback: ActivePlayback | null =
    null;

export function isAudioPlaying(): boolean {
    return activePlayback !== null;
}

export function stopAudio(): void {
    if (!activePlayback) {
        return;
    }

    activePlayback.interrupted = true;

    activePlayback.child.kill();
}

export function playAudio(
    audioPath: string,
): Promise<void> {
    return new Promise(
        (resolve, reject) => {
            const script = [
                "$player = New-Object System.Media.SoundPlayer",
                "$player.SoundLocation = $env:ULTRON_AUDIO_PATH",
                "$player.Load()",
                "$player.PlaySync()",
            ].join("; ");

            const child = spawn(
                "powershell.exe",
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    script,
                ],
                {
                    windowsHide: true,

                    stdio: [
                        "ignore",
                        "ignore",
                        "pipe",
                    ],

                    env: {
                        ...process.env,

                        ULTRON_AUDIO_PATH:
                            audioPath,
                    },
                },
            );

            const playback: ActivePlayback = {
                child,
                interrupted: false,
            };

            activePlayback =
                playback;

            let stderr = "";

            child.stderr.on(
                "data",
                (chunk: Buffer) => {
                    stderr +=
                        chunk.toString();
                },
            );

            child.once(
                "error",
                error => {
                    if (
                        activePlayback ===
                        playback
                    ) {
                        activePlayback = null;
                    }

                    reject(error);
                },
            );

            child.once(
                "close",
                code => {
                    const interrupted =
                        playback.interrupted;

                    if (
                        activePlayback ===
                        playback
                    ) {
                        activePlayback = null;
                    }

                    /*
                     * Interrupção manual não é erro.
                     */
                    if (interrupted) {
                        resolve();
                        return;
                    }

                    if (code === 0) {
                        resolve();
                        return;
                    }

                    reject(
                        new Error(
                            stderr.trim() ||
                            `O reprodutor encerrou com código ${code}.`,
                        ),
                    );
                },
            );
        },
    );
}
