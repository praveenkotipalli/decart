import { Engine } from "./Engine";

/** One engine per page, created outside React so StrictMode remounts don't duplicate it. */
export const engine = new Engine();

if (import.meta.env.DEV || new URLSearchParams(location.search).has("qa")) {
  (window as unknown as { __domain: unknown }).__domain = {
    state: () => engine.debugState(),
    status: () => engine.status.get(),
    probe: (points: { x: number; y: number }[]) => engine.probe(points),
  };
}
