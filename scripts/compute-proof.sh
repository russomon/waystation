#!/usr/bin/env bash
# Hybrid-compute proof: the sender's "Cloud compute" checkbox routes each transfer to a
# different worker, and the provenance manifest records WHERE it was processed.
#
# STATUS: BLOCKED pending a reviewed network plan. The static checks below still run. The
# live half is NOT executed, and no Docker command is issued, because the previous design
# could not be made private:
#   * MinIO (synthetic minioadmin credentials) and the gateway ran as HOST processes on all
#     interfaces so the containerized worker could reach them via host.docker.internal;
#     publishing them to 127.0.0.1 only would make them unreachable from the container.
#   * The "local" worker was a host python process, reachable by the gateway only on the host.
#
# Proposed redesign for review (not implemented): run MinIO, the gateway and BOTH workers as
# labelled containers on ONE run-owned network, with only the gateway and MinIO published to
# 127.0.0.1 on free ports for the host-side driver. The "local" worker becomes a second
# container of the same image with WORKER_LABEL=local (the property under test is the routing
# by the `compute` option and the provenance label, not host-versus-container execution).
# That needs a gateway image matching this tree, so it shares the BLOCKER recorded for
# docker-proof.sh, and it must use scripts/lib/docker-isolation.sh like the other Docker proofs.
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

grep -Eq 'id="opt_cloud" checked' "$WEB/client/index.html" \
  || { echo "FAIL: Cloud compute is not checked by default"; exit 1; }
! grep -Eq 'id="opt_qc_ai"' "$WEB/client/index.html" \
  || { echo "FAIL: legacy AI QC remains visible"; exit 1; }
grep -Fq 'Creative and delivery context' "$WEB/client/index.html" \
  || { echo "FAIL: interpretive context label is missing"; exit 1; }
echo "✓ sender defaults to Cloud compute and exposes only consolidated interpretive AI"

echo "SKIP - BLOCKED: the live compute-routing half needs a reviewed private network plan (see the header); nothing was started and no Docker command was issued."
exit 0
