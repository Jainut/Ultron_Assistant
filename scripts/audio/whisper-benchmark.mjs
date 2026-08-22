#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..", "..");
const DEFAULT_MANIFEST = path.join(SCRIPT_DIRECTORY, "whisper-benchmark.manifest.json");

export function normalizeWords(value) {
    return String(value ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLocaleLowerCase("pt-BR")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

export function wordErrorStats(reference, hypothesis) {
    const expected = normalizeWords(reference);
    const actual = normalizeWords(hypothesis);
    const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);

    for (let row = 1; row <= expected.length; row += 1) {
        const current = [row];
        for (let column = 1; column <= actual.length; column += 1) {
            const substitutionCost = expected[row - 1] === actual[column - 1] ? 0 : 1;
            current[column] = Math.min(
                current[column - 1] + 1,
                previous[column] + 1,
                previous[column - 1] + substitutionCost,
            );
        }
        previous.splice(0, previous.length, ...current);
    }

    const edits = previous[actual.length] ?? expected.length;
    return {
        edits,
        referenceWords: expected.length,
        hypothesisWords: actual.length,
        wer: expected.length === 0 ? null : edits / expected.length,
    };
}

export function criticalTermStats(terms, hypothesis) {
    const words = normalizeWords(hypothesis);
    const hits = [];
    const misses = [];
    for (const term of terms ?? []) {
        const termWords = normalizeWords(term);
        const found = termWords.length > 0 && containsSequence(words, termWords);
        (found ? hits : misses).push(term);
    }
    const total = hits.length + misses.length;
    return {
        hits,
        misses,
        recall: total === 0 ? null : hits.length / total,
    };
}

export function parseWhisperDiagnostics(stderr) {
    const timing = (label) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = new RegExp(
            `whisper_print_timings:\\s+${escaped}\\s*=\\s*([\\d.]+) ms`,
            "i",
        ).exec(stderr);
        return match?.[1] === undefined ? null : Number(match[1]);
    };
    const duration = /\([^\r\n)]*?,\s*([\d.]+)\s+sec\)[^\r\n]*task = transcribe/i.exec(stderr);
    const gpu = /ggml_vulkan:\s*\d+\s*=\s*([^|\r\n]+)/i.exec(stderr);
    const modelMemory = /Vulkan\d+ total size\s*=\s*([\d.]+) MB/i.exec(stderr);
    const totalMs = timing("total time");
    const loadMs = timing("load time");
    return {
        audioDurationSeconds: duration?.[1] === undefined ? null : Number(duration[1]),
        device: gpu?.[1]?.trim() ?? null,
        modelGpuMiB: modelMemory?.[1] === undefined ? null : Number(modelMemory[1]),
        loadMs,
        melMs: timing("mel time"),
        sampleMs: timing("sample time"),
        encodeMs: timing("encode time"),
        decodeMs: timing("decode time"),
        batchedDecodeMs: timing("batchd time"),
        promptMs: timing("prompt time"),
        totalMs,
        processingExcludingLoadMs: totalMs === null || loadMs === null
            ? null
            : round(Math.max(0, totalMs - loadMs)),
    };
}

export function median(values) {
    const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (finite.length === 0) return null;
    const middle = Math.floor(finite.length / 2);
    return finite.length % 2 === 0
        ? (finite[middle - 1] + finite[middle]) / 2
        : finite[middle];
}

export async function inventory(options) {
    const manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
    const root = path.resolve(options.root);
    const cliCandidates = [...new Set([
        manifest.cli,
        "services/speech-whisper/build/bin/whisper-cli.exe",
        "services/speech-whisper/build/bin/main.exe",
    ].filter(Boolean))];
    const cli = await firstExisting(root, cliCandidates);
    const selected = options.models === null
        ? null
        : new Set(options.models);
    const models = [];
    for (const definition of manifest.models ?? []) {
        if (selected && !selected.has(definition.id)) continue;
        const file = await firstExisting(root, definition.paths ?? []);
        models.push({
            id: definition.id,
            available: file !== null,
            path: file,
            bytes: file === null ? null : (await stat(file)).size,
            searched: (definition.paths ?? []).map(candidate => resolveFrom(root, candidate)),
        });
    }
    const samples = [];
    for (const definition of manifest.samples ?? []) {
        const file = resolveFrom(root, definition.audio);
        const available = await exists(file);
        samples.push({
            ...definition,
            available,
            path: file,
            bytes: available ? (await stat(file)).size : null,
            labeled: typeof definition.reference === "string",
        });
    }
    return {
        manifest,
        cli: {
            available: cli !== null,
            path: cli,
            searched: cliCandidates.map(candidate => resolveFrom(root, candidate)),
        },
        models,
        samples,
    };
}

