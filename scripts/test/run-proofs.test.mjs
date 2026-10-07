import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  STATUS, classifyResult, discover, gate, main, parseArgs, portsOf, scan, scrubbedEnv, sha256, summarize,
} from "../run-proofs.mjs";

const mk = (files) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "proof-runner-test-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
    if (name.endsWith(".sh")) chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
};
const run = async (dir, args = []) => {
  const lines = [];
  const code = await main(["--dir", dir, ...args], { out: (s) => lines.push(s) });
  return { code, text: lines.join("\n") };
};

// ───────── classification ─────────

test("classifyResult: exit 0 with clean output passes", () => {
  assert.equal(classifyResult({ code: 0, output: "all good\nPASS - x\n" }).status, STATUS.PASS);
  assert.equal(classifyResult({ code: 0, output: "" }).status, STATUS.PASS);
});

test("classifyResult: any non-zero exit, signal or timeout fails", () => {
  assert.equal(classifyResult({ code: 1, output: "PASS PASS" }).status, STATUS.FAIL);
  assert.equal(classifyResult({ code: 2, output: "" }).status, STATUS.FAIL);
  assert.equal(classifyResult({ code: null, signal: "SIGKILL", output: "" }).status, STATUS.FAIL);
  assert.equal(classifyResult({ code: 0, timedOut: true, output: "PASS" }).status, STATUS.FAIL);
  assert.equal(classifyResult({ code: undefined, output: "" }).status, STATUS.FAIL);
});

test("classifyResult: exit 0 that prints FAIL is still a failure", () => {
  for (const line of ["FAIL - something", "  FAIL: nope", "FAILED x", "  FAIL"])
    assert.equal(classifyResult({ code: 0, output: `ok\n${line}\nPASS\n` }).status, STATUS.FAIL, line);
});

test("classifyResult: SKIP, including a partial run that also prints PASS, is not a pass", () => {
  assert.equal(classifyResult({ code: 0, output: "SKIP - minio not installed" }).status, STATUS.SKIP);
  assert.equal(classifyResult({ code: 0, output: "  guards ok\nSKIP (live half) - minio not installed\n" }).status, STATUS.SKIP);
  assert.equal(classifyResult({ code: 0, output: "PASS\nSKIP — docker not available" }).status, STATUS.SKIP);
});

test("classifyResult: words merely containing the markers do not misclassify", () => {
  assert.equal(classifyResult({ code: 0, output: "no failures\nskipped nothing here\nrefused (FAILing closed is fine mid-line)\n" }).status, STATUS.PASS);
});

// ───────── scanning ─────────

test("scan: benign local scripts need nothing", () => {
  const s = scan('#!/bin/bash\n# uses docker in a comment only\ncurl -s http://127.0.0.1:8794/x\ncurl https://api.example.test/x\nORIGIN=https://orbitolive.com\nrm -rf "$WORK"\n');
  assert.deepEqual(s.needs, []);
});

test("scan: docker, external hosts, credential reads and destructive commands are flagged", () => {
  assert.deepEqual(scan("docker build -t x .\n").needs, ["docker"]);
  assert.deepEqual(scan("colima start\n").needs, ["docker"]);
  assert.deepEqual(scan("curl -s https://api.stripe.com/v1/charges\n").needs, ["external"]);
  assert.deepEqual(scan('python3 -c "urlopen(\'https://example.org/x\')"\n').needs, ["external"]);
  assert.deepEqual(scan("b2 authorize-account\n").needs, ["external"]);
  assert.deepEqual(scan("set -a; source ./.env; set +a\n").needs, ["credentials"]);
  assert.deepEqual(scan("cat .env\n").needs, ["credentials"]);
  assert.deepEqual(scan("cp ~/.aws/credentials /tmp/x\n").needs, ["credentials"]);
  assert.deepEqual(scan("rm -rf /var/data\n").needs, ["destructive"]);
  assert.deepEqual(scan('rm -rf "$HOME/x"\n').needs, ["destructive"]);
  assert.deepEqual(scan("pkill -f gateway\n").needs, ["destructive"]);
  assert.deepEqual(scan("git reset --hard\n").needs, ["destructive"]);
  assert.deepEqual(scan("sudo sysctl -w x=1\n").needs, ["destructive"]);
});

test("scan: an .env.example reference is not a credential read", () => {
  assert.deepEqual(scan("cp .env.example .env.proof\n").needs, []);
});

test("portsOf: finds bind, kill and probe ports", () => {
  const p = portsOf('GW=8794 MIN=9014\nlsof -ti:8787\ncurl http://localhost:8000/x\nminio server d --address :9000\nPORT=8010 x\ndocker run -p 8001:8000 i\n');
  assert.deepEqual(p, [8000, 8001, 8010, 8787, 8794, 9000, 9014]);
});

// ───────── environment ─────────

