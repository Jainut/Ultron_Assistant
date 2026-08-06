import { spawn } from "node:child_process";

export function playAudio(audioPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
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
                stdio: ["ignore", "ignore", "pipe"],
                env: {
                    ...process.env,
                    ULTRON_AUDIO_PATH: audioPath,
                },
            },
        );

        let stderr = "";

        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.once("error", (error) => {
            reject(error);
        });

        child.once("close", (code) => {
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
        });
    });
}