// Guards the shared-context documents: the decision record must stay intact and
// every ADR reference anywhere in the repository's docs must resolve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (f) => readFileSync(path.join(repo, f), "utf8");
const decisions = read("DECISIONS.md");

const blocks = decisions.split(/^(?=### \[ADR-)/m).filter((b) => b.startsWith("### [ADR-"));
const ids = blocks.map((b) => b.match(/^### \[(ADR-\d{3})\]/)[1]);

test("DECISIONS.md keeps its records: ADR-001.. are present, unique and consecutive", () => {
  assert.ok(ids.length >= 41, `only ${ids.length} ADRs; the decision record has been truncated`);
  assert.equal(new Set(ids).size, ids.length, "duplicate ADR id");
  ids.forEach((id, i) => assert.equal(id, `ADR-${String(i + 1).padStart(3, "0")}`, "ADR ids must be consecutive and never renumbered"));
});

test("every ADR has Status, Decision, Rationale, Invariant and Date in schema order", () => {
  for (const b of blocks) {
    const id = b.match(/^### \[(ADR-\d+)\]/)[1];
    const fields = [...b.matchAll(/^- \*\*(Status|Decision|Rationale|Invariant|Date)\*\*: (.+)$/gm)];
    assert.deepEqual(fields.map((m) => m[1]), ["Status", "Decision", "Rationale", "Invariant", "Date"], id);
    assert.match(fields[0][2], /^`(ACCEPTED|PROVISIONAL|SUPERSEDED by ADR-\d{3})`/, `${id} status`);
    assert.match(fields[4][2], /^(\d{4}-\d{2}-\d{2}|UNKNOWN)/, `${id} date`);
    assert.match(fields[3][2], /DO .*DO NOT|DO NOT/, `${id} invariant`);
  }
});

test("every ADR referenced in tracked documents exists", () => {
  const files = execFileSync("git", ["ls-files", "*.md", "*.mjs", "*.sh", "*.ts"], { cwd: repo }).toString().split("\n")
    .filter((f) => f && !f.startsWith("docs/DECISIONS_HISTORY.md") && !f.startsWith("docs/archive/") && !f.startsWith("node_modules/"));
  const known = new Set(ids);
  const bad = [];
  for (const f of files) {
    if (f.startsWith("scripts/test/")) continue; // this file's own examples
    for (const m of read(f).matchAll(/\bADR-(\d{3})\b/g)) if (!known.has(`ADR-${m[1]}`)) bad.push(`${f}: ADR-${m[1]}`);
  }
  assert.deepEqual(bad, [], "references to ADRs that do not exist");
});

test("a SUPERSEDED status points at an existing ADR", () => {
  for (const b of blocks) {
    const m = b.match(/^- \*\*Status\*\*: `SUPERSEDED by (ADR-\d{3})`/m);
    if (m) assert.ok(ids.includes(m[1]), `${m[1]} does not exist`);
  }
});
