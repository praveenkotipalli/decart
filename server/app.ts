import express, { type Request, type Response } from "express";
import { existsSync } from "node:fs";
import type { ServerConfig } from "./config.js";
import { RateLimiter } from "./rateLimit.js";

/** The slice of the Decart SDK the server uses — injectable so tests never need a real key. */
export interface TokenMinter {
  create(options: {
    expiresIn: number;
    allowedModels: string[];
    allowedOrigins?: string[];
    constraints: { realtime: { maxSessionDuration: number } };
    metadata: Record<string, unknown>;
  }): Promise<{ apiKey: string; expiresAt: string }>;
}

export interface AppDeps {
  tokens: TokenMinter | null;
  fetch: typeof fetch;
  staticDir?: string;
  log?: (msg: string) => void;
}

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
// What Decart accepts in allowedOrigins: lowercase scheme+host, optional non-default port, nothing else.
const CANONICAL_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$|^https?:\/\/\[[0-9a-f:]+\](:\d{1,5})?$/;

export function isCanonicalOrigin(origin: string): boolean {
  if (!CANONICAL_ORIGIN.test(origin)) return false;
  return !/^https:\/\/.*:443$/.test(origin) && !/^http:\/\/.*:80$/.test(origin);
}

export function createApp(config: ServerConfig, deps: AppDeps) {
  const app = express();
  const log = deps.log ?? ((m: string) => console.log(m));
  const limiter = new RateLimiter(config.tokenRateLimitPerMinute);
  let quotaCache: { at: number; body: unknown; status: number } | null = null;

  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    next();
  });

  const originAllowed = (origin: string | undefined) =>
    !origin || LOCAL_ORIGIN.test(origin) || config.allowedOrigins.includes(origin);

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      decart: {
        configured: Boolean(deps.tokens),
        defaultModel: config.defaultModel,
        allowedModels: config.allowedModels,
        allowFast: config.allowFast,
        maxSessionSeconds: config.maxSessionSeconds,
      },
    });
  });

  app.post("/api/realtime-token", async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (!originAllowed(origin)) {
      res.status(403).json({ error: "ORIGIN_NOT_ALLOWED", message: `Origin ${origin} may not mint tokens.` });
      return;
    }
    if (!deps.tokens) {
      res.status(503).json({
        error: "DECART_NOT_CONFIGURED",
        message: "Set DECART_API_KEY in .env and restart the server.",
      });
      return;
    }
    const retryAfter = limiter.hit(req.ip ?? "unknown");
    if (retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "RATE_LIMITED", message: `Too many token requests. Retry in ${retryAfter}s.` });
      return;
    }

    const requested = typeof req.body?.model === "string" ? req.body.model : config.defaultModel;
    if (!config.allowedModels.includes(requested)) {
      res.status(400).json({ error: "MODEL_NOT_ALLOWED", message: `Model ${requested} is not enabled on this server.` });
      return;
    }

    try {
      const token = await deps.tokens.create({
        expiresIn: config.tokenTtlSeconds,
        allowedModels: [requested],
        // Pin the token to the page that asked for it (browser-enforced, defence in depth).
        ...(origin && isCanonicalOrigin(origin) ? { allowedOrigins: [origin] } : {}),
        constraints: { realtime: { maxSessionDuration: config.maxSessionSeconds } },
        metadata: { app: "domain-hand-portal" },
      });
      res.json({ apiKey: token.apiKey, expiresAt: token.expiresAt, model: requested });
    } catch (err) {
      const code = (err as { code?: string })?.code ?? "TOKEN_CREATE_ERROR";
      log(`[token] mint failed: ${code} ${(err as Error)?.message ?? err}`);
      const status = /INVALID_API_KEY|401/.test(`${code} ${(err as Error)?.message}`) ? 401 : 502;
      res.status(status).json({
        error: status === 401 ? "INVALID_API_KEY" : "TOKEN_CREATE_FAILED",
        message:
          status === 401
            ? "Decart rejected the server API key. Check DECART_API_KEY."
            : "Could not mint a Decart client token. See server log.",
      });
    }
  });

  // Concurrent-session quota, for the status rail. Decart asks for <= 1 req/s.
  app.get("/api/realtime-quota", async (_req, res) => {
    if (!config.decartApiKey) {
      res.status(503).json({ error: "DECART_NOT_CONFIGURED" });
      return;
    }
    const now = Date.now();
    if (!quotaCache || now - quotaCache.at > 2000) {
      try {
        const r = await deps.fetch(`${config.decartBaseUrl}/v1/realtime/quota`, {
          headers: { "x-api-key": config.decartApiKey },
        });
        const body = r.ok ? await r.json() : { error: "QUOTA_UNAVAILABLE", status: r.status };
        quotaCache = { at: now, body, status: r.ok ? 200 : 502 };
      } catch {
        quotaCache = { at: now, body: { error: "QUOTA_UNAVAILABLE" }, status: 502 };
      }
    }
    res.status(quotaCache.status).json(quotaCache.body);
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT_FOUND" });
  });

  if (deps.staticDir && existsSync(deps.staticDir)) {
    const dir = deps.staticDir;
    app.use(express.static(dir, { index: "index.html", maxAge: "1h" }));
    app.get("/{*splat}", (_req, res) => res.sendFile("index.html", { root: dir }));
  }

  return app;
}
