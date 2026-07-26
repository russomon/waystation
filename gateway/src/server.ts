import "./env.js"; // MUST be first — loads .env before s3.ts reads process.env
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { allowedOrigins, authBanner, authEnabled } from "./auth.js";
import { dbPathLabel } from "./db.js";
import { api } from "./routes.js";

const app = new Hono();

// CORS is registered BEFORE the API routes on purpose. Hono's cors() answers an
// OPTIONS preflight with 204 and returns WITHOUT calling next(), so a preflight
// can never reach the session gate. If auth ran first, preflight would 401 and
// the browser would never send the real request — the classic credentialed-CORS
// failure.
//
// Exact origins, never "*": a wildcard is not merely bad practice with
// credentials — browsers reject it outright alongside
// Access-Control-Allow-Credentials.
app.use(
  "/api/*",
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type"],
    maxAge: 600,
  }),
);
app.route("/api", api);
app.get("/", (c) => c.text("waystation gateway"));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  // Configuration disclosure only — never a code, hash, token, or secret.
  console.log(`gateway listening on :${port}`);
  console.log(`  ${authBanner()}`);
  console.log(`  origins: ${allowedOrigins.join(", ")}`);
  console.log(`  state: ${dbPathLabel}`);
  if (!authEnabled) console.log("  WARNING: sender authentication is OFF (development mode)");
});
