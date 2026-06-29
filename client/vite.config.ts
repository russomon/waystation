import { defineConfig } from "vite";

// Proxy /api to the gateway in dev so the browser sees one origin.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
