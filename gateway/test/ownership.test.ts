import { test } from "node:test";
import assert from "node:assert/strict";
import { mayUseUpload, type OwnableUpload } from "../src/ownership.js";

const NOW = 1_800_000_000_000;
const WINDOW = 24 * 3_600_000;
const opts = { now: NOW, recoveryWindowMs: WINDOW };
const row = (o: Partial<OwnableUpload> = {}): OwnableUpload =>
  ({ ownerId: "code_A", sessionId: "sid-1", state: "active", createdAt: NOW - 3_600_000, ...o });
const sess = (sid: string, ownerId: string) => ({ sid, ownerId });

test("same owner, same session: allowed (unchanged behaviour)", () => {
  assert.equal(mayUseUpload(row(), sess("sid-1", "code_A"), opts), true);
});

test("same owner, NEW session: allowed — the recovery case", () => {
  assert.equal(mayUseUpload(row(), sess("sid-2", "code_A"), opts), true);
});

test("a different owner is denied, even holding the stored session id (no session fallback)", () => {
  assert.equal(mayUseUpload(row(), sess("sid-2", "code_B"), opts), false);
  assert.equal(mayUseUpload(row(), sess("sid-1", "code_B"), opts), false);
});

test("admin and per-order owners match only themselves", () => {
  assert.equal(mayUseUpload(row({ ownerId: "admin" }), sess("s9", "admin"), opts), true);
  assert.equal(mayUseUpload(row({ ownerId: "admin" }), sess("s9", "code_A"), opts), false);
  assert.equal(mayUseUpload(row({ ownerId: "pay_111" }), sess("s9", "pay_111"), opts), true);
  assert.equal(mayUseUpload(row({ ownerId: "pay_111" }), sess("s9", "pay_222"), opts), false);
});

test("no session: denied", () => {
  assert.equal(mayUseUpload(row(), null, opts), false);
  assert.equal(mayUseUpload(row(), sess("", "code_A"), opts), false);
  assert.equal(mayUseUpload(row(), sess("sid-1", ""), opts), false);
});

test("legacy row with no owner: session match only", () => {
  for (const ownerId of [null, undefined, ""]) {
    const legacy = row({ ownerId });
    assert.equal(mayUseUpload(legacy, sess("sid-1", "code_A"), opts), true, `owner=${String(ownerId)} same session`);
    assert.equal(mayUseUpload(legacy, sess("sid-2", "code_A"), opts), false, `owner=${String(ownerId)} new session`);
  }
  assert.equal(mayUseUpload(row({ ownerId: null, sessionId: null }), sess("sid-1", "code_A"), opts), false);
});

test("an owned row never falls back to session when owners differ, even if the row's session is null", () => {
  assert.equal(mayUseUpload(row({ sessionId: null }), sess("sid-1", "code_B"), opts), false);
  assert.equal(mayUseUpload(row({ sessionId: null }), sess("sid-1", "code_A"), opts), true);
});

test("cross-session recovery is bounded by the active-upload window", () => {
  const old = row({ createdAt: NOW - WINDOW - 1 });
  assert.equal(mayUseUpload(old, sess("sid-2", "code_A"), opts), false);
  assert.equal(mayUseUpload(row({ createdAt: NOW - WINDOW }), sess("sid-2", "code_A"), opts), true);
  // the starting session keeps its pre-existing behaviour regardless of age
  assert.equal(mayUseUpload(old, sess("sid-1", "code_A"), opts), true);
});

test("cross-session recovery needs an active or complete upload", () => {
  for (const state of ["aborted", "failed", "expired", "revoked", ""])
    assert.equal(mayUseUpload(row({ state }), sess("sid-2", "code_A"), opts), false, state);
  assert.equal(mayUseUpload(row({ state: "complete" }), sess("sid-2", "code_A"), opts), true);
});
