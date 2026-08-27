export interface RemoteCommand {
    readonly requestId: string;
    readonly text: string;
}

export interface StagedRemoteCommand {
    readonly position: number;
    commit(): void;
    cancel(): void;
}

/** Only committed (acknowledged) commands can enter the existing assistant loop. */
export class RemoteCommandInbox {
    private readonly queued: RemoteCommand[] = [];
    private readonly staged = new Set<RemoteCommand>();
    private pending: Promise<RemoteCommand> | null = null;
    private resolvePending: ((command: RemoteCommand) => void) | null = null;
    private rejectPending: ((error: Error) => void) | null = null;
    private acceptedListener: (() => void) | null = null;
    private stopped = false;

    constructor(private readonly capacity = 8) {}

    get size(): number { return this.queued.length + this.staged.size; }

    onAccepted(listener: () => void): void { this.acceptedListener = listener; }

    stage(command: RemoteCommand): StagedRemoteCommand {
        if (this.stopped) throw new Error("O Ultron está encerrando.");
        if (this.size >= this.capacity) throw new Error("A fila de comandos está cheia. Aguarde a resposta atual.");
        this.staged.add(command);
        const position = this.size;
        return {
            position,
            cancel: () => { this.staged.delete(command); },
            commit: () => {
                if (!this.staged.delete(command) || this.stopped) return;
                this.queued.push(command);
                // A listener failure must not replay an acknowledged command.
                try { this.acceptedListener?.(); } catch { /* Runtime owns its diagnostics. */ }
                this.deliver();
            },
        };
    }

    next(): Promise<RemoteCommand> {
        if (this.stopped) return Promise.reject(new DOMException("Ultron encerrado", "AbortError"));
        if (this.pending) return this.pending;
        const queued = this.queued.shift();
        if (queued) return Promise.resolve(queued);
        this.pending = new Promise<RemoteCommand>((resolve, reject) => {
            this.resolvePending = resolve;
            this.rejectPending = reject;
        });
        // The main loop may currently be speaking and not yet racing this input.
        void this.pending.catch(() => undefined);
        return this.pending;
    }

    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        this.queued.length = 0;
        this.staged.clear();
        this.rejectPending?.(new DOMException("Ultron encerrado", "AbortError"));
        this.clearPending();
        this.acceptedListener = null;
    }

    private deliver(): void {
        if (!this.resolvePending) return;
        const command = this.queued.shift();
        if (!command) return;
        const resolve = this.resolvePending;
        this.clearPending();
        resolve(command);
    }

    private clearPending(): void {
        this.pending = null;
        this.resolvePending = null;
        this.rejectPending = null;
    }
}
