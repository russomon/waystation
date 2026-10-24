# CURRENT_WORK.md

## Meta
- **Branch**: `main` (observed pre-checkpoint snapshot)
- **HEAD**: `d656dd6` (observed pre-checkpoint snapshot: the docs commit that records this deployment follows it, see `SHARED_CODING_WORKFLOW.md` section 12)
- **Upstream**: `origin/main`, in sync at `d656dd6` before the docs commit
- **Tree State**: `DIRTY — deployment records, uncommitted while this file was written; expected clean after the commit that includes it`
- **Last Updated**: `2026-10-24`

## Immediate Target
- **Task**: `Owner live-check of folder transfers (ADR-042) on orbitolive.com.`
- **Target Files**: none expected; fixes, if the live check finds any, would land in `client/src/folderDelivery.ts`, `client/src/main.ts` or `gateway/src/routes.ts`
- **Current State**: `DEPLOYED 2026-10-24. The owner tested on a local stack, asked for a UI polish pass (d656dd6), then directed merge and go-live. main fast-forwarded to d656dd6 and pushed. Production gateway rebuilt from main d656dd6 after a WAL-safe backup (/home/waystation/control-pre-d656dd6.db); schema v7 → v8, rows preserved, public checks pass (record in docs/DEPLOY.md). This also deployed the previously merged trusted-API-origin and owner-based upload-recovery changes. Website: OrbitWebsite de43a2e pins client d656dd6 (verify-waystation-release.sh PASS), pushed to main after the gateway. Known limits: empty (0-byte) files and .DS_Store/Thumbs.db/desktop.ini are left out of a folder; a paused folder send resumes only within the page; Chrome will not grant a site the whole of Desktop/Documents/Downloads for "Download entire folder…" (the page says so).`
- **Blockers**: `Owner live test in Chrome and Safari.`

## Validation
- **Last Run**: `client tsc + vite build; git diff --check; scripts/folder-transfer-proof.sh (PASS); browser pane against a local stack: single-file save from the folder page (exact size), whole-folder save into an empty picked directory (direct) and a non-empty one ("Client Delivery"), member link redirects to the folder, share-link label and "(optional)" email head render, no console errors. Production: /healthz 200, unauthenticated POST /api/uploads and /api/folders 401, unknown transfer 404, schema v8 integrity ok.`
- **Result**: `PASS. NOT covered: a real folder through the live site, native Chrome dialogs, Safari.`

## Handoff Instruction
1. Verify: `git status --short --branch` (expect `main`, clean, in sync with origin), and `curl -s https://orbitolive.com/orbistation/release-manifest.json` names commit `d656dd6`.
2. If the owner reports a live problem, reproduce on a local stack first; roll back per `docs/DEPLOY.md` Runbook (backup above) only on the owner's instruction.
3. Validate with: `( cd gateway && npx tsc --noEmit && npm test ) && node --test scripts/test/*.test.mjs && bash scripts/folder-transfer-proof.sh && git diff --check`
