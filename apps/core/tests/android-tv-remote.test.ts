import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { AndroidRemote, AndroidRemoteOptions, Certificate } from "@kud/androidtv-remote";

import {
    AndroidTvPairingRequiredError,
    AndroidTvRemoteService,
    type PairingStore,
} from "../src/automation/android-tv-remote.ts";
import type { DiscoveredDevice } from "../src/automation/device-discovery.ts";

const device: DiscoveredDevice = {
    id: "android-tv:test",
    name: "TV de teste",
    ip: "192.0.2.20",
    mac: "AA:BB:CC:DD:EE:01",
    kind: "television",
    protocol: "android-tv",
    lastSeen: 0,
};
const storeKey = "mac:AABBCCDDEE01";
const savedCertificate: Certificate = { key: "test-key", cert: "test-cert" };

interface RemotePlan {
    mode?: "ready" | "pairing" | "reset" | "waiting";
    powered?: boolean;
    certificate?: Certificate;
}

class FakeRemote extends EventEmitter implements AndroidRemote {
    powerCommands = 0;
    readonly keys: number[] = [];
    readonly codes: string[] = [];
    stops = 0;
    private finishStart?: (connected: boolean) => void;

    constructor(readonly plan: RemotePlan, readonly options?: AndroidRemoteOptions) {
        super();
    }

    start(): Promise<boolean> {
        if (this.plan.mode === "waiting") return new Promise(() => undefined);
        if (this.plan.mode === "reset") {
            queueMicrotask(() => this.emit("unpaired"));
            return new Promise(() => undefined);
        }
        if (this.plan.mode === "pairing") {
            queueMicrotask(() => this.emit("secret"));
            return new Promise(resolve => { this.finishStart = resolve; });
        }
        queueMicrotask(() => this.ready());
        return Promise.resolve(true);
    }

    private ready(): void {
        this.emit("ready");
        if (this.plan.powered !== undefined) this.emit("powered", this.plan.powered);
        this.finishStart?.(true);
    }

    sendCode(code: string): boolean {
        this.codes.push(code);
        queueMicrotask(() => this.ready());
        return true;
    }

    sendPower(): void { this.powerCommands += 1; }
    sendKey(key: number): void { this.keys.push(key); }
    sendAppLink(): void {}
    sendText(): void {}
    getCertificate(): Certificate { return this.plan.certificate ?? savedCertificate; }
    stop(): void { this.stops += 1; }
}

function harness(plans: RemotePlan[], initialStore: PairingStore = {}) {
    const remotes: FakeRemote[] = [];
    const snapshots: PairingStore[] = [];
    let stored = structuredClone(initialStore);
    const service = new AndroidTvRemoteService({
        remoteFactory: (_host, options) => {
            const plan = plans[remotes.length];
            assert.ok(plan, "O teste não esperava outra conexão");
            const remote = new FakeRemote(plan, options);
            remotes.push(remote);
            return remote;
        },
        readPairings: async () => structuredClone(stored),
        writePairings: async store => {
            stored = structuredClone(store);
            snapshots.push(stored);
        },
        powerStateTimeoutMs: 5,
        connectionTimeoutMs: 100,
        readyTimeoutMs: 100,
    });
    return { service, remotes, snapshots, stored: () => stored };
}

test("Android TV não converte estado desconhecido em on/off por toggle", async t => {
    const { service, remotes } = harness([{}]);
    t.after(() => service.stop());
    await assert.rejects(service.control(device, "on"), /Não enviei Power/);
    await assert.rejects(service.control(device, "off"), /Não enviei Power/);
    const status = await service.control(device, "status");
    assert.equal(status.status, "unknown");
    assert.equal(status.confirmed, false);
    assert.equal(status.powered, undefined);
    assert.equal(remotes[0].powerCommands, 0);
});

test("Android TV já no estado observado solicitado não recebe outro Power", async t => {
    const { service, remotes } = harness([{ powered: true }]);
    t.after(() => service.stop());
    const result = await service.control(device, "on");
    assert.equal(result.confirmed, true);
    assert.equal(result.changed, false);
    assert.equal(result.commandSent, false);
    assert.equal(result.powered, true);
    assert.equal(remotes[0].powerCommands, 0);
});

