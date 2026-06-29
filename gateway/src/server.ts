import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { api } from "./routes.js";

const app = new Hono();
app.use("/api/*", cors());
app.route("/api", api);
app.get("/", (c) => c.text("orbitxfer-web gateway"));

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, () => console.log(`gateway listening on :${port}`));
