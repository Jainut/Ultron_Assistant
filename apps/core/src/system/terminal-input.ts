import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { validateRemoteText } from "./instance-control.ts";

/** Optional interactive fallback; it feeds the same validated command inbox. */
export class TerminalInput {
    private reader: Interface | null = null;

    start(options: {
        input: Readable;
        accept(text: string): void;
        onError(message: string): void;
        onInterrupt(): void;
    }): void {
        if (this.reader) return;
        const reader = createInterface({ input: options.input, terminal: false });
        this.reader = reader;
        reader.on("line", line => {
            if (this.reader !== reader || !line.trim()) return;
            if (!validateRemoteText(line)) {
                options.onError("Comando inválido: use até 8 KiB, sem caracteres de controle.");
                return;
            }
            try { options.accept(line.trim()); }
            catch { options.onError("Não consegui receber o comando. A fila pode estar cheia ou encerrando."); }
        });
        reader.on("SIGINT", options.onInterrupt);
        reader.on("error", () => {
            if (this.reader !== reader) return;
            this.stop();
            options.onError("Entrada deste terminal indisponível; comandos ultron continuam disponíveis em outro CMD.");
        });
        reader.once("close", () => { if (this.reader === reader) this.reader = null; });
    }

    stop(): void {
        const reader = this.reader;
        this.reader = null;
        reader?.close();
    }
}
