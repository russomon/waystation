#!/usr/bin/env bash
# Sender contract: transfer-first mode, additive multi-file queue, drag/drop,
# and the existing QC controls isolated behind the explicit second mode.
set -euo pipefail

WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HTML="$WEB/client/index.html"
MAIN="$WEB/client/src/main.ts"

grep -Fq 'id="modeTransfer" role="tab" aria-selected="true"' "$HTML"
grep -Fq 'id="modeQc" role="tab" aria-selected="false"' "$HTML"
grep -Eq 'id="file" type="file" multiple' "$HTML"
grep -Fq 'id="qcOptions" hidden' "$HTML"
! grep -Fq 'id="transferOnly"' "$HTML"
grep -Fq 'addEventListener("drop"' "$MAIN"
grep -Fq 'setMode("transfer")' "$MAIN"
grep -Fq 'selectedMode === "transfer"' "$MAIN"

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

echo "PASS - transfer-first multi-file sender contract"
