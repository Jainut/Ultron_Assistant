import assert from "node:assert/strict";
import type { Dir, Dirent, Stats } from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import {
    indexSignature, pathKey, readIndexCache, restoreDirectorySnapshots,
    scanDirectoryTree, waitForIndex, writeIndexCache, type DirectorySnapshot,
} from "../src/utils/persistent-index.ts";

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-index-cache-test-"));
    t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 3 }));
    return directory;
}

test("cache versionado é atômico e assinatura/JSON inválidos viram cache miss", async t => {
    const directory = await fixture(t);
    const cachePath = path.join(directory, "index.json");
    const signature = indexSignature({ roots: [directory] });
    const value = { schemaVersion: 1 as const, signature, updatedAt: Date.now(), payload: { names: ["one"] } };
    await writeIndexCache(cachePath, value);
    assert.deepEqual(await readIndexCache(cachePath, signature), value);
    assert.equal(await readIndexCache(cachePath, "other-roots"), null);
    assert.deepEqual(await readdir(directory), ["index.json"]);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeIndexCache(cachePath, { ...value, payload: { names: ["two"] } }, controller.signal), { name: "AbortError" });
    assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), value);
    await writeFile(cachePath, "{broken", "utf8");
    assert.equal(await readIndexCache(cachePath, signature), null);
    await writeFile(cachePath, JSON.stringify({ ...value, schemaVersion: 999 }));
    assert.equal(await readIndexCache(cachePath, signature), null);
});

test("refresh incremental relê só diretório cujo mtime mudou", async t => {
    const root = await fixture(t);
    const nested = path.join(root, "project");
    await mkdir(nested);
    await writeFile(path.join(nested, "one.txt"), "fixture");
    const snapshots = new Map<string, DirectorySnapshot>();
    const names: string[] = [];
    const options = { roots: [{ directory: root, maxDepth: 4 }], snapshots,
        signal: new AbortController().signal, skipName: /^(?:node_modules|\.git)$/,
        maxEntries: 100, onEntry: (_entry: unknown, fullPath: string) => { names.push(fullPath); } };
    const first = await scanDirectoryTree(options);
    assert.equal(first.listedDirectories, 2);
    const second = await scanDirectoryTree(options);
    assert.equal(second.listedDirectories, 0);
    assert.equal(second.reusedDirectories, 2);
    await writeFile(path.join(nested, "two.txt"), "fixture");
    const changed = new Date(Date.now() + 2_000);
    await utimes(nested, changed, changed);
    names.length = 0;
    const third = await scanDirectoryTree(options);
    assert.equal(third.listedDirectories, 1);
    assert.equal(third.reusedDirectories, 1);
    assert.ok(names.includes(path.join(nested, "two.txt")));
});

test("cancelamento de traversal interrompe callbacks e não visita o restante", async t => {
    const root = await fixture(t);
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => writeFile(path.join(root, `${index}.txt`), "fixture")));
    const controller = new AbortController();
    let entries = 0;
    await assert.rejects(scanDirectoryTree({ roots: [{ directory: root, maxDepth: 4 }],
        snapshots: new Map(), signal: controller.signal, skipName: /^(?:node_modules)$/,
        maxEntries: 100, onEntry: () => { if (++entries === 3) controller.abort(); },
    }), { name: "AbortError" });
    assert.equal(entries, 3);
});

test("limite de entradas não grava listing truncado como snapshot completo", async t => {
    const root = await fixture(t);
    await Promise.all(Array.from({ length: 12 }, (_unused, index) => writeFile(path.join(root, `${index}.txt`), "fixture")));
    const snapshots = new Map<string, DirectorySnapshot>();
    const common = { roots: [{ directory: root, maxDepth: 4 }], snapshots,
        signal: new AbortController().signal, skipName: /^(?:node_modules)$/,
        onEntry: () => undefined };
    const bounded = await scanDirectoryTree({ ...common, maxEntries: 3 });
    assert.equal(bounded.complete, false);
    assert.equal(bounded.indexedEntries, 3);
    assert.equal(snapshots.has(pathKey(root)), false);
    const complete = await scanDirectoryTree({ ...common, maxEntries: 100 });
    assert.equal(complete.complete, true);
    assert.equal(complete.indexedEntries, 12);
    assert.equal(complete.listedDirectories, 1);
});

