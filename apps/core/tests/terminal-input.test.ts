import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TerminalInput } from "../src/system/terminal-input.ts";

test("terminal mantém texto no mesmo canal e valida limites sem executar tools", () => {
    const input = new PassThrough();
    const terminal = new TerminalInput();
    const accepted: string[] = [];
    const errors: string[] = [];
    try {
        terminal.start({ input, accept: text => accepted.push(text), onError: text => errors.push(text), onInterrupt: () => undefined });
        input.write("  que horas são?  \n\nsim\n");
        input.write("\u001b[31mhidden\n");
        input.write("x".repeat(8_193) + "\n");
        assert.deepEqual(accepted, ["que horas são?", "sim"]);
        assert.equal(errors.length, 2);
        terminal.stop();
        input.write("não deve chegar\n");
        assert.equal(accepted.length, 2);
    } finally { terminal.stop(); input.destroy(); }
});

test("fila indisponível no terminal não causa erro órfão nem expõe detalhes", () => {
    const terminal = new TerminalInput();
    const input = new PassThrough();
    const errors: string[] = [];
    try {
        terminal.start({ input, accept: () => { throw new Error("fake private failure"); }, onError: text => errors.push(text), onInterrupt: () => undefined });
        input.write("abra o app\n");
        assert.equal(errors.length, 1);
        assert.equal(errors[0]!.includes("private"), false);
    } finally { terminal.stop(); input.destroy(); }
});
