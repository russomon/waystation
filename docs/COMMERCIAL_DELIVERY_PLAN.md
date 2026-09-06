# Commercial delivery plan — identity, metered egress, download credits

**Status: designed, deliberately NOT implemented.** Nothing here is built.
This records product decisions taken 2026-09-05 so they do not have to be
rediscovered, in the manner of `docs/SYNTHETIC_ORIGIN_PLAN.md`.

## Goal

Turn Waystation from a personal transfer tool into a client-facing one:
per-gigabyte billing, sender-chosen link expiry, and links that permit a
limited number of downloads which the sender can pay to extend.

## What already exists

More than expected. Three of the foundations are in place.

| Already built | Where |
|---|---|
| `expires_at` as a **per-transfer column** — only the *input* is a global env var | `gateway/src/db.ts` (transfers table) |
| Per-GB metering of uploads, durable and idempotent, shaped 1:1 onto a Stripe/Lago meter event | `gateway/src/routes.ts` (`meter({ event: "transfer", unit: "gb" })`) |
| An authorization gate doing revocation, recipient password, and scope checks | `gateway/src/routes.ts` — `GET /transfers/:id/download` |
| A CDN Worker for token-gated streaming (written, **never deployed**) | `cdn-worker/` |

## What is missing

**Durable ownership.** `gateway/src/routes.ts` already stores a per-transfer
owner — `sessionId: sessionIdOf(c)` — and every ownership check reads it. But
that value is a random UUID in a signed cookie with a TTL: an *ephemeral*
pseudo-identity. The slot exists; the value does not persist.

So this is not "add tenancy to a system that has none". It is **put a durable
value where an ephemeral one already lives.**

**Only ingest is metered.** Uploads produce meter events; downloads produce
none. For a delivery product that is the wrong half.

## Identity — without signup

**Do not build an account system.** No signup form, no passwords. The
requirement is *identity*, not registration.

Identity is the **email**, because humans remember their email and nobody
remembers `cus_QxR7…`. It arrives either from the Stripe transaction or from
the sender at upload time.

### The rule that must hold

**Email identifies. Email must never authorize.**

An address entered at checkout is unverified — anyone can type someone else's.
If an unverified email granted access, a stranger could type a customer's
address and have that customer's transfers disclosed to them.

| Purpose | Mechanism |
|---|---|
| identify and group transfers | the email, unverified — that is all it is for |
| access a transfer now | the **sender capability URL** — a secret, emailed at creation |
| recover a lost capability URL | a **magic link sent to that email** |

The magic link closes the loop: delivering it to the address proves control of
the address at the moment that control matters. This is a passwordless account
system, which is the right amount of account.

The sender capability URL is symmetric with the recipient capability already
built, so the pattern exists. Emailing it at creation also solves the ordinary
case of a sender closing the tab before copying their link.

### Key it on `owner_id`, not on the email

Store an opaque `owner_id` on the transfer, with the email as a **verified
attribute** of that owner. It costs nothing now and prevents two certainties:

- a client changes email — with the email as primary key, their history orphans;
- one human uses two addresses (personal card, then company card) — their
  history splits with no way to merge.

With `owner_id`, both are a row update. A "my transfers" view, whenever it is
wanted, is then just a query on that key.

**This is the one thing that must not be deferred.** Adding richer accounts
later *on top of* a stable `owner_id` is grouping rows that already carry the
key. Retrofitting a key onto transfers that never had one is a migration with
no source of truth — ownership would have to be guessed from timestamps.

Skip signup; keep tenancy.

## The decisive constraint

**A presigned B2 URL is a bearer token: invisible and unrevocable.**

You cannot meter egress you cannot observe, cannot revoke a link you do not
mediate, and cannot count downloads you never see. Every commercial feature
here therefore depends on downloads being **gateway-mediated** — a stable,
non-expiring link that the gateway authorizes per request and redirects to a
freshly minted, short-lived presigned URL.

Consequences:

- **Raising the presigned TTL is disqualified**, not merely unwise. It widens
  the window in which revocation, passwords and expiry are all bypassed.
- The 1-hour presigned lifetime **stays as it is**. It is not a limitation to
  route around; it is what makes revocation meaningful.
- The mediated endpoint ends up carrying four jobs — revocation, egress
  metering, credit checking and grant issuance — which makes it the most
  load-bearing component in the plan. Build it once, carefully.
- Because credits can be topped up after a link is sent, the balance must be
  **live-checked on every download** and can never be baked into a signed
  link payload.

## Download credits

### The counting problem

**One download is not one HTTP request.** Resumable downloads reconnect;
parallel ranged downloads issue many requests for a single logical download
(`aria2c -x 16` would burn 16 credits); browsers sometimes probe with a HEAD or
a small range first. Counting requests is wrong.

The unit is a **grant**: the recipient starts, the gateway atomically claims one
credit and issues a short-lived grant token, and every range request carrying
that token is free because it belongs to the same download.

### Decisions

| Decision | Value |
|---|---|
| Credit consumed | on **first byte** |
| Grant resumable for | **7 days** |
| Byte budget per grant | **1.7 × file size** |
| Default credits per link | **2** |
| Sender's own downloads | **count**, like any other |
| Top-up after sending | **allowed at any time** |
| Grant vs link expiry | grant may overhang the link by **up to 24 h** |

