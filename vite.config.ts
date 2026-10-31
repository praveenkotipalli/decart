import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5199),
    proxy: {
      // The browser never talks to Decart's token endpoint directly: the local
      // server holds the API key and mints short-lived client tokens.
      "/api": { target: `http://localhost:${API_PORT}`, changeOrigin: false },
    },
  },
  preview: { port: 4199 },
  build: { target: "es2022", sourcemap: true },
});
