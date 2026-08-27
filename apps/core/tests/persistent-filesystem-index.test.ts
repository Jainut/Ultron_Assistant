import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import { FileSystemService } from "../src/filesystem/file-system-service.ts";
import { applicationResolver } from "../src/system/application-resolver.ts";

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-files-index-test-"));
    const root = path.join(directory, "files");
    await mkdir(root);
    const instances: FileSystemService[] = [];
    t.after(async () => {
        for (const instance of instances) instance.stop();
        await Promise.all(instances.map(instance => instance.refreshIndex().catch(() => undefined)));
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    });
    const options = { searchRoots: [root], currentDirectory: root,
        cachePath: path.join(directory, "cache", "filesystem.json") };
    const create = (overrides: Partial<typeof options> = {}) => {
        const service = new FileSystemService({ ...options, ...overrides });
        instances.push(service);
        return service;
    };
    return { directory, root, options, create };
}

test("filesystem retorna cache após restart sem aguardar ou repetir traversal", async t => {
    const f = await fixture(t);
    const project = path.join(f.root, "Fakeboxd");
    await mkdir(project);
    const target = path.join(project, "package.json");
    await writeFile(target, "{}");
    const first = f.create();
    await first.refreshIndex();
    first.stop();
    const before = await readFile(f.options.cachePath, "utf8");
    const second = f.create();
    assert.equal((await second.findDirectory("Fakeboxd")).data?.path, project);
    assert.equal((await second.findFile("package.json")).data?.path, target);
    await second.refreshIndex();
    assert.equal(second.getIndexStatus().visitedDirectories, 0);
    assert.equal(await readFile(f.options.cachePath, "utf8"), before);
    assert.equal(second.getCurrentDirectory().data?.path, f.root);
});

test("filesystem incremental detecta criações/remoções sem reler pastas intactas", async t => {
    const f = await fixture(t);
    const nested = path.join(f.root, "project");
    await mkdir(nested);
    const removed = path.join(nested, "old.txt");
    await writeFile(removed, "fixture");
    const service = f.create();
    await service.refreshIndex();
    await service.refreshIndex({ force: true });
    assert.equal(service.getIndexStatus().listedDirectories, 0);
    await unlink(removed);
    const created = path.join(nested, "new.txt");
    await writeFile(created, "fixture");
    const changed = new Date(Date.now() + 2_000);
    await utimes(nested, changed, changed);
    await service.refreshIndex({ force: true });
    assert.equal(service.getIndexStatus().listedDirectories, 1);
    assert.equal((await service.findFile("new.txt")).data?.path, created);
    assert.equal((await service.findFile("old.txt")).success, false);
});

test("arquivo removido é invalidado no primeiro candidato, mesmo antes do TTL", async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "curriculo.pdf");
    await writeFile(target, "fixture");
    const first = f.create();
    await first.refreshIndex();
    first.stop();
    await unlink(target);
    const second = f.create();
    assert.equal((await second.findFile("curriculo")).success, false);
    await second.refreshIndex();
    assert.equal(second.getIndexStatus().entries, 0);
});

test("filesystem ignora cache de outros roots e mantém cwd/contexto/criação segura", async t => {
    const f = await fixture(t);
    await mkdir(path.join(f.root, "old-project"));
    const first = f.create();
    await first.refreshIndex();
    first.stop();
    const replacement = path.join(f.directory, "other-files");
    await mkdir(replacement);
    const second = f.create({ searchRoots: [replacement], currentDirectory: replacement });
    await second.refreshIndex();
    assert.equal((await second.findDirectory("old-project")).success, false);
    await second.createDirectory("backend");
    assert.equal((await second.changeDirectory("backend")).data?.path, path.join(replacement, "backend"));
    assert.equal((await second.changeDirectory("volta")).data?.path, replacement);
    await assert.rejects(second.createDirectory("backend"), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
    await second.refreshIndex({ force: true });
    assert.equal((await second.findDirectory("backend")).success, true);
});

test("buscas/refresh cancelados e shutdown não iniciam traversal residual", async t => {
    const f = await fixture(t);
    const service = f.create();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.findFile("never.txt", { signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(service.refreshIndex({ signal: controller.signal }), { name: "AbortError" });
    assert.equal(service.getIndexStatus().visitedDirectories, 0);
    service.stop();
    service.startIndexing();
    await assert.rejects(service.findDirectory("never"), { name: "AbortError" });
    assert.equal(service.getIndexStatus().refreshing, false);
});

test("erro ao persistir cache não quebra busca em memória", async t => {
    const f = await fixture(t);
    const target = path.join(f.root, "package.json");
    await writeFile(target, "{}");
    const service = f.create({ cachePath: f.directory });
    await service.refreshIndex();
    assert.equal((await service.findFile("package.json")).data?.path, target);
});

test("editor não substitui caminho inexistente pelo cwd nem procura um aplicativo", async t => {
    const f = await fixture(t);
    const service = f.create();
    const resolver = t.mock.method(applicationResolver, "resolve", async () => null);
    const result = await service.openInEditor("projeto-que-nao-existe");
    assert.equal(result.success, false);
    assert.match(result.message, /projeto-que-nao-existe/);
    assert.equal(resolver.mock.callCount(), 0);
    assert.equal(service.getCurrentDirectory().data?.path, f.root);
});