test("scrubbedEnv: ambient credentials are dropped and B2 is pointed at a dead loopback port", () => {
  const env = scrubbedEnv({
    PATH: "/bin", HOME: "/h", STRIPE_SECRET_KEY: "synthetic-not-a-key", RESEND_API_KEY: "re_x", GMI_API_KEY: "g",
    B2_APP_KEY: "real", B2_S3_ENDPOINT: "https://s3.example", AWS_SECRET_ACCESS_KEY: "a", TUNNEL_TOKEN: "t",
  });
  assert.equal(env.PATH, "/bin");
  for (const k of ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "GMI_API_KEY", "AWS_SECRET_ACCESS_KEY", "TUNNEL_TOKEN"])
    assert.equal(env[k], undefined, k);
  assert.equal(env.B2_S3_ENDPOINT, "http://127.0.0.1:9");
  assert.notEqual(env.B2_APP_KEY, "real");
});

// ───────── summary and acceptance ─────────

const r = (...statuses) => statuses.map((status, i) => ({ name: `s${i}`, status }));

test("summarize: full pass is the only acceptance", () => {
  const s = summarize(r("PASS", "PASS"), { discovered: 2, selected: 2 });
  assert.equal(s.exitCode, 0); assert.equal(s.acceptance, true); assert.match(s.verdict, /^ACCEPTED/);
});

test("summarize: a partial selection that passes is labelled and never an acceptance", () => {
  const s = summarize(r("PASS"), { discovered: 5, selected: 1 });
  assert.equal(s.exitCode, 0); assert.equal(s.acceptance, false); assert.match(s.verdict, /NOT a full-suite acceptance/);
});

test("summarize: failures win; skips and not-run are incomplete, never accepted", () => {
  assert.equal(summarize(r("PASS", "FAIL", "SKIP"), { discovered: 3, selected: 3 }).exitCode, 1);
  const skip = summarize(r("PASS", "SKIP"), { discovered: 2, selected: 2 });
  assert.equal(skip.exitCode, 2); assert.equal(skip.acceptance, false); assert.match(skip.verdict, /NOT AN ACCEPTANCE/);
  const nr = summarize(r("PASS", "NOT_RUN"), { discovered: 2, selected: 2 });
  assert.equal(nr.exitCode, 2); assert.equal(nr.acceptance, false);
  assert.equal(summarize([], { discovered: 3, selected: 0 }).exitCode, 2);
});

// ───────── discovery and arguments ─────────

test("discover: finds only *-proof.sh, sorted", () => {
  const dir = mk({ "b-proof.sh": "", "a-proof.sh": "", "notes.md": "", "proof.sh": "", "c-proof.sh.bak": "" });
  try { assert.deepEqual(discover(dir).map((f) => path.basename(f)), ["a-proof.sh", "b-proof.sh"]); }
  finally { rmSync(dir, { recursive: true }); }
});

test("parseArgs: flags, values and errors", () => {
  const o = parseArgs(["--only", "a,b", "--docker", "--timeout", "5", "--json", "x.json"]);
  assert.deepEqual(o.only, ["a", "b"]); assert.equal(o.docker, true); assert.equal(o.timeout, 5); assert.equal(o.json, "x.json");
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--timeout", "0"]), /positive/);
  assert.throws(() => parseArgs(["--only"]), /needs a value/);
});

// ───────── gate ─────────

test("gate: opt-ins, reviews bound to the script hash, and busy ports", async () => {
  const s = scan("docker run x\nrm -rf /var/y\n");
  const free = async () => false;
  assert.equal((await gate(s, {}, free)).run, false);
  assert.equal((await gate(s, { docker: true }, free)).run, false);          // still needs destructive
  assert.equal((await gate(s, { docker: true, destructive: true }, free)).run, true);
  const review = { allow: ["destructive"], sha256: "abc" };
  assert.equal((await gate(s, { docker: true }, free, review, "abc")).run, true);
  const stale = await gate(s, { docker: true }, free, review, "different");
  assert.equal(stale.run, false); assert.match(stale.reason, /stale/);
  const busy = await gate(scan("GW=8794\n"), {}, async (p) => p === 8794);
  assert.equal(busy.run, false); assert.match(busy.reason, /8794/);
});

// ───────── end to end, with real fixture scripts ─────────