export async function runBenchmark(options) {
    const found = await inventory(options);
    const report = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        host: {
            platform: process.platform,
            architecture: process.arch,
            logicalCpuCount: os.cpus().length,
            cpu: os.cpus()[0]?.model ?? null,
        },
        configuration: {
            root: path.resolve(options.root),
            manifest: options.manifestPath,
            runsPerModelSample: options.runs,
            threads: options.threads,
            beamSize: options.beamSize,
            bestOf: options.bestOf,
            temperature: options.temperature,
            noSpeechThreshold: options.noSpeechThreshold,
            gpu: options.gpu,
            timeoutMs: options.timeoutMs,
            networkDownloads: false,
        },
        inventory: {
            cli: found.cli,
            models: found.models,
            samples: found.samples.map(sample => ({
                id: sample.id,
                path: sample.path,
                available: sample.available,
                bytes: sample.bytes,
                language: sample.language,
                labeled: sample.labeled,
                criticalTerms: sample.criticalTerms ?? [],
            })),
        },
        runs: [],
        summaries: [],
        caveats: [
            "Cada execução do CLI recarrega o modelo; loadMs não representa o servidor persistente do Ultron.",
            "processingExcludingLoadMs é uma aproximação calculada como totalMs - loadMs, não uma medição HTTP do servidor persistente.",
            "WER só é calculado para WAVs com reference humana no manifesto.",
            "Nenhum modelo ou gravação é baixado por este harness.",
        ],
    };

    if (!options.inventoryOnly && found.cli.path !== null) {
        for (const model of found.models) {
            if (!model.available || model.path === null) continue;
            for (const sample of found.samples) {
                if (!sample.available) continue;
                for (let iteration = 1; iteration <= options.runs; iteration += 1) {
                    process.stderr.write(
                        `[BENCH] ${model.id} / ${sample.id} / ${iteration}/${options.runs}\n`,
                    );
                    report.runs.push(await runOne({
                        cli: found.cli.path,
                        model,
                        sample,
                        iteration,
                        options,
                        globalPromptTerms: found.manifest.promptTerms ?? [],
                    }));
                }
            }
        }
    }
    report.summaries = summarize(found.models, report.runs);
    return report;
}

async function runOne({ cli, model, sample, iteration, options, globalPromptTerms }) {
    const promptTerms = [...new Set([
        ...globalPromptTerms,
        ...(sample.promptTerms ?? []),
    ])];
    const args = [
        "-m", model.path,
        "-f", sample.path,
        "-l", sample.language ?? "pt",
        "-t", String(options.threads),
        "-bs", String(options.beamSize),
        "-bo", String(options.bestOf),
        "-tp", String(options.temperature),
        "-nth", String(options.noSpeechThreshold),
        "-nt",
        "-fa",
        "-sns",
    ];
    if (!options.gpu) args.push("-ng");
    if (promptTerms.length > 0) {
        args.push("--prompt", promptTerms.join(", "), "--carry-initial-prompt");
    }

    const startedAt = performance.now();
    const processResult = await spawnCaptured(cli, args, options.timeoutMs);
    const wallMs = performance.now() - startedAt;
    const transcript = processResult.stdout.replace(/\s+/g, " ").trim();
    const diagnostics = parseWhisperDiagnostics(processResult.stderr);
    const words = sample.reference === undefined
        ? null
        : wordErrorStats(sample.reference, transcript);
    const terms = criticalTermStats(sample.criticalTerms ?? [], transcript);
    return {
        model: model.id,
        sample: sample.id,
        iteration,
        status: processResult.exitCode === 0 && !processResult.timedOut
            ? "completed"
            : processResult.timedOut ? "timeout" : "failed",
        exitCode: processResult.exitCode,
        wallMs: round(wallMs),
        transcript: options.omitTranscripts ? undefined : transcript,
        diagnostics,
        wordError: words,
        criticalTerms: terms,
        error: processResult.exitCode === 0 && !processResult.timedOut
            ? undefined
            : processResult.stderr.slice(-2_000),
    };
}

function summarize(models, runs) {
    return models.map(model => {
        if (!model.available) {
            return { model: model.id, status: "model-not-found", runs: 0 };
        }
        const completed = runs.filter(run =>
            run.model === model.id && run.status === "completed"
        );
        const labeled = completed.filter(run => run.wordError !== null);
        const referenceWords = labeled.reduce(
            (total, run) => total + run.wordError.referenceWords,
            0,
        );
        const edits = labeled.reduce((total, run) => total + run.wordError.edits, 0);
        const expectedTerms = completed.reduce(
            (total, run) => total + run.criticalTerms.hits.length + run.criticalTerms.misses.length,
            0,
        );
        const termHits = completed.reduce(
            (total, run) => total + run.criticalTerms.hits.length,
            0,
        );
        return {
            model: model.id,
            status: completed.length > 0 ? "measured" : "not-measured",
            runs: completed.length,
            medianWallMs: roundNullable(median(completed.map(run => run.wallMs))),
            medianLoadMs: roundNullable(median(
                completed.map(run => run.diagnostics.loadMs),
            )),
            medianProcessingExcludingLoadMs: roundNullable(median(
                completed.map(run => run.diagnostics.processingExcludingLoadMs),
            )),
            medianRealTimeFactorExcludingLoad: roundNullable(median(
                completed.map(run => {
                    const duration = run.diagnostics.audioDurationSeconds;
                    const processing = run.diagnostics.processingExcludingLoadMs;
                    return duration && processing !== null
                        ? processing / (duration * 1_000)
                        : null;
                }),
            )),
            aggregateWer: referenceWords === 0 ? null : round(edits / referenceWords, 4),
            labeledSamples: new Set(labeled.map(run => run.sample)).size,
            labeledRuns: labeled.length,
            criticalTermRecall: expectedTerms === 0
                ? null
                : round(termHits / expectedTerms, 4),
            criticalTermsExpected: expectedTerms,
        };
    });
}

