// The Docker proofs must be safe BEFORE anyone approves running them. Nothing here executes
// Docker: guard behaviour is tested by sourcing the library in plan mode, the four proof
// scripts are exercised in plan mode (they print the commands and stop), and a stub `docker`
// on PATH records any call that would reach a real daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dockerEnv, parseArgs, scrubbedEnv } from "../run-proofs.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIB = path.join(repo, "scripts/lib/docker-isolation.sh");
const SCRIPTS = ["docker", "archive-tools-docker", "broadcast-qc-docker"].map((n) => path.join(repo, `scripts/${n}-proof.sh`));
const COMPUTE = path.join(repo, "scripts/compute-proof.sh");   // BLOCKED pending a reviewed network plan

const stubDir = mkdtempSync(path.join(os.tmpdir(), "dk-stub-"));
const stubLog = path.join(stubDir, "calls.log");
writeFileSync(path.join(stubDir, "docker"), `#!/bin/sh\necho "$@" >> "${stubLog}"\ncase "$1" in info) exit 0;; esac\nexit 99\n`);
chmodSync(path.join(stubDir, "docker"), 0o755);
const stubCalls = () => (existsSync(stubLog) ? readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean) : []);
const resetStub = () => rmSync(stubLog, { force: true });
test.after(() => rmSync(stubDir, { recursive: true, force: true }));

const sh = (script, env = {}) => spawnSync("bash", ["-c", script], {
  encoding: "utf8", cwd: repo,
  env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: os.tmpdir(), ...env },
});
// source the library in plan mode and call ws_dk; print the exit status
const guard = (call, env = {}) => {
  const r = sh(`WEB="${repo}"; . "${LIB}"; ws_dk_begin t; ${call}; echo "rc=$?"`, { WS_DOCKER_PLAN: "1", ...env });
  const rc = Number(/rc=(\d+)/.exec(r.stdout)?.[1] ?? NaN);
  return { rc, out: r.stdout, err: r.stderr };
};
const RUN = (extra = "") => `ws_dk run --rm --name "$WS_DK_RUN_ID-x" --label "$WS_DK_LABEL" --network none ${extra} img`;
const RUN_NET = (net) => `ws_dk run --rm --name "$WS_DK_RUN_ID-x" --label "$WS_DK_LABEL" ${net} img`;

test("guard: shared-resource and destructive docker commands are refused", () => {
  for (const call of ["ws_dk system prune -af", "ws_dk volume prune -f", "ws_dk network prune -f", "ws_dk container prune -f",
    "ws_dk image prune -a", "ws_dk image rm x", "ws_dk image tag a b", "ws_dk tag a b", "ws_dk rmi x", "ws_dk commit c i",
    "ws_dk push i", "ws_dk login", "ws_dk save i", "ws_dk load", "ws_dk context use x", "ws_dk compose up", "ws_dk volume rm shared-vol"]) {
    const g = guard(call);
    assert.notEqual(g.rc, 0, `${call} must be refused`);
    assert.match(g.err, /REFUSED/, call);
    assert.doesNotMatch(g.out, /PLAN docker/, `${call} must not even be planned`);
  }
});

test("guard: a run needs a run-specific name and label, and may not mount, env-file, go privileged or host-network", () => {
  assert.equal(guard(RUN()).rc, 0);
  assert.notEqual(guard('ws_dk run --rm --label "$WS_DK_LABEL" img').rc, 0, "no --name");
  assert.notEqual(guard('ws_dk run --rm --name shared-name --label "$WS_DK_LABEL" img').rc, 0, "name not for this run");
  assert.notEqual(guard('ws_dk run --rm --name "$WS_DK_RUN_ID-x" img').rc, 0, "no label");
  for (const bad of ["-v /Users/me:/data", "--volume /x:/y", "--mount type=bind,src=/x,dst=/y", "--env-file .env", "--privileged",
    "--network host", "--net host", "--pid host", "--pid=host", "-v /var/run/docker.sock:/var/run/docker.sock"]) {
    const g = guard(RUN(bad));
    assert.notEqual(g.rc, 0, `${bad} must be refused`);
    assert.match(g.err, /REFUSED/);
  }
});

