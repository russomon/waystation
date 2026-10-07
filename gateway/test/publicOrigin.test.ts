import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_MOUNT, loadPublicApiOrigin, mediatedDownloadUrlFor, parsePublicApiOrigin,
} from "../src/publicOrigin.js";

const ok = (raw: string) => {
  const r = parsePublicApiOrigin(raw);
  assert.ok(r.ok, `expected ${raw} to be accepted: ${JSON.stringify(r)}`);
  return r.origin;
};
const bad = (raw: string | undefined) => {
  const r = parsePublicApiOrigin(raw);
  assert.equal(r.ok, false, `expected ${String(raw)} to be rejected`);
};

test("accepts https origins and loopback http, normalized", () => {
  assert.equal(ok("https://api.orbitolive.com"), "https://api.orbitolive.com");
  assert.equal(ok("  https://API.OrbitOlive.com/ "), "https://api.orbitolive.com");
  assert.equal(ok("https://api.example.test:8443"), "https://api.example.test:8443");
  assert.equal(ok("http://localhost:8787"), "http://localhost:8787");
  assert.equal(ok("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(ok("http://[::1]:8787"), "http://[::1]:8787");
});

test("rejects absent, malformed and unsafe configuration", () => {
  for (const v of [undefined, "", "   ", "api.orbitolive.com", "//api.orbitolive.com", "ftp://api.example.test",
    "javascript:alert(1)", "http://api.orbitolive.com", "http://10.0.0.5:8787",
    "https://user:pw@api.example.test", "https://api.example.test/api", "https://api.example.test/?a=1",
    "https://api.example.test/#x", "https://api.example.test?x", "https://", "https://api example.test"])
    bad(v);
});

test("loadPublicApiOrigin: production requires an https origin and refuses otherwise", () => {
  assert.deepEqual(loadPublicApiOrigin("https://api.orbitolive.com", true), { origin: "https://api.orbitolive.com" });
  assert.throws(() => loadPublicApiOrigin(undefined, true), /required/);
  assert.throws(() => loadPublicApiOrigin("", true), /required/);
  assert.throws(() => loadPublicApiOrigin("not a url", true), /invalid/);
  assert.throws(() => loadPublicApiOrigin("http://localhost:8787", true), /https/);
});

test("loadPublicApiOrigin: development allows absence but never an invalid value", () => {
  assert.deepEqual(loadPublicApiOrigin(undefined, false), { origin: null });
  assert.deepEqual(loadPublicApiOrigin("  ", false), { origin: null });
  assert.deepEqual(loadPublicApiOrigin("http://localhost:8787", false), { origin: "http://localhost:8787" });
  assert.throws(() => loadPublicApiOrigin("http://evil.test", false), /invalid/);
});

const ID = "11111111-2222-3333-4444-555555555555";

test("configured origin wins over whatever the request claims (forged Host / X-Forwarded-*)", () => {
  const cfg = { origin: "https://api.orbitolive.com" };
  const want = `https://api.orbitolive.com${API_MOUNT}/transfers/${ID}/original`;
  // The request URL is built from the Host header; none of these can matter.
  for (const forged of [
    `http://evil.test/api/transfers/${ID}`,
    `http://evil.test:8787/api/transfers/${ID}`,
    `https://attacker.example/api/transfers/${ID}`,
    `http://localhost:8787/api/transfers/${ID}`,
  ]) assert.equal(mediatedDownloadUrlFor(cfg, forged, ID), want);
});

test("the link keeps the API mount prefix and https, and encodes the id", () => {
  const cfg = { origin: "https://api.orbitolive.com" };
  const url = mediatedDownloadUrlFor(cfg, "http://gateway:8787/api/transfers/x", ID)!;
  assert.ok(url.startsWith("https://api.orbitolive.com/api/transfers/"));
  assert.ok(url.endsWith("/original"));
  assert.equal(new URL(url).search, "");
  const odd = mediatedDownloadUrlFor(cfg, "http://gateway:8787/", "a/b?c#d")!;
  assert.equal(odd, "https://api.orbitolive.com/api/transfers/a%2Fb%3Fc%23d/original");
});

test("unconfigured development fallback: loopback only, always http, never a forwarded value", () => {
  const cfg = { origin: null };
  assert.equal(mediatedDownloadUrlFor(cfg, `http://localhost:5173/api/transfers/${ID}`, ID),
    `http://localhost:5173/api/transfers/${ID}/original`);
  assert.equal(mediatedDownloadUrlFor(cfg, `http://127.0.0.1:8787/api/transfers/${ID}`, ID),
    `http://127.0.0.1:8787/api/transfers/${ID}/original`);
  for (const host of ["evil.test", "api.orbitolive.com", "10.0.0.5:8787", "localhost.evil.test", "127.0.0.1.evil.test"])
    assert.equal(mediatedDownloadUrlFor(cfg, `http://${host}/api/transfers/${ID}`, ID), null, host);
  assert.equal(mediatedDownloadUrlFor(cfg, "not a url", ID), null);
});
