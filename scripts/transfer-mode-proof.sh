#!/usr/bin/env bash
# Sender contract: transfer-first mode, additive multi-file queue, drag/drop,
# optional recipient passwords, honest concurrent progress, copyable share URLs,
# and the existing QC controls isolated behind the explicit second mode.
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTML="$WEB/client/index.html"
MAIN="$WEB/client/src/main.ts"
UPLOADER="$WEB/client/src/uploader.ts"
DELIVERY="$WEB/client/src/delivery.ts"
ROUTES="$WEB/gateway/src/routes.ts"

grep -Fq 'id="modeTransfer" role="tab" aria-selected="true"' "$HTML"
grep -Fq 'id="modeQc" role="tab" aria-selected="false"' "$HTML"
grep -Eq 'id="file" type="file" multiple' "$HTML"
grep -Fq 'id="qcOptions" hidden' "$HTML"
! grep -Fq 'id="transferOnly"' "$HTML"
grep -Fq 'id="recipientPassword"' "$HTML"
grep -Fq 'maxlength="128"' "$HTML"
grep -Fq '1–128 characters. Applied to every file in this send.' "$HTML"
grep -Fq 'addEventListener("drop"' "$MAIN"
grep -Fq 'setMode("transfer")' "$MAIN"
grep -Fq 'selectedMode === "transfer"' "$MAIN"
grep -Fq 'makeTrack("Integrity check")' "$MAIN"
grep -Fq 'makeTrack("Upload")' "$MAIN"
grep -Fq 'anchor.textContent = link' "$MAIN"
grep -Fq 'Copied to clipboard' "$MAIN"
! grep -Fq 'Open share link' "$MAIN"
grep -Fq 'hashInWorker' "$UPLOADER"
grep -Fq 'recipientPassword' "$UPLOADER"
grep -Fq 'recipient_password_required' "$DELIVERY"
grep -Fq '/transfers/:id/unlock' "$ROUTES"

cd "$WEB"
npx tsx -e '
  import { appendUniqueFiles } from "./client/src/fileQueue.ts";
  const a = { name: "a.mov", size: 10, lastModified: 1 };
  const b = { name: "b.wav", size: 20, lastModified: 2 };
  const duplicate = { ...a };
  const merged = appendUniqueFiles([a], [duplicate, b]);
  if (merged.length !== 2 || merged[0] !== a || merged[1] !== b)
    throw new Error("file queue did not preserve order and remove duplicates");
'

echo "PASS - transfer-first multi-file sender, password, progress, and share-link contract"
