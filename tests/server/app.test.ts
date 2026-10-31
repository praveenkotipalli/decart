import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApp, isCanonicalOrigin, type TokenMinter } from "../../server/app";
import { loadConfig } from "../../server/config";

const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

function start(env: Record<string, string>, tokens: TokenMinter | null, fetchImpl: typeof fetch = fetch) {
  const config = loadConfig({ ...env, NODE_ENV: "test" } as NodeJS.ProcessEnv);
  const app = createApp(config, { tokens, fetch: fetchImpl, log: () => {} });
  const server = app.listen(0);
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

function recordingMinter() {
  const calls: Parameters<TokenMinter["create"]>[0][] = [];
  const minter: TokenMinter = {
    create: async (opts) => {
      calls.push(opts);
      return { apiKey: "ek_test_token", expiresAt: "2030-01-01T00:00:00Z" };
    },
  };
  return { minter, calls };
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/realtime-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("server config", () => {
  it("defaults and clamps", () => {
    const c = loadConfig({ DECART_TOKEN_TTL_SECONDS: "99999", DECART_MAX_SESSION_SECONDS: "1" } as NodeJS.ProcessEnv);
    expect(c.tokenTtlSeconds).toBe(3600);
    expect(c.maxSessionSeconds).toBe(10);
    expect(c.defaultModel).toBe("lucy-2.6");
    expect(c.allowedModels).toContain("lucy-2.6");
    expect(c.decartApiKey).toBeNull();
  });

  it("always allows the default model", () => {
    const c = loadConfig({ DECART_MODEL: "lucy-2.5", DECART_ALLOWED_MODELS: "lucy-restyle-2" } as NodeJS.ProcessEnv);
    expect(c.allowedModels).toEqual(["lucy-2.5", "lucy-restyle-2"]);
  });
});

describe("token endpoint", () => {
  it("reports configuration without leaking the key", async () => {
    const base = start({ DECART_API_KEY: "dct_secret_value" }, recordingMinter().minter);
    const res = await fetch(`${base}/api/health`);
    const text = await res.text();
    expect((JSON.parse(text) as { decart: { configured: boolean } }).decart.configured).toBe(true);
    expect(text).not.toContain("dct_secret_value");
  });

  it("answers 503 with guidance when no key is configured", async () => {
    const base = start({}, null);
    const res = await post(base, { model: "lucy-2.6" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("DECART_NOT_CONFIGURED");
  });

  it("mints a short-lived token scoped to the model, origin and a session cap", async () => {
    const { minter, calls } = recordingMinter();
    const base = start({ DECART_API_KEY: "dct_x", DECART_TOKEN_TTL_SECONDS: "60", DECART_MAX_SESSION_SECONDS: "300" }, minter);
    const res = await post(base, { model: "lucy-2.6" }, { Origin: "http://localhost:5199" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ apiKey: "ek_test_token", expiresAt: "2030-01-01T00:00:00Z", model: "lucy-2.6" });
    expect(calls[0]).toMatchObject({
      expiresIn: 60,
      allowedModels: ["lucy-2.6"],
      allowedOrigins: ["http://localhost:5199"],
      constraints: { realtime: { maxSessionDuration: 300 } },
    });
  });

  it("refuses models the server has not enabled", async () => {
    const base = start({ DECART_API_KEY: "dct_x", DECART_ALLOWED_MODELS: "lucy-2.6" }, recordingMinter().minter);
    const res = await post(base, { model: "lucy-vton-3.6" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("MODEL_NOT_ALLOWED");
  });

  it("refuses foreign origins but accepts configured ones", async () => {
    const base = start({ DECART_API_KEY: "dct_x", ALLOWED_ORIGINS: "https://portal.example.com" }, recordingMinter().minter);
    expect((await post(base, {}, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post(base, {}, { Origin: "https://portal.example.com" })).status).toBe(200);
  });

  it("rate-limits token requests per client", async () => {
    const base = start({ DECART_API_KEY: "dct_x", TOKEN_RATE_LIMIT_PER_MINUTE: "2" }, recordingMinter().minter);
    expect((await post(base, {})).status).toBe(200);
    expect((await post(base, {})).status).toBe(200);
    const third = await post(base, {});
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("maps an invalid server key to 401 without echoing details", async () => {
    const failing: TokenMinter = {
      create: async () => {
        throw Object.assign(new Error("401 Unauthorized dct_secret"), { code: "INVALID_API_KEY" });
      },
    };
    const base = start({ DECART_API_KEY: "dct_secret" }, failing);
    const res = await post(base, {});
    const text = await res.text();
    expect(res.status).toBe(401);
    expect(text).not.toContain("dct_secret");
  });
});

describe("quota endpoint", () => {
  it("proxies Decart's quota with the server key and caches it", async () => {
    let calls = 0;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls++;
      expect(url).toBe("https://api.decart.ai/v1/realtime/quota");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("dct_x");
      return new Response(JSON.stringify({ limit: 5, active: 1, remaining: 4 }), { status: 200 });
    }) as typeof fetch;
    const base = start({ DECART_API_KEY: "dct_x" }, recordingMinter().minter, fakeFetch);
    const a = await (await fetch(`${base}/api/realtime-quota`)).json();
    await fetch(`${base}/api/realtime-quota`);
    expect(a).toEqual({ limit: 5, active: 1, remaining: 4 });
    expect(calls).toBe(1);
  });
});

describe("origin canonicalisation", () => {
  it("matches Decart's rules for allowedOrigins", () => {
    expect(isCanonicalOrigin("http://localhost:5199")).toBe(true);
    expect(isCanonicalOrigin("https://app.example.com")).toBe(true);
    expect(isCanonicalOrigin("https://app.example.com/")).toBe(false);
    expect(isCanonicalOrigin("https://app.example.com:443")).toBe(false);
    expect(isCanonicalOrigin("https://EXAMPLE.com")).toBe(false);
  });
});