test("Android TV separa intenção de ligar da observação e não repete toggle pendente", async t => {
    const { service, remotes } = harness([{ powered: false }]);
    t.after(() => service.stop());
    const result = await service.control(device, "on");
    assert.equal(result.status, "accepted");
    assert.equal(result.confirmed, false);
    assert.equal(result.powered, undefined);
    assert.equal(result.observedPowered, false);
    assert.equal(result.desiredPower, true);
    assert.equal(result.commandSent, true);

    const pending = await service.control(device, "status");
    assert.equal(pending.status, "unknown");
    assert.equal(pending.powered, undefined);
    assert.equal(pending.pending, true);
    const repeat = await service.control(device, "on");
    assert.equal(repeat.commandSent, false);
    await assert.rejects(service.control(device, "off"), /comando anterior/);
    assert.equal(remotes[0].powerCommands, 1);

    remotes[0].emit("powered", false);
    assert.equal((await service.control(device, "status")).confirmed, false);
    remotes[0].emit("powered", true);
    const observed = await service.control(device, "status");
    assert.equal(observed.powered, true);
    assert.equal(observed.confirmed, true);
    assert.equal(observed.pending, false);
});

test("Android TV só confirma desligamento após evento powered da TV", async t => {
    const { service, remotes } = harness([{ powered: true }]);
    t.after(() => service.stop());
    const result = await service.control(device, "off");
    assert.equal(result.confirmed, false);
    assert.equal(result.observedPowered, true);
    assert.equal(result.desiredPower, false);
    remotes[0].emit("powered", false);
    const status = await service.control(device, "status");
    assert.equal(status.powered, false);
    assert.equal(status.confirmed, true);
    assert.equal(remotes[0].powerCommands, 1);
});

test("Android TV mantém toggle explícito sem inventar o estado resultante", async t => {
    const { service, remotes } = harness([{}]);
    t.after(() => service.stop());
    const result = await service.control(device, "toggle");
    assert.equal(result.commandSent, true);
    assert.equal(result.powered, undefined);
    assert.equal(result.desiredPower, undefined);
    assert.equal(result.status, "accepted");
    await assert.rejects(service.control(device, "on"), /comando anterior/);
    assert.equal(remotes[0].powerCommands, 1);
    remotes[0].emit("powered", true);
    assert.equal((await service.control(device, "status")).confirmed, true);
});

test("reset transitório preserva certificado e a próxima conexão o reutiliza", async t => {
    const { service, remotes, snapshots, stored } = harness(
        [{ powered: true }, { powered: false }],
        { [storeKey]: savedCertificate },
    );
    t.after(() => service.stop());
    await service.control(device, "status");
    await setImmediate();
    const savesBeforeReset = snapshots.length;
    remotes[0].emit("unpaired");
    assert.equal(remotes[0].stops, 1);
    assert.deepEqual(stored()[storeKey], savedCertificate);
    assert.equal(snapshots.length, savesBeforeReset);

    const status = await service.control(device, "status");
    assert.equal(status.powered, false);
    assert.deepEqual(remotes[1].options?.cert, savedCertificate);
    const currentSaves = snapshots.length;
    remotes[0].emit("ready");
    remotes[0].emit("unpaired");
    remotes[0].emit("powered", true);
    assert.equal(remotes[1].stops, 0);
    assert.equal(snapshots.length, currentSaves);
    assert.equal((await service.control(device, "status")).powered, false);
});

test("pareamento explícito pode recuperar certificado recusado sem apagá-lo antecipadamente", async t => {
    const newCertificate = { key: "new-test-key", cert: "new-test-cert" };
    const { service, remotes, stored } = harness(
        [{ mode: "reset" }, { mode: "pairing", certificate: newCertificate }],
        { [storeKey]: savedCertificate },
    );
    t.after(() => service.stop());
    const pairing = await service.beginPairing(device) as { paired: boolean; confirmed: boolean; status: string };
    assert.equal(pairing.paired, false);
    assert.equal(pairing.confirmed, false);
    assert.equal(pairing.status, "accepted");
    assert.deepEqual(remotes[0].options?.cert, savedCertificate);
    assert.equal(remotes[1].options?.cert, undefined);
    assert.deepEqual(stored()[storeKey], savedCertificate);

    const result = await service.submitPairingCode("21891f");
    assert.equal(result.paired, true);
    assert.equal(result.pairingPersisted, true);
    assert.deepEqual(remotes[1].codes, ["21891F"]);
    assert.deepEqual(stored()[storeKey], newCertificate);
});

test("pareamento e envio de ação pendente têm resultados separados", async t => {
    const { service, remotes } = harness([{ mode: "pairing", powered: false }]);
    t.after(() => service.stop());
    await assert.rejects(service.control(device, "on"), AndroidTvPairingRequiredError);
    const result = await service.submitPairingCode("21891F");
    assert.equal(result.paired, true);
    assert.equal(result.executedAction, "on");
    assert.equal(result.actionResult?.status, "accepted");
    assert.equal(result.actionResult?.confirmed, false);
    assert.equal(result.actionResult?.powered, undefined);
    assert.equal(remotes[0].powerCommands, 1);
});