async function spawnCaptured(executable, args, timeoutMs) {
    return await new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, timeoutMs);
        child.stdout.on("data", chunk => {
            if (stdout.length < 2_000_000) stdout += chunk.toString();
        });
        child.stderr.on("data", chunk => {
            if (stderr.length < 2_000_000) stderr += chunk.toString();
        });
        child.once("error", error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", exitCode => {
            clearTimeout(timer);
            resolve({ stdout, stderr, timedOut, exitCode });
        });
    });
}

function containsSequence(words, sequence) {
    outer: for (let index = 0; index <= words.length - sequence.length; index += 1) {
        for (let offset = 0; offset < sequence.length; offset += 1) {
            if (words[index + offset] !== sequence[offset]) continue outer;
        }
        return true;
    }
    return false;
}

async function firstExisting(root, candidates) {
    for (const candidate of candidates) {
        const resolved = resolveFrom(root, candidate);
        if (await exists(resolved)) return resolved;
    }
    return null;
}

async function exists(file) {
    try {
        return (await stat(file)).isFile();
    } catch {
        return false;
    }
}

function resolveFrom(root, candidate) {
    return path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(root, candidate);
}

function round(value, digits = 2) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function roundNullable(value) {
    return value === null ? null : round(value);
}

function parseArguments(argv) {
    const options = {
        root: DEFAULT_ROOT,
        manifestPath: DEFAULT_MANIFEST,
        models: null,
        runs: 1,
        threads: 4,
        beamSize: 2,
        bestOf: 2,
        temperature: 0,
        noSpeechThreshold: 0.5,
        gpu: true,
        timeoutMs: 120_000,
        output: null,
        inventoryOnly: false,
        omitTranscripts: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined) throw new Error(`Valor ausente para ${argument}.`);
            index += 1;
            return value;
        };
        switch (argument) {
            case "--root": options.root = path.resolve(next()); break;
            case "--manifest": options.manifestPath = path.resolve(next()); break;
            case "--models": options.models = next().split(",").map(value => value.trim()).filter(Boolean); break;
            case "--runs": options.runs = positiveInteger(next(), "runs"); break;
            case "--threads": options.threads = positiveInteger(next(), "threads"); break;
            case "--beam-size": options.beamSize = positiveInteger(next(), "beam-size"); break;
            case "--best-of": options.bestOf = positiveInteger(next(), "best-of"); break;
            case "--temperature": options.temperature = Number(next()); break;
            case "--no-speech-threshold": options.noSpeechThreshold = Number(next()); break;
            case "--timeout-ms": options.timeoutMs = positiveInteger(next(), "timeout-ms"); break;
            case "--output": options.output = path.resolve(next()); break;
            case "--no-gpu": options.gpu = false; break;
            case "--inventory-only": options.inventoryOnly = true; break;
            case "--omit-transcripts": options.omitTranscripts = true; break;
            case "--help": printHelp(); process.exit(0); break;
            default: throw new Error(`Argumento desconhecido: ${argument}`);
        }
    }
    return options;
}

function positiveInteger(value, label) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new Error(`${label} deve ser inteiro positivo.`);
    }
    return number;
}

function printHelp() {
    process.stdout.write(`Uso: node scripts/audio/whisper-benchmark.mjs [opções]\n\n`);
    process.stdout.write(`  --inventory-only          só detecta CLI, modelos e WAVs\n`);
    process.stdout.write(`  --models small,medium     seleciona modelos do manifesto\n`);
    process.stdout.write(`  --runs N                  repetições por modelo/WAV\n`);
    process.stdout.write(`  --manifest FILE           manifesto JSON configurável\n`);
    process.stdout.write(`  --output FILE             salva também o relatório JSON\n`);
    process.stdout.write(`  --no-gpu                  força CPU\n`);
    process.stdout.write(`  --omit-transcripts        omite transcrições do relatório\n`);
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const report = await runBenchmark(options);
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output !== null) {
        await mkdir(path.dirname(options.output), { recursive: true });
        await writeFile(options.output, serialized, "utf8");
    }
    process.stdout.write(serialized);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
    main().catch(error => {
        process.stderr.write(`[BENCH] ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
