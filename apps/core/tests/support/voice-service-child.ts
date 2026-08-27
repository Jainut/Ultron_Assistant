import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, Writable } from "node:stream";

/** JSON-lines subprocess double: never starts Python or any audio device. */
export class VoiceServiceChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly messages: Record<string, unknown>[] = [];
    readonly stdin = new Writable({
        write: (chunk, _encoding, callback) => {
            for (const line of String(chunk).trim().split("\n")) {
                if (line) this.messages.push(JSON.parse(line) as Record<string, unknown>);
            }
            callback();
        },
    });
    killed = false;

    kill(): boolean {
        // Deliberately do not emit close: tests can reproduce delayed or absent
        // close events independently of termination requests.
        this.killed = true;
        return true;
    }

    send(message: unknown): void {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    close(code: number | null = 0): void {
        this.stdout.end();
        this.stderr.end();
        this.emit("close", code);
    }

    asProcess(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
    }
}
