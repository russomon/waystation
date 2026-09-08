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

# ── pause: an upload must stop cleanly and come back ─────────────────────────
# Uploads were already resumable — resumeStore remembers the uploadId and B2's
# ListParts is the source of truth for which parts landed — so pause only had to
# stop cleanly and put the file back on the queue. Three things must hold, and
# each has a failure that is silent rather than loud.
U="$WEB/client/src/uploader.ts"; M="$WEB/client/src/main.ts"; H="$WEB/client/src/hashClient.ts"

grep -q "body: blob, signal }" "$U" \
  || { echo "FAIL - part uploads do not receive the abort signal; pause would not stop them"; exit 1; }

# A paused file must go back on the QUEUE, not into the failed list: failed files
# are offered for retry, but the queue is what a resumed Send actually reads.
grep -q "queuedFiles = \[...paused, ...failed\]" "$M" \
  || { echo "FAIL - paused files are not returned to the queue, so Send cannot resume them"; exit 1; }
grep -q "if (sendAbort?.signal.aborted)" "$M" \
  || { echo "FAIL - an aborted upload is recorded as an error rather than a pause"; exit 1; }

# The hash worker reads the whole file. Left running after a pause it holds a
# core, and resuming starts a SECOND worker over the same file.
grep -q "worker.terminate();" "$H" && grep -q "signal?.addEventListener(\"abort\", stop" "$H" \
  || { echo "FAIL - the hash worker is not terminated when the upload is paused"; exit 1; }

# The button must stay clickable while sending, or there is nothing to press.
grep -q "sendBtn.disabled = !sending && count === 0" "$M" \
  || { echo "FAIL - the send button is disabled while sending, so it cannot pause"; exit 1; }
echo "  pause stops the parts and the hash worker, and requeues the file for a resumed Send"

# ── one formatter, decimal, shared by both pages ─────────────────────────────
# The sender and the recipient had SEPARATE formatters and drifted: the sender
# divided by 1024 and labelled GiB, the recipient divided by 1e9 and labelled
# GB, so one 26 GiB master read as 26.00 GiB to the sender and 27.92 GB to the
# recipient — 7% apart, on two screens of one product.
if grep -rn "GiB\|MiB\|KiB" "$WEB/client/src/main.ts" "$WEB/client/src/delivery.ts" \
     | grep -vE ":\s*(//|\*)" | grep -q .; then
  echo "FAIL - binary units in user-facing sender or recipient code:"
  grep -rn "GiB\|MiB\|KiB" "$WEB/client/src/main.ts" "$WEB/client/src/delivery.ts" | grep -vE ":\s*(//|\*)" | sed 's/^/    /'
  exit 1
fi
# Inspect the CODE, not the prose: this file's own comments explain the 1024
# mistake, so a whole-file grep would flag the explanation as the defect.
FMT_CODE=$(grep -vE "^\s*(//|\*|/\*)" "$WEB/client/src/format.ts")
if printf '%s' "$FMT_CODE" | grep -q "1024"; then
  echo "FAIL - the shared formatter divides by 1024; relabelling without recomputing is 7% wrong"; exit 1
fi
printf '%s' "$FMT_CODE" | grep -q "/ 1000" \
  || { echo "FAIL - the shared formatter is not decimal"; exit 1; }
for f in main delivery; do
  grep -q 'from "./format.js"' "$WEB/client/src/$f.ts" \
    || { echo "FAIL - $f.ts does not use the shared formatter"; exit 1; }
done
echo "  both pages share one decimal formatter, so their numbers cannot disagree"

# ── a paused batch says what the button will do ──────────────────────────────
# "Send file" after pausing reads as "start over", which is exactly the doubt
# the pause button exists to remove.
grep -q '"Resume send"' "$WEB/client/src/main.ts" \
  || { echo "FAIL - a paused batch still offers Send rather than Resume"; exit 1; }
grep -q "pausedFiles = new Set(paused)" "$WEB/client/src/main.ts" \
  || { echo "FAIL - paused files are not tracked, so the label cannot know"; exit 1; }
echo "  a paused batch offers Resume send, and reverts to Send once the queue changes"

echo "PASS - transfer-first multi-file sender, password, progress, and share-link contract"