test("snapshots não aceitam escape de roots nem nomes com traversal", async t => {
    const root = await fixture(t);
    const snapshot = { directory: root, mtimeMs: 10, entries: [
        { name: "safe", type: "directory" }, { name: "../private", type: "file" },
    ] };
    const restored = restoreDirectorySnapshots([snapshot, { ...snapshot, directory: path.dirname(root) }], [root]);
    assert.equal(restored.size, 1);
    assert.deepEqual(restored.get(pathKey(root))?.entries, [{ name: "safe", type: "directory" }]);
});

test("espera cancelável e limitada não depende de scan terminar", async () => {
    const never = new Promise<void>(() => undefined);
    assert.equal(await waitForIndex(never, undefined, 5), undefined);
    const controller = new AbortController();
    const waiting = waitForIndex(never, controller.signal);
    const rejected = assert.rejects(waiting, { name: "AbortError" });
    controller.abort();
    await rejected;
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function directoryIOMock(t: TestContext, open: () => Promise<Dir>): void {
    const details = { mtimeMs: 1, isSymbolicLink: () => false, isDirectory: () => true } as Stats;
    const mockedStat = t.mock.method(fsPromises, "lstat", async () => details);
    const mockedOpen = t.mock.method(fsPromises, "opendir", open);
    syncBuiltinESMExports();
    t.after(() => {
        mockedStat.mock.restore();
        mockedOpen.mock.restore();
        syncBuiltinESMExports();
    });
}

for (const blocked of ["opendir", "read"] as const) {
    for (const interruption of ["abort", "deadline"] as const) {
        test(`${blocked} pendente respeita ${interruption} e fecha handle tardio sem continuar scan`, async t => {
            const opened = deferred<Dir>();
            const pendingRead = deferred<Dirent | null>();
            const entered = deferred<void>();
            const controller = new AbortController();
            let closed = 0;
            let openCalls = 0;
            let readCalls = 0;
            let callbacks = 0;
            const directory = {
                read: () => {
                    readCalls += 1;
                    entered.resolve();
                    return pendingRead.promise;
                },
                close: async () => { closed += 1; },
                // Keep the mock compatible with the original Dir iterator too.
                async *[Symbol.asyncIterator]() {
                    try {
                        const entry = await directory.read();
                        if (entry) yield entry;
                    } finally { await directory.close(); }
                },
            } as unknown as Dir;
            directoryIOMock(t, () => {
                openCalls += 1;
                if (blocked === "opendir") {
                    entered.resolve();
                    return opened.promise;
                }
                return Promise.resolve(directory);
            });
            const scan = scanDirectoryTree({
                roots: ["index-io-fixture", "index-must-not-continue"].map(name => ({
                    directory: path.join(process.cwd(), name), maxDepth: 1,
                })),
                snapshots: new Map(), signal: controller.signal, skipName: /^node_modules$/,
                maxEntries: 10, maxDurationMs: interruption === "deadline" ? 20 : 5_000,
                onEntry: () => { callbacks += 1; },
            });
            await entered.promise;
            try {
                if (interruption === "abort") {
                    const rejected = assert.rejects(waitForIndex(scan, undefined, 200), { name: "AbortError" });
                    controller.abort();
                    await rejected;
                } else {
                    const result = await waitForIndex(scan, undefined, 200);
                    assert.equal(result?.complete, false);
                }
                assert.equal(closed, 0, "must not close while open/read is still outstanding");
                assert.equal(callbacks, 0);
            } finally {
                opened.resolve(directory);
                pendingRead.resolve({ name: "late.txt", isFile: () => true, isDirectory: () => false,
                    isSymbolicLink: () => false } as Dirent);
                await yieldToEventLoop();
            }
            assert.equal(closed, 1);
            assert.equal(openCalls, 1);
            assert.equal(callbacks, 0, "late I/O must never resume indexing");
            assert.equal(readCalls, blocked === "read" ? 1 : 0);
        });
    }
}
