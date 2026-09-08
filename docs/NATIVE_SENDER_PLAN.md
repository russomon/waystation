# Native sender, browser recipient — design idea

**Status: idea only. Not designed in detail, not implemented, not scheduled.**
Recorded 2026-09-07 so the reasoning is not rediscovered.

## The problem it solves

Waystation verifies downloads with BLAKE3 + a bao outboard, which allows any
byte range to be verified independently — the same scheme `iroh-blobs` uses,
implemented separately in `crates/blake3-outboard`.

That verification stops at **16 GiB** (`VERIFIED_RANGE_MAX_BYTES`). Above it the
client switches to root-only mode and skips the `.obao`, and the delivery page
says so honestly.

**The ceiling is not BLAKE3's and not the storage layer's. It is the browser's.**
The outboard is built during upload, in wasm; wasm32 caps at 4 GiB of address
space and a 28 GB master needs a ~1.7 GB outboard. Attempting it wedged a real
27 GiB upload. So the limit is a browser constraint expressed as a server-side
setting.

## The idea

Let **OrbitXfer** — the existing native Tauri/Rust desktop app — act as an
alternative *sender*, talking to Waystation's ordinary `/uploads/*` API. Native
Rust uses the real `bao` crate with no address-space ceiling, so it can build an
outboard for a file of any size.

The recipient stays in the browser and gains per-range verification on large
files, **with no install**.

## Why the sender, not the recipient

Making OrbitXfer the *recipient* would also remove the ceiling, and more besides
— native I/O, no CORS, no mixed-content rules, no File System Access quirks. But
it would require the person receiving a file to install an application, which
destroys the property that makes Waystation worth having: send a link, they
click it.

Putting the native client on the **sending** side puts the install burden on the
party who can carry it — the operator, who already runs OrbitXfer — and leaves
the client experience untouched.

## What this is NOT

- **Not iroh.** In this shape OrbitXfer speaks HTTPS to the Waystation gateway
  and to B2, exactly as the browser does. iroh solves peer discovery and NAT
  traversal between two online machines, which is OrbitXfer's own problem and
  not Waystation's — Waystation is store-and-forward, and nobody is on the other
  end when the recipient downloads.
- **Not a merge of the two products.** `AGENTS.md` states they are separate and
  that code should not move between them unasked. This keeps that boundary:
  OrbitXfer would be one more client of a public API, sharing no code.

## Alternative worth weighing first

**Generate the outboard server-side.** Verifying a range is cheap and streaming;
only *building* the outboard needs the whole file. Something server-side could
compute the `.obao` after the object lands, and every browser recipient would get
verified ranges at any size with no new client anywhere.

The cost is that it needs compute that touches file bytes — which the gateway
deliberately never does, and the worker is parked. It would also add ~6% storage
and a download of the outboard alongside the object.

This is probably the better option if the goal is *recipient* verification for
everyone rather than a better sending tool.

## Open questions

- Is large-file verification actually wanted by clients, or is the whole-file
  BLAKE3 root enough for delivery?
- Would OrbitXfer send to Waystation, or would Waystation's upload logic be
  reimplemented there? The former shares nothing but the API; the latter starts
  to blur two products.
- `VERIFIED_RANGE_MAX_BYTES` is an env var. What is the real native ceiling, and
  does anything else break above 16 GiB when it is raised?
