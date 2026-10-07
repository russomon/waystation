#!/usr/bin/env node
// Discovery-based proof runner.
//
//   node scripts/run-proofs.mjs [--list] [--only a,b] [--skip a,b]
//        [--docker] [--external] [--credentials] [--destructive]
//        [--timeout SECONDS] [--json FILE] [--dir DIR]
//
// It discovers `*-proof.sh` under scripts/ (or --dir), runs them one at a time
// in a scrubbed environment, and reports each as exactly one of:
//
//   PASS     exit 0, no SKIP line, no FAIL line
//   FAIL     non-zero exit, a timeout, or exit 0 while printing a FAIL line
//   SKIP     the script ran but declared it skipped (missing tool, partial run)
//   NOT_RUN  the runner refused to start it (see the reason)
//
// "Ends in -proof.sh" does not make a script safe. Before running, each script
// is scanned and the run is refused (NOT_RUN) unless the matching opt-in flag is
// given:
//   --docker       uses docker / colima (builds or runs containers)
//   --external     contacts a non-loopback host or runs a cloud/provider CLI
//   --credentials  reads an env file or credential store
//   --destructive  deletes outside its own temp dir, or force-kills by name
// A scan hit that is benign for one exact script (say, a command that only
// appears inside a string literal) can be recorded in scripts/proof-review.json,
// bound to that script's sha256; editing the script invalidates the review.
// and it is also refused when a port it would bind or terminate is already in
// use, because several scripts kill whatever listens on their ports.
//
// Acceptance is never implied by a partial result. Exit codes:
//   0  every discovered script PASSED (a full-suite acceptance), or, with
//      --only/--skip, every SELECTED script passed (labelled NOT a full suite)
//   1  at least one FAIL
//   2  no FAIL, but at least one SKIP or NOT_RUN: INCOMPLETE, not an acceptance
//   3  usage or internal error

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATUS = Object.freeze({ PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", NOT_RUN: "NOT_RUN" });

// ───────── discovery ─────────

export function discover(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith("-proof.sh"))
    .sort()
    .map((f) => path.join(dir, f));
}

// ───────── static scan ─────────

const stripComments = (text) =>
  text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const LOOPBACK = String.raw`(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|host\.docker\.internal)`;

/** Pure: what a script needs permission for, and which ports it touches. */
export function scan(text) {
  const code = stripComments(text);
  const needs = new Set();
  const why = [];
  const flag = (need, reason) => { needs.add(need); why.push(`${need}: ${reason}`); };

  if (/(^|[\s;&|(])(docker|colima|docker-compose|podman)(\s|$)/m.test(code)) flag("docker", "uses docker/colima");

  // A fetch of a non-loopback literal host. `.test`, `.example`, `.invalid` and
  // `.localhost` are reserved names, used in the proofs as config values only.
  const reserved = String.raw`[^/\s"']*\.(?:test|example|invalid|localhost)\b`;
  const hostRe = new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*?https?://(?!${LOOPBACK}|${reserved})[A-Za-z0-9]`, "m");
  const pyRe = new RegExp(String.raw`\b(?:urlopen|requests\.(?:get|post)|httpx\.|fetch)\(\s*[f]?["']https?://(?!${LOOPBACK}|${reserved})[A-Za-z0-9]`, "m");
  if (hostRe.test(code) || pyRe.test(code)) flag("external", "fetches a non-loopback host");
  if (/(^|[\s;&|(])(aws|b2|gcloud|wrangler|cloudflared|stripe|ssh|scp|rsync|sftp|gh)\s/m.test(code))
    flag("external", "runs a cloud/provider/remote CLI");

  if (/(^|[\s;&|(])(source|\.)\s+[^\s;]*\.env\b(?!\.example)/m.test(code)
      || /\b(?:cat|less|more|grep|cp|mv)\s+[^\s;|]*\.env\b(?!\.example)/m.test(code)
      || /--env-file|\bset\s+-a\b|~\/\.aws|\.aws\/credentials|\.netrc|\.ssh\//.test(code))
    flag("credentials", "reads an env file or credential store");

  if (/\brm\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:["']?(?:\/|~|\.\.|\$HOME|\$\{HOME\}))/m.test(code)
      || /\b(?:pkill|killall)\b/.test(code)
      || /\bdocker\s+(?:volume|system|network)\s+(?:rm|prune)/.test(code)
      || /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|push|checkout\s+--|stash\s+drop)/.test(code)
      || /\bsudo\b|\bsysctl\b|\bpfctl\b|\bifconfig\b/.test(code))
    flag("destructive", "deletes outside its temp dir, force-kills by name, or changes git/host state");

  return { needs: [...needs].sort(), why, ports: portsOf(code) };
}

/** Ports a script binds, kills or probes, resolved from literal assignments. */
export function portsOf(code) {
  const ports = new Set();
  const add = (n) => { n = Number(n); if (n >= 1000 && n <= 65535) ports.add(n); };
  for (const m of code.matchAll(/\b[A-Z][A-Z0-9_]*(?:PORT|GW|MIN|API|WORKER)[A-Z0-9_]*=(\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:GW|MIN|PORT)=(\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/lsof\s+-ti:?\s*(\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):(\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/--address\s+:(\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/--port[ =](\d{4,5})\b/g)) add(m[1]);
  for (const m of code.matchAll(/-p\s+(\d{4,5}):\d{2,5}/g)) add(m[1]);
  return [...ports].sort((a, b) => a - b);
}

/** True when something already listens on 127.0.0.1:port or [::1]:port. */
export function portInUse(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

// ───────── result classification ─────────

const SKIP_LINE = /^\s*SKIP(?:PED)?\b/m;
const FAIL_LINE = /^\s*(?:[-*•✗✘❌]\s*)?FAIL(?:ED)?\b/m;

/** Pure: decide a status from how a script ended. */
export function classifyResult({ code, signal = null, timedOut = false, output = "" }) {
  if (timedOut) return { status: STATUS.FAIL, reason: "timed out" };
  if (signal) return { status: STATUS.FAIL, reason: `terminated by ${signal}` };
  if (code === null || code === undefined) return { status: STATUS.FAIL, reason: "no exit status" };
  if (code !== 0) return { status: STATUS.FAIL, reason: `exit ${code}` };
  if (FAIL_LINE.test(output)) return { status: STATUS.FAIL, reason: "exit 0 but the output reports FAIL" };
  if (SKIP_LINE.test(output)) {
    const line = output.split("\n").find((l) => SKIP_LINE.test(l))?.trim() ?? "";
    return { status: STATUS.SKIP, reason: line.slice(0, 160) || "script reported SKIP" };
  }
  return { status: STATUS.PASS, reason: "" };
}

/** Pure: tally results into counts, a verdict line and an exit code. */
export function summarize(results, { discovered, selected }) {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, NOT_RUN: 0 };
  for (const r of results) counts[r.status] += 1;
  const partial = selected < discovered;
  let exitCode, verdict;
  if (counts.FAIL > 0) {
    exitCode = 1; verdict = `FAILED: ${counts.FAIL} failing`;
  } else if (counts.SKIP > 0 || counts.NOT_RUN > 0) {
    exitCode = 2;
    verdict = `INCOMPLETE, NOT AN ACCEPTANCE: ${counts.SKIP} skipped, ${counts.NOT_RUN} not run`;
  } else if (selected === 0) {
    exitCode = 2; verdict = "INCOMPLETE, NOT AN ACCEPTANCE: no proof scripts selected";
  } else if (partial) {
    exitCode = 0;
    verdict = `SELECTION PASSED (${selected} of ${discovered} discovered scripts), NOT a full-suite acceptance`;
  } else {
    exitCode = 0; verdict = `ACCEPTED: all ${discovered} discovered proof scripts passed`;
  }
  return { counts, verdict, exitCode, acceptance: exitCode === 0 && !partial && selected > 0 };
}

// ───────── execution ─────────

/** Only these variables reach a proof. Ambient credentials never do. */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "JAVA_HOME",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY"];
export function scrubbedEnv(source = process.env) {
  const env = {};
  for (const k of ENV_ALLOW) if (source[k] !== undefined) env[k] = source[k];
  // A gateway started without B2_S3_ENDPOINT loads the repository .env, which
  // holds real credentials. Pre-setting these (to an unroutable loopback port)
  // keeps that path closed for any script; proofs override them as they need.
  env.B2_S3_ENDPOINT = "http://127.0.0.1:9";
  env.B2_KEY_ID = "runner-synthetic";
  env.B2_APP_KEY = "runner-synthetic";
  env.B2_BUCKET = "runner-synthetic";
  return env;
}

export function runScript(file, { timeoutMs, cwd, env = scrubbedEnv(), keepBytes = 8192 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    const child = spawn("bash", [file], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const take = (b) => { output += b.toString("utf8"); if (output.length > 4_000_000) output = output.slice(-2_000_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true; killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, signal: null, timedOut, output: String(e), ms: Date.now() - started, tail: String(e) }); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, output, ms: Date.now() - started, tail: output.slice(-keepBytes) });
    });
  });
}

export const nameOf = (file) => path.basename(file).replace(/-proof\.sh$/, "");

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Decide whether to run a script, from its scan, the opt-in flags and an optional
 *  human review. A review is a recorded judgment that a scan hit is benign for
 *  THIS exact script (bound to its sha256), for example a string literal that the
 *  scanner mistook for a command. Editing the script invalidates it. */
export async function gate(scanResult, flags, inUse = portInUse, review = null, hash = "") {
  const missing = [];
  let stale = false;
  for (const need of scanResult.needs) {
    if (flags[need]) continue;
    if (review && Array.isArray(review.allow) && review.allow.includes(need)) {
      if (review.sha256 === hash) continue;
      stale = true;
    }
    missing.push(need);
  }
  if (missing.length) {
    const detail = scanResult.why.filter((w) => missing.includes(w.split(":")[0])).join("; ");
    return { run: false, reason: stale
      ? `reviewed exception is stale: the script changed since it was reviewed (${detail})`
      : `needs --${missing.join(" --")} (${detail})` };
  }
  for (const p of scanResult.ports)
    if (await inUse(p)) return { run: false, reason: `port ${p} is already in use; the script would bind or terminate its owner` };
  return { run: true, reason: "" };
}

export function loadReviews(file) {
  if (!file || !existsSync(file)) return {};
  const data = JSON.parse(readFileSync(file, "utf8"));
  return data && typeof data === "object" ? data : {};
}

// ───────── CLI ─────────

export function parseArgs(argv) {
  const o = { list: false, only: [], skip: [], docker: false, external: false, credentials: false, destructive: false,
    timeout: 900, json: null, dir: null };
  const need = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") o.list = true;
    else if (["--docker", "--external", "--credentials", "--destructive"].includes(a)) o[a.slice(2)] = true;
    else if (a === "--only") { o.only = need(i, a).split(",").filter(Boolean); i++; }
    else if (a === "--skip") { o.skip = need(i, a).split(",").filter(Boolean); i++; }
    else if (a === "--timeout") { o.timeout = Number(need(i, a)); i++; if (!(o.timeout > 0)) throw new Error("--timeout must be a positive number of seconds"); }
    else if (a === "--json") { o.json = need(i, a); i++; }
    else if (a === "--dir") { o.dir = need(i, a); i++; }
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const matches = (name, terms) => terms.some((t) => name === t || name.includes(t));

export async function main(argv, { out = (s) => process.stdout.write(s + "\n"), inUse = portInUse } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(`error: ${e.message}`); return 3; }
  if (opts.help) {
    out("usage: node scripts/run-proofs.mjs [--list] [--only a,b] [--skip a,b] [--docker] [--external] [--credentials] [--destructive] [--timeout S] [--json FILE] [--dir DIR]");
    return 0;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(opts.dir ?? here);
  const repo = path.resolve(dir, opts.dir ? "." : "..");
  let files;
  try { files = discover(dir); } catch (e) { out(`error: cannot read ${dir}: ${e.message}`); return 3; }
  const discovered = files.length;
  const unknown = [...opts.only, ...opts.skip].filter((t) => !files.some((f) => matches(nameOf(f), [t])));
  if (unknown.length) { out(`error: no proof script matches: ${unknown.join(", ")}`); return 3; }
  const selectedFiles = files.filter((f) =>
    (opts.only.length === 0 || matches(nameOf(f), opts.only)) && !matches(nameOf(f), opts.skip));

  let reviews;
  try { reviews = loadReviews(path.join(dir, "proof-review.json")); } catch (e) { out(`error: proof-review.json is not valid JSON: ${e.message}`); return 3; }
  const results = [];
  for (const file of selectedFiles) {
    const name = nameOf(file);
    const text = readFileSync(file, "utf8");
    const sc = scan(text);
    if (opts.list) {
      const rv = reviews[name];
      const reviewed = rv && rv.sha256 === sha256(text) ? ` reviewed=[${(rv.allow ?? []).join(",")}]` : rv ? " review=STALE" : "";
      out(`${name.padEnd(28)} needs=[${sc.needs.join(",")}] ports=[${sc.ports.join(",")}]${reviewed}`);
      continue;
    }
    const g = await gate(sc, opts, inUse, reviews[name] ?? null, sha256(text));
    if (!g.run) {
      results.push({ name, status: STATUS.NOT_RUN, reason: g.reason, ms: 0 });
      out(`NOT_RUN  ${name}  (${g.reason})`);
      continue;
    }
    out(`running  ${name} ...`);
    const r = await runScript(file, { timeoutMs: opts.timeout * 1000, cwd: repo });
    const c = classifyResult(r);
    results.push({ name, status: c.status, reason: c.reason, ms: r.ms, tail: c.status === STATUS.PASS ? undefined : r.tail });
    out(`${c.status.padEnd(8)} ${name}  ${(r.ms / 1000).toFixed(1)}s${c.reason ? `  (${c.reason})` : ""}`);
    if (c.status === STATUS.FAIL) out(r.tail.split("\n").slice(-12).map((l) => `    | ${l}`).join("\n"));
  }
  if (opts.list) { out(`${discovered} discovered, ${selectedFiles.length} selected`); return 0; }

  const sum = summarize(results, { discovered, selected: selectedFiles.length });
  out("");
  out(`${sum.counts.PASS} passed, ${sum.counts.FAIL} failed, ${sum.counts.SKIP} skipped, ${sum.counts.NOT_RUN} not run (of ${selectedFiles.length} selected, ${discovered} discovered)`);
  for (const r of results.filter((x) => x.status !== STATUS.PASS)) out(`  ${r.status.padEnd(8)} ${r.name}: ${r.reason}`);
  out(sum.verdict);
  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({ discovered, selected: selectedFiles.length, ...sum, results }, null, 2) + "\n");
    out(`report written to ${opts.json}`);
  }
  return sum.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(3); });
}
