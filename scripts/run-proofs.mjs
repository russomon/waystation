#!/usr/bin/env node
// Discovery-based proof runner.
//
//   node scripts/run-proofs.mjs [--list] [--only a,b] [--skip a,b]
//        [--docker] [--docker-build] [--docker-pull] [--external]
//        [--timeout SECONDS] [--json FILE] [--dir DIR]
//
// It discovers `*-proof.sh` under scripts/ (or --dir), runs them one at a time,
// and reports each as exactly one of:
//
//   PASS     exit 0, no SKIP line, no FAIL line
//   FAIL     non-zero exit, a timeout, or exit 0 while printing a FAIL line
//   SKIP     the script ran but declared it skipped (missing tool, partial run)
//   NOT_RUN  the runner refused to start it (see the reason)
//
// SAFETY MODEL. A proof script is arbitrary shell, and a text scan of it cannot
// prove it harmless (a URL or a path can sit in a variable, a script can call
// another script). So nothing here relies on reading the script. Every script
// runs inside an OS sandbox (macOS sandbox-exec) that ENFORCES the limits:
//
//   * network: loopback only. No other host is reachable; nothing is "approved"
//     by the text of the script. (--external lifts this.)
//   * docker: the Docker/Colima sockets are unreachable. (--docker lifts this, and tells
//     the Docker proofs they are approved; --docker-build / --docker-pull additionally
//     authorize image builds / pulls, which reach external mirrors.) The sandbox does NOT
//     constrain what the Docker daemon does for a script that can reach it: the Docker
//     proofs enforce their own isolation (scripts/lib/docker-isolation.sh).
//   * file writes: only the repository and a private, uniquely created per-run
//     temp directory (TMPDIR points at it; proofs put their logs and fixtures
//     there). Home, /tmp, /var/folders, caches, other projects and `.git` are
//     not writable, so no pre-existing file outside the run directory can be
//     created over, overwritten, truncated, appended to, renamed or deleted.
//   * file reads: `.env*`, ~/.aws, ~/.ssh, ~/.config/gcloud, ~/.docker and
//     ~/.netrc are unreadable, so an unset B2 endpoint cannot load credentials.
//   * signals: a script may signal only processes inside its own sandbox, so a
//     `lsof -ti:PORT | xargs kill` cannot terminate a process it did not start.
//
// If the sandbox is unavailable (not macOS, or sandbox-exec cannot be applied),
// every script is NOT_RUN: there is no unsandboxed mode. The old text scan
// remains only as an early, friendlier refusal for docker and external-network
// use; it is never what authorizes a run.
//
// A script is also refused (NOT_RUN) when a port it names is already in use on
// either IPv4 or IPv6 loopback, so it does not collide with a running stack.
//
// Acceptance is never implied by a partial result. Exit codes:
//   0  every discovered script PASSED (a full-suite acceptance), or, with
//      --only/--skip, every SELECTED script passed (labelled NOT a full suite)
//   1  at least one FAIL
//   2  no FAIL, but at least one SKIP or NOT_RUN: INCOMPLETE, not an acceptance
//   3  usage or internal error

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
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

// ───────── advisory scan (never an authorization) ─────────

const stripComments = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

/** Pure. Early, friendly refusal for docker / external use, plus the ports a
 *  script names. A clean scan authorizes nothing: the sandbox is the control. */
