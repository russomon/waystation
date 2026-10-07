import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  STATUS, buildProfile, classifyResult, discover, gate, main, parseArgs, portInUse, portsOf, sandboxAvailable, scan,
  scrubbedEnv, summarize,
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

// ───────── advisory scan ─────────

test("scan: benign local scripts need nothing", () => {
  const s = scan('#!/bin/bash\n# uses docker in a comment only\ncurl -s http://127.0.0.1:8794/x\ncurl https://api.example.test/x\nORIGIN=https://orbitolive.com\nrm -rf "$WORK"\n');
  assert.deepEqual(s.needs, []);
});

test("scan: docker and obvious external use are flagged for an early refusal", () => {
  assert.deepEqual(scan("docker build -t x .\n").needs, ["docker"]);
  assert.deepEqual(scan("colima start\n").needs, ["docker"]);
  assert.deepEqual(scan("curl -s https://api.stripe.com/v1/charges\n").needs, ["external"]);
  assert.deepEqual(scan("b2 authorize-account\n").needs, ["external"]);
});

test("scan: a clean scan is NOT an authorization, it cannot see indirection", () => {
  // These are exactly the shapes a text scan misses; the sandbox tests below are what stop them.
  assert.deepEqual(scan('u="https://example.org/x"\ncurl -s "$u"\n').needs, []);
  assert.deepEqual(scan('d="$HOME/precious"\nrm -rf "$d"\n').needs, []);
  assert.deepEqual(scan("bash ./other.sh\n").needs, []);
});

test("portsOf: finds bind, kill and probe ports", () => {
  const p = portsOf('GW=8794 MIN=9014\nlsof -ti:8787\ncurl http://localhost:8000/x\nminio server d --address :9000\nPORT=8010 x\ndocker run -p 8001:8000 i\n');
  assert.deepEqual(p, [8000, 8001, 8010, 8787, 8794, 9000, 9014]);
});

// ───────── ports: both loopback families ─────────

test("portInUse: a listener on EITHER IPv4 or IPv6 loopback makes the port busy", async () => {
  const only = (h) => async (_port, host) => host === h;
  assert.equal(await portInUse(8787, only("127.0.0.1")), true);
  assert.equal(await portInUse(8787, only("::1")), true, "an IPv6-only listener must not be missed");
  assert.equal(await portInUse(8787, async () => false), false);
  const seen = [];
  await portInUse(8787, async (_p, h) => { seen.push(h); return false; });
  assert.deepEqual(seen.sort(), ["127.0.0.1", "::1"], "both families are probed");
});

test("portInUse: finds a real IPv6-only listener (skipped where ::1 is unavailable)", async (t) => {
  const server = net.createServer();
  const ok = await new Promise((resolve) => { server.once("error", () => resolve(false)); server.listen(0, "::1", () => resolve(true)); });
  if (!ok) return t.skip("IPv6 loopback listener cannot be created here");
  try { assert.equal(await portInUse(server.address().port), true); }
  finally { server.close(); }
});

// ───────── environment ─────────

test("scrubbedEnv: ambient credentials are dropped, B2 points at a dead loopback port, TMPDIR is the run's own", () => {
  const env = scrubbedEnv({
    PATH: "/bin", HOME: "/h", STRIPE_SECRET_KEY: "synthetic-not-a-key", RESEND_API_KEY: "re_x", GMI_API_KEY: "g",
    B2_APP_KEY: "real", B2_S3_ENDPOINT: "https://s3.example", AWS_SECRET_ACCESS_KEY: "a", TUNNEL_TOKEN: "t", TMPDIR: "/elsewhere",
  }, "/run/tmp");
  assert.equal(env.PATH, "/bin");
  for (const k of ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "GMI_API_KEY", "AWS_SECRET_ACCESS_KEY", "TUNNEL_TOKEN"])
    assert.equal(env[k], undefined, k);
  assert.equal(env.B2_S3_ENDPOINT, "http://127.0.0.1:9");
  assert.notEqual(env.B2_APP_KEY, "real");
  assert.equal(env.TMPDIR, "/run/tmp");
});

// ───────── the sandbox profile ─────────

