import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileSystemService } from "../src/filesystem/file-system-service.ts";

test("mantém diretório atual e cria pasta sem sobrescrever", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ultron-fs-test-"));

    try {
        const service = new FileSystemService();
        const changed = await service.changeDirectory(temporaryRoot);
        const created = await service.createDirectory("testes");
        const listed = await service.listDirectory();

        assert.equal(changed.success, true);
        assert.equal(created.success, true);
        assert.match(created.data?.path ?? "", /testes$/);
        assert.match(listed.message, /testes/);

        await assert.rejects(
            () => service.createDirectory("testes"),
            (error: NodeJS.ErrnoException) => error.code === "EEXIST",
        );
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
