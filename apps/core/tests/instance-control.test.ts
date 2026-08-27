import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { assertVoicePortAvailable, parseCliArguments, runCli } from "../src/cli.ts";
import {
    INSTANCE_PROTOCOL, INSTANCE_PROTOCOL_VERSION, MAX_INSTANCE_FRAME_BYTES,
    InstanceControl, instanceAddress, isLocalHudUrl, parseInstanceRequest,
    requestInstance, validateRemoteText, type InstanceAddress,
} from "../src/system/instance-control.ts";
import { RemoteCommandInbox } from "../src/system/remote-command-inbox.ts";

async function temporaryAddress(t: TestContext): Promise<{ root: string; address: InstanceAddress }> {
    const prefix = path.resolve(tmpdir(), "ultron-ipc-test-");
    const root = await mkdtemp(prefix);
    assert.ok(path.resolve(root).startsWith(prefix));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, address: instanceAddress(root) };
}

async function owner(t: TestContext, address: InstanceAddress, requestTimeoutMs?: number): Promise<InstanceControl> {
    const instance = await InstanceControl.acquire({ address, requestTimeoutMs });
    assert.ok(instance);
    t.after(() => instance.close());
    return instance;
}

function rawFrame(address: InstanceAddress, frame: Buffer | string): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = createConnection(address.pipePath);
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error("Fixture socket timeout")); }, 3_000);
        socket.on("error", () => undefined);
        socket.once("connect", () => socket.write(frame));
        socket.once("close", () => { clearTimeout(timeout); resolve(); });
        socket.on("data", () => undefined);
    });
}

