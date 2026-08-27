import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
    DeviceRegistry, mergeDeviceInventory, parseDeviceInventory, sameDeviceIdentity,
    mapDiscoveryLimited, writeDeviceInventoryAtomic,
    type DeviceScanContext, type DiscoveredDevice,
} from "../src/automation/device-discovery.ts";

const now = 1_000_000;
function device(overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
    return { id: "samsung:192.168.1.20", name: "TV da sala", ip: "192.168.1.20",
        mac: "AA:BB:CC:DD:EE:01", kind: "television", protocol: "samsung", lastSeen: now, ...overrides };
}
function deferred() {
    let resolve = (): void => undefined;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

test("inventário migra array legado sem inventar controle, pareamento ou estado online", () => {
    const legacy = parseDeviceInventory([device({ authToken: "fake-token" })], now);
    assert.equal(legacy[0].authToken, "fake-token");
    assert.equal(legacy[0].controllable, false);
    assert.equal(legacy[0].paired, null);
    assert.equal(legacy[0].online, null);
    assert.equal(legacy[0].lastConfirmed, undefined);
    assert.ok(legacy[0].capabilities?.actions.includes("on"));
    assert.deepEqual(parseDeviceInventory({ version: 2, devices: legacy }, now), legacy);
});

test("IP reutilizado com MAC diferente nunca herda token e bloqueia endereço do ocupante anterior", () => {
    const old = device({ authToken: "old-token", controllable: true, paired: true });
    const replacement = device({ id: "samsung:new-tv", mac: "AA:BB:CC:DD:EE:02" });
    const merged = mergeDeviceInventory([old], [replacement], now);
    assert.equal(sameDeviceIdentity(old, replacement), false);
    const current = merged.find(item => item.mac === replacement.mac)!;
    assert.equal(current.authToken, undefined);
    assert.equal(current.controllable, false);
    assert.equal(current.paired, null);
    assert.equal(merged.find(item => item.mac === old.mac)?.addressConflict, true);
});

test("IDs estáveis incompatíveis não herdam autorização mesmo se MAC coincidir", () => {
    const old = device({ id: "uuid:first", authToken: "old-token" });
    const changed = device({ id: "uuid:second" });
    assert.equal(sameDeviceIdentity(old, changed), false);
    assert.equal(mergeDeviceInventory([old], [changed], now)[0].authToken, undefined);
});

test("mudança DHCP mantém identidade, token e um único registro", () => {
    const old = device({ authToken: "saved-token", paired: true });
    const moved = device({ id: "samsung:192.168.1.30", ip: "192.168.1.30" });
    const result = mergeDeviceInventory([old], [moved], now);
    assert.equal(result.length, 1);
    assert.equal(result[0].ip, moved.ip);
    assert.equal(result[0].authToken, "saved-token");
    assert.equal(result[0].paired, true);
});

test("identidade baseada apenas no IP não transfere token durante redescoberta", () => {
    const previous = device({ mac: undefined, authToken: "untrusted-old-token" });
    assert.equal(sameDeviceIdentity(previous, previous), false);
    assert.equal(mergeDeviceInventory([previous], [device({ mac: undefined })], now)[0].authToken, undefined);
});

test("inventário rejeita schemas inválidos e não perpetua online antigo", () => {
    assert.deepEqual(parseDeviceInventory({ version: 99, devices: [device()] }, now), []);
    assert.deepEqual(parseDeviceInventory([{}, device({ protocol: "arbitrary" as never }), device({ ip: "https://outside.invalid" })], now), []);
    assert.doesNotThrow(() => parseDeviceInventory([device({ mac: 12 as never })], now));
    assert.equal(parseDeviceInventory([device({ online: true, lastReachable: now - 61_000 })], now)[0].online, null);
});

test("cache hit retorna sem aguardar scan e múltiplas buscas compartilham refresh", async t => {
    const gate = deferred();
    let scans = 0;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [device()], writeStore: async () => undefined,
        scan: async () => { scans += 1; await gate.promise; },
    });
    t.after(() => { gate.resolve(); registry.stop(); });
    const [first, second] = await Promise.all([registry.find("TV"), registry.find("TV")]);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    await setImmediate();
    assert.equal(scans, 1);
    gate.resolve();
    await registry.scan();
});

test("resultado incremental local libera busca antes da fonte lenta terminar", async t => {
    const gate = deferred();
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => { context = current; await gate.promise; }, lookupWaitMs: 100,
    });
    t.after(() => { gate.resolve(); registry.stop(); });
    const lookup = registry.find("TV");
    await setImmediate();
    context.publish([device()]);
    assert.equal((await lookup).length, 1);
    assert.equal(context.signal.aborted, false);
    gate.resolve();
    await registry.scan();
});

test("miss tem orçamento limitado e a atualização continua em background", async t => {
    const gate = deferred();
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => { context = current; await gate.promise; }, lookupWaitMs: 10,
    });
    t.after(() => { gate.resolve(); registry.stop(); });
    assert.deepEqual(await registry.find("TV"), []);
    context.publish([device()]);
    assert.equal((await registry.find("TV")).length, 1);
    gate.resolve();
    await registry.scan();
});

