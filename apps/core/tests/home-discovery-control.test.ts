import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
    controlDiscoveredDevice, executeDiscoveredDeviceCommand, isSafeDiscoveryRetry,
    type DiscoveredDevice, type DiscoveredProtocol,
} from "../src/automation/device-discovery.ts";

function device(protocol: DiscoveredProtocol, extra: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
    return { id: protocol + ":192.168.1.20", name: "Aparelho de teste", ip: "192.168.1.20",
        mac: "AA:BB:CC:DD:EE:01", protocol, kind: "switch", lastSeen: Date.now(), ...extra };
}
const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const networkError = (): Error => Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" });

class FakeSocket {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly sent: string[] = [];
    closed = 0;
    send(value: string): void { this.sent.push(value); }
    close(): void { this.closed += 1; this.onclose?.(); }
    connected(): void { this.onmessage?.({ data: JSON.stringify({ event: "ms.channel.connect", data: { token: "fake-token" } }) } as MessageEvent); }
}

test("Shelly Gen2 toggle usa Switch.Toggle e não confunde was_on com estado novo", async () => {
    const urls: string[] = [];
    const result = await executeDiscoveredDeviceCommand(device("shelly", {
        capabilities: { actions: [], powerMode: "discrete", requiresPairing: false, generation: 2 },
    }), "toggle", undefined, { fetch: async input => {
        urls.push(String(input));
        return jsonResponse({ was_on: true });
    } }) as { confirmed: boolean; powered?: boolean; status: string };
    assert.deepEqual(urls, ["http://192.168.1.20/rpc/Switch.Toggle?id=0"]);
    assert.equal(result.confirmed, false);
    assert.equal(result.powered, undefined);
    assert.equal(result.status, "accepted");
});

test("Shelly consulta geração uma vez e reutiliza o cache", async () => {
    const urls: string[] = [];
    const target = device("shelly", { mac: "AA:BB:CC:DD:EE:09" });
    const adapters = { fetch: (async (input: RequestInfo | URL) => {
        const url = String(input); urls.push(url);
        return jsonResponse(url.endsWith("/shelly") ? { gen: 2 } : { was_on: false });
    }) as typeof fetch };
    await executeDiscoveredDeviceCommand(target, "on", undefined, adapters);
    await executeDiscoveredDeviceCommand(target, "off", undefined, adapters);
    assert.equal(urls.filter(url => url.endsWith("/shelly")).length, 1);
    assert.ok(urls[1].endsWith("Switch.Set?id=0&on=true"));
    assert.ok(urls[2].endsWith("Switch.Set?id=0&on=false"));
});

test("Shelly confirma leitura real e recusa ação não suportada antes de HTTP", async () => {
    let calls = 0;
    const target = device("shelly", { capabilities: { actions: [], powerMode: "discrete", requiresPairing: false, generation: 2 } });
    const adapters = { fetch: (async () => { calls += 1; return jsonResponse({ output: true }); }) as typeof fetch };
    await assert.rejects(executeDiscoveredDeviceCommand(target, "open", undefined, adapters), /integração disponível/);
    assert.equal(calls, 0);
    const state = await executeDiscoveredDeviceCommand(target, "status", undefined, adapters) as { confirmed: boolean; powered: boolean };
    assert.equal(state.confirmed, true);
    assert.equal(state.powered, true);
});

test("Kasa err_code e confirmação ausente não viram sucesso", async () => {
    for (const payload of [{ err_code: -1 }, {}]) {
        await assert.rejects(executeDiscoveredDeviceCommand(device("kasa"), "on", undefined, {
            kasaRequest: async () => ({ system: { set_relay_state: payload } }),
        }), /Kasa/);
    }
    await assert.rejects(executeDiscoveredDeviceCommand(device("kasa"), "status", undefined, {
        kasaRequest: async () => ({ system: { get_sysinfo: { err_code: -1 } } }),
    }), /recusou/);
});

test("Kasa toggle sem estado não envia alteração", async () => {
    let calls = 0;
    await assert.rejects(executeDiscoveredDeviceCommand(device("kasa"), "toggle", undefined, {
        kasaRequest: async () => { calls += 1; return { system: { get_sysinfo: { err_code: 0 } } }; },
    }), /não enviei toggle/);
    assert.equal(calls, 1);
});

test("Kasa toggle com estado real envia só o inverso e mantém resultado accepted", async () => {
    const commands: unknown[] = [];
    const result = await executeDiscoveredDeviceCommand(device("kasa"), "toggle", undefined, {
        kasaRequest: async (_ip, command) => {
            commands.push(command);
            return commands.length === 1
                ? { system: { get_sysinfo: { relay_state: 1, err_code: 0 } } }
                : { system: { set_relay_state: { err_code: 0 } } };
        },
    }) as { confirmed: boolean; status: string };
    assert.deepEqual(commands[1], { system: { set_relay_state: { state: 0 } } });
    assert.equal(result.confirmed, false);
    assert.equal(result.status, "accepted");
});

test("Roku e WLED propagam cancelamento durante HTTP", async () => {
    for (const protocol of ["roku", "wled"] as const) {
        const abort = new AbortController();
        let upstream: AbortSignal | undefined;
        const operation = executeDiscoveredDeviceCommand(device(protocol), "off", abort.signal, {
            fetch: async (_input, init) => {
                upstream = init?.signal ?? undefined;
                return new Promise<Response>((_resolve, reject) => upstream?.addEventListener("abort", () => reject(upstream?.reason), { once: true }));
            },
        });
        const rejected = assert.rejects(operation, { name: "AbortError" });
        await setImmediate();
        abort.abort();
        await rejected;
        assert.equal(upstream?.aborted, true);
    }
});

