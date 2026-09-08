import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import test from "node:test";

import { HudServer } from "../src/interface/hud-server.ts";

function requestHud(hud: HudServer, target: string, headers: Record<string, string> = {}) {
    const url = new URL(hud.url());
    return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port: url.port, path: target, headers }, response => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", chunk => { body += chunk; });
            response.once("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
            response.once("error", reject);
        });
        request.setTimeout(1_500, () => request.destroy(new Error("HUD test request timed out")));
        request.once("error", reject);
        request.end();
    });
}

test("procura outra porta quando a porta preferida está ocupada", async () => {
    const primary = new HudServer(18_787);
    let secondary: HudServer | undefined;

    try {
        await primary.start();
        const primaryPort = Number(new URL(primary.url()).port);
        secondary = new HudServer(primaryPort);
        await secondary.start();

        const secondaryPort = Number(new URL(secondary.url()).port);
        assert.ok(secondaryPort > primaryPort && secondaryPort <= primaryPort + 10);
    } finally {
        secondary?.stop();
        primary.stop();
    }
});

test("publicar timings preserva o estado corrente do HUD", async () => {
    const hud = new HudServer(18_797);

    try {
        await hud.start();
        hud.update({
            state: "thinking",
            message: "Interpretando solicitação",
            transcript: "liga a luz",
        });
        hud.update({
            timings: {
                endpoint_delay: 300,
                speech_duration: 1_000,
            },
        });

        const response = await fetch(`${hud.url()}/api/status`);
        const snapshot = await response.json() as {
            state: string;
            message: string;
            transcript?: string;
            timings?: Record<string, number>;
        };

        assert.equal(snapshot.state, "thinking");
        assert.equal(snapshot.message, "Interpretando solicitação");
        assert.equal(snapshot.transcript, "liga a luz");
        assert.deepEqual(snapshot.timings, {
            endpoint_delay: 300,
            speech_duration: 1_000,
        });
    } finally {
        hud.stop();
    }
});

test("SSE agrupa uma rajada de tokens e entrega somente o snapshot mais recente", async () => {
    const hud = new HudServer(18_798);
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        await hud.start();
        const response = await fetch(`${hud.url()}/api/events`, { signal: controller.signal });
        reader = response.body!.getReader();
        await reader.read(); // Snapshot inicial permanece imediato.
        for (let index = 0; index < 100; index += 1) {
            hud.update({ response: `token-${index}` });
        }
        hud.update({ services: [{ name: "tts", state: "ready", attempts: 1, restarts: 0 }] });
        const timeout = setTimeout(() => controller.abort(), 2_000);
        try {
            const frame = await reader.read();
            const text = new TextDecoder().decode(frame.value);
            const events = text.split("\n\n").filter(Boolean);
            assert.equal(events.length, 1);
            assert.equal(JSON.parse(events[0]!.slice(6)).response, "token-99");
            assert.deepEqual(JSON.parse(events[0]!.slice(6)).services,
                [{ name: "tts", state: "ready", attempts: 1, restarts: 0 }]);
        } finally {
            clearTimeout(timeout);
        }
    } finally {
        controller.abort();
        await reader?.cancel().catch(() => undefined);
        hud.stop();
    }
});

test("HUD não expõe transcrições a uma origem externa", async () => {
    const hud = new HudServer(18_799);
    try {
        await hud.start();
        const denied = await fetch(`${hud.url()}/api/status`, {
            headers: { Origin: "https://example.com" },
        });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get("access-control-allow-origin"), null);
        const allowed = await fetch(`${hud.url()}/api/status`, {
            headers: { Origin: hud.url() },
        });
        assert.equal(allowed.status, 200);
    } finally {
        hud.stop();
    }
});

test("saúde opcional preserva conversa e publica somente os quatro campos seguros", async () => {
    const hud = new HudServer(18_810);
    try {
        await hud.start();
        const initial = await requestHud(hud, "/api/status");
        assert.equal(Object.hasOwn(JSON.parse(initial.body), "services"), false);
        const services = [{ name: "stt", state: "ready" as const, attempts: 1, restarts: 0,
            lastFailure: { error: "private-provider-payload", path: "private-path" } },
        { name: "unlisted-service", state: "failed" as const, attempts: 1, restarts: 0,
            lastFailure: { error: "private-provider-payload", path: "private-path" } }];
        hud.update({ transcript: "comando", state: "thinking", services });
        services[0]!.restarts = 42;
        hud.update({ response: "Resposta preservada" });
        const response = await requestHud(hud, "/api/status");
        const snapshot = JSON.parse(response.body);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(snapshot.transcript, "comando");
        assert.equal(snapshot.response, "Resposta preservada");
        assert.equal(snapshot.state, "thinking");
        assert.deepEqual(snapshot.services, [{ name: "stt", state: "ready", attempts: 1, restarts: 0 }]);
        assert.doesNotMatch(response.body, /private-|lastFailure|unlisted-service/);
        hud.update({ services: undefined });
        assert.deepEqual(JSON.parse((await requestHud(hud, "/api/status")).body).services, []);
    } finally { hud.stop(); }
});

test("Host externo sem Origin também é bloqueado contra DNS rebinding", async () => {
    const hud = new HudServer(18_811);
    try {
        await hud.start();
        hud.update({ transcript: "private-transcript" });
        for (const target of ["/api/status", "/api/events", "/"]) {
            const response = await requestHud(hud, target, { Host: "attacker.invalid" });
            assert.equal(response.status, 403);
            assert.equal(response.headers["cache-control"], "no-store");
            assert.doesNotMatch(response.body, /private-transcript/);
        }
        const spoofed = await requestHud(hud, "/api/status", { Host: "attacker.invalid", Origin: hud.url() });
        assert.equal(spoofed.status, 403);
        assert.equal((await requestHud(hud, "/api/status")).status, 200);
    } finally { hud.stop(); }
});

test("localhost é permitido somente na porta real e com a mesma origem", async () => {
    const hud = new HudServer(18_812);
    try {
        await hud.start();
        const port = new URL(hud.url()).port;
        const local = await requestHud(hud, "/api/status", { Host: `localhost:${port}`, Origin: `http://localhost:${port}` });
        assert.equal(local.status, 200);
        for (const host of [`localhost:${Number(port) + 1}`, `127.0.0.1.attacker.invalid:${port}`, `2130706433:${port}`]) {
            assert.equal((await requestHud(hud, "/api/status", { Host: host })).status, 403);
        }
        assert.equal((await requestHud(hud, "/api/status", { Host: `localhost:${port}`, Origin: hud.url() })).status, 403);
    } finally { hud.stop(); }
});

test("URL inválida ou absoluta externa é recusada sem derrubar o servidor", async () => {
    const hud = new HudServer(18_813);
    try {
        await hud.start();
        assert.equal((await requestHud(hud, "http://[")).status, 400);
        for (const target of ["//attacker.invalid/api/status", "http://attacker.invalid/api/status"]) {
            assert.equal((await requestHud(hud, target)).status, 403);
        }
        assert.equal((await requestHud(hud, "/api/status")).status, 200);
    } finally { hud.stop(); }
});