test("cancelar um observador não cancela o scan compartilhado de outro", async t => {
    const gate = deferred();
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => { context = current; await gate.promise; },
    });
    t.after(() => { gate.resolve(); registry.stop(); });
    const abort = new AbortController();
    const cancelled = assert.rejects(registry.scan(true, abort.signal), { name: "AbortError" });
    const other = registry.scan(true);
    await setImmediate();
    abort.abort();
    await cancelled;
    assert.equal(context.signal.aborted, false);
    context.publish([device()]);
    gate.resolve();
    assert.equal((await other).length, 1);
});

test("shutdown aborta scan e ignora publicações tardias", async () => {
    const gate = deferred();
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => { context = current; await gate.promise; },
    });
    const rejected = assert.rejects(registry.scan(true), { name: "AbortError" });
    await setImmediate();
    registry.stop();
    await rejected;
    assert.equal(context.signal.aborted, true);
    context.publish([device()]);
    gate.resolve();
    assert.deepEqual(await registry.list(), []);
});

test("token salvo com snapshot antigo não é associado ao novo ocupante do IP", async () => {
    const old = device({ authToken: "old" });
    const current = device({ id: "uuid:new", mac: "AA:BB:CC:DD:EE:03" });
    const registry = new DeviceRegistry({ now: () => now, readStore: async () => [current], writeStore: async () => undefined });
    await registry.saveToken(old, "must-not-transfer");
    assert.equal((await registry.list())[0].authToken, undefined);
    assert.equal((await registry.current(old)).addressConflict, true);
});

test("controle aceito atualiza alcance sem inventar confirmação física", async () => {
    const target = device();
    const registry = new DeviceRegistry({ now: () => now, readStore: async () => [target], writeStore: async () => undefined });
    await registry.recordOutcome(target, { confirmed: false, status: "accepted" });
    let saved = (await registry.list())[0];
    assert.equal(saved.controllable, true);
    assert.equal(saved.lastReachable, now);
    assert.equal(saved.lastConfirmed, undefined);
    await registry.recordOutcome(target, { confirmed: true });
    saved = (await registry.list())[0];
    assert.equal(saved.lastConfirmed, now);
});

test("endpoint de status alcançável sem estado não prova autorização de controle", async () => {
    const target = device();
    const registry = new DeviceRegistry({ now: () => now, readStore: async () => [target], writeStore: async () => undefined });
    await registry.recordOutcome(target, { online: true, confirmed: false, status: "unknown" });
    const saved = (await registry.list())[0];
    assert.equal(saved.online, true);
    assert.equal(saved.controllable, false);
    assert.equal(saved.lastConfirmed, undefined);
});

test("sondagens limitam concorrência e preservam ordem", async () => {
    let active = 0, peak = 0;
    const result = await mapDiscoveryLimited([0, 1, 2, 3, 4, 5, 6], 3, async value => {
        active += 1; peak = Math.max(peak, active);
        await setImmediate();
        active -= 1;
        return value * 2;
    });
    assert.ok(peak <= 3);
    assert.deepEqual(result, [0, 2, 4, 6, 8, 10, 12]);
});

test("persistência atômica mantém JSON completo e não deixa temporários", async t => {
    const directory = await mkdtemp(path.join(tmpdir(), "ultron-discovery-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "inventory.json");
    await writeDeviceInventoryAtomic(file, { version: 2, devices: [device()] });
    await writeDeviceInventoryAtomic(file, { version: 2, devices: [] });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 2, devices: [] });
    assert.deepEqual(await readdir(directory), ["inventory.json"]);
});

test("falha de uma fonte encerra o scan e ignora resultados tardios", async () => {
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => { context = current; throw new Error("fixture offline"); },
    });
    assert.deepEqual(await registry.scan(true), []);
    assert.equal(context.signal.aborted, true);
    context.publish([device()]);
    assert.deepEqual(await registry.list(), []);
});

test("deadline retorna inventário parcial mesmo se uma fonte não respeita abort", async t => {
    let timer: NodeJS.Timeout | undefined;
    let context!: DeviceScanContext;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false, scanTimeoutMs: 10,
        readStore: async () => [], writeStore: async () => undefined,
        scan: async current => {
            context = current;
            current.publish([device()]);
            await new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); });
        },
    });
    t.after(() => { clearTimeout(timer); registry.stop(); });
    assert.equal((await registry.scan(true)).length, 1);
    assert.equal(context.signal.aborted, true);
});

test("schema desconhecido não é sobrescrito ao reconstruir cache em memória", async () => {
    let writes = 0;
    const registry = new DeviceRegistry({ now: () => now, disabled: () => false,
        readStore: async () => ({ version: 99, devices: [] }),
        writeStore: async () => { writes += 1; },
        scan: async current => { current.publish([device()]); },
    });
    assert.equal((await registry.scan(true)).length, 1);
    assert.equal(writes, 0);
});
