import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ObsidianIndex } from "../src/memory/obsidian-index.ts";
import { parseMarkdownNote } from "../src/memory/markdown-note.ts";

test("Markdown preserva properties planas, aliases, tags e links sem interpretar exemplos como arestas", () => {
    const note = parseMarkdownNote(
        "Projetos/Ultron.md",
        `---
title: Ultron
aliases: [Assistente, Jarvis]
tags: [projetos/ativos]
power: true
count: 2
date: 2026-09-08
link: "[[Backend]]"
---
# Meu projeto
Usa [[Supabase#Tabelas|banco]] e [Backend](Backend.md).
#typescript #1984
\`[[exemplo]]\`
\`\`\`ts
[[código]]
\`\`\`
%% [[privado]] %%`,
    );
    assert.equal(note.propertiesValid, true);
    assert.equal(note.title, "Ultron");
    assert.equal(note.properties.power, true);
    assert.equal(note.properties.count, 2);
    assert.equal(note.properties.date, "2026-09-08");
    assert.deepEqual(note.aliases, ["Assistente", "Jarvis"]);
    assert.deepEqual(note.tags, ["projetos/ativos", "typescript"]);
    assert.deepEqual(note.links, ["Supabase#Tabelas", "Backend", "Backend.md"]);
});

test("YAML inválido, aliases expansivos e tags custom não quebram leitura nem executam conteúdo", () => {
    for (const yaml of ["a: 1\na: 2", "a: &a [1]\nb: *a", "a: !command desligar tudo"]) {
        const note = parseMarkdownNote("nota.md", `---\n${yaml}\n---\nConteúdo legível.`);
        assert.equal(note.propertiesValid, false);
        assert.equal(note.text, "Conteúdo legível.");
    }
    const note = parseMarkdownNote("nota.md", "\u001b[31mtexto\u0007");
    assert.doesNotMatch(note.text, /[\u001b\u0007]/);
    const escaped = parseMarkdownNote(
        "nota.md",
        '---\ntitle: "\\e[31mTítulo"\naliases: ["\\aAlias"]\n---\nTexto',
    );
    assert.doesNotMatch(JSON.stringify(escaped), /\\u001b|\\u0007/);
});

async function fixture(t: TestContext) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-vault-test-"));
    const vault = path.join(directory, "vault");
    await mkdir(path.join(vault, "Projetos"), { recursive: true });
    const index = new ObsidianIndex({
        vaultPath: vault,
        cachePath: path.join(directory, "cache.json"),
    });
    t.after(async () => {
        index.stop();
        await rm(directory, { recursive: true, force: true });
    });
    return { directory, vault, index };
}

test("índice incremental reutiliza arquivos/cache, encontra aliases/tags e invalida alteração/remoção", async (t) => {
    const { directory, vault, index } = await fixture(t);
    const file = path.join(vault, "Projetos", "Ultron.md");
    await writeFile(
        file,
        "---\naliases: [Jarvis]\ntags: [projetos/ativos]\n---\n# Ultron\nAssistente local",
    );
    await writeFile(path.join(vault, "Backend.md"), "# Backend\nTypeScript");
    const before = await readFile(file);
    await index.refresh();
    assert.equal(index.status().readFiles, 2);
    assert.equal((await index.search("Jarvis")).items[0]?.id, "Projetos/Ultron.md");
    assert.equal((await index.search("#projetos")).items.length, 1);
    await index.refresh();
    assert.equal(index.status().readFiles, 0);
    assert.equal(index.status().reusedFiles, 2);
    assert.deepEqual(await readFile(file), before);
    const restarted = new ObsidianIndex({
        vaultPath: vault,
        cachePath: path.join(directory, "cache.json"),
    });
    t.after(() => restarted.stop());
    await restarted.refresh();
    assert.equal(restarted.status().readFiles, 0);
    assert.equal(restarted.status().reusedFiles, 2);
    await writeFile(file, "# Ultron\nNovo conteúdo");
    assert.equal((await restarted.search("Jarvis")).items.length, 0);
    assert.match((await restarted.read("Ultron")).text, /Novo conteúdo/);
    await restarted.refresh();
    assert.equal(restarted.status().readFiles, 1);
    await unlink(file);
    assert.equal((await restarted.search("Ultron")).items.length, 0);
    await restarted.refresh();
    assert.equal(restarted.status().notes, 1);
});

