import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", windowsHide: true });
if (tracked.status !== 0) throw new Error("Não foi possível listar os arquivos versionados.");
const files = tracked.stdout.split("\0").filter(file => /\.(?:ts|js|mjs|cjs|py|json|md|yml|yaml|cmd)$/.test(file));
const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];
for (const file of files) {
    try { decoder.decode(readFileSync(path.join(root, file))); }
    catch { failures.push(file); }
}
if (failures.length) {
    console.error(`Arquivos inválidos/ilegíveis como UTF-8:\n${failures.join("\n")}`);
    process.exitCode = 1;
} else {
    console.log(`UTF-8 validado em ${files.length} arquivos versionados.`);
}