test("guard: published ports must bind 127.0.0.1", () => {
  assert.equal(guard(RUN("-p 127.0.0.1:18787:8787")).rc, 0);
  for (const bad of ["-p 8787:8787", "-p 0.0.0.0:8787:8787", "--publish 9000:9000", "-p :8787"])
    assert.notEqual(guard(RUN(bad)).rc, 0, bad);
});

// Not plan mode: a refusal returns before docker; an allowed call reaches the (stub) docker.
const live = (call, env = {}) => {
  resetStub();
  const r = sh(`WEB="${repo}"; . "${LIB}"; WS_DK_RUN_ID=wsproof-t-1-1; WS_DK_LABEL=wsproof.run=$WS_DK_RUN_ID; ${call}; echo "rc=$?"`, env);
  return { rc: Number(/rc=(\d+)/.exec(r.stdout)?.[1] ?? NaN), calls: stubCalls(), err: r.stderr };
};

test("guard: build and pull are refused unless authorized, and a build may tag only wsproof/<name>:<run id>", () => {
  const refused = live("ws_dk build -t wsproof/worker:wsproof-t-1-1 ctx");
  assert.equal(refused.rc, 96); assert.deepEqual(refused.calls, []);
  const refusedPull = live("ws_dk pull minio/minio");
  assert.equal(refusedPull.rc, 96); assert.deepEqual(refusedPull.calls, []);
  const allow = { WS_DOCKER_ALLOW_BUILD: "1", WS_DOCKER_ALLOW_PULL: "1" };
  const ok = live("ws_dk build -t wsproof/worker:wsproof-t-1-1 ctx", allow);
  assert.equal(ok.calls.length, 1, "an authorized, run-tagged build reaches docker");
  for (const tag of ["waystation-worker:latest", "waystation-worker:local", "wsproof/worker:latest", "wsproof/worker:other-run", "latest"]) {
    const r = live(`ws_dk build -t ${tag} ctx`, allow);
    assert.equal(r.rc, 96, tag); assert.deepEqual(r.calls, [], tag);
  }
  assert.equal(live("ws_dk build ctx", allow).rc, 96, "an untagged build is refused");
  assert.equal(live("ws_dk pull minio/minio", allow).calls.length, 1);
});

test("guard: rm / stop / kill / exec / network and volume removal only name this run's objects", () => {
  for (const verb of ["rm -f", "stop", "kill", "exec"]) {
    assert.notEqual(guard(`ws_dk ${verb} orbisphere-stage2-mariadb`).rc, 0, `${verb} on a stranger`);
    assert.notEqual(guard(`ws_dk ${verb} waystation-local-cloud-worker`).rc, 0, `${verb} on a stranger`);
    assert.equal(guard(`ws_dk ${verb} "$WS_DK_RUN_ID-worker"${verb === "exec" ? " true" : ""}`).rc, 0, `${verb} on this run's container`);
  }
  assert.notEqual(guard("ws_dk network rm somebody-elses-net").rc, 0);
  assert.equal(guard('ws_dk network rm "$WS_DK_RUN_ID-net"').rc, 0);
  assert.notEqual(guard("ws_dk network create plainnet").rc, 0, "unlabelled network");
  assert.equal(guard('ws_dk network create --label "$WS_DK_LABEL" "$WS_DK_RUN_ID-net"').rc, 0);
});

test("guard: only docker's subcommand tokens are inspected, not the text of a container script", () => {
  const g = guard(RUN(`--entrypoint sh`) .replace(" img", ` img -c 'python -c "from qc import x; import os"; echo tag export system commit'`));
  assert.equal(g.rc, 0, g.err);
});

test("begin: without approval nothing touches docker, not even `docker info`", () => {
  resetStub();
  const r = sh(`WEB="${repo}"; . "${LIB}"; ws_dk_begin t; echo "not reached"`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SKIP - Docker proofs run only with explicit approval/m);
  assert.doesNotMatch(r.stdout, /not reached/);
  assert.deepEqual(stubCalls(), []);
});

