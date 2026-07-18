import "./env.js"; // MUST be first — loads .env before s3.ts reads process.env
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./routes.js";

const app = new Hono();
app.use("/api/*", cors());
app.route("/api", api);
app.get("/", (c) => c.text("waystation gateway"));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`gateway listening on :${port}`));
