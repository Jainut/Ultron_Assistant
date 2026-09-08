import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";

import { GoogleApiClient } from "../src/providers/google/google-api-client.ts";
import type { FetchTransport } from "../src/security/oauth2-desktop.ts";

const oauth = { getAccessToken: async () => "fixture-token" };
const endpoint = "https://provider.example.test/api/";
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

test("Google GET recupera falha transitória uma vez sem duplicar escritas", async () => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
        let calls = 0;
        const transport: FetchTransport = async () => ++calls === 1 ? new Response(null, { status: 503 }) : json({ ok: true });
        const client = new GoogleApiClient("fake", endpoint, oauth, transport, { retryDelayMs: 0 });
        if (method === "GET") assert.deepEqual(await client.request("resource", { method }), { ok: true });
        else await assert.rejects(client.request("resource", { method }));
        assert.equal(calls, method === "GET" ? 2 : 1);
    }
});

test("Google respeita Retry-After longo e não tenta antes do prazo", async () => {
    let calls = 0;
    const client = new GoogleApiClient("fake", endpoint, oauth, async () => {
        calls += 1;
        return new Response(null, { status: 429, headers: { "retry-after": "60" } });
    });
    await assert.rejects(client.request("resource"), (error: any) => error.retryAfterMs === 60_000);
    assert.equal(calls, 1);
});

test("Google deadline aborta transporte sem aguardar indefinidamente", async () => {
    const transport: FetchTransport = async (_url, init) => new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    });
    const client = new GoogleApiClient("fake", endpoint, oauth, transport, { timeoutMs: 20 });
    await assert.rejects(client.request("resource"), { name: "TimeoutError" });
});

test("cancelamento de OAuth não é disfarçado como credencial expirada", async () => {
    const controller = new AbortController();
    const cancelledOauth = { getAccessToken: async () => {
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw controller.signal.reason;
    } };
    let calls = 0;
    const client = new GoogleApiClient("fake", endpoint, cancelledOauth, async () => { calls += 1; return json({}); });
    await assert.rejects(client.request("resource", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 0);
});

test("cancelamento durante backoff impede a segunda leitura", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = new GoogleApiClient("fake", endpoint, oauth, async () => {
        calls += 1;
        setTimeout(() => controller.abort(), 5);
        return new Response(null, { status: 503 });
    });
    await assert.rejects(client.request("resource", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(calls, 1);
});

test("token não é enviado para URL fora do provider e mensagens não contêm secrets", async () => {
    let calls = 0;
    const client = new GoogleApiClient("fake", endpoint, oauth, async () => { calls += 1; throw new Error("fixture-token"); });
    await assert.rejects(client.request("https://other.example.test/"), /endpoint permitido/);
    assert.equal(calls, 0);
    await assert.rejects(client.request("resource", { method: "POST" }), error => {
        assert.doesNotMatch((error as Error).message, /fixture-token/);
        return true;
    });
    assert.equal(calls, 1);
});

test("OAuth que ignora abort expira sem enviar mutação quando o token chega atrasado", async () => {
    let release: ((token: string) => void) | undefined;
    let calls = 0;
    const client = new GoogleApiClient("fake", endpoint, {
        getAccessToken: () => new Promise(resolve => { release = resolve; }),
    }, async () => { ++calls; return json({}); }, { timeoutMs: 20 });
    await assert.rejects(client.request("resource", { method: "POST" }), { name: "TimeoutError" });
    release?.("late-fixture-token");
    await nextTurn();
    assert.equal(calls, 0);
});

test("transporte que ignora abort expira sem repetir uma escrita de resultado incerto", async () => {
    let calls = 0;
    let release: ((response: Response) => void) | undefined;
    const client = new GoogleApiClient("fake", endpoint, oauth, () => {
        ++calls;
        return new Promise(resolve => { release = resolve; });
    }, { timeoutMs: 20 });
    await assert.rejects(client.request("resource", { method: "POST" }), { name: "TimeoutError" });
    release?.(json({ id: "already-created" }));
    await nextTurn();
    assert.equal(calls, 1);
});

test("leitura de body travada também respeita o deadline total", async () => {
    const response = json({});
    response.json = () => new Promise(() => undefined);
    const client = new GoogleApiClient("fake", endpoint, oauth, async () => response, { timeoutMs: 20 });
    await assert.rejects(client.request("resource"), { name: "TimeoutError" });
});