test("links e backlinks resolvem caminho relativo, wiki aliases e duplicados sem inventar destino", async (t) => {
    const { vault, index } = await fixture(t);
    await writeFile(
        path.join(vault, "Projetos", "Ultron.md"),
        "# Ultron\n[[Backend]] [[Inexistente]] [DB](../Banco.md)",
    );
    await writeFile(path.join(vault, "Projetos", "Backend.md"), "# Backend\n[[Ultron]]");
    await writeFile(
        path.join(vault, "Banco.md"),
        "---\naliases: [DB]\n---\n# Banco\n[[Projetos/Ultron]]",
    );
    await index.refresh();
    const graph = await index.connections("Ultron");
    assert.deepEqual(graph.links.map((item) => item.id).sort(), [
        "Banco.md",
        "Projetos/Backend.md",
    ]);
    assert.deepEqual(graph.backlinks.map((item) => item.id).sort(), [
        "Banco.md",
        "Projetos/Backend.md",
    ]);
    assert.deepEqual(graph.unresolved, ["Inexistente"]);
    assert.equal((await index.read("DB")).id, "Banco.md");
    await mkdir(path.join(vault, "Outro"));
    await writeFile(path.join(vault, "Outro", "Backend.md"), "# Backend");
    await index.refresh();
    await assert.rejects(index.read("Backend"), /mais de uma/);
    assert.equal((await index.read("Projetos/Backend.md")).id, "Projetos/Backend.md");
});

test("vault opt-in não faz I/O e cache dentro do vault é recusado em todas as tentativas", async (t) => {
    const disabled = new ObsidianIndex();
    disabled.start();
    assert.equal(disabled.status().state, "disabled");
    await assert.rejects(disabled.search("projeto"), /ULTRON_OBSIDIAN_VAULT/);
    disabled.stop();
    const { vault } = await fixture(t);
    const unsafe = new ObsidianIndex({
        vaultPath: vault,
        cachePath: path.join(vault, "cache.json"),
    });
    t.after(() => unsafe.stop());
    await assert.rejects(unsafe.refresh());
    await assert.rejects(unsafe.refresh());
    await assert.rejects(readFile(path.join(vault, "cache.json")), { code: "ENOENT" });
});

test("busca ignora diretórios ocultos, junction externa, arquivo grande e traversal", async (t) => {
    const { directory, vault, index } = await fixture(t);
    const outside = path.join(directory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "Secret.md"), "# Secret\nfora");
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian", "Private.md"), "# Private");
    await symlink(outside, path.join(vault, "Linked"), "junction");
    await writeFile(path.join(vault, "Large.md"), "x".repeat(262_145));
    await writeFile(path.join(vault, "Normal.md"), "# Normal");
    await index.refresh();
    assert.equal(index.status().notes, 1);
    assert.equal(index.status().state, "partial");
    assert.equal((await index.search("Secret")).items.length, 0);
    await assert.rejects(index.read("../outside/Secret.md"));
});

test("cancelamento de caller não encerra índice compartilhado; stop impede novos trabalhos", async (t) => {
    const { vault, index } = await fixture(t);
    await writeFile(path.join(vault, "Note.md"), "# Note");
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(index.search("Note", 5, aborted.signal), { name: "AbortError" });
    await index.refresh();
    assert.equal((await index.search("Note")).items.length, 1);
    index.stop();
    await assert.rejects(index.refresh(), { name: "AbortError" });
});

test("cache por junction não escreve no vault e profundidade limitada é reportada como parcial", async (t) => {
    const { directory, vault, index } = await fixture(t);
    await symlink(vault, path.join(directory, "cache-link"), "junction");
    const unsafe = new ObsidianIndex({
        vaultPath: vault,
        cachePath: path.join(directory, "cache-link", "cache.json"),
    });
    t.after(() => unsafe.stop());
    await assert.rejects(unsafe.refresh());
    await assert.rejects(readFile(path.join(vault, "cache.json")), { code: "ENOENT" });
    const deep = path.join(vault, ...Array.from({ length: 17 }, () => "a"));
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "Deep.md"), "# Deep");
    await writeFile(path.join(vault, "Note.md"), "# Note");
    await index.refresh();
    assert.equal(index.status().state, "partial");
    assert.equal(index.status().notes, 1);
});

test("benchmark local: 500 notas, refresh quente reutiliza conteúdo e busca usa índice", async (t) => {
    const { vault, index } = await fixture(t);
    for (let i = 0; i < 500; i += 25) {
        await Promise.all(
            Array.from({ length: 25 }, (_, j) =>
                writeFile(
                    path.join(vault, `Nota-${i + j}.md`),
                    `---\ntags: [projetos]\n---\n# Nota ${i + j}\n${"Projeto TypeScript com links [[Nota-0]]. ".repeat(30)}`,
                ),
            ),
        );
    }
    await index.refresh();
    const cold = index.status();
    assert.equal(cold.readFiles, 500);
    await index.refresh();
    const warm = index.status();
    assert.equal(warm.readFiles, 0);
    assert.equal(warm.reusedFiles, 500);
    const started = performance.now();
    assert.equal((await index.search("TypeScript")).items.length, 5);
    t.diagnostic(
        `500 notas: cold_refresh=${cold.durationMs}ms, warm_refresh=${warm.durationMs}ms, warm_search=${Math.round(performance.now() - started)}ms; leituras Markdown 500 → 0.`,
    );
});
