import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface SecretStoreContext {
    readonly signal?: AbortSignal;
}

export interface SecretStore {
    get(key: string, context?: SecretStoreContext): Promise<string | null>;
    set(key: string, value: string, context?: SecretStoreContext): Promise<void>;
    delete(key: string, context?: SecretStoreContext): Promise<boolean>;
}

export class SecretStoreError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "SecretStoreError";
    }
}

export interface DataProtector {
    readonly id: string;
    protect(plaintext: string, context?: SecretStoreContext): Promise<string>;
    unprotect(ciphertext: string, context?: SecretStoreContext): Promise<string>;
}

const POWERSHELL_PROTECT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputText = [Console]::In.ReadToEnd()
$plainBytes = [Text.Encoding]::UTF8.GetBytes($inputText)
$entropy = [Convert]::FromBase64String($env:ULTRON_DPAPI_ENTROPY)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$protected = [System.Security.Cryptography.ProtectedData]::Protect($plainBytes, $entropy, $scope)
[Array]::Clear($plainBytes, 0, $plainBytes.Length)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const POWERSHELL_UNPROTECT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cipherText = [Console]::In.ReadToEnd()
$protected = [Convert]::FromBase64String($cipherText)
$entropy = [Convert]::FromBase64String($env:ULTRON_DPAPI_ENTROPY)
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($protected, $entropy, $scope)
try {
    [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plainBytes))
} finally {
    [Array]::Clear($plainBytes, 0, $plainBytes.Length)
}
`;

export interface WindowsDpapiProtectorOptions {
    readonly powershellPath?: string;
    readonly applicationEntropy?: string;
}

/** Uses Windows DPAPI CurrentUser. Secrets never appear in process arguments. */
export class WindowsDpapiProtector implements DataProtector {
    readonly id = "windows-dpapi-current-user-v1";

    private readonly powershellPath: string;
    private readonly entropy: string;

    constructor(options: WindowsDpapiProtectorOptions = {}) {
        if (process.platform !== "win32") {
            throw new SecretStoreError("Windows DPAPI só está disponível no Windows.");
        }

        this.powershellPath = options.powershellPath ?? "powershell.exe";
        this.entropy = Buffer.from(
            options.applicationEntropy ?? "Ultron.SecretStore.v1",
            "utf8",
        ).toString("base64");
    }

    protect(plaintext: string, context?: SecretStoreContext): Promise<string> {
        return this.runPowerShell(POWERSHELL_PROTECT, plaintext, context);
    }

    unprotect(ciphertext: string, context?: SecretStoreContext): Promise<string> {
        return this.runPowerShell(POWERSHELL_UNPROTECT, ciphertext, context);
    }

    private async runPowerShell(
        script: string,
        input: string,
        context?: SecretStoreContext,
    ): Promise<string> {
        context?.signal?.throwIfAborted();

        return await new Promise<string>((resolve, reject) => {
            const child = spawn(
                this.powershellPath,
                ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                {
                    env: {
                        ...process.env,
                        ULTRON_DPAPI_ENTROPY: this.entropy,
                    },
                    windowsHide: true,
                    stdio: ["pipe", "pipe", "pipe"],
                    signal: context?.signal,
                },
            );
            const stdout: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;

            const fail = (message: string, cause?: unknown): void => {
                if (settled) return;
                settled = true;
                reject(new SecretStoreError(message, { cause }));
            };

            child.stdout.on("data", (chunk: Buffer) => {
                outputBytes += chunk.length;
                if (outputBytes > 16 * 1024 * 1024) {
                    child.kill();
                    fail("A resposta do DPAPI excedeu o limite de segurança.");
                    return;
                }
                stdout.push(chunk);
            });

            // Drain stderr without propagating it: an external process must not
            // accidentally copy sensitive input into application logs/errors.
            child.stderr.resume();
            child.on("error", error => fail("Não foi possível executar o DPAPI.", error));
            child.on("close", code => {
                if (settled) return;
                if (code !== 0) {
                    fail("O Windows DPAPI recusou a operação.");
                    return;
                }
                settled = true;
                resolve(Buffer.concat(stdout).toString("utf8"));
            });

            child.stdin.on("error", error => {
                if (!settled) fail("Não foi possível enviar dados ao DPAPI.", error);
            });
            child.stdin.end(input, "utf8");
        });
    }
}

interface SecretFileEntry {
    readonly protector: string;
    readonly protectedValue: string;
    readonly updatedAt: string;
}

interface SecretFile {
    readonly version: 1;
    readonly entries: Readonly<Record<string, SecretFileEntry>>;
}

export interface WindowsDpapiSecretStoreOptions {
    readonly filePath?: string;
    readonly protector?: DataProtector;
}

export class WindowsDpapiSecretStore implements SecretStore {
    readonly filePath: string;

    private readonly protector: DataProtector;
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(options: WindowsDpapiSecretStoreOptions = {}) {
        this.filePath = options.filePath ?? defaultSecretFilePath();
        this.protector = options.protector ?? new WindowsDpapiProtector();
    }

    get(key: string, context?: SecretStoreContext): Promise<string | null> {
        validateSecretKey(key);
        return this.enqueue(async () => {
            context?.signal?.throwIfAborted();
            const file = await this.readSecretFile();
            const entry = file.entries[key];
            if (!entry) return null;
            if (entry.protector !== this.protector.id) {
                throw new SecretStoreError(
                    `Protector incompatível para o secret ${key}.`,
                );
            }
            return await this.protector.unprotect(entry.protectedValue, context);
        });
    }

    set(key: string, value: string, context?: SecretStoreContext): Promise<void> {
        validateSecretKey(key);
        return this.enqueue(async () => {
            context?.signal?.throwIfAborted();
            const protectedValue = await this.protector.protect(value, context);
            const current = await this.readSecretFile();
            await this.writeSecretFile({
                version: 1,
                entries: {
                    ...current.entries,
                    [key]: {
                        protector: this.protector.id,
                        protectedValue,
                        updatedAt: new Date().toISOString(),
                    },
                },
            });
        });
    }

    delete(key: string, context?: SecretStoreContext): Promise<boolean> {
        validateSecretKey(key);
        return this.enqueue(async () => {
            context?.signal?.throwIfAborted();
            const current = await this.readSecretFile();
            if (!current.entries[key]) return false;

            const entries = { ...current.entries };
            delete entries[key];
            await this.writeSecretFile({ version: 1, entries });
            return true;
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }

    private async readSecretFile(): Promise<SecretFile> {
        let raw: string;
        try {
            raw = await readFile(this.filePath, "utf8");
        } catch (error) {
            if (isNodeError(error) && error.code === "ENOENT") {
                return { version: 1, entries: {} };
            }
            throw new SecretStoreError("Não foi possível ler o cofre de secrets.", {
                cause: error,
            });
        }

        try {
            const parsed: unknown = JSON.parse(raw);
            if (!isSecretFile(parsed)) {
                throw new TypeError("Formato desconhecido.");
            }
            return parsed;
        } catch (error) {
            throw new SecretStoreError("O cofre de secrets está corrompido.", {
                cause: error,
            });
        }
    }

    private async writeSecretFile(file: SecretFile): Promise<void> {
        const directory = path.dirname(this.filePath);
        const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
        await mkdir(directory, { recursive: true });

        try {
            await writeFile(temporaryPath, JSON.stringify(file, null, 2), {
                encoding: "utf8",
                mode: 0o600,
            });
            await rename(temporaryPath, this.filePath);
        } catch (error) {
            await unlink(temporaryPath).catch(() => undefined);
            throw new SecretStoreError("Não foi possível persistir o cofre de secrets.", {
                cause: error,
            });
        }
    }
}

/**
 * Plaintext in-memory store. It exists only for unit tests and ephemeral test
 * harnesses; callers must opt into its insecurity explicitly.
 */
export class InMemorySecretStore implements SecretStore {
    private readonly values = new Map<string, string>();

    constructor(options: { readonly insecurePurpose: "tests-only" }) {
        if (options.insecurePurpose !== "tests-only") {
            throw new SecretStoreError("InMemorySecretStore é exclusivo para testes.");
        }
    }

    async get(key: string, context?: SecretStoreContext): Promise<string | null> {
        context?.signal?.throwIfAborted();
        validateSecretKey(key);
        return this.values.get(key) ?? null;
    }

    async set(key: string, value: string, context?: SecretStoreContext): Promise<void> {
        context?.signal?.throwIfAborted();
        validateSecretKey(key);
        this.values.set(key, value);
    }

    async delete(key: string, context?: SecretStoreContext): Promise<boolean> {
        context?.signal?.throwIfAborted();
        validateSecretKey(key);
        return this.values.delete(key);
    }
}

export function createDefaultSecretStore(
    options: Omit<WindowsDpapiSecretStoreOptions, "protector"> = {},
): SecretStore {
    if (process.platform !== "win32") {
        throw new SecretStoreError(
            "Nenhum cofre seguro padrão está configurado nesta plataforma. "
            + "Configure um SecretStore seguro explicitamente.",
        );
    }
    return new WindowsDpapiSecretStore(options);
}

function defaultSecretFilePath(): string {
    const localData = process.env.LOCALAPPDATA?.trim();
    const base = localData || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Ultron", "secrets.dpapi.json");
}

function validateSecretKey(key: string): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) {
        throw new SecretStoreError("Identificador de secret inválido.");
    }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

function isSecretFile(value: unknown): value is SecretFile {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<SecretFile>;
    if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
        return false;
    }

    return Object.values(candidate.entries).every(entry => (
        Boolean(entry)
        && typeof entry === "object"
        && typeof entry.protector === "string"
        && typeof entry.protectedValue === "string"
        && typeof entry.updatedAt === "string"
    ));
}