test("blocked: an approved run with no suitable image is a SKIP/BLOCKED, never a build or pull", () => {
  resetStub();
  const r = sh(`WEB="${repo}"; . "${LIB}"; ws_dk_begin t; ws_dk_obtain_image worker; echo "not reached"`, { WS_DOCKER_APPROVED: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SKIP - BLOCKED: no suitable worker image/m);
  assert.doesNotMatch(r.stdout, /not reached/);
  assert.deepEqual(stubCalls(), ["info"], "only the reachability probe may run, and it must reach the stub");
});

test("blocked: a named image that does not exist locally is BLOCKED, not pulled", () => {
  resetStub();
  const r = sh(`WEB="${repo}"; . "${LIB}"; ws_dk_begin t; ws_dk_obtain_image worker`, { WS_DOCKER_APPROVED: "1", WS_PROOF_WORKER_IMAGE: "no-such:image" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^SKIP - BLOCKED: image 'no-such:image'/m);
  assert.equal(stubCalls()[0], "info", "the stub must have answered the probe");
  assert.ok(stubCalls().every((c) => c === "info" || c.startsWith("image inspect")), stubCalls().join("|"));
});

// ───────── the four proof scripts, in plan mode ─────────

const plan = (script, env = {}) => {
  resetStub();
  const r = spawnSync("bash", [script], {
    encoding: "utf8", cwd: repo,
    env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: mkdtempSync(path.join(os.tmpdir(), "dk-plan-")),
      WS_DOCKER_PLAN: "1", ...env },
  });
  return { status: r.status, out: r.stdout + r.stderr, plan: (r.stdout + r.stderr).split("\n").filter((l) => l.startsWith("PLAN docker")), calls: stubCalls() };
};
const withImages = { WS_PROOF_WORKER_IMAGE: "some/worker:ref", WS_PROOF_GATEWAY_IMAGE: "some/gateway:ref", WS_PROOF_MINIO_IMAGE: "some/minio:ref" };

for (const script of SCRIPTS) {
  const name = path.basename(script);

  test(`${name}: plan mode prints isolated commands and executes nothing`, () => {
    const p = plan(script, withImages);
    assert.equal(p.status, 0, p.out);
    assert.deepEqual(p.calls, [], "plan mode must never reach docker");
    assert.ok(p.plan.length > 0, "no planned commands");
    assert.match(p.out, /PLAN-ONLY|PLAN MODE/);
    for (const line of p.plan) {
      assert.doesNotMatch(line, /\bprune\b|\bdown\b|--env-file|\.env\b|docker\.sock| -v |--volume|--mount|--privileged|--network host|\bcompose\b/, line);
      assert.doesNotMatch(line, /(^| )(tag|rmi|commit|push|login|system)( |$)/, line);
      assert.doesNotMatch(line, /waystation-(worker|gateway)[^ ]*:(latest|local)/, line);
      if (/^PLAN docker (run|create)/.test(line)) {
        assert.match(line, / --name wsproof-/, line);
        assert.match(line, / --label wsproof\.run=wsproof-/, line);
        assert.match(line, / --memory /, line);
        assert.match(line, / --cap-drop ALL/, line);
        assert.match(line, / --security-opt no-new-privileges/, line);
        for (const m of line.matchAll(/ (?:-p|--publish) (\S+)/g)) assert.match(m[1], /^127\.0\.0\.1:/, line);
      }
    }
  });

  test(`${name}: with no image named and no build authorized, it is BLOCKED with no build or pull`, () => {
    resetStub();
    const r = spawnSync("bash", [script], {
      encoding: "utf8", cwd: repo,
      env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: mkdtempSync(path.join(os.tmpdir(), "dk-blk-")), WS_DOCKER_APPROVED: "1" },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^SKIP - BLOCKED: no suitable worker image/m);
    assert.deepEqual(stubCalls(), ["info"], `the stub must have answered exactly the reachability probe, got: ${stubCalls().join(" | ")}`);
  });

  test(`${name}: refuses to run at all without approval`, () => {
    resetStub();
    const r = spawnSync("bash", [script], {
      encoding: "utf8", cwd: repo,
      env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: mkdtempSync(path.join(os.tmpdir(), "dk-na-")) },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^SKIP/m);
    assert.deepEqual(stubCalls(), []);
  });

  test(`${name}: static rules, no compose project, prune, env file, host mount, port-wide kill or shared tag`, () => {
    const code = readFileSync(script, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
    assert.doesNotMatch(code, /docker compose|docker-compose|\bdown -v\b|\bprune\b|--env-file|env_file/);
    assert.doesNotMatch(code, /^\s*docker\s/m, "every docker call must go through ws_dk");
    assert.doesNotMatch(code, /lsof[^\n]*xargs kill|xargs kill/, "no port-wide kill");
    assert.doesNotMatch(code, /waystation-[a-z-]+:(latest|local)|-t\s+"?waystation/);
    assert.match(code, /docker-isolation\.sh/);
  });
}

test("docker-proof's plan names a labelled network and three containers for this run only", () => {
  const p = plan(SCRIPTS[0], withImages);
  const runs = p.plan.filter((l) => /^PLAN docker run -d/.test(l));
  assert.equal(runs.length, 3);
  assert.equal(p.plan.filter((l) => /^PLAN docker network create/.test(l)).length, 1);
  assert.ok(p.plan.some((l) => /PLAN cleanup: remove containers, networks and volumes labelled wsproof\.run=/.test(l)) || /PLAN cleanup/.test(p.out));
});

test("image identity: with an image named, the plan verifies its application files before using it", () => {
  const p = plan(SCRIPTS[2], withImages);
  assert.ok(p.plan.some((l) => /--network none/.test(l) && /find requirements\.txt worker\.py qc policies/.test(l) && /sha256sum/.test(l)), p.plan.join("\n"));
});

test("with no image named, a plan shows a build only to a run-specific wsproof/ tag", () => {
  const p = plan(SCRIPTS[2], {});
  const builds = p.plan.filter((l) => /^PLAN docker build/.test(l));
  assert.equal(builds.length, 1);
  assert.match(builds[0], / -t wsproof\/worker:wsproof-/);
});

// ───────── the runner side ─────────

test("runner: --docker-build and --docker-pull imply --docker and are never on by default", () => {
  const d = parseArgs([]); assert.equal(d.docker, false); assert.equal(d.dockerBuild, false); assert.equal(d.dockerPull, false);
  const b = parseArgs(["--docker-build"]); assert.equal(b.docker, true); assert.equal(b.dockerBuild, true); assert.equal(b.dockerPull, false);
  const p = parseArgs(["--docker-pull"]); assert.equal(p.docker, true); assert.equal(p.dockerPull, true); assert.equal(p.dockerBuild, false);
});

test("runner: the scrubbed environment never carries docker approval, and dockerEnv adds it only when asked", () => {
  const base = scrubbedEnv({ PATH: "/bin", HOME: "/h", WS_DOCKER_APPROVED: "1", WS_DOCKER_ALLOW_BUILD: "1", DOCKER_HOST: "unix:///x" }, "/run");
  for (const k of ["WS_DOCKER_APPROVED", "WS_DOCKER_ALLOW_BUILD", "WS_DOCKER_ALLOW_PULL", "DOCKER_HOST", "DOCKER_CONFIG"]) assert.equal(base[k], undefined, k);
  assert.deepEqual(dockerEnv({ docker: false }, "/run", {}, () => "x"), {});
  const e = dockerEnv({ docker: true }, "/run", { WS_PROOF_WORKER_IMAGE: "w:1", HOME: "/h", STRIPE_SECRET_KEY: "no" }, () => "unix:///colima.sock");
  assert.equal(e.WS_DOCKER_APPROVED, "1");
  assert.equal(e.WS_DOCKER_ALLOW_BUILD, undefined);
  assert.equal(e.WS_DOCKER_ALLOW_PULL, undefined);
  assert.equal(e.WS_PROOF_WORKER_IMAGE, "w:1");
  assert.equal(e.DOCKER_HOST, "unix:///colima.sock");
  assert.equal(e.DOCKER_CONFIG, "/run/docker-config", "the CLI must not read ~/.docker");
  assert.equal(e.STRIPE_SECRET_KEY, undefined);
  const full = dockerEnv({ docker: true, dockerBuild: true, dockerPull: true }, "/run", {}, () => "");
  assert.equal(full.WS_DOCKER_ALLOW_BUILD, "1"); assert.equal(full.WS_DOCKER_ALLOW_PULL, "1");
});

// ───────── review corrections: targets, names, networks, executable precedence ─────────

test("guard: removal and exec validate EVERY target, so one owned name cannot launder a stranger", () => {
  const O = '"$WS_DK_RUN_ID-worker"';
  const mixed = [
    `ws_dk rm -f ${O} orbisphere-stage2-mariadb`, `ws_dk rm -f orbisphere-stage2-mariadb ${O}`, `ws_dk rm ${O} ${O} stranger`,
    `ws_dk stop -t 1 ${O} stranger`, `ws_dk stop stranger ${O}`, `ws_dk restart ${O} stranger`,
    `ws_dk kill -s KILL ${O} stranger`, `ws_dk kill --signal=KILL stranger ${O}`,
    `ws_dk exec stranger ${O}`, `ws_dk exec -e A=1 -u root stranger sh -c true`,
    `ws_dk network rm "$WS_DK_RUN_ID-net" somebody-elses-net`, `ws_dk network rm somebody-elses-net "$WS_DK_RUN_ID-net"`,
    `ws_dk volume rm -f "$WS_DK_RUN_ID-v" shared-volume`, `ws_dk volume rm shared-volume`,
    `ws_dk network create --label "$WS_DK_LABEL" plain-name`, `ws_dk volume create --label "$WS_DK_LABEL" plain-name`,
    `ws_dk rm -f`, `ws_dk stop`,
  ];
  for (const call of mixed) { const g = guard(call); assert.notEqual(g.rc, 0, `${call} must be refused`); assert.match(g.err, /REFUSED/, call); }
  const fine = [
    `ws_dk rm -f ${O} "$WS_DK_RUN_ID-minio"`, `ws_dk stop -t 1 ${O} "$WS_DK_RUN_ID-minio"`, `ws_dk kill -s KILL ${O}`,
    `ws_dk exec -e A=1 -u root ${O} sh -c 'echo $PATH; ls /tmp'`, 'ws_dk network rm "$WS_DK_RUN_ID-net"',
    'ws_dk volume rm -f "$WS_DK_RUN_ID-v"', 'ws_dk network create --label "$WS_DK_LABEL" "$WS_DK_RUN_ID-net"',
  ];
  for (const call of fine) { const g = guard(call); assert.equal(g.rc, 0, `${call} should be allowed: ${g.err}`); }
});

test("guard: ownership is the run id or '<run id>-suffix', not a bare prefix", () => {
  for (const call of ['ws_dk rm -f "${WS_DK_RUN_ID}9-worker"', 'ws_dk rm -f "${WS_DK_RUN_ID}x"',
    'ws_dk run --rm --name "${WS_DK_RUN_ID}9" --label "$WS_DK_LABEL" --network none img',
    'ws_dk run --rm --name "${WS_DK_RUN_ID}-x" --label "$WS_DK_LABEL" --network "${WS_DK_RUN_ID}9-net" img'])
    assert.notEqual(guard(call).rc, 0, call);
  assert.equal(guard('ws_dk rm -f "$WS_DK_RUN_ID"').rc, 0);
  assert.equal(guard('ws_dk run --rm --name "$WS_DK_RUN_ID" --label "$WS_DK_LABEL" --network none img').rc, 0);
});

test("guard: a container joins no shared network (default bridge, host, another project's network) and gains no mounts, devices, links, capabilities or host aliases", () => {
  assert.equal(guard(RUN_NET("--network none")).rc, 0);
  assert.equal(guard(RUN_NET('--network "$WS_DK_RUN_ID-net"')).rc, 0);
  assert.equal(guard(RUN_NET('--net="$WS_DK_RUN_ID-net"')).rc, 0);
  for (const net of ["", "--network bridge", "--network host", "--network somebody-net", "--network=bridge", "--net=orbisphere-net"])
    assert.notEqual(guard(RUN_NET(net)).rc, 0, `network ${JSON.stringify(net)}`);
  for (const bad of ["--volumes-from other", "--link other:o", "--device /dev/fuse", "--cap-add NET_ADMIN", "--add-host host.docker.internal:host-gateway",
    "--cgroup-parent /x", "--uts host", "--userns host"])
    assert.notEqual(guard(RUN(bad)).rc, 0, bad);
});

test("executable precedence: the docker binary is pinned when the library is sourced, so a later PATH edit cannot swap it", () => {
  resetStub();
  const poison = mkdtempSync(path.join(os.tmpdir(), "dk-poison-"));
  writeFileSync(path.join(poison, "docker"), `#!/bin/sh\necho POISON >> "${stubLog}"\nexit 98\n`);
  chmodSync(path.join(poison, "docker"), 0o755);
  try {
    const r = sh(`WEB="${repo}"; . "${LIB}"; PATH="${poison}:$PATH"; ws_dk_begin t; ws_dk info; echo "bin=$WS_DK_BIN"`, { WS_DOCKER_APPROVED: "1" });
    assert.match(r.stdout, new RegExp(`bin=${stubDir}/docker`), r.stdout + r.stderr);
    assert.deepEqual(stubCalls(), ["info", "info"], "both calls must reach the pinned stub, never the poisoned PATH entry");
    assert.equal(sh(`WEB="${repo}"; WS_DOCKER_BIN="${path.join(poison, "docker")}"; . "${LIB}"; echo "bin=$WS_DK_BIN"`).stdout.trim(), `bin=${path.join(poison, "docker")}`, "WS_DOCKER_BIN pins explicitly");
  } finally { rmSync(poison, { recursive: true, force: true }); }
});

test("executable precedence: each Docker proof sources the library before it edits PATH, and nothing calls a bare `docker`", () => {
  for (const script of SCRIPTS) {
    const lines = readFileSync(script, "utf8").split("\n");
    const src = lines.findIndex((l) => /^\.\s+"\$WEB\/scripts\/lib\/docker-isolation\.sh"/.test(l));
    const pathEdit = lines.findIndex((l) => /^\s*export PATH=|^\s*PATH=/.test(l));
    assert.ok(src >= 0, `${path.basename(script)} must source the library`);
    if (pathEdit >= 0) assert.ok(src < pathEdit, `${path.basename(script)} edits PATH (line ${pathEdit + 1}) before sourcing the library (line ${src + 1})`);
  }
  const lib = readFileSync(LIB, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(lib, /(^|[\s;&|(`])command docker\b|(^|[;&|(`])\s*docker\s|\$\(docker\s|\bdocker info\b[^"]*>/m, "every daemon call must use \"$WS_DK_BIN\"");
});

test("every Docker proof run reaches the stub: an approved run records its calls there", () => {
  for (const script of SCRIPTS) {
    resetStub();
    const r = spawnSync("bash", [script], { encoding: "utf8", cwd: repo,
      env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: mkdtempSync(path.join(os.tmpdir(), "dk-stub-run-")), WS_DOCKER_APPROVED: "1" } });
    assert.equal(r.status, 0, path.basename(script) + r.stdout + r.stderr);
    assert.deepEqual(stubCalls(), ["info"], `${path.basename(script)} did not reach the stub (a real docker would have been used)`);
  }
});

// ───────── compute-proof: BLOCKED, issues no Docker command, exposes nothing ─────────

test("compute-proof is explicitly BLOCKED: it runs only its static checks and never starts a listener or touches docker, even when approved", () => {
  for (const env of [{}, { WS_DOCKER_APPROVED: "1", WS_DOCKER_ALLOW_BUILD: "1", WS_DOCKER_ALLOW_PULL: "1" }, { WS_DOCKER_PLAN: "1" }]) {
    resetStub();
    const r = spawnSync("bash", [COMPUTE], { encoding: "utf8", cwd: repo,
      env: { PATH: `${stubDir}:/usr/bin:/bin:/opt/homebrew/bin`, HOME: os.homedir(), TMPDIR: mkdtempSync(path.join(os.tmpdir(), "dk-compute-")), ...env } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^SKIP - BLOCKED: the live compute-routing half needs a reviewed private network plan/m);
    assert.deepEqual(stubCalls(), [], "compute-proof must issue no Docker command");
  }
  const code = readFileSync(COMPUTE, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /minio server|uvicorn|tsx|--address|0\.0\.0\.0|host\.docker\.internal|host-gateway|ws_dk|\bdocker\b|-p\s+\d/, "no listener, host alias or docker call may remain");
});
