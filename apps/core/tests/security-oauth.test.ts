import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
    OAuth2DesktopClient,
    createPkceChallenge,
    createPkceVerifier,
} from "../src/security/oauth2-desktop.ts";
import {
    InMemorySecretStore,
    WindowsDpapiSecretStore,
    type DataProtector,
} from "../src/security/secret-store.ts";

class TestProtector implements DataProtector {
    readonly id = "test-protector";

    async protect(plaintext: string): Promise<string> {
        return `cipher:${Buffer.from(plaintext, "utf8").toString("base64")}`;
    }

    async unprotect(ciphertext: string): Promise<string> {
        assert.match(ciphertext, /^cipher:/);
        return Buffer.from(ciphertext.slice("cipher:".length), "base64").toString("utf8");
    }
}

test("SecretStore persiste somente o valor protegido e faz escrita/leitura atômica", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ultron-secret-test-"));
    const filePath = path.join(directory, "secrets.json");
    const store = new WindowsDpapiSecretStore({
        filePath,
        protector: new TestProtector(),
    });

    try {
        await store.set("google.oauth", "refresh-token-super-secreto");
        const file = await readFile(filePath, "utf8");

        assert.equal(file.includes("refresh-token-super-secreto"), false);
        assert.equal(await store.get("google.oauth"), "refresh-token-super-secreto");
        assert.equal(await store.delete("google.oauth"), true);
        assert.equal(await store.get("google.oauth"), null);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test("PKCE usa verifier aleatório e challenge SHA-256 base64url", () => {
    const first = createPkceVerifier();
    const second = createPkceVerifier();
    assert.notEqual(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{43,128}$/);
    assert.match(createPkceChallenge(first), /^[A-Za-z0-9_-]{43}$/);
});

test("OAuth desktop valida state, troca PKCE e preserva refresh token", async () => {
    const store = new InMemorySecretStore({ insecurePurpose: "tests-only" });
    const tokenRequests: URLSearchParams[] = [];
    const transport = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
        const form = new URLSearchParams(String(init?.body ?? ""));
        tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
            return jsonResponse({
                access_token: "access-one",
                refresh_token: "refresh-one",
                token_type: "Bearer",
                expires_in: 1,
                scope: "mail.read tasks.read",
            });
        }
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "refresh-one");
        return jsonResponse({
            access_token: "access-two",
            token_type: "Bearer",
            expires_in: 3600,
        });
    };
    const oauth = new OAuth2DesktopClient({
        clientId: "desktop-client-id",
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        scopes: ["mail.read", "tasks.read"],
        tokenSecretKey: "test.oauth.tokens",
    }, store, transport);

    let authorizationUrl: URL | undefined;
    const initial = await oauth.authorizeInteractive({
        timeoutMs: 5_000,
        openAuthorizationUrl: async url => {
            authorizationUrl = url;
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", url.searchParams.get("state")!);
            callback.searchParams.set("code", "authorization-code");
            const response = await fetch(callback);
            assert.equal(response.status, 200);
        },
    });

    assert.equal(initial.authorized, true);
    assert.equal(initial.canRefresh, true);
    assert.equal(authorizationUrl?.hostname, "accounts.example.test");
    assert.equal(authorizationUrl?.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorizationUrl?.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]+$/);
    assert.match(tokenRequests[0]?.get("code_verifier") ?? "", /^[A-Za-z0-9_-]{43,128}$/);

    // expires_in=1 is below the default minimum validity and therefore refreshes.
    assert.equal(await oauth.getAccessToken(), "access-two");
    assert.equal((await oauth.getAuthorizationState()).canRefresh, true);
    assert.equal(tokenRequests.length, 2);
});

test("falha ao abrir o navegador cancela imediatamente a espera do callback OAuth", async () => {
    const store = new InMemorySecretStore({ insecurePurpose: "tests-only" });
    const oauth = new OAuth2DesktopClient({
        clientId: "desktop-client",
        scopes: ["mail.read"],
        authorizationEndpoint: "https://accounts.example.test/authorize",
        tokenEndpoint: "https://accounts.example.test/token",
        redirectPath: "/oauth/callback",
        tokenSecretKey: "oauth.failure",
    }, store, async () => {
        throw new Error("o endpoint de token não deveria ser chamado");
    });
    const browserError = new Error("navegador indisponível");
    const lateUnhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
        lateUnhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
        const startedAt = performance.now();
        await assert.rejects(
            oauth.authorizeInteractive({
                timeoutMs: 1_000,
                openAuthorizationUrl: async () => {
                    throw browserError;
                },
            }),
            browserError,
        );

        assert.ok(
            performance.now() - startedAt < 500,
            "a falha do navegador não deve aguardar o timeout do callback",
        );
        await delay(1_100);
        assert.deepEqual(lateUnhandledRejections, []);
        assert.equal((await oauth.getAuthorizationState()).authorized, false);
    } finally {
        process.off("unhandledRejection", recordUnhandledRejection);
    }
});

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}
