#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const entryPoint = path.join(projectRoot, "apps", "core", "dist", "src", "index.js");
const environmentFile = path.join(projectRoot, "ultron.env.cmd");

if (!existsSync(entryPoint)) {
    console.error("Build do Ultron não encontrado. Execute `npm run build` na pasta do projeto.");
    process.exit(1);
}

const childEnvironment = { ...process.env, ULTRON_ROOT: projectRoot };

if (existsSync(environmentFile)) {
    for (const line of readFileSync(environmentFile, "utf8").split(/\r?\n/)) {
        const setting = line.match(/^\s*set\s+"([^"=]+)=(.*)"\s*$/i);
        if (!setting) continue;
        const [, name, rawValue] = setting;
        childEnvironment[name] = rawValue.replace(/%([^%]+)%/g, (match, variable) => {
            return childEnvironment[variable] ?? match;
        });
    }
}

const child = spawn(
    process.execPath,
    [entryPoint, ...process.argv.slice(2)],
    {
        cwd: projectRoot,
        env: childEnvironment,
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
