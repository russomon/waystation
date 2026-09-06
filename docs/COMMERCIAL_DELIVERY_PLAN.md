# Commercial delivery plan — accounts, metered egress, download credits

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

**There is no notion of an account.** No `accountId`, `tenantId` or
`customerId` anywhere in `gateway/src/`. Authentication is a *single shared
access code*; ownership is scoped to a browser session, which is not an
identity and does not persist. Every feature below needs this first.

**Only ingest is metered.** Uploads produce meter events; downloads produce
none. For a delivery product that is the wrong half.

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

`transfers` gains `downloads_allowed INTEGER NOT NULL DEFAULT 2`.

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

Each step depends on the one above it.

1. **Accounts** — identity, per-account ownership of transfers and meters.
   The largest piece, and everything else needs it.
2. **Gateway-mediated download + egress metering** — the load-bearing endpoint.
3. **Download credits** — grants, byte budgets, top-up.
4. **Per-transfer expiry selection** — small once 1 exists.
5. **Parallel ranged downloads** — built against the endpoint from 2. Building
   it earlier, against raw presigned URLs, would mean rewriting it.
6. **Paywall / Stripe or Lago meters** — the ledger is already the right shape.

## Open questions

- Are credits refunded when delivery demonstrably failed, or never?
- Do unused credits expire with the link, or persist against the account?
- Does the account model need organisations and seats, or is one login per
  client sufficient at first?
- Pricing: per GB stored, per GB egressed, per download, or a combination.
