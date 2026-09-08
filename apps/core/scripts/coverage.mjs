import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const report = path.resolve(core, "..", "..", "coverage", "core.lcov");
mkdirSync(path.dirname(report), { recursive: true });
const tests = readdirSync(path.join(core, "dist", "tests"))
    .filter(name => name.endsWith(".test.js"))
    .map(name => path.join(core, "dist", "tests", name));
const result = spawnSync(process.execPath, [
    "--test", "--experimental-test-coverage",
    "--test-coverage-include=**/dist/src/**", "--test-coverage-include=**/dist/tools/**",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=lcov", `--test-reporter-destination=${report}`,
    ...tests,
], { cwd: core, stdio: "inherit", windowsHide: true });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
