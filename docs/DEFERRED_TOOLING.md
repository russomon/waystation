# Deferred deterministic tooling

Tools we have decided are worth adding to the **worker image**, investigated but
deliberately **not implemented**, because QC development is parked and
production runs transfer-only with no worker at all.

This file exists so that reviving QC does not mean rediscovering the research.
It is referenced from `docs/DEPLOY.md` → **"Returning to full QC"**, which is
where you will actually be standing when this becomes actionable.

## Why the timing matters

The moment a full-QC box is up with the worker image loaded is the **cheapest**
moment to add tools. Doing it afterwards means standing the whole stack up again
for what may be a single `pip install`. **Work through this list while the box is
already running**, then re-archive once.

## Register

| Tool | Purpose | Cost to add | Status |
|---|---|---|---|
| OpenCV (`opencv-python-headless`) | computer-vision frame analysis for future analyzers | ~75 MB layer, no compiler | investigated, not implemented |

### Adding an entry

Record four things, or the entry will not save anyone time later: **the exact
pin and why that version**, **where it plugs into the code**, **the failure mode
someone would otherwise walk into**, and **what it does _not_ do**. Installation
is never clearance — a new tool must not silently become a passing check.

---

## OpenCV

**Goal:** make `cv2` importable inside the worker's Python 3.13 and honestly
inventoried. **No analyzer, no check that can reach `warn`/`fail`** — a
capability sitting ready, reported as *available, not active*.

### The pin

`opencv-python-headless==4.12.0.88`

- Wheels are tagged **`cp37-abi3`** (stable ABI), so Python 3.13 needs no
  version-specific wheel. Verified against PyPI.
- **54 MB**, plus numpy (`>=2,<2.3.0`). Expect ~75 MB on the 1.43 GB base; the
  B2 archive grows from ~372 MB to roughly 440 MB.
- An **aarch64 wheel exists**, so the code path can be proven on an arm64 Mac
  without a VPS.
- `5.0.0.93` was current at time of writing but is a brand-new major with API
  changes — the wrong risk profile for a measurement instrument. Prefer the
  mature 4.x line unless something specifically requires 5.
- **Nothing else in the image uses numpy.** Verified: a dev venv built from
  `pipeline/requirements.txt` has neither `cv2` nor `numpy`. So the `<2.3.0`
  ceiling cannot conflict with an existing pin. Re-check this if
  `requirements.txt` has since grown.

### Layer it — do not rebuild the image

`pipeline/Dockerfile` pins `mediaconch=25.04-2` and compiles QCTools from source
against Qt5. As the **Image archive** section of `docs/DEPLOY.md` notes, that
Dockerfile "is a recipe with a shelf life" — Debian rotates old package versions
out of the main archive. Rebuilding from source to add one pip package risks
losing the proven toolchain for reasons unrelated to OpenCV.

Instead, derive from the archived worker image:

```dockerfile
ARG BASE_IMAGE=waystation-worker:latest
FROM ${BASE_IMAGE}
ARG OPENCV_VERSION=4.12.0.88
RUN pip install --no-cache-dir "opencv-python-headless==${OPENCV_VERSION}" \
 && pip check \
 && python -c "import cv2; print(cv2.__version__)"
ENV OPENCV_VERSION=${OPENCV_VERSION}
LABEL org.opencontainers.image.waystation.opencv.version="${OPENCV_VERSION}"
```

`pip check` is not decoration — it is what catches a dependency the layer would
otherwise silently downgrade.

Installing interactively first is worth doing, as the **experiment**: it is how
you learn whether the wheel resolves on that exact base, whether `import cv2`
succeeds, and whether `pip check` stays green. Then write the Dockerfile as the
record.

### ⚠ Do not use `docker commit`

Snapshotting a running container is the obvious shortcut and it is a trap.
`docker commit` captures the container's **configuration, including its
environment**. A worker started by compose holds every `.env` value — B2 keys,
GMI keys, the session secret — so committing it bakes those into the image
config, and that image then gets uploaded to B2.

The **Image archive** section says the tarballs are the safer artifact
*precisely because* they contain no `.env`. `commit` forfeits that. Build from a
Dockerfile, which also leaves the recipe in git rather than in shell history.

### Where to build

Wheels invoke **no compiler**, so this does not need a big host — only the
QCTools/Qt stage in the full rebuild does. A 1 vCPU / 1 GB / 25 GB box is
sufficient. The layer must be **amd64** to match the archived image; on an arm64
Mac use `--platform linux/amd64`.

Avoid building on the box serving live transfers: it loads ~1.5 GB onto a
production host for a non-urgent capability. A throwaway instance costs pennies.

### Where it plugs in

`_TOOLS` in `pipeline/qc/archive_tools.py`. Two things to know:

1. The table is **CLI-only** today — it probes executables with `shutil.which`
   and a `--version` flag. A Python module needs a `kind` discriminator
   (`"cli"` vs `"python_module"`) and a probe branch. Probing in a
   **subprocess** rather than importing in-process keeps ~100 MB of OpenCV out
   of the long-lived worker's RSS, and reuses the existing `run()` helper from
   `qc/util.py` unchanged.
2. **Append the new entry, never insert it.** `scripts/archive-tools-proof.sh`
   indexes that tuple positionally (`present_inventory[0]`, `[1]`).

An interpreter override — the `SYNCNET_PYTHON` precedent — lets a proof script
select an interpreter with and without `cv2`, so both branches can be proven for
real instead of mocked.

**No `worker.py` change is needed.** `qarchive_tools.inventory()` and
`.checks()` already run unconditionally in the `check_av` block, and
`active_archive_tools` is only ever `{"mediaconch", "qcli"}` — so a new entry
self-reports as *available, not active* with no orchestration change.

Verified safe downstream: `compile_packets` in `qc/prompt_compiler.py` skips any
check name absent from `_QUESTIONS` **and** any status that is not `warn`/`fail`,
so an `info` row is doubly inert. `tool_provenance` is not rendered by the
client, so there is no UI change.

### Free interim workaround

An image built with `INSTALL_SYNCNET=1` **already has OpenCV** — at
`/opt/syncnet/env/bin/python`, in the micromamba Python 3.10 sandbox. If you
need `cv2` before doing this properly, point at that interpreter. It is
`opencv-contrib-python-headless` on a different Python version, so treat it as a
scratchpad, not as the supported path.
