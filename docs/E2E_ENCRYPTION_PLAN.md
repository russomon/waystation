# End-to-end encryption — design study

**Status: studied and shelved. Not scheduled, not being implemented.**
Recorded 2026-09-30 so the reasoning is not rediscovered. The decision to
harden the current (non-E2E) model instead is in `DECISIONS.md` 2026-09-30.

## Where things stand today

OrbiStation encrypts in transit (HTTPS everywhere) and, when the bucket's
SSE-B2 default encryption is enabled, at rest on Backblaze's disks (new objects
only; the gateway does not request SSE itself). It is **not**
end-to-end: anyone holding a B2 application key, a recipient link, or a download
ticket reads the plain file — the operator, Backblaze, anyone who compromises
the gateway's `.env`, or anyone who obtains a live capability from a database
backup. Marketing copy must not imply more than that.

## The goal E2E would meet

The sender's browser encrypts before upload; only the recipient's browser can
decrypt. The gateway, B2, the database and backups never hold a key.

**Outside any browser-E2E design's protection**, and to be stated honestly if
it is ever built:

1. **The served code.** The page that encrypts comes from orbitolive.com
   (GitHub → Cloudflare Pages). Whoever can change it can ship code that exfiltrates
   keys. Third-party scripts on the page (today, Stripe.js on the sender page)
   are inside the same trust boundary.
2. **Metadata**: size, timing, IPs, sender email, recipient emails when the
   email feature is used.
3. A recipient re-sharing the decrypted file.

## Design that was worked out

- **Key in the link fragment.** A random secret travels after `#`
  (`…/orbistation/?t=<id>#k=<secret>`); browsers never send the fragment to any
  server. An optional password is combined with it (Argon2id), so a leaked link
  alone is useless and the server cannot brute-force the password (it lacks the
  fragment secret).
- **Chunked AEAD.** 1 MiB plaintext chunks, AES-256-GCM via WebCrypto, a random
  96-bit nonce per chunk (so a resumed upload that re-encrypts a part can never
  reuse a nonce), and associated data binding chunk index, a final-chunk flag and
  the transfer id — reordering, swapping and truncation are all detected. Every
  chunk decrypts independently, so parallel ranged download, resume and URL
  renewal all survive; ranges align to ciphertext chunks as they align to 1 KiB
  BLAKE3 chunks today. Upload parts are whole numbers of chunks.
- **Encrypted header** (version, filename, MIME type, plaintext size, a
  plaintext BLAKE3 fingerprint) stored in a DB column, so the delivery page can
  render and learn whether a password is needed without touching `/original`
  (which meters egress and claims paid credits).
- **The server stops learning**: filenames (opaque `payload.enc` object keys),
  content types, and the plaintext BLAKE3 root (which would allow
  confirmation-of-file).
- **Integrity improves**: per-chunk tags replace the bao outboard at any size,
  lifting the 16 GiB verified-range ceiling for encrypted transfers.
- **Format**: custom AES-GCM chunk format with a published spec and test
  vectors was preferred over `age` compatibility once a CLI decrypt path was
  ruled out — native WebCrypto is the fastest option.

## The constraint that shelved it

Owner requirements: **vanilla browser only — no service worker, no decrypt
tool, no local staging copy** (a recipient may be saving to an external disk
because the system drive lacks space).

Under those requirements a web page can deliver decrypted bytes to a
user-chosen location only through the File System Access API
(`showSaveFilePicker` + a writable stream), which exists **only in desktop
Chromium** (Chrome, Edge, Brave, Opera, Arc). Firefox and Safari have declined
to implement it. The alternatives each break a requirement:

| Route | Why rejected |
|---|---|
| Service worker streaming a decrypted `Response` into the download manager | Owner requirement: no service worker. It is the only standards-based route to every browser at any size. |
| Decrypt into OPFS, then `<a download>` the disk-backed `File` | Needs a full-size copy on the system drive plus quota (Firefox best-effort 10 GiB; 50% of disk after a persistence prompt). Fails the external-disk case. |
| Assemble a `Blob` in memory, then download | Bounded by RAM — viable only for small files (~1–2 GB, unmeasured). |
| CLI decrypt tool (curl/aria2c users) | Owner requirement: no tool. Command-line downloads of E2E transfers are therefore impossible. |
| Server-side decryption | Not end-to-end. |

**What would have been buildable:** E2E as a per-transfer choice; large
encrypted files downloadable only in desktop Chromium; Firefox, Safari and
mobile limited to small files held in memory; standard transfers retained for
everyone else and for command-line recipients. The owner declined that trade.

## Trade-offs recorded for any future revisit

- QC, thumbnails and AI lanes cannot run on encrypted content.
- Emailing links through the gateway leaks the fragment secret to the server
  and the mail provider unless a separately shared password is set.
- A lost link is an unrecoverable file.
- Resume state holds the key in IndexedDB until the upload completes; the
  recent-transfers list holds keyed links in localStorage.
- Per-part encryption buffers ~100–250 MB during upload (6 parts in flight).

## If it is revisited

Reopen only if the constraints change (a service worker becomes acceptable,
or Chromium-only large downloads do). The phased plan was: spike (WebCrypto
throughput in a worker, large-file behaviour per browser) → format module with
spec, test vectors and a proof script → upload path (schema v7 `e2e` flag and
header column) → Chromium download path → Firefox/Safari path → passwords,
email rules and copy → hardening (strict CSP, isolate Stripe.js, published
release hashes, external review). Rollout behind `WAYSTATION_E2E=off|optional|default`.
