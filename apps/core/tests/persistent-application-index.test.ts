import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { ApplicationResolver } from "../src/system/application-resolver.ts";

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-app-index-test-"));
    const menu = path.join(directory, "menu");
    const bin = path.join(directory, "bin");
    const programs = path.join(directory, "programs");
    await Promise.all([menu, bin, programs].map(value => mkdir(value)));
    const instances: ApplicationResolver[] = [];
    t.after(async () => {
        for (const instance of instances) instance.stop();
        await Promise.all(instances.map(instance => instance.refresh().catch(() => undefined)));
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const options = { cachePath: path.join(directory, "cache", "applications.json"),
        startMenuRoots: [menu], pathDirectories: [bin], programFilesRoots: [programs],
        configuredApplications: {}, scanWindowsSources: false };
    const create = (overrides: Partial<typeof options> = {}) => {
        const resolver = new ApplicationResolver({ ...options, ...overrides });
        instances.push(resolver);
        return resolver;
    };
    return { directory, menu, bin, programs, options, create };
}

test("índice de apps carrega após restart sem repetir scan de fontes frescas", async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.menu, "Spotify.lnk"), "shortcut fixture");
    await writeFile(path.join(f.bin, "tool.cmd"), "fixture");
    const browser = path.join(f.programs, "Zen Browser.exe");
    await writeFile(browser, "not an executable");
    const first = f.create();
    await first.refresh();
    assert.ok(first.getIndexStatus().listedDirectories >= 3);
    first.stop();
    const before = await readFile(f.options.cachePath, "utf8");
    const second = f.create();
    assert.equal((await second.resolve("zen"))?.entry.command, browser);
    assert.equal((await second.resolve("spotfy"))?.entry.name, "Spotify");
    await second.refresh();
    assert.equal(second.getIndexStatus().visitedDirectories, 0);
    assert.equal(await readFile(f.options.cachePath, "utf8"), before);
});

test("refresh de apps reutiliza snapshots e captura mudança em diretório aninhado", async t => {
    const f = await fixture(t);
    const nested = path.join(f.programs, "Editor");
    await mkdir(nested);
    await writeFile(path.join(nested, "Code.exe"), "fixture");
    const resolver = f.create();
    await resolver.refresh();
    await resolver.refresh({ force: true });
    assert.equal(resolver.getIndexStatus().listedDirectories, 0);
    assert.ok(resolver.getIndexStatus().reusedDirectories >= 4);
    const created = path.join(nested, "NewEditor.exe");
    await writeFile(created, "fixture");
    const changed = new Date(Date.now() + 2_000);
    await utimes(nested, changed, changed);
    await resolver.refresh({ force: true });
    assert.equal(resolver.getIndexStatus().listedDirectories, 1);
    assert.equal((await resolver.resolve("NewEditor"))?.entry.command, created);
});

test("app removido não é retornado a partir de cache fresco", async t => {
    const f = await fixture(t);
    const app = path.join(f.menu, "Spotify.lnk");
    await writeFile(app, "fixture");
    const first = f.create();
    await first.refresh();
    first.stop();
    await unlink(app);
    const second = f.create();
    assert.equal(await second.resolve("Spotify"), null);
    await second.refresh();
    assert.equal(second.getIndexStatus().entries, 0);
});

test("assinatura de fontes alterada descarta apps de roots anteriores", async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.programs, "OldEditor.exe"), "fixture");
    const first = f.create();
    await first.refresh();
    first.stop();
    const replacement = path.join(f.directory, "new-programs");
    await mkdir(replacement);
    const second = f.create({ programFilesRoots: [replacement] });
    await second.refresh();
    assert.equal(await second.resolve("OldEditor"), null);
    assert.equal(second.getIndexStatus().entries, 0);
});

test("aliases configurados/argumentos sobrevivem e stop bloqueia novos scans", async t => {
    const f = await fixture(t);
    const resolver = f.create({ configuredApplications: {
        vscode: { command: "custom-code.cmd", args: ["--reuse-window"] },
    } });
    for (const alias of ["VS Code", "code", "Visual Studio Code"]) {
        const match = await resolver.resolve(alias);
        assert.equal(match?.entry.source, "configured");
        assert.deepEqual(match?.entry.args, ["--reuse-window"]);
    }
    assert.equal(resolver.getIndexStatus().visitedDirectories, 0);
    resolver.stop();
    await assert.rejects(resolver.resolve("anything"), { name: "AbortError" });
    await assert.rejects(resolver.refresh(), { name: "AbortError" });
});

test("erro ao persistir cache não quebra resolução de apps em memória", async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.menu, "Spotify.lnk"), "fixture");
    // Existing directory instead of a file forces an atomic rename failure.
    const resolver = f.create({ cachePath: f.directory });
    await resolver.refresh();
    assert.equal((await resolver.resolve("Spotify"))?.entry.name, "Spotify");
});

test("cache miss aguarda a geração rápida atual após um refresh anterior", async t => {
    const f = await fixture(t);
    const resolver = f.create();
    await resolver.refresh();
    await writeFile(path.join(f.menu, "NewEditor.lnk"), "fixture");
    const changed = new Date(Date.now() + 2_000);
    await utimes(f.menu, changed, changed);

    // Expire the quick sources without waiting for the real background timer.
    const staleNow = Date.now() + 31 * 60_000;
    t.mock.method(Date, "now", () => staleNow);
    const scans = resolver as unknown as { scanStartMenus(signal: AbortSignal): Promise<boolean> };
    const scanStartMenus = scans.scanStartMenus.bind(resolver);
    t.mock.method(scans, "scanStartMenus", async (signal: AbortSignal) => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return scanStartMenus(signal);
    });

    // The previous resolved quickScan returned null here in ~1ms, despite the
    // new application becoming available well within the 650ms search budget.
    assert.equal((await resolver.resolve("NewEditor"))?.entry.name, "NewEditor");
});

test("refresh rápido cancelado não contamina a busca da geração seguinte", async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.menu, "Spotify.lnk"), "fixture");
    const resolver = f.create();
    const controller = new AbortController();
    const scans = resolver as unknown as { scanStartMenus(signal: AbortSignal): Promise<boolean> };
    const cancelled = t.mock.method(scans, "scanStartMenus", async (signal: AbortSignal) => {
        controller.abort();
        signal.throwIfAborted();
        return false;
    });
    await assert.rejects(resolver.refresh({ signal: controller.signal }), { name: "AbortError" });
    cancelled.mock.restore();

    assert.equal((await resolver.resolve("Spotify"))?.entry.name, "Spotify");
});
