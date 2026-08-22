import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    deliverNotification,
    NotificationCenter,
    type NotificationRecord,
} from "../src/notifications/index.ts";

const pending: NotificationRecord = {
    id: "notification-delivery-test",
    title: "Teste",
    message: "Mensagem do aviso.",
    source: "test",
    priority: "normal",
    trust: "untrusted-derived",
    status: "pending",
    createdAt: "2026-08-20T12:00:00.000Z",
};

test("entrega por voz só persiste delivered depois de concluir", async () => {
    const order: string[] = [];
    const result = await deliverNotification(pending, {
        async speak(message) {
            assert.equal(message, pending.message);
            order.push("speak");
        },
        async markDelivered(id) {
            assert.equal(id, pending.id);
            order.push("persist");
            return {
                ...pending,
                status: "delivered",
                deliveredAt: "2026-08-20T12:01:00.000Z",
            };
        },
    });

    assert.deepEqual(order, ["speak", "persist"]);
    assert.equal(result.status, "delivered");
});

test("interrupção mantém notificação pendente", async () => {
    let persisted = false;
    const result = await deliverNotification(pending, {
        async speak() {},
        wasInterrupted: () => true,
        async markDelivered() {
            persisted = true;
            return pending;
        },
    });

    assert.equal(result.status, "interrupted");
    assert.equal(persisted, false);
});

test("falha ou cancelamento de voz não confirma entrega", async (context) => {
    await context.test("falha", async () => {
        let persisted = false;
        await assert.rejects(
            deliverNotification(pending, {
                async speak() {
                    throw new Error("player indisponível");
                },
                async markDelivered() {
                    persisted = true;
                    return pending;
                },
            }),
            /player indisponível/,
        );
        assert.equal(persisted, false);
    });

    await context.test("cancelamento", async () => {
        const controller = new AbortController();
        let persisted = false;
        await assert.rejects(
            deliverNotification(pending, {
                async speak() {
                    controller.abort(new DOMException("Encerrado", "AbortError"));
                },
                async markDelivered() {
                    persisted = true;
                    return pending;
                },
                signal: controller.signal,
            }),
            (error: Error) => error.name === "AbortError",
        );
        assert.equal(persisted, false);
    });
});

test("falha de voz permanece recuperável no NotificationCenter após restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-notification-delivery-"));
    const filePath = path.join(root, "notifications.json");
    try {
        const center = new NotificationCenter({ filePath });
        const notification = await center.publish({
            title: "Persistente",
            message: "Tente falar novamente depois do restart.",
            source: "test",
        });

        await assert.rejects(deliverNotification(notification, {
            async speak() {
                throw new Error("saída de áudio indisponível");
            },
            markDelivered: id => center.markDelivered(id),
        }), /saída de áudio indisponível/);

        const restarted = new NotificationCenter({ filePath });
        const recovered = await restarted.waitForNext();
        assert.equal(recovered.id, notification.id);
        assert.equal(recovered.status, "pending");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
