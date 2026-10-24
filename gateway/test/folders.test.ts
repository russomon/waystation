import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFolderManifest, validateFolderName, validateRelativePath, MAX_FOLDER_FILES } from "../src/folders.js";
import {
  accessTransferId, capabilityRevoked, claimFolderFile, completedSince, createFolder, createUpload,
  getTransfer, listFolderMembers, markFolderReady, saveTransfer, setRecipientState, setUploadState,
} from "../src/db.js";
import { randomUUID } from "node:crypto";

const ok = (r: object) => !("error" in r);

test("relative paths: nested names accepted, NFKC-normalized", () => {
  const r = validateRelativePath("Reel 1/audio/mix.wav");
  assert.ok(ok(r));
  assert.deepEqual((r as any).segments, ["Reel 1", "audio", "mix.wav"]);
  assert.equal((validateRelativePath("ﬁle.txt") as any).path, "file.txt"); // ligature folds
});

test("relative paths: traversal, absolute, separators and control characters refused", () => {
  for (const bad of ["../x", "a/../b", "a/./b", "/etc/passwd", "a//b", "a/", "a\\b", "a/b\u0000c", "", "  ",
    "a/ b", "a/b ", "x/..hidden"])
    assert.ok(!ok(validateRelativePath(bad)), `should refuse ${JSON.stringify(bad)}`);
});

test("relative paths: depth and length bounded", () => {
  assert.ok(!ok(validateRelativePath(Array(33).fill("d").join("/"))));
  assert.ok(ok(validateRelativePath(Array(32).fill("d").join("/"))));
  assert.ok(!ok(validateRelativePath("a".repeat(201))));
  assert.ok(!ok(validateRelativePath(Array(10).fill("b".repeat(150)).join("/"))));
});

test("folder name is a single segment", () => {
  assert.ok(ok(validateFolderName("Delivery 2026")));
  assert.ok(!ok(validateFolderName("a/b")));
  assert.ok(!ok(validateFolderName("..")));
});

test("manifest: totals, duplicates ignoring case, file-vs-folder clashes, empty files", () => {
  const good = validateFolderManifest([{ path: "a/x.mov", size: 10 }, { path: "b.wav", size: 5 }]);
  assert.equal((good as any).totalBytes, 15);
  assert.equal((validateFolderManifest([{ path: "A.mov", size: 1 }, { path: "a.MOV", size: 1 }]) as any).code, "duplicate_path");
  assert.equal((validateFolderManifest([{ path: "a", size: 1 }, { path: "a/b", size: 1 }]) as any).code, "duplicate_path");
  assert.equal((validateFolderManifest([{ path: "a/b", size: 1 }, { path: "A", size: 1 }]) as any).code, "duplicate_path");
  assert.equal((validateFolderManifest([{ path: "a", size: 0 }]) as any).code, "bad_size");
  assert.equal((validateFolderManifest([]) as any).code, "empty_folder");
  assert.equal((validateFolderManifest(
    Array.from({ length: MAX_FOLDER_FILES + 1 }, (_, i) => ({ path: `f${i}`, size: 1 }))) as any).code, "too_many_files");
});

/** A folder with completed members, as the routes would leave it. */
function seedFolder(owner = "code_A", sid = "sid-1") {
  const folderId = randomUUID();
  createFolder(folderId, "Delivery", owner, [{ path: "a/one.mov", size: 10 }, { path: "two.wav", size: 20 }]);
  const members = ["a/one.mov", "two.wav"].map((path) => {
    const transferId = randomUUID();
    const key = `transfers/${transferId}/${path.split("/").pop()}`;
    createUpload({ objectKey: key, uploadId: "u-" + transferId, transferId, sessionId: sid, ownerId: owner,
      verificationMode: "range", parentId: folderId, relativePath: path });
    claimFolderFile(folderId, path, transferId);
    setUploadState(key, "u-" + transferId, "complete");
    saveTransfer(transferId, { key, createdAt: Date.now(), ownerId: owner, parentId: folderId });
    return transferId;
  });
  return { folderId, members };
}

test("an unfinished folder is not a link; ready opens it and its members", () => {
  const { folderId, members } = seedFolder();
  assert.equal(getTransfer(folderId)?.kind, "folder");
  assert.equal(capabilityRevoked(folderId), true);
  assert.equal(capabilityRevoked(members[0]), true, "a member of an unfinished folder must not open");
  assert.equal(markFolderReady(folderId, { expiresAt: Date.now() + 86_400_000, downloadsAllowed: 3 }), true);
  assert.equal(markFolderReady(folderId, {}), false, "ready only once");
  assert.equal(capabilityRevoked(folderId), false);
  assert.equal(capabilityRevoked(members[0]), false);
  assert.equal(listFolderMembers(folderId).length, 2);
  assert.equal(getTransfer(members[1])?.expiresAt, getTransfer(folderId)?.expiresAt, "members carry the folder expiry");
});

test("members are gated by the folder: password, allowance and revocation", () => {
  const { folderId, members } = seedFolder();
  markFolderReady(folderId, { passwordHash: "h", downloadsAllowed: 2 });
  assert.equal(accessTransferId(members[0]), folderId);
  assert.equal(accessTransferId(folderId), folderId);
  assert.equal(getTransfer(accessTransferId(members[1]))?.downloadsAllowed, 2);
  setRecipientState(folderId, { revoked: true });
  assert.equal(capabilityRevoked(members[0]), true);
  assert.equal(getTransfer(members[0])?.revoked, true, "revocation cascades onto member rows for the purge");
});

test("an expired folder takes its members with it", () => {
  const { folderId, members } = seedFolder();
  markFolderReady(folderId, {});
  setRecipientState(folderId, { expiresAt: Date.now() - 1000 });
  assert.equal(capabilityRevoked(members[1]), true);
});

test("a folder counts as one job against the session cap", () => {
  const sid = "sid-" + randomUUID();
  const since = new Date(Date.now() - 60_000).toISOString();
  seedFolder("code_B", sid);
  assert.equal(completedSince(sid, since), 1);
  seedFolder("code_B", sid);
  assert.equal(completedSince(sid, since), 2);
});
