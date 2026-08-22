import assert from "node:assert/strict";
import test from "node:test";

import { OperationalContext } from "../src/context/operational-context.ts";

test("mantém referências operacionais separadas do histórico textual", () => {
    const context = new OperationalContext();
    context.set({ type: "email", id: "message-1", provider: "gmail", label: "Processo seletivo" });
    context.set({ type: "device", id: "light", label: "Lâmpada" });

    assert.equal(context.get("email")?.id, "message-1");
    assert.equal(context.get("device")?.id, "light");
    assert.match(context.get("email")?.updatedAt ?? "", /^\d{4}-/);

    context.clear("email");
    assert.equal(context.get("email"), undefined);
    assert.equal(context.get("device")?.id, "light");
});
