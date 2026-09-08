/** Waits remain cancellable even when a provider ignores AbortSignal. */
export async function awaitServiceOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
        void operation.catch(() => undefined);
        throw signal.reason;
    }
    let abort: (() => void) | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                abort = (): void => reject(signal.reason);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            }),
        ]);
    } finally {
        if (abort) signal.removeEventListener("abort", abort);
    }
}

export function serviceError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export async function timedServiceOperation<T>(
    operation: (signal: AbortSignal) => Promise<T> | T,
    options: { signal?: AbortSignal; timeoutMs: number; label: string },
): Promise<T> {
    options.signal?.throwIfAborted();
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(Object.assign(new Error(
        `${options.label}: tempo limite excedido.`,
    ), { code: "ETIMEDOUT" })), Math.max(1, options.timeoutMs));
    try {
        return await awaitServiceOperation(Promise.resolve(operation(signal)), signal);
    } finally {
        clearTimeout(timer);
    }
}
