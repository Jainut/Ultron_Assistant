import type { NotificationRecord } from "./types.ts";

export interface NotificationDeliveryOptions {
    /** Omitido quando a exibição local já é o canal de entrega desejado. */
    readonly speak?: (message: string) => Promise<void>;
    /** Verificado após o áudio terminar para não confirmar uma fala interrompida. */
    readonly wasInterrupted?: () => boolean;
    readonly markDelivered: (
        notificationId: string,
    ) => Promise<NotificationRecord | undefined>;
    readonly signal?: AbortSignal;
}

export type NotificationDeliveryOutcome =
    | {
        readonly status: "delivered";
        readonly notification: NotificationRecord;
    }
    | {
        readonly status: "interrupted";
        readonly notification: NotificationRecord;
    };

/**
 * Confirma uma notificação somente depois que seu canal de entrega termina.
 * Falhas do canal e cancelamentos propagam sem alterar o registro persistido.
 */
export async function deliverNotification(
    notification: NotificationRecord,
    options: NotificationDeliveryOptions,
): Promise<NotificationDeliveryOutcome> {
    options.signal?.throwIfAborted();

    if (options.speak !== undefined) {
        await options.speak(notification.message);
        options.signal?.throwIfAborted();
        if (options.wasInterrupted?.() === true) {
            return { status: "interrupted", notification };
        }
    }

    options.signal?.throwIfAborted();
    const delivered = await options.markDelivered(notification.id);
    if (delivered === undefined) {
        throw new Error(`Notification no longer exists: ${notification.id}`);
    }
    return { status: "delivered", notification: delivered };
}
