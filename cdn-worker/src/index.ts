// Cloudflare Worker on cdn.waystation.app.
// Verifies the gateway's short-lived HMAC token, then streams the object from
// the PRIVATE B2 bucket. B2→Worker egress is free (Bandwidth Alliance);
// Cloudflare caches hot ranges. Range requests pass through for verified
// streaming. This is the ToS-clean way to serve large files via Cloudflare.
import { AwsClient } from "aws4fetch";

interface Env {
  B2_S3_ENDPOINT: string;
  B2_REGION: string;
  B2_BUCKET: string;
  B2_KEY_ID: string;
  B2_APP_KEY: string;
  CDN_TOKEN_SECRET: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.slice(1));
    const exp = Number(url.searchParams.get("exp") || 0);
    const sig = url.searchParams.get("sig") || "";

    if (!key) return new Response("not found", { status: 404 });
    if (exp * 1000 < Date.now()) return new Response("link expired", { status: 403 });
    if (sig !== (await hmac(env.CDN_TOKEN_SECRET, `${key}:${exp}`)))
      return new Response("forbidden", { status: 403 });

    const aws = new AwsClient({
      accessKeyId: env.B2_KEY_ID, secretAccessKey: env.B2_APP_KEY,
      service: "s3", region: env.B2_REGION,
    });
    const origin = `${env.B2_S3_ENDPOINT}/${env.B2_BUCKET}/${encodeURI(key)}`;
    const headers: Record<string, string> = {};
    const rangeHeader = req.headers.get("Range");
    if (rangeHeader) headers.Range = rangeHeader;

    const signed = await aws.sign(origin, { method: "GET", headers });
    return fetch(signed, { cf: { cacheEverything: true, cacheTtl: 3600 } });
  },
};

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
