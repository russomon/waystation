import "./env.js"; // MUST be first — loads .env before s3.ts reads process.env
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { allowedOrigins, authBanner, authEnabled } from "./auth.js";
import { activeAccessCodeCount } from "./db.js";
import { dbPathLabel } from "./db.js";
import { policyBanner } from "./limits.js";
import { paymentsBanner } from "./payments.js";
import { emailBanner } from "./email.js";
import { purgeBanner, startPurgeLoop } from "./purge.js";
import { api } from "./routes.js";

const app = new Hono();

// Security headers on every response, preflights included. The API serves JSON,
// an SSE stream and redirects — never a page — so the policy can be total:
// nothing may load, nothing may frame it, and no Referer leaves it (the paths
// carry transfer ids, which are bearer capabilities). HSTS without
// includeSubDomains or preload: it pins this host only, and is safe because the
// only way in is the Cloudflare tunnel, which is HTTPS-only.
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

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
    // `range` is required by the mediated download: verified and resumed
    // downloads send Range, which is NOT a CORS-safelisted request header, so
    // omitting it here makes the browser fail the preflight and the download
    // never starts. It was safe to omit only while every ranged fetch went
    // straight to storage and never touched this origin.
    allowHeaders: ["content-type", "range"],
    maxAge: 600,
  }),
);
app.route("/api", api);
app.get("/", (c) => c.text("waystation gateway"));

// Liveness for the tunnel connector and deployment checks. Unauthenticated by
// necessity — a health probe has no credentials — so it discloses NOTHING:
// no version, no auth mode, no origins, no database path, no build id. Those
// belong in the boot log on the host, not on an endpoint reachable from the
// internet, where they would only help someone map the deployment.
app.get("/healthz", (c) => c.json({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  // Configuration disclosure only — never a code, hash, token, or secret.
  console.log(`gateway listening on :${port}`);
  console.log(`  ${authBanner()} senderCodes=${activeAccessCodeCount()}`);
  console.log(`  origins: ${allowedOrigins.join(", ")}`);
  console.log(`  state: ${dbPathLabel}`);
  console.log(`  ${policyBanner()}`);
  console.log(`  ${paymentsBanner()}`);
  console.log(`  ${emailBanner()}`);
  console.log(`  ${purgeBanner()}`);
  if (!authEnabled) console.log("  WARNING: sender authentication is OFF (development mode)");
});
startPurgeLoop();
