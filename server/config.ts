export interface ServerConfig {
  port: number;
  production: boolean;
  decartApiKey: string | null;
  decartBaseUrl: string;
  defaultModel: string;
  allowedModels: string[];
  tokenTtlSeconds: number;
  maxSessionSeconds: number;
  allowFast: boolean;
  allowedOrigins: string[];
  tokenRateLimitPerMinute: number;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const defaultModel = env.DECART_MODEL?.trim() || "lucy-2.6";
  const allowed = list(env.DECART_ALLOWED_MODELS);
  const allowedModels = allowed.length ? allowed : ["lucy-2.6", "lucy-restyle-2"];
  if (!allowedModels.includes(defaultModel)) allowedModels.unshift(defaultModel);

  return {
    port: int(env.PORT, 8787, 1, 65535),
    production: env.NODE_ENV === "production",
    decartApiKey: env.DECART_API_KEY?.trim() || null,
    decartBaseUrl: (env.DECART_BASE_URL?.trim() || "https://api.decart.ai").replace(/\/+$/, ""),
    defaultModel,
    allowedModels,
    // Decart accepts 1-3600 s for client tokens and >= 10 s for session caps.
    tokenTtlSeconds: int(env.DECART_TOKEN_TTL_SECONDS, 60, 1, 3600),
    maxSessionSeconds: int(env.DECART_MAX_SESSION_SECONDS, 600, 10, 86400),
    allowFast: env.DECART_ALLOW_FAST === "true",
    allowedOrigins: list(env.ALLOWED_ORIGINS),
    tokenRateLimitPerMinute: int(env.TOKEN_RATE_LIMIT_PER_MINUTE, 20, 1, 10000),
  };
}
