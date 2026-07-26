import { defineConfig } from "vite";

// Dev: proxy /api to the gateway so the browser sees one origin (the client's
// default API base is "/api", which this serves).
//
// Build: `base` must match where the release is actually mounted. The hosted
// MVP lives at https://orbitolive.com/waystation/, so assets and the wasm URL
// have to resolve under that subpath — with the default "/" they resolve to the
// site root and 404. Override for a differently-mounted deployment with
// WAYSTATION_PUBLIC_BASE (must start and end with "/").
// Applied to BUILDS ONLY. In dev the app stays at http://localhost:5173/ —
// scripts/dev-up.sh, live-run.sh and live-event-run.sh gate on `curl` against
// that root, and a dev base would 404 it and hang those readiness loops.
const publicBase = process.env.WAYSTATION_PUBLIC_BASE || "/waystation/";

export default defineConfig(({ command }) => ({
  base: command === "build" ? publicBase : "/",
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
}));