test("runner: pass, fail, skip, partial skip and exit-0-with-FAIL are each reported correctly", async () => {
  const dir = mk({
    "good-proof.sh": "#!/usr/bin/env bash\necho PASS - good\n",
    "bad-proof.sh": "#!/usr/bin/env bash\necho something broke\nexit 1\n",
    "skipped-proof.sh": "#!/usr/bin/env bash\necho 'SKIP - tool missing'\nexit 0\n",
    "partial-proof.sh": "#!/usr/bin/env bash\necho 'static half ok'\necho 'SKIP (live half) - tool missing'\nexit 0\n",
    "liar-proof.sh": "#!/usr/bin/env bash\necho 'FAIL: it broke but I exit 0'\nexit 0\n",
  });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 1);
    assert.match(text, /^PASS\s+good/m);
    assert.match(text, /^FAIL\s+bad/m);
    assert.match(text, /^SKIP\s+skipped/m);
    assert.match(text, /^SKIP\s+partial/m);
    assert.match(text, /^FAIL\s+liar/m);
    assert.match(text, /1 passed, 2 failed, 2 skipped, 0 not run/);
    assert.doesNotMatch(text, /ACCEPTED/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("runner: a skip alone yields an incomplete result and exit 2, not an acceptance", async () => {
  const dir = mk({ "a-proof.sh": "echo PASS\n", "b-proof.sh": "echo 'SKIP - docker not available'\n" });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 2);
    assert.match(text, /INCOMPLETE, NOT AN ACCEPTANCE/);
    assert.doesNotMatch(text, /ACCEPTED/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("runner: everything passing is an acceptance; --only is labelled a selection", async () => {
  const dir = mk({ "a-proof.sh": "echo PASS a\n", "b-proof.sh": "echo PASS b\n" });
  try {
    const all = await run(dir);
    assert.equal(all.code, 0); assert.match(all.text, /ACCEPTED: all 2 discovered/);
    const one = await run(dir, ["--only", "a"]);
    assert.equal(one.code, 0); assert.match(one.text, /SELECTION PASSED \(1 of 2.*NOT a full-suite acceptance/);
    assert.doesNotMatch(one.text, /ACCEPTED/);
    const missing = await run(dir, ["--only", "zzz"]);
    assert.equal(missing.code, 3);
  } finally { rmSync(dir, { recursive: true }); }
});

test("runner: a timeout is a failure and the script's process group is terminated", async () => {
  const dir = mk({ "slow-proof.sh": "#!/usr/bin/env bash\nsleep 30 &\nwait\n" });
  try {
    const t0 = Date.now();
    const { code, text } = await run(dir, ["--timeout", "0.5"]);
    assert.equal(code, 1); assert.match(text, /FAIL\s+slow.*timed out/);
    assert.ok(Date.now() - t0 < 15_000, "the runner must not wait for the script's sleep");
  } finally { rmSync(dir, { recursive: true }); }
});

test("runner: risky scripts are NOT_RUN without opt-in and never executed", async () => {
  const marker = path.join(os.tmpdir(), `proof-runner-marker-${process.pid}`);
  const dir = mk({
    "dock-proof.sh": `touch ${marker}\ndocker run --rm hello\n`,
    "ext-proof.sh": `touch ${marker}\ncurl -s https://api.stripe.com/v1/x\n`,
    "cred-proof.sh": `touch ${marker}\nsource .env\n`,
    "del-proof.sh": `touch ${marker}\nrm -rf /var/lib/x\n`,
  });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 2);
    assert.match(text, /4 not run/);
    for (const n of ["dock", "ext", "cred", "del"]) assert.match(text, new RegExp(`NOT_RUN\\s+${n}`));
    const { existsSync } = await import("node:fs");
    assert.equal(existsSync(marker), false, "a refused script must not have been executed");
  } finally { rmSync(dir, { recursive: true }); rmSync(marker, { force: true }); }
});

test("runner: a script whose port is already in use is NOT_RUN, not run", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const dir = mk({ "port-proof.sh": `GW=${port}\necho PASS\n` });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 2); assert.match(text, new RegExp(`NOT_RUN\\s+port.*${port}`));
  } finally { server.close(); rmSync(dir, { recursive: true }); }
});

test("runner: ambient credentials do not reach a script", async () => {
  process.env.STRIPE_SECRET_KEY = "synthetic-leak-check-value";
  const dir = mk({ "env-proof.sh": '#!/usr/bin/env bash\n[ -z "${STRIPE_SECRET_KEY:-}" ] || { echo "leaked"; exit 1; }\n[ "$B2_S3_ENDPOINT" = "http://127.0.0.1:9" ] || exit 1\necho PASS\n' });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 0, text);
  } finally { delete process.env.STRIPE_SECRET_KEY; rmSync(dir, { recursive: true }); }
});

test("runner: a hash-bound review lets a flagged script run; a changed script loses it", async () => {
  const body = "#!/usr/bin/env bash\necho 'sample \"rm -rf /var/x\" is only text'\necho PASS\n";
  const dir = mk({ "r-proof.sh": body });
  try {
    assert.equal((await run(dir)).code, 2);                                   // flagged, unreviewed
    writeFileSync(path.join(dir, "proof-review.json"), JSON.stringify({ r: { allow: ["destructive"], sha256: sha256(body) } }));
    const ok = await run(dir); assert.equal(ok.code, 0, ok.text);
    writeFileSync(path.join(dir, "r-proof.sh"), body + "# edited\n");
    const stale = await run(dir); assert.equal(stale.code, 2); assert.match(stale.text, /stale/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("runner: --json writes a machine-readable report", async () => {
  const dir = mk({ "a-proof.sh": "echo PASS\n", "b-proof.sh": "exit 3\n" });
  const out = path.join(dir, "report.json");
  try {
    const { code } = await run(dir, ["--json", out]);
    assert.equal(code, 1);
    const { readFileSync } = await import("node:fs");
    const rep = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(rep.acceptance, false); assert.equal(rep.counts.FAIL, 1); assert.equal(rep.results.length, 2);
  } finally { rmSync(dir, { recursive: true }); }
});
