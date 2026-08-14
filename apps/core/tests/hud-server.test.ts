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
