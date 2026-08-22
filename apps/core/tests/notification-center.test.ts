import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { NotificationCenter } from "../src/notifications/index.ts";

async function withCenter(
    run: (center: NotificationCenter, filePath: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "ultron-notifications-"));
    const filePath = path.join(root, "notifications.json");
    try {
        await run(new NotificationCenter({ filePath }), filePath);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("NotificationCenter persiste estados e metadados entre instâncias", async () => {
    await withCenter(async (center, filePath) => {
        const published = await center.publish({
            title: "Agenda",
            message: "Reunião em quinze minutos.",
            source: "google.calendar",
            priority: "high",
            trust: "untrusted-derived",
            metadata: { eventId: "event-42" },
        });
        const delivered = await center.markDelivered(published.id);
        assert.equal(delivered?.status, "delivered");
        assert.ok(delivered?.deliveredAt);

        const restarted = new NotificationCenter({ filePath });
        const records = await restarted.list({ status: "delivered" });
        assert.equal(records.length, 1);
        assert.equal(records[0]?.id, published.id);
        assert.equal(records[0]?.trust, "untrusted-derived");
        assert.deepEqual(records[0]?.metadata, { eventId: "event-42" });

        const read = await restarted.markRead(published.id);
        assert.equal(read?.status, "read");
        assert.equal(read?.deliveredAt, delivered?.deliveredAt);
        assert.ok(read?.readAt);
    });
});

test("NotificationCenter deduplica concorrentemente e após delivery/restart", async () => {
    await withCenter(async (center, filePath) => {
        let sequence = 0;
        const deterministic = new NotificationCenter({
            filePath,
            createId: () => `notification_test_${sequence += 1}`,
        });
        const input = {
            title: "Email novo",
            message: "Uma mensagem importante chegou.",
            source: "gmail.watch",
            dedupeKey: "gmail:message-123",
        } as const;

        const concurrent = await Promise.all(
            Array.from({ length: 8 }, () => deterministic.publish(input)),
        );
        assert.equal(new Set(concurrent.map((record) => record.id)).size, 1);
        assert.equal((await deterministic.list()).length, 1);

        const first = concurrent[0]!;
        await deterministic.markDelivered(first.id);
        const restarted = new NotificationCenter({ filePath });
        const duplicate = await restarted.publish({
            ...input,
            message: "Texto que não deve substituir a notificação original.",
        });
        assert.equal(duplicate.id, first.id);
        assert.equal(duplicate.status, "delivered");
        assert.equal(duplicate.message, input.message);
        assert.equal((await restarted.list()).length, 1);
    });
});

test("waitForNext aguarda publish e respeita AbortSignal", async () => {
    await withCenter(async (center) => {
        const waiting = center.waitForNext();
        const published = await center.publish({
            title: "Tarefa",
            message: "O relatório está vencendo.",
            source: "google.tasks",
        });
        assert.equal(published.trust, "untrusted-derived");
        assert.equal((await waiting).id, published.id);
        await center.markDelivered(published.id);

        const controller = new AbortController();
        const aborted = center.waitForNext({ signal: controller.signal });
        controller.abort(new DOMException("Interrompido", "AbortError"));
        await assert.rejects(aborted, (error: Error) => error.name === "AbortError");

        const next = await center.publish({
            title: "Depois",
            message: "O waiter cancelado não consome notificações futuras.",
            source: "test",
        });
        assert.equal((await center.waitForNext()).id, next.id);
    });
});

test("waitForNext recupera uma notificação pendente após restart", async () => {
    await withCenter(async (center, filePath) => {
        const pending = await center.publish({
            title: "Reinício",
            message: "Esta notificação ainda precisa ser entregue.",
            source: "automation",
            dedupeKey: "automation:run-7",
        });

        const restarted = new NotificationCenter({ filePath });
        const recovered = await restarted.waitForNext();
        assert.equal(recovered.id, pending.id);
        assert.equal(recovered.status, "pending");

        await restarted.markDelivered(recovered.id);
        const afterDelivery = new NotificationCenter({ filePath });
        const controller = new AbortController();
        controller.abort(new DOMException("Sem pendentes", "AbortError"));
        await assert.rejects(
            afterDelivery.waitForNext({ signal: controller.signal }),
            (error: Error) => error.name === "AbortError",
        );
    });
});

test("waitForNext ignora IDs já tentados sem apagar o retry persistente", async () => {
    await withCenter(async (center) => {
        const first = await center.publish({
            title: "Primeiro",
            message: "Primeira entrega.",
            source: "test",
            dedupeKey: "test:first",
        });
        const waiting = center.waitForNext({ excludeIds: [first.id] });
        const second = await center.publish({
            title: "Segundo",
            message: "Segunda entrega.",
            source: "test",
            dedupeKey: "test:second",
        });

        assert.equal((await waiting).id, second.id);
        assert.equal((await center.list({ status: "pending" })).length, 2);
    });
});
