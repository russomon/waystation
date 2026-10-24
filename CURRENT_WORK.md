# CURRENT_WORK.md

## Meta
- **Branch**: `claude/orbistation-folder-transfers` (observed pre-checkpoint snapshot)
- **HEAD**: `edb46bf` (observed pre-checkpoint snapshot: the branch was cut from main at edb46bf; the folder-transfer commit that records this file follows it, see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `NONE` (branch not pushed at time of writing)
- **Tree State**: `DIRTY — the folder-transfer implementation, uncommitted while this file was written; expected clean after the commit that includes it`
- **Last Updated**: `2026-10-24`

## Immediate Target
- **Task**: `Review, browser-check, merge and deploy folder transfers (ADR-042): one link for a whole folder tree.`
- **Target Files**: `gateway/src/folders.ts`, `gateway/src/db.ts`, `gateway/src/routes.ts`, `gateway/test/folders.test.ts`, `client/src/folders.ts`, `client/src/folderDelivery.ts`, `client/src/main.ts`, `client/src/delivery.ts`, `client/src/uploader.ts`, `client/src/idb.ts`, `client/index.html`, `scripts/folder-transfer-proof.sh`
- **Current State**: `Implemented on the branch, UNMERGED and UNDEPLOYED. Gateway: schema v8 (transfers.kind/parent_id/display_name, uploads.parent_id/relative_path, folder_files); POST /folders declares the tree (one job, budget reserved once), POST /uploads takes folderId+relativePath checked against the manifest, POST /folders/:id/complete seals it; members are gated, capped (per file) and revoked by their folder via accessTransferId; GET /transfers/:folderId lists the tree. Client: "Or choose a whole folder" plus folder drag-drop on the sender; folder delivery view with per-file links and a Download folder… that rebuilds the tree via showDirectoryPicker. main moved on 2026-10-24: the security/proof-hardening branch was fast-forwarded into main and pushed at the owner's direction, without the separate independent review of 143aef5. Owner browser test 2026-10-24 led to a UI polish pass: a full-size "Or choose a whole folder" button, a "Download link" label on the share link, "(optional)" on the email section; on the folder page only the folder and "Download entire folder…" show, with the files behind a closed "Download individual files" disclosure, each file saving directly (save dialog plus the verified download, or the plain link), member pages redirecting to the folder, a hint about Chrome's folder dialogs, and an empty picked folder receiving the tree directly. Known limits: empty (0-byte) files and .DS_Store/Thumbs.db/desktop.ini are left out of a folder; a paused folder resumes within the page, but after a page reload re-sending starts a new folder; the client was NOT exported to OrbitWebsite (it must ship after the gateway).`
- **Blockers**: `Owner review and merge; a manual browser send of a real folder (native folder dialogs and drag-drop could not be automated); deployment approval (gateway first, then client export).`

## Validation
- **Last Run**: `gateway tsc + npm test; client tsc + vite build; node --test scripts/test/*.test.mjs; git diff --check; local MinIO proofs: folder-transfer, upload-recovery, delivery, mediated-download, recipient-password, resumable-download, payment-gateway, access-codes, access, purge. Browser pane against a local stack: folder page renders the tree, per-file link opens the file page with a back link, Download folder… rebuilt the tree (3 files, 42 MB, sizes exact) into the browser's private storage standing in for the directory picker, and a second download went to "Client Delivery (2)".`
- **Result**: `PASS — 25/25 gateway tests, 73/73 script tests, client builds, all ten listed proofs PASS, no console errors. NOT covered: picking or dragging a folder on the sender page in a real browser, Safari, and a real on-disk directory via the native picker.`

## Handoff Instruction
1. Verify: `git status --short --branch` (expect `claude/orbistation-folder-transfers`, clean, one commit after `edb46bf`), then read ADR-042 and `git diff main...HEAD`.
2. In Chrome against a local stack (`scripts/dev-up.sh`), send a nested folder by picking and by dragging, then download it with Download folder… and `diff -r` against the source; repeat the send in Safari.
3. Validate with: `( cd gateway && npx tsc --noEmit && npm test ) && node --test scripts/test/*.test.mjs && bash scripts/folder-transfer-proof.sh && git diff --check`