**Why 1.7×.** The budget, not the clock, is what bounds cost. 1.7× covers the
realistic worst case — a download that fails at 60% and restarts from scratch
spends 1.6× and still completes on one credit. Two complete copies would need
2.0×, so **one credit can never yield two files**; the worst case is ~70% of a
second copy, which for a media asset is useless. Without a byte budget, a
7-day grant would be a week of unlimited downloads for a single credit.

**The overhang applies to grants, never to the link.** The link stops issuing
new grants exactly when the sender said it would. A download *already in
flight* gets up to 24 more hours to finish. The other reading — where the link
itself lives 8 days — would mean a sender who chose 7 days told their client
something untrue.

**Why default 2.** Downloads count uniformly, including the sender's own. With
a default of 1, a sender checking their own link would leave the recipient with
zero — a support ticket on day one. The sender UI must say so plainly:

> "This link allows 2 downloads — one for your recipient, and a spare so you
> can test it yourself or send it to a second person."

### Schema sketch

`transfers` gains `downloads_allowed INTEGER NOT NULL DEFAULT 2` and
`owner_id TEXT` (see *Identity* above — durable, replacing the ephemeral
`sessionId` in that role).

A new `owners` table: `owner_id`, email, email-verified flag, Stripe customer
id, created at. Email is an attribute here, never the key.

A new `download_grants` table: grant id, transfer id, issued at, expires at,
bytes served, completed flag.

**Derive the used count from the grants table; do not store a counter.** This
is something being charged for, so it needs an audit trail — matching what
`gateway/src/metering.ts` already states as its purpose: *provenance-backed
billing, where you can prove every line item ran.* When a client disputes a
charge, show them the grants.

### Atomicity

Prepaid credit is money: two recipients clicking at once must not both take the
last one. This is unusually easy here — `gateway/src/db.ts` uses `node:sqlite`
`DatabaseSync` in a single Node process, so a guarded conditional update is
atomic with no transaction gymnastics:

```sql
UPDATE ... WHERE downloads_used < downloads_allowed
```

Zero rows affected means someone else took the last credit.

## Link expiry

`expires_at` is already per-transfer, so offering the sender 7 / 14 / 21 / 30
days is plumbing a choice into a column that exists — not a data-model change.
Today the value is computed from the deployment-wide `RECIPIENT_LINK_TTL_DAYS`
(currently 14).

## Unit economics

If billing is per gigabyte, **B2 egress is the margin.** The `cdn-worker/` was
written precisely because B2→Cloudflare egress is free under the Bandwidth
Alliance — but it has never been deployed, and its HMAC token is self-contained,
carrying the same bearer weakness as a presigned URL.

The shape that serves both concerns: **gateway gate → CDN Worker**, keeping
authorization and metering at the gateway while egress stays cheap. Never
gateway → raw B2 for a billed download.

## Build order

Mostly sequential, with one important exception: **step 2 does not depend on
step 1.** The mediated download endpoint needs only the authorization gate that
already exists plus presigned minting, and the meter ledger is keyed by
`transferId`, not by owner — so egress metering works before any identity does.

Step 2 was therefore built first, and is now done. It was unblocked, it is the
piece everything else leans on, and it improved the product immediately with no
billing attached: links that stop expiring, revocation that takes effect at
once, and the prerequisite for parallel downloads.

Step 1, by contrast, is blocked on a decision nobody has made yet — the pricing
model. You cannot build a checkout without knowing what it charges for.

1. **Payment + identity.** Take the card, capture the email, mint an
   `owner_id`, write it where `sessionId` is written today, and email the sender
   capability URL. Payment comes **first, not last** — it is what produces the
   identity everything else is keyed to, and for a pay-per-use product it *is*
   the authorization, which lets the shared access code retire.
2. ~~**Gateway-mediated download + egress metering**~~ — **DONE 2026-09-05.**
   `GET /transfers/:id/original`, proven by `scripts/mediated-download-proof.sh`.
   The recipient no longer receives a storage URL for the master; revocation
   takes effect on the next request. **Egress metering is an approximation** —
   because the route redirects, the gateway sees that a download started but
   never how many bytes moved, so it records one event per transfer per hour.
   That stops a sixteen-connection download billing sixteen times, and is
   replaced by the grant ledger in step 3, which knows exactly when a download
   began and what it was entitled to.
3. **Download credits** — grants, byte budgets, top-up.
4. **Per-transfer expiry selection** — small; the column already exists.
5. ~~**Parallel ranged downloads**~~ — **DONE 2026-09-05**, against the endpoint
   from 2 exactly as intended. One authorization resolves the redirect once and
   the workers range against storage, which is the same shape download grants
   formalise in step 3: one authorization per download, many range requests.
6. **Magic-link recovery** — for a sender who loses the capability URL. Needed
   before support volume makes it urgent, not before launch.

Deliberately **not** on this list: signup, passwords, an account dashboard, a
"my transfers" view. Each is additive later against `owner_id`, and none is
required to charge money.

## Open questions

- Are credits refunded when delivery demonstrably failed, or never?
- Do unused credits expire with the link, or persist against the `owner_id`?
- Which email wins when the Stripe billing address differs from the address the
  sender wants their link sent to — for example a company card paying for an
  individual's transfer?
- Pricing: per GB stored, per GB egressed, per download, or a combination.
- Storing customer emails makes this a personal-data processor. Worth a look at
  retention and deletion obligations before taking real clients.
