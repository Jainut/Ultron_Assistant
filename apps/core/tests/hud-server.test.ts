import assert from "node:assert/strict";
import test from "node:test";

import { HudServer } from "../src/interface/hud-server.ts";

test("procura outra porta quando a porta preferida está ocupada", async () => {
    const primary = new HudServer(18_787);
    const secondary = new HudServer(18_787);

    try {
        await primary.start();
        await secondary.start();

        assert.equal(primary.url(), "http://127.0.0.1:18787");
        assert.equal(secondary.url(), "http://127.0.0.1:18788");
    } finally {
        secondary.stop();
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
