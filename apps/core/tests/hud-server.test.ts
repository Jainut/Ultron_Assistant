import assert from "node:assert/strict";
import test from "node:test";

import { HudServer } from "../src/interface/hud-server.ts";

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
        const timeout = setTimeout(() => controller.abort(), 2_000);
        try {
            const frame = await reader.read();
            const text = new TextDecoder().decode(frame.value);
            const events = text.split("\n\n").filter(Boolean);
            assert.equal(events.length, 1);
            assert.equal(JSON.parse(events[0]!.slice(6)).response, "token-99");
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