test("ação pendente recusada por estado desconhecido não transforma pareamento concluído em falha", async t => {
    const { service, remotes, stored } = harness([{ mode: "pairing" }]);
    t.after(() => service.stop());
    await assert.rejects(service.control(device, "off"), AndroidTvPairingRequiredError);
    const result = await service.submitPairingCode("21891F");
    assert.equal(result.paired, true);
    assert.equal(result.requestedAction, "off");
    assert.equal(result.executedAction, undefined);
    assert.match(result.actionError ?? "", /Não enviei Power/);
    assert.deepEqual(stored()[storeKey], savedCertificate);
    assert.equal(remotes[0].powerCommands, 0);
});

test("cancelamento no handshake encerra a sessão sem enviar ações", async t => {
    const { service, remotes } = harness([{ mode: "waiting" }]);
    t.after(() => service.stop());
    const controller = new AbortController();
    const operation = service.control(device, "off", controller.signal);
    const rejected = assert.rejects(operation, { name: "AbortError" });
    await setImmediate();
    controller.abort();
    await rejected;
    assert.equal(remotes[0].stops, 1);
    assert.equal(remotes[0].powerCommands, 0);
});

test("shutdown encerra sessões e libera waits pendentes", async () => {
    const { service, remotes } = harness([{ mode: "waiting" }]);
    const operation = service.control(device, "status");
    const rejected = assert.rejects(operation, /encerrado/);
    await setImmediate();
    service.stop();
    await rejected;
    assert.equal(remotes[0].stops, 1);
    assert.equal(service.hasPendingPairing(), false);
});

test("reconexão interna invalida observação anterior até um novo powered", async t => {
    const { service, remotes } = harness([{ powered: true }]);
    t.after(() => service.stop());
    await service.control(device, "status");
    remotes[0].emit("ready");
    const unknown = await service.control(device, "status");
    assert.equal(unknown.powered, undefined);
    assert.equal(unknown.confirmed, false);
    await assert.rejects(service.control(device, "off"), /Não enviei Power/);
    assert.equal(remotes[0].powerCommands, 0);
    remotes[0].emit("powered", false);
    assert.equal((await service.control(device, "status")).powered, false);
});

test("shutdown durante leitura do store não permite uma conexão tardia", async () => {
    let resolveStore: (value: PairingStore) => void = () => undefined;
    let factories = 0;
    const service = new AndroidTvRemoteService({
        remoteFactory: () => { factories += 1; return new FakeRemote({}); },
        readPairings: () => new Promise(resolve => { resolveStore = resolve; }),
        writePairings: async () => undefined,
    });
    const operation = service.control(device, "status");
    const rejected = assert.rejects(operation, /encerrado/);
    service.stop();
    resolveStore({});
    await rejected;
    assert.equal(factories, 0);
});

test("shutdown durante pedido explícito de pareamento não inicia outra conexão", async () => {
    const { service, remotes } = harness([{ mode: "waiting" }], { [storeKey]: savedCertificate });
    const operation = service.beginPairing(device);
    const rejected = assert.rejects(operation, /encerrado/);
    await setImmediate();
    service.stop();
    await rejected;
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].stops, 1);
});

test("chamadas concorrentes reutilizam sessão e aguardam o mesmo estado de pareamento", async t => {
    const { service, remotes } = harness([{ mode: "pairing", powered: true }]);
    t.after(() => service.stop());
    const operations = await Promise.allSettled([
        service.control(device, "off"),
        service.control(device, "off"),
    ]);
    assert.equal(remotes.length, 1);
    for (const result of operations) {
        assert.equal(result.status, "rejected");
        if (result.status === "rejected") assert.ok(result.reason instanceof AndroidTvPairingRequiredError);
    }
    const paired = await service.submitPairingCode("21891F");
    assert.equal(paired.executedAction, "off");
    assert.equal(remotes[0].powerCommands, 1);
});

test("volume, mídia e navegação continuam disponíveis sem afirmar confirmação física", async t => {
    const { service, remotes } = harness([{ powered: true }]);
    t.after(() => service.stop());
    for (const action of ["volume_up", "volume_down", "mute", "unmute", "play", "pause", "stop", "home", "back", "up", "down", "left", "right", "select", "menu", "input", "channel_up", "channel_down", "next", "previous"] as const) {
        const result = await service.control(device, action);
        assert.equal(result.status, "accepted");
        assert.equal(result.confirmed, false);
        assert.equal(result.commandSent, true);
    }
    assert.equal(remotes[0].keys.length, 20);
    assert.equal(remotes[0].powerCommands, 0);
});