export function scan(text) {
  const code = stripComments(text);
  const needs = new Set();
  const why = [];
  const flag = (need, reason) => { needs.add(need); why.push(`${need}: ${reason}`); };
  if (/(^|[\s;&|(])(docker|colima|docker-compose|podman)(\s|$)/m.test(code) || /docker-isolation\.sh|\bws_dk\b/.test(code)) flag("docker", "uses docker/colima");
  const loopback = String.raw`(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|host\.docker\.internal)`;
  const reserved = String.raw`[^/\s"']*\.(?:test|example|invalid|localhost)\b`;
  const hostRe = new RegExp(String.raw`\b(?:curl|wget)\b[^\n]*?https?://(?!${loopback}|${reserved})[A-Za-z0-9]`, "m");
  const pyRe = new RegExp(String.raw`\b(?:urlopen|requests\.(?:get|post)|httpx\.|fetch)\(\s*[f]?["']https?://(?!${loopback}|${reserved})[A-Za-z0-9]`, "m");
  if (hostRe.test(code) || pyRe.test(code)) flag("external", "fetches a non-loopback host");
  if (/(^|[\s;&|(])(aws|b2|gcloud|wrangler|cloudflared|stripe|ssh|scp|rsync|sftp|gh)\s/m.test(code))
    flag("external", "runs a cloud/provider/remote CLI");
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

/** True when something accepts a connection on host:port. */
export function probe(port, host) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

/** A port is in use if EITHER loopback family has a listener. IPv4 alone is not
 *  enough: a process bound to ::1 is invisible to a 127.0.0.1 probe. The probe is
 *  injectable so both families are covered by deterministic tests. */
export async function portInUse(port, probeFn = probe) {
  for (const host of ["127.0.0.1", "::1"]) if (await probeFn(port, host)) return true;
  return false;
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

// ───────── the sandbox ─────────

const q = (p) => JSON.stringify(p); // SBPL string literal

/** Pure: the SBPL profile that ENFORCES the limits described at the top. */
export function buildProfile({ repo, runTmp, home, docker = false, external = false }) {
  const rules = [
    "(version 1)",
    "(allow default)",
    // network
    ...(external ? [] : [
      "(deny network-outbound)",
      '(allow network-outbound (remote ip "localhost:*"))',
      "(allow network-outbound (remote unix-socket))",
    ]),
    ...(docker ? [] : [
      '(deny network-outbound (remote unix-socket (path-regex #"docker[^/]*\\.sock$")))',
      '(deny network-outbound (remote unix-socket (path-regex #"/\\.colima/")))',
      '(deny network-outbound (remote unix-socket (path-regex #"/\\.docker/")))',
    ]),
    // signals: only inside this sandbox
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    // writes: ONLY the repository and this run's own unique temp directory (plus the
    // null/tty/random device nodes). Shared temp areas (/tmp, /var/folders) and
    // caches are NOT writable at all, so another program's temporary data cannot be
    // created over, overwritten, truncated, appended to, renamed or deleted.
    "(deny file-write*)",
    `(allow file-write* (subpath ${q(repo)}) (subpath ${q(runTmp)})` +
      ` (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom")` +
      ` (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/stdout") (literal "/dev/stderr")` +
      ` (regex #"^/dev/(fd/[0-9]+|ttys[0-9]+|pty[a-z0-9]+)$"))`,
    // never writable, even inside the repo
    `(deny file-write* (subpath ${q(path.join(repo, ".git"))}) (regex #"/\\.env[^/]*$"))`,
    // credentials unreadable
    `(deny file-read* (subpath ${q(path.join(home, ".aws"))}) (subpath ${q(path.join(home, ".ssh"))})` +
      ` (subpath ${q(path.join(home, ".config/gcloud"))}) (subpath ${q(path.join(home, ".docker"))})` +
      ` (literal ${q(path.join(home, ".netrc"))}) (regex #"/\\.env[^/]*$"))`,
    // .env.example stays readable (it holds no secret)
    `(allow file-read* (literal ${q(path.join(repo, ".env.example"))}))`,
  ];
  return rules.join("\n");
}

/** Can sandbox-exec actually apply a profile here? (It cannot be nested.) */
export function sandboxAvailable() {
  if (process.platform !== "darwin") return { ok: false, reason: "sandbox enforcement is only implemented for macOS (sandbox-exec)" };
  const r = spawnSync("sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" });
  if (r.error || r.status !== 0) return { ok: false, reason: "sandbox-exec cannot be applied in this environment (already sandboxed?)" };
  return { ok: true, reason: "" };
}

// ───────── execution ─────────

/** Only these variables reach a proof. Ambient credentials never do. */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "JAVA_HOME",
  "HOMEBREW_PREFIX", "HOMEBREW_CELLAR", "HOMEBREW_REPOSITORY"];
export function scrubbedEnv(source = process.env, runTmp) {
  const env = {};
  for (const k of ENV_ALLOW) if (source[k] !== undefined) env[k] = source[k];
  if (runTmp) {
    env.TMPDIR = runTmp;
    // Caches go to the run's own directory too (the home caches are not writable).
    env.XDG_CACHE_HOME = path.join(runTmp, "xdg-cache");
    env.npm_config_cache = path.join(runTmp, "npm-cache");
    env.npm_config_logs_dir = path.join(runTmp, "npm-logs");
    env.npm_config_update_notifier = "false";
    // The JVM ignores TMPDIR on macOS; point it (and its perf-data file) at the run directory.
    env.JAVA_TOOL_OPTIONS = `-Djava.io.tmpdir=${runTmp} -XX:-UsePerfData`;
  }
  // Belt and braces with the file-read denial: a gateway started without
  // B2_S3_ENDPOINT would try to load the repository .env. Pre-setting these keeps
  // that path closed; proofs override them as they need.
  env.B2_S3_ENDPOINT = "http://127.0.0.1:9";
  env.B2_KEY_ID = "runner-synthetic";
  env.B2_APP_KEY = "runner-synthetic";
  env.B2_BUCKET = "runner-synthetic";
  return env;
}

/** Extra environment for the Docker proofs. Nothing here is set unless --docker is given. */
export function dockerEnv(opts, runTmp, source = process.env, resolveHost = defaultDockerHost) {
  if (!opts.docker) return {};
  const env = { WS_DOCKER_APPROVED: "1", DOCKER_CONFIG: path.join(runTmp, "docker-config") };
  if (opts.dockerBuild) env.WS_DOCKER_ALLOW_BUILD = "1";
  if (opts.dockerPull) env.WS_DOCKER_ALLOW_PULL = "1";
  for (const k of ["WS_PROOF_WORKER_IMAGE", "WS_PROOF_GATEWAY_IMAGE", "WS_PROOF_MINIO_IMAGE"])
    if (source[k]) env[k] = source[k];
  const host = source.DOCKER_HOST || resolveHost();
  if (host) env.DOCKER_HOST = host;
  return env;
}

/** The current Docker context's endpoint (reads local config only; contacts no daemon). */
export function defaultDockerHost() {
  const r = spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

export function runScript(file, { timeoutMs, cwd, repo, docker = false, external = false, keepBytes = 8192, extraEnv = () => ({}) }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let timedOut = false;
    const runTmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "proof-run-")));
    const home = process.env.HOME ?? os.homedir();
    const profile = buildProfile({ repo, runTmp, home, docker, external });
    const child = spawn("sandbox-exec", ["-p", profile, "bash", file],
      { cwd, env: { ...scrubbedEnv(process.env, runTmp), ...extraEnv(runTmp) }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const take = (b) => { output += b.toString("utf8"); if (output.length > 4_000_000) output = output.slice(-2_000_000); };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const killGroup = (sig) => { try { process.kill(-child.pid, sig); } catch { /* already gone */ } };
    const timer = setTimeout(() => {
      timedOut = true; killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      killGroup("SIGKILL"); // anything the script left running inside its own group
      try { rmSync(runTmp, { recursive: true, force: true }); } catch { /* our own temp dir; best effort */ }
      resolve({ code, signal, timedOut, output, ms: Date.now() - started, tail: output.slice(-keepBytes) });
    };
    child.on("error", (e) => { output += String(e); finish(null, null); });
    child.on("close", finish);
  });
}

export const nameOf = (file) => path.basename(file).replace(/-proof\.sh$/, "");

/** Decide whether to start a script. The scan only refuses early; it never authorizes. */
export async function gate(scanResult, flags, inUse = portInUse) {
  const missing = scanResult.needs.filter((n) => !flags[n]);
  if (missing.length)
    return { run: false, reason: `needs --${missing.join(" --")} (${scanResult.why.filter((w) => missing.includes(w.split(":")[0])).join("; ")})` };
  for (const p of scanResult.ports)
    if (await inUse(p)) return { run: false, reason: `port ${p} is already in use (IPv4 or IPv6 loopback); not starting a script that binds it` };
  return { run: true, reason: "" };
}

// ───────── CLI ─────────

export function parseArgs(argv) {
  const o = { list: false, only: [], skip: [], docker: false, dockerBuild: false, dockerPull: false, external: false, timeout: 900, json: null, dir: null };
  const need = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") o.list = true;
    else if (a === "--docker" || a === "--external") o[a.slice(2)] = true;
    else if (a === "--docker-build") { o.dockerBuild = true; o.docker = true; }
    else if (a === "--docker-pull") { o.dockerPull = true; o.docker = true; }
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

export async function main(argv, { out = (s) => process.stdout.write(s + "\n"), inUse = portInUse, sandbox = sandboxAvailable() } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { out(`error: ${e.message}`); return 3; }
  if (opts.help) {
    out("usage: node scripts/run-proofs.mjs [--list] [--only a,b] [--skip a,b] [--docker] [--docker-build] [--docker-pull] [--external] [--timeout S] [--json FILE] [--dir DIR]");
    return 0;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(opts.dir ?? here);
  const repo = realpathSync(path.resolve(dir, opts.dir ? "." : ".."));
  let files;
  try { files = discover(dir); } catch (e) { out(`error: cannot read ${dir}: ${e.message}`); return 3; }
  const discovered = files.length;
  const unknown = [...opts.only, ...opts.skip].filter((t) => !files.some((f) => matches(nameOf(f), [t])));
  if (unknown.length) { out(`error: no proof script matches: ${unknown.join(", ")}`); return 3; }
  const selectedFiles = files.filter((f) =>
    (opts.only.length === 0 || matches(nameOf(f), opts.only)) && !matches(nameOf(f), opts.skip));

  const results = [];
  for (const file of selectedFiles) {
    const name = nameOf(file);
    const sc = scan(readFileSync(file, "utf8"));
    if (opts.list) {
      out(`${name.padEnd(28)} needs=[${sc.needs.join(",")}] ports=[${sc.ports.join(",")}]`);
      continue;
    }
    if (!sandbox.ok) {
      const reason = `no enforcement available: ${sandbox.reason}`;
      results.push({ name, status: STATUS.NOT_RUN, reason, ms: 0 });
      out(`NOT_RUN  ${name}  (${reason})`);
      continue;
    }
    const g = await gate(sc, opts, inUse);
    if (!g.run) {
      results.push({ name, status: STATUS.NOT_RUN, reason: g.reason, ms: 0 });
      out(`NOT_RUN  ${name}  (${g.reason})`);
      continue;
    }
    out(`running  ${name} ...`);
    const r = await runScript(file, { timeoutMs: opts.timeout * 1000, cwd: repo, repo, docker: opts.docker, external: opts.external,
      extraEnv: (runTmp) => dockerEnv(opts, runTmp) });
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
