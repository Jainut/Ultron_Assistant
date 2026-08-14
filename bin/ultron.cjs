#!/usr/bin/env node
const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const entryPoint = path.join(projectRoot, "apps", "core", "dist", "src", "index.js");

if (!existsSync(entryPoint)) {
    console.error("Build do Ultron não encontrado. Execute `npm run build` na pasta do projeto.");
    process.exit(1);
}

const child = spawn(
    process.execPath,
    [entryPoint, ...process.argv.slice(2)],
    {
        cwd: projectRoot,
        env: { ...process.env, ULTRON_ROOT: projectRoot },
        stdio: "inherit",
        windowsHide: false,
    },
);

child.once("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }

    process.exitCode = code ?? 1;
});

child.once("error", (error) => {
    console.error("Não foi possível iniciar o Ultron:", error.message);
    process.exitCode = 1;
});
