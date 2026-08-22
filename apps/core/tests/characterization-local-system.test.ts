import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileSystemService } from "../src/filesystem/file-system-service.ts";
import { ApplicationResolver } from "../src/system/application-resolver.ts";
import { perf } from "../src/utils/performance.ts";

test("ApplicationResolver resolve aliases configurados antes da indexação", async () => {
    const resolver = new ApplicationResolver();

    for (const alias of ["vscode", "VS Code", "code", "Visual Studio Code"]) {
        const match = await resolver.resolve(alias);

        assert.equal(match?.entry.name, "vscode", alias);
        assert.equal(match?.entry.source, "configured", alias);
        assert.equal(match?.score, 1, alias);
    }
});

test("filesystem propaga cancelamento anterior sem criar ou listar conteúdo", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "ultron-fs-cancel-characterization-"),
    );
    const service = new FileSystemService();
    const controller = new AbortController();

    try {
        const changed = await service.changeDirectory(temporaryRoot);
        assert.equal(changed.success, true);

        controller.abort();

        await assert.rejects(
            () => service.createDirectory("nao-deve-existir", {
                signal: controller.signal,
            }),
            (error: Error) => error.name === "AbortError",
        );
        await assert.rejects(
            () => service.listDirectory(undefined, {
                signal: controller.signal,
            }),
            (error: Error) => error.name === "AbortError",
        );
        await assert.rejects(
            () => access(path.join(temporaryRoot, "nao-deve-existir")),
            (error: NodeJS.ErrnoException) => error.code === "ENOENT",
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("filesystem não sobrescreve diretório existente nem seu conteúdo", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "ultron-fs-safety-characterization-"),
    );
    const existingDirectory = path.join(temporaryRoot, "existente");
    const marker = path.join(existingDirectory, "conteudo.txt");
    const service = new FileSystemService();

    try {
        await mkdir(existingDirectory);
        await writeFile(marker, "preservado", "utf8");
        await service.changeDirectory(temporaryRoot);

        await assert.rejects(
            () => service.createDirectory("existente"),
            (error: NodeJS.ErrnoException) => error.code === "EEXIST",
        );
        assert.equal(await readFile(marker, "utf8"), "preservado");
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("filesystem mantém navegação contextual e volta ao diretório pai", async () => {
    const temporaryRoot = await mkdtemp(
        path.join(os.tmpdir(), "ultron-fs-context-characterization-"),
    );
    const child = path.join(temporaryRoot, "projeto");
    const nested = path.join(child, "backend");
    const service = new FileSystemService();

    try {
        await mkdir(nested, { recursive: true });
        await service.changeDirectory(temporaryRoot);

        assert.equal((await service.changeDirectory("projeto")).data?.path, child);
        assert.equal((await service.changeDirectory("backend")).data?.path, nested);
        assert.equal((await service.changeDirectory("volta")).data?.path, child);
        assert.equal(service.getCurrentDirectory().data?.path, child);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});

test("PerformanceTracker mede sem alterar retorno e não engole falhas", async () => {
    let executions = 0;
    const result = await perf.measure("characterization success", () => {
        executions += 1;
        return { ok: true };
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(executions, 1);

    await assert.rejects(
        () => perf.measure("characterization failure", () => {
            throw new Error("falha preservada");
        }),
        /falha preservada/,
    );
});