test("buildProfile: network, docker, signal, write and credential rules, and the opt-in relaxations", () => {
  const base = { repo: "/r/repo", runTmp: "/t/run", home: "/h" };
  const p = buildProfile(base);
  assert.match(p, /\(deny network-outbound\)/);
  assert.match(p, /remote ip "localhost:\*"/);
  assert.match(p, /docker\[\^\/\]\*\\\.sock/);
  assert.match(p, /\(deny signal\)/);
  assert.match(p, /allow signal \(target same-sandbox\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /deny file-write-unlink \(subpath "\/private\/tmp"\)/);
  assert.match(p, /subpath "\/r\/repo\/\.git"/);
  assert.match(p, /subpath "\/h\/\.aws"/);
  const ext = buildProfile({ ...base, external: true });
  assert.doesNotMatch(ext, /\(deny network-outbound\)\n/);
  const dock = buildProfile({ ...base, docker: true });
  assert.doesNotMatch(dock, /docker\[\^/);
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

test("gate: docker/external need their flags, and a busy port refuses", async () => {
  const free = async () => false;
  const s = scan("docker run x\ncurl -s https://api.stripe.com/x\n");
  assert.equal((await gate(s, {}, free)).run, false);
  assert.equal((await gate(s, { docker: true }, free)).run, false);
  assert.equal((await gate(s, { docker: true, external: true }, free)).run, true);
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

test("runner: docker and external-looking scripts are NOT_RUN without opt-in and never executed", async () => {
  const marker = path.join(os.tmpdir(), `proof-runner-marker-${process.pid}`);
  const dir = mk({
    "dock-proof.sh": `touch ${marker}\ndocker run --rm hello\n`,
    "ext-proof.sh": `touch ${marker}\ncurl -s https://api.stripe.com/v1/x\n`,
  });
  try {
    const { code, text } = await run(dir);
    assert.equal(code, 2);
    assert.match(text, /2 not run/);
    for (const n of ["dock", "ext"]) assert.match(text, new RegExp(`NOT_RUN\\s+${n}`));
    assert.equal(existsSync(marker), false, "a refused script must not have been executed");
  } finally { rmSync(dir, { recursive: true }); rmSync(marker, { force: true }); }
});

test("runner: with no sandbox available EVERY script is NOT_RUN, even a clean one: there is no unsandboxed mode", async () => {
  const marker = path.join(os.tmpdir(), `proof-runner-nosandbox-${process.pid}`);
  const dir = mk({ "clean-proof.sh": `touch ${marker}\necho PASS\n` });
  try {
    const lines = [];
    const code = await main(["--dir", dir], { out: (x) => lines.push(x), sandbox: { ok: false, reason: "test: unavailable" } });
    assert.equal(code, 2);
    assert.match(lines.join("\n"), /NOT_RUN\s+clean.*no enforcement available/);
    assert.equal(existsSync(marker), false);
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


// ───────── enforcement: the sandbox, not the script text, is what holds ─────────
//
// Each fixture hides its intent from any text scan (URLs and paths sit in
// variables; one script delegates to another) and the test checks the EFFECT.

const sandbox = sandboxAvailable();
const needSandbox = (t) => { if (!sandbox.ok) { t.skip(`sandbox unavailable here: ${sandbox.reason}`); return false; } return true; };
const listen = (host) => new Promise((resolve, reject) => {
  const hits = [];
  const server = net.createServer((sock) => { hits.push(sock.remoteAddress); sock.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"); });
  server.once("error", reject);
  server.listen(0, host, () => resolve({ server, hits, port: server.address().port }));
});
const runSandboxed = async (dir, name = "") => {
  const lines = [];
  const code = await main(["--dir", dir, ...(name ? ["--only", name] : [])], { out: (x) => lines.push(x), sandbox, inUse: async () => false });
  return { code, text: lines.join("\n") };
};

// A connect() to a TEST-NET address (RFC 5737, never routed) is the probe. Unsandboxed it
// times out or reports no route; under the sandbox it is refused IMMEDIATELY with EPERM (1).
// That errno, not a timeout, is what shows the sandbox (not the network) said no. Nothing is sent
// to any real host.
const connectErrno = (host) => new Promise((resolve) => {
  const s = net.connect({ host, port: 80 });
  s.setTimeout(1500, () => { s.destroy(); resolve("ETIMEDOUT"); });
  s.once("connect", () => { s.destroy(); resolve("CONNECTED"); });
  s.once("error", (e) => { s.destroy(); resolve(e.code); });
});
const PROBE_PY = (hostVar) =>
  `python3 -c 'import socket,os,sys;s=socket.socket();s.settimeout(3);sys.exit(0 if s.connect_ex((os.environ["${hostVar}"],80))==1 else 3)'`;

test("enforced: a non-loopback host is refused by the sandbox even when the address hides in a variable; loopback works", async (t) => {
  if (!needSandbox(t)) return;
  const control = await connectErrno("192.0.2.1");
  if (control === "EPERM") return t.skip("this environment already forbids outbound connects, so the control proves nothing");
  const near = await listen("127.0.0.1");
  const dir = mk({ "net-proof.sh": `#!/usr/bin/env bash
a=192; b=0; c=2; d=1; export TARGET="$a.$b.$c.$d"      # nothing a text scan could read as a host
${PROBE_PY("TARGET")} || { echo "FAIL the connect was not refused by the sandbox"; exit 1; }
curl -s -m 3 -o /dev/null "http://127.0.0.1:${near.port}/" || { echo "FAIL loopback was blocked too"; exit 1; }
echo PASS
` });
  try {
    const { code, text } = await runSandboxed(dir);
    assert.equal(code, 0, text);
    assert.equal(near.hits.length, 1, "the loopback server must have been reached");
  } finally { near.server.close(); rmSync(dir, { recursive: true }); }
});

test("enforced: a script cannot delete a directory it did not create, under HOME or /tmp, via a variable", async (t) => {
  if (!needSandbox(t)) return;
  const homeVictim = path.join(os.homedir(), `.proof-runner-victim-${process.pid}`);
  const tmpVictim = path.join("/private/tmp", `proof-runner-victim-${process.pid}`);
  for (const d of [homeVictim, tmpVictim]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, "keep"), "x"); }
  const dir = mk({ "del-proof.sh": `#!/usr/bin/env bash
a="${homeVictim}"; b="${tmpVictim}"
rm -rf "$a" "$b" 2>/dev/null
true
echo done
` });
  try {
    const { text } = await runSandboxed(dir);
    assert.match(text, /PASS\s+del/, text);
    assert.equal(existsSync(path.join(homeVictim, "keep")), true, "a HOME directory was deleted");
    assert.equal(existsSync(path.join(tmpVictim, "keep")), true, "a fixed /tmp directory was deleted");
  } finally { rmSync(homeVictim, { recursive: true, force: true }); rmSync(tmpVictim, { recursive: true, force: true }); rmSync(dir, { recursive: true }); }
});

test("enforced: a script can create and remove its OWN temp directory, and write inside the repository", async (t) => {
  if (!needSandbox(t)) return;
  const dir = mk({ "own-proof.sh": `#!/usr/bin/env bash
d=$(mktemp -d); echo x > "$d/f"; rm -rf "$d"; [ ! -e "$d" ] || { echo "FAIL own temp not removable"; exit 1; }
echo y > ./inside-repo.txt
echo PASS
` });
  try {
    const { code, text } = await runSandboxed(dir);
    assert.equal(code, 0, text);
    assert.equal(existsSync(path.join(dir, "inside-repo.txt")), true);
  } finally { rmSync(dir, { recursive: true }); }
});

test("enforced: writes outside the repository, HOME and /tmp areas are refused; .git and .env are read-only/unreadable", async (t) => {
  if (!needSandbox(t)) return;
  const probe = path.join(os.homedir(), `.proof-runner-write-${process.pid}`);
  const dir = mk({ "wr-proof.sh": `#!/usr/bin/env bash
p="${probe}"
( echo leak > "$p" ) 2>/dev/null && { echo "FAIL wrote to HOME"; exit 1; }
mkdir -p .git && ( echo x > .git/pwned ) 2>/dev/null && { echo "FAIL wrote into .git"; exit 1; }
cat .env >/dev/null 2>&1 && { echo "FAIL read .env"; exit 1; }
echo PASS
`, ".env": "SECRET=not-real\n" });
  try {
    const { code, text } = await runSandboxed(dir);
    assert.equal(code, 0, text);
    assert.equal(existsSync(probe), false);
  } finally { rmSync(probe, { force: true }); rmSync(dir, { recursive: true }); }
});

test("enforced: a script cannot signal a process it did not start, but can signal its own", async (t) => {
  if (!needSandbox(t)) return;
  const { spawn } = await import("node:child_process");
  const foreign = spawn("sleep", ["120"], { stdio: "ignore" });
  const dir = mk({ "sig-proof.sh": `#!/usr/bin/env bash
victim=${foreign.pid}
kill -9 "$victim" 2>/dev/null || true       # what a port-wide kill would do to a stranger
sleep 30 & own=$!
kill -9 "$own" && echo "own process signalled"
echo PASS
` });
  try {
    const { code, text } = await runSandboxed(dir);
    assert.equal(code, 0, text);
    assert.equal((() => { try { process.kill(foreign.pid, 0); return true; } catch { return false; } })(), true,
      "the runner's script killed a process it did not start");
  } finally { foreign.kill("SIGKILL"); rmSync(dir, { recursive: true }); }
});

test("enforced: invoking another script does not escape the sandbox", async (t) => {
  if (!needSandbox(t)) return;
  const control = await connectErrno("192.0.2.1");
  if (control === "EPERM") return t.skip("this environment already forbids outbound connects");
  const victim = path.join(os.homedir(), `.proof-runner-nested-${process.pid}`);
  mkdirSync(victim, { recursive: true }); writeFileSync(path.join(victim, "keep"), "x");
  const dir = mk({
    "outer-proof.sh": "#!/usr/bin/env bash\nbash \"$(dirname \"$0\")/helper.sh\" || { echo \"FAIL the helper was not confined\"; exit 1; }\necho PASS\n",
    "helper.sh": `#!/usr/bin/env bash
export TARGET="192.0.2.1"
${PROBE_PY("TARGET")} || exit 1                         # the helper's connect must be refused too
rm -rf "${victim}" 2>/dev/null
exit 0
`,
  });
  try {
    const { code, text } = await runSandboxed(dir);
    assert.equal(code, 0, text);
    assert.equal(existsSync(path.join(victim, "keep")), true, "the helper deleted a directory it did not create");
  } finally { rmSync(victim, { recursive: true, force: true }); rmSync(dir, { recursive: true }); }
});
