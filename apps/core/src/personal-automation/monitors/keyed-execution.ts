export class KeyedExecutionQueue {
    private readonly tails = new Map<string, Promise<void>>();

    async run<T>(
        key: string,
        operation: () => Promise<T>,
        signal?: AbortSignal,
    ): Promise<T> {
        signal?.throwIfAborted();
        const previous = this.tails.get(key) ?? Promise.resolve();
        let release!: () => void;
        let released = false;
        let acquired = false;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        this.tails.set(key, current);

        try {
            await waitForTurn(previous, signal);
            acquired = true;
            signal?.throwIfAborted();
            return await operation();
        } finally {
            const finish = (): void => {
                if (released) return;
                released = true;
                release();
                if (this.tails.get(key) === current) this.tails.delete(key);
            };
            if (acquired) {
                finish();
            } else {
                // Preserve serialization for later callers while allowing this
                // aborted caller to reject immediately.
                void previous.then(finish, finish);
            }
        }
    }
}

function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (!signal) return previous;
    signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
        const abort = (): void => {
            cleanup();
            reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        };
        const cleanup = (): void => signal.removeEventListener("abort", abort);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
            abort();
            return;
        }
        void previous.then(() => {
            cleanup();
            resolve();
        }, error => {
            cleanup();
            reject(error);
        });
    });
}