test("Samsung aborta handshake e eventos tardios não enviam teclas nem salvam token", async () => {
    const socket = new FakeSocket();
    const abort = new AbortController();
    let tokens = 0;
    const operation = executeDiscoveredDeviceCommand(device("samsung"), "off", abort.signal, {
        createWebSocket: () => socket as unknown as WebSocket,
        saveToken: async () => { tokens += 1; },
    });
    const rejected = assert.rejects(operation, { name: "AbortError" });
    abort.abort();
    await rejected;
    socket.connected();
    assert.equal(socket.sent.length, 0);
    assert.equal(tokens, 0);
    assert.equal(socket.closed, 1);
});

test("Samsung evento connect duplicado só envia uma tecla", async () => {
    const socket = new FakeSocket();
    let tokens = 0;
    const operation = executeDiscoveredDeviceCommand(device("samsung"), "volume_up", undefined, {
        createWebSocket: () => socket as unknown as WebSocket,
        saveToken: async () => { tokens += 1; },
    });
    socket.connected(); socket.connected(); socket.close();
    const result = await operation as { confirmed: boolean };
    assert.equal(socket.sent.length, 1);
    assert.equal(tokens, 1);
    assert.equal(result.confirmed, false);
});

test("Tuya mantém o daemon persistente e o AbortSignal sem promover envio a confirmação", async () => {
    const controller = new AbortController();
    let seenArgs: unknown, seenSignal: AbortSignal | undefined;
    const result = await executeDiscoveredDeviceCommand(device("tuya-cloud", { deviceId: "fixture-id" }), "on", controller.signal, {
        tuyaRequest: async (args, signal) => {
            seenArgs = args; seenSignal = signal;
            return { success: true, confirmed: false, optimistic: true };
        },
    }) as { confirmed: boolean };
    assert.deepEqual(seenArgs, ["control", "fixture-id", "on"]);
    assert.equal(seenSignal, controller.signal);
    assert.equal(result.confirmed, false);
});

test("nenhum adapter é chamado se o comando já foi cancelado", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    for (const protocol of ["samsung", "roku", "wled", "kasa", "shelly", "android-tv", "tuya-cloud"] as const) {
        await assert.rejects(executeDiscoveredDeviceCommand(device(protocol), "on", controller.signal, {
            fetch: async () => { calls += 1; return jsonResponse({}); },
            kasaRequest: async () => { calls += 1; return {}; },
            createWebSocket: () => { calls += 1; return new FakeSocket() as unknown as WebSocket; },
            androidControl: async () => { calls += 1; },
            tuyaRequest: async () => { calls += 1; return {}; },
        }), { name: "AbortError" });
    }
    assert.equal(calls, 0);
});

test("recuperação de IP repete setter idempotente uma vez, na mesma identidade", async () => {
    const old = device("wled");
    const moved = { ...old, id: "wled:192.168.1.30", ip: "192.168.1.30" };
    const targets: string[] = [];
    const result = await controlDiscoveredDevice(old, "on", undefined, {
        registry: { current: async () => old, refreshIdentity: async () => moved, recordOutcome: async () => undefined },
        execute: async target => { targets.push(target.ip); if (targets.length === 1) throw networkError(); return { status: "accepted" }; },
    }) as { status: string };
    assert.deepEqual(targets, [old.ip, moved.ip]);
    assert.equal(result.status, "accepted");
});

test("toggle, volume e Power Android TV nunca são reenviados após timeout", async () => {
    for (const [protocol, action] of [["wled", "toggle"], ["roku", "volume_up"], ["android-tv", "on"], ["android-tv", "off"], ["samsung", "mute"]] as const) {
        const old = device(protocol);
        let calls = 0;
        await assert.rejects(controlDiscoveredDevice(old, action, undefined, {
            registry: { current: async () => old, refreshIdentity: async () => ({ ...old, ip: "192.168.1.30" }), recordOutcome: async () => undefined },
            execute: async () => { calls += 1; throw networkError(); },
        }), /Connection refused/);
        assert.equal(calls, 1);
        assert.equal(isSafeDiscoveryRetry(old, action), false);
    }
});

test("recuperação rejeita novo ocupante do mesmo IP e mudança de identidade", async () => {
    const old = device("wled");
    let calls = 0;
    await assert.rejects(controlDiscoveredDevice(old, "on", undefined, {
        registry: { current: async () => old, refreshIdentity: async () => ({ ...old, ip: "192.168.1.30", mac: "AA:BB:CC:DD:EE:99" }), recordOutcome: async () => undefined },
        execute: async () => { calls += 1; throw networkError(); },
    }), /Connection refused/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(controlDiscoveredDevice(old, "toggle", undefined, {
        registry: { current: async () => ({ ...old, addressConflict: true }), refreshIdentity: async () => null, recordOutcome: async () => undefined },
        execute: async () => { calls += 1; },
    }), /outro dispositivo/);
    assert.equal(calls, 0);
});

test("IP já atualizado no cache é usado antes de enviar qualquer comando", async () => {
    const old = device("wled"), moved = { ...old, ip: "192.168.1.30" };
    const targets: string[] = [];
    await controlDiscoveredDevice(old, "toggle", undefined, {
        registry: { current: async () => moved, refreshIdentity: async () => null, recordOutcome: async () => undefined },
        execute: async target => { targets.push(target.ip); return { status: "accepted" }; },
    });
    assert.deepEqual(targets, [moved.ip]);
});