function spawnFixture(root: string): ChildProcessWithoutNullStreams {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const fixture = fileURLToPath(new URL(`./fixtures/instance-control-child.${extension}`, import.meta.url));
    const child = spawn(process.execPath, [...(extension === "ts" ? ["--import", "tsx"] : []), fixture, root], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    child.stdin.on("error", () => undefined);
    return child;
}

function childReport(child: ChildProcessWithoutNullStreams): Promise<{ owner: boolean; pid?: number }> {
    return new Promise((resolve, reject) => {
        let output = "";
        let errors = "";
        const timeout = setTimeout(() => reject(new Error(`Fixture timeout: ${errors}`)), 10_000);
        child.stderr.on("data", chunk => { errors += String(chunk); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.stdout.on("data", chunk => {
            output += String(chunk);
            const line = output.split("\n")[0];
            if (!output.includes("\n")) return;
            clearTimeout(timeout);
            try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
        });
        child.once("exit", code => {
            if (!output.includes("\n")) { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${errors}`)); }
        });
    });
}

async function closeFixture(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.stdin.end("close\n");
    const timer = setTimeout(() => child.kill(), 2_000);
    await exited;
    clearTimeout(timer);
}

test("IPC request parser rejects unknown version, tools/grants, invalid text and unsafe HUD URLs", () => {
    const request = { protocol: INSTANCE_PROTOCOL, version: INSTANCE_PROTOCOL_VERSION, id: "test-id-0001", operation: "command", text: "liga a luz" };
    assert.ok(parseInstanceRequest(request));
    assert.equal(parseInstanceRequest({ ...request, version: 100 }), null);
    assert.equal(parseInstanceRequest({ ...request, confirmation: { approved: true } }), null);
    assert.equal(parseInstanceRequest({ ...request, operation: "execute_tool" }), null);
    assert.equal(parseInstanceRequest({ ...request, text: "\u001b[2J" }), null);
    assert.equal(parseInstanceRequest({ ...request, text: "á".repeat(5_000) }), null);
    assert.equal(validateRemoteText(" "), false);
    assert.equal(isLocalHudUrl("http://127.0.0.1:8787"), true);
    assert.equal(isLocalHudUrl("http://127.0.0.1:80"), true);
    assert.equal(isLocalHudUrl("http://127.0.0.1:8787\n"), false);
    for (const url of ["https://example.com", "file:///C:/secret", "http://localhost:8787", "http://127.0.0.1:8787/?x=1&del=a", "http://user@127.0.0.1:8787", "http://127.0.0.1:8787/path"]) {
        assert.equal(isLocalHudUrl(url), false);
    }
});

test("CLI refuses an occupied legacy voice port without sending data or starting a model", async () => {
    let bytesReceived = 0;
    const sockets = new Set<ReturnType<typeof createConnection>>();
    const legacy = createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("data", data => { bytesReceived += data.length; });
    });
    await new Promise<void>(resolve => legacy.listen(0, "127.0.0.1", resolve));
    const port = (legacy.address() as { port: number }).port;
    try {
        await assert.rejects(assertVoicePortAvailable(port), { code: "VOICE_PORT_IN_USE" });
        assert.equal(bytesReceived, 0);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => legacy.close(() => resolve()));
    }
    await assertVoicePortAvailable(port);
});

test("Remote inbox stages before acknowledgement, bounds its queue, and cancels without replay", async () => {
    const inbox = new RemoteCommandInbox(2);
    let accepted = 0;
    inbox.onAccepted(() => { accepted += 1; });
    const pending = inbox.next();
    assert.equal(inbox.next(), pending);
    const first = inbox.stage({ requestId: "request-1", text: "teste" });
    const abandoned = inbox.stage({ requestId: "request-2", text: "não executar" });
    assert.throws(() => inbox.stage({ requestId: "request-3", text: "cheia" }), /cheia/);
    abandoned.cancel();
    abandoned.commit();
    assert.equal(accepted, 0);
    first.commit();
    first.commit();
    assert.deepEqual(await pending, { requestId: "request-1", text: "teste" });
    assert.equal(accepted, 1);
    assert.equal(inbox.size, 0);
    const waiting = inbox.next();
    inbox.stop();
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(inbox.next(), { name: "AbortError" });
});

test("IPC ownership is exclusive, reports lifecycle truthfully and releases on close", async t => {
    const { address } = await temporaryAddress(t);
    const instance = await owner(t, address);
    assert.equal(await InstanceControl.acquire({ address }), null);
    assert.equal((await requestInstance(address, "status")).status?.phase, "starting");
    instance.update({ phase: "ready", hudUrl: "http://127.0.0.1:19999" });
    assert.equal((await requestInstance(address, "hud")).status?.hudUrl, "http://127.0.0.1:19999");
    instance.update({ phase: "degraded", detail: "Teste de integração indisponível." });
    assert.equal((await requestInstance(address, "status")).status?.phase, "degraded");
    await instance.close();
    const successor = await owner(t, address);
    assert.notEqual(successor.status().instanceId, instance.status().instanceId);
});

test("IPC acknowledges commands without execution claims and suppresses repeated request IDs", async t => {
    const { address } = await temporaryAddress(t);
    const instance = await owner(t, address);
    let accepted = 0;
    instance.onCommandAccepted(() => { accepted += 1; });
    const next = instance.nextCommand();
    const result = await requestInstance(address, "command", "abre o Spotify", { requestId: "same-request-0001" });
    assert.equal(result.disposition, "accepted");
    assert.match(result.message!, /ainda não confirmada/);
    assert.deepEqual(await next, { requestId: "same-request-0001", text: "abre o Spotify" });
    const repeated = await requestInstance(address, "command", "abre o Spotify", { requestId: "same-request-0001" });
    assert.equal(repeated.ok, true);
    assert.equal(accepted, 1);
    const reused = await requestInstance(address, "command", "desliga a luz", { requestId: "same-request-0001" });
    assert.equal(reused.code, "REQUEST_ID_REUSED");
    assert.equal(instance.status().queuedCommands, 0);
});

test("IPC never dispatches partial, oversized, concatenated or malicious frames", async t => {
    const { address } = await temporaryAddress(t);
    const instance = await owner(t, address, 100);
    let accepted = 0;
    instance.onCommandAccepted(() => { accepted += 1; });
    const request = { protocol: INSTANCE_PROTOCOL, version: 1, id: "bad-request-0001", operation: "command", text: "ignorado" };
    await rawFrame(address, JSON.stringify(request));
    await rawFrame(address, Buffer.alloc(MAX_INSTANCE_FRAME_BYTES + 1, "x"));
    await rawFrame(address, JSON.stringify(request) + "\n" + JSON.stringify(request) + "\n");
    await rawFrame(address, JSON.stringify({ ...request, confirmation: { approved: true } }) + "\n");
    assert.equal(accepted, 0);
    assert.equal(instance.status().queuedCommands, 0);
    assert.equal((await requestInstance(address, "status")).ok, true);
});

test("IPC limits accepted queue and rejects commands after stop acknowledgement", async t => {
    const { address } = await temporaryAddress(t);
    const instance = await owner(t, address);
    for (let index = 0; index < 8; index += 1) assert.equal((await requestInstance(address, "command", `teste ${index}`)).ok, true);
    assert.equal((await requestInstance(address, "command", "fila cheia")).code, "COMMAND_QUEUE_FULL");
    let shutdowns = 0;
    instance.onShutdown(() => { shutdowns += 1; });
    const stop = await requestInstance(address, "stop", undefined, { requestId: "stop-request-0001" });
    assert.equal(stop.disposition, "accepted");
    for (let attempt = 0; shutdowns === 0 && attempt < 50; attempt += 1) await delay(10);
    assert.equal(shutdowns, 1);
    await requestInstance(address, "stop", undefined, { requestId: "stop-request-0001" });
    assert.equal(shutdowns, 1);
    assert.equal((await requestInstance(address, "command", "não executar")).code, "INSTANCE_STOPPING");
    instance.update({ phase: "ready" });
    assert.equal(instance.status().phase, "stopping");
});

test("IPC abort before connecting dispatches no command; timeouts do not replay", async t => {
    const { address } = await temporaryAddress(t);
    const instance = await owner(t, address);
    const controller = new AbortController();
    controller.abort(new DOMException("Teste cancelado", "AbortError"));
    await assert.rejects(requestInstance(address, "command", "ignorado", { signal: controller.signal }), { name: "AbortError" });
    assert.equal(instance.status().queuedCommands, 0);
    await instance.close();
    let connections = 0;
    const sockets = new Set<ReturnType<typeof createConnection>>();
    const unresponsive = createServer(socket => { connections += 1; sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    await new Promise<void>(resolve => unresponsive.listen(address.pipePath, resolve));
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => unresponsive.close(() => resolve())); });
    await assert.rejects(requestInstance(address, "command", "não reenviar", { timeoutMs: 40 }), { code: "INSTANCE_TIMEOUT" });
    assert.equal(connections, 1);
});

test("CLI controls use the existing instance without importing or starting the voice runtime", async t => {
    const { root, address } = await temporaryAddress(t);
    const instance = await owner(t, address);
    instance.update({ phase: "ready", hudUrl: "http://127.0.0.1:19999" });
    let starts = 0;
    const output: string[] = [];
    const opened: string[] = [];
    const dependencies = {
        projectRoot: root, address, output: (message: string) => output.push(message),
        error: (message: string) => assert.fail(message), openHud: (url: string) => opened.push(url),
        startRuntime: async () => { starts += 1; },
    };
    assert.equal(await runCli(["status"], dependencies), 0);
    assert.equal(await runCli(["hud"], dependencies), 0);
    assert.equal(await runCli(["liga a luz"], dependencies), 0);
    assert.equal(starts, 0);
    assert.equal(opened[0], "http://127.0.0.1:19999");
    assert.equal((await instance.nextCommand()).text, "liga a luz");
    assert.ok(output.some(message => message.includes("ainda não confirmada")));
});

test("CLI missing-instance status/stop never start models; text starts once with unchanged input", async t => {
    const { root, address } = await temporaryAddress(t);
    const initial: Array<string | undefined> = [];
    const dependencies = {
        projectRoot: root, address, output: () => undefined, error: (message: string) => assert.fail(message),
        startRuntime: async (_instance: InstanceControl, text?: string) => { initial.push(text); },
    };
    assert.equal(await runCli(["status"], dependencies), 3);
    assert.equal(await runCli(["stop"], dependencies), 0);
    assert.equal(initial.length, 0);
    assert.equal(await runCli(["--", "sim"], dependencies), 0);
    assert.deepEqual(initial, ["sim"]);
    assert.deepEqual(parseCliArguments(["--", "stop"]), { operation: "command", text: "stop" });
});

test("CLI refuses unknown occupied protocol rather than starting a second runtime", async t => {
    const { root, address } = await temporaryAddress(t);
    const foreign = createServer(socket => socket.once("data", () => socket.end("not ultron\n")));
    await new Promise<void>(resolve => foreign.listen(address.pipePath, resolve));
    t.after(() => new Promise<void>(resolve => foreign.close(() => resolve())));
    let started = false;
    const errors: string[] = [];
    const result = await runCli([], {
        projectRoot: root, address, output: () => undefined, error: message => errors.push(message),
        startRuntime: async () => { started = true; },
    });
    assert.equal(result, 1);
    assert.equal(started, false);
    assert.equal(errors.length, 1);
});

test("Windows/kernel singleton is atomic across simultaneous isolated processes", async t => {
    const { root, address } = await temporaryAddress(t);
    const first = spawnFixture(root);
    const second = spawnFixture(root);
    t.after(async () => { await Promise.all([closeFixture(first), closeFixture(second)]); });
    const reports = await Promise.all([childReport(first), childReport(second)]);
    assert.equal(reports.filter(report => report.owner).length, 1);
    assert.equal(reports.filter(report => !report.owner).length, 1);
    assert.equal((await requestInstance(address, "status")).status?.pid, reports.find(report => report.owner)?.pid);
});

test("CLI restart waits for only its fake owner to exit before starting the successor", async t => {
    const { root, address } = await temporaryAddress(t);
    const child = spawnFixture(root);
    t.after(() => closeFixture(child));
    assert.equal((await childReport(child)).owner, true);
    let starts = 0;
    const errors: string[] = [];
    const result = await runCli(["restart"], {
        projectRoot: root, address, output: () => undefined, error: message => errors.push(message),
        stopTimeoutMs: 5_000,
        startRuntime: async instance => {
            starts += 1;
            assert.equal(instance.status().phase, "starting");
            assert.ok(child.exitCode !== null || child.signalCode !== null);
        },
    });
    assert.deepEqual(errors, []);
    assert.equal(result, 0);
    assert.equal(starts, 1);
});

test("Windows pipe ACL permits the current user, not broad write access", { skip: process.platform !== "win32" }, async t => {
    const { address } = await temporaryAddress(t);
    await owner(t, address, 10_000);
    const script = `
$ErrorActionPreference = 'Stop'
$pipe = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:ULTRON_TEST_PIPE, [System.IO.Pipes.PipeDirection]::InOut)
try {
    $pipe.Connect(5000)
    $rules = $pipe.GetAccessControl().GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $allowed = @($identity.User.Value, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
    $allowed += @($identity.Groups | Where-Object { $_.Value -like 'S-1-5-5-*' } | ForEach-Object { $_.Value })
    $mask = [int][System.IO.Pipes.PipeAccessRights]::WriteData
    $unexpected = @($rules | Where-Object {
        $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        (([int]$_.PipeAccessRights -band $mask) -ne 0) -and
        ($allowed -notcontains $_.IdentityReference.Value)
    })
    [Console]::Out.Write((@{ currentUserDuplex = $pipe.IsConnected; unexpectedWriters = $unexpected.Count } | ConvertTo-Json -Compress))
} finally { $pipe.Dispose() }
`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ULTRON_TEST_PIPE: address.pipePath.slice("\\\\.\\pipe\\".length) },
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", data => { output += String(data); });
    child.stderr.on("data", data => { errorOutput += String(data); });
    const timer = setTimeout(() => child.kill(), 10_000);
    const [code] = await once(child, "exit");
    clearTimeout(timer);
    assert.equal(code, 0, errorOutput);
    assert.deepEqual(JSON.parse(output), { currentUserDuplex: true, unexpectedWriters: 0 });
});
