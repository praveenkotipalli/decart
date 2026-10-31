import "dotenv/config";
import { createDecartClient } from "@decartai/sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, type TokenMinter } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

let tokens: TokenMinter | null = null;
if (config.decartApiKey) {
  const client = createDecartClient({ apiKey: config.decartApiKey, baseUrl: config.decartBaseUrl });
  tokens = { create: (opts) => client.tokens.create(opts) };
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = createApp(config, {
  tokens,
  fetch,
  staticDir: config.production ? join(root, "dist") : undefined,
});

app.listen(config.port, () => {
  const where = config.production ? `http://localhost:${config.port}` : `API on :${config.port}`;
  console.log(`[server] ${where}`);
  console.log(
    config.decartApiKey
      ? `[server] Decart ready · default ${config.defaultModel} · allowed ${config.allowedModels.join(", ")}`
      : "[server] DECART_API_KEY not set · AI transform disabled, local preview only",
  );
});
