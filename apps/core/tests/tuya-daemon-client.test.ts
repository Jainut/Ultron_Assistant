import assert from "node:assert/strict";
import test from "node:test";

import { TuyaCloudClient } from "../src/automation/tuya-cloud-client.ts";
import { VoiceServiceChild } from "./support/voice-service-child.ts";

function fixture(timeoutMs = 1_000) {
    const children: VoiceServiceChild[] = [];
    const client = new TuyaCloudClient({
        timeoutMs,
        spawnProcess: () => {
            const child = new VoiceServiceChild();
            children.push(child);
            return child.asProcess();
        },
    });
    return { client, children };
}

function reply(child: VoiceServiceChild, index = 0, fields: object = {}) {
    child.send({ id: child.messages[index]!.id, type: "result", success: true, ...fields });
}

test("Tuya reutiliza um processo e só envia uma ação por vez", async () => {
    const { client, children } = fixture();
    try {
        const first = client.request(["on"]);
        const second = client.request(["brightness", "20"]);
        const child = children[0]!;
        assert.equal(children.length, 1);
        assert.equal(child.messages.length, 1);
        reply(child, 0, { confirmed: false, optimistic: true });
        const result = JSON.parse(await first);
        assert.equal(result.confirmed, false);
        assert.equal(result.optimistic, true);
        assert.equal(result.id, undefined);
        assert.equal(child.messages.length, 2);
        reply(child, 1);
        await second;
        assert.equal(children.length, 1);
    } finally { client.stop(); }
});

test("Tuya cancelada na fila nunca atravessa stdin", async () => {
    const { client, children } = fixture();
    try {
        const first = client.request(["status"]);
        const controller = new AbortController();
        const queued = client.request(["off"], controller.signal);
        const rejected = assert.rejects(queued, { name: "AbortError" });
        controller.abort();
        await rejected;
        assert.equal(children[0]!.messages.length, 1);
        assert.equal(children[0]!.killed, false);
        reply(children[0]!);
        await first;
        assert.equal(children[0]!.messages.length, 1);
    } finally { client.stop(); }
});

test("abort em voo encerra worker; close antigo não invalida o seguinte", async () => {
    const { client, children } = fixture();
    try {
        const controller = new AbortController();
        const first = client.request(["on"], controller.signal);
        const firstRejected = assert.rejects(first, { name: "AbortError" });
        const second = client.request(["status"]);
        controller.abort();
        await firstRejected;
        assert.equal(children[0]!.killed, true);
        assert.equal(children.length, 2);
        children[0]!.close(1);
        reply(children[1]!);
        await second;
        assert.deepEqual(children[1]!.messages[0]!.arguments, ["status"]);
    } finally { client.stop(); }
});

test("timeout limita HTTP bloqueado e não repete mutação", async () => {
    const { client, children } = fixture(20);
    try {
        await assert.rejects(client.request(["off"]), /Timeout Tuya/);
        assert.equal(children.length, 1);
        assert.equal(children[0]!.killed, true);
        const next = client.request(["status"]);
        children[0]!.close(1);
        reply(children[1]!);
        await next;
        assert.deepEqual(children[1]!.messages[0]!.arguments, ["status"]);
    } finally { client.stop(); }
});

test("falha de protocolo/Tuya não vira sucesso e worker pode continuar", async () => {
    const { client, children } = fixture();
    try {
        const failed = client.request(["on"]);
        const rejected = assert.rejects(failed, /recusado/);
        reply(children[0]!, 0, { success: false, error: "recusado" });
        await rejected;
        const next = client.request(["status"]);
        children[0]!.send({ id: "unrelated", success: true });
        reply(children[0]!, 1);
        await next;
        assert.equal(children.length, 1);
    } finally { client.stop(); }
});

test("erro de stdin/shutdown rejeita pendências e não deixa promises órfãs", async () => {
    const { client, children } = fixture();
    const first = client.request(["on"]);
    const second = client.request(["status"]);
    const failures = [assert.rejects(first, /indisponível/), assert.rejects(second, /indisponível/)];
    children[0]!.stdin.emit("error", new Error("EPIPE"));
    await Promise.all(failures);
    assert.equal(children[0]!.killed, true);
    const third = client.request(["status"]);
    const rejected = assert.rejects(third, /encerrado/);
    client.stop();
    await rejected;
});

test("signal já abortado não inicia Python", async () => {
    const { client, children } = fixture();
    await assert.rejects(client.request(["on"], AbortSignal.abort()), { name: "AbortError" });
    assert.equal(children.length, 0);
});
