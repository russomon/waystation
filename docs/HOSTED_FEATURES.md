# Hosted features: email-the-link, admin dashboard, embedded Stripe checkout

Reference for three features that shipped in source on 2026-09-23 to 2026-09-27 and were missing from the shared context. Everything below was read from source at `b16a109`; nothing was run against a live service.

**Deployed status.** The owner confirmed on 2026-10-06 that email-the-link, the admin dashboard and embedded Stripe checkout are live. That is **owner-confirmed, not independently verified** by any session; no credentials, host or live service were accessed to check it. `docs/DEPLOY.md` has no release record for them (its last records are the 2026-09-30 gateway releases, which contain them in source).

Configuration is listed by **name only**. Values are never recorded here.

## Email-the-link

**What it does.** After an upload completes, the sender page offers a form (recipient chips, "Your email", subject, message). `POST /api/transfers/email` sends each recipient the delivery-page link through Resend, from OrbiStation, with the sender as Reply-To and BCC'd on a copy. The client auto-sends when the upload completes if the form was filled in; copying the link stays available. The form is also offered to comped/admin senders (client cap 25).

**Source.** `gateway/src/email.ts` (Resend wrapper, message rendering), `gateway/src/routes.ts` (`/transfers/email`), `client/src/config.ts` (`sendTransferEmail`), `client/src/main.ts` (form), `client/src/recentTransfers.ts`.

**Server-side rules.**
- Requires a sender session and an allowed `Origin`; limited to 20 requests/minute per session.
- The link is built server-side from the transfer id (never a client-supplied URL): the sender-page base (`WAYSTATION_PUBLIC_BASE_URL`) plus `?t=<transfer id>`.
- Every transfer must belong to the caller's owner (`t.ownerId === session.ownerId`; admin may send any), must exist, and must not be revoked.
- Recipients are capped at the transfer's `downloads_allowed` (comped/admin transfers have none: cap 25). `downloads_allowed` for a paid link includes the hidden bonus download (chosen + 1), so the server cap is one higher than the number the client shows.
- A download password is never included; the email says the sender will share it separately.
- Disabled (503 `email_disabled`) unless the Resend key is configured.

**Configuration (names only).** `RESEND_API_KEY` (server-side secret; absent means the feature is off), `WAYSTATION_EMAIL_FROM` (optional; defaults to an OrbiStation noreply address on the orbitolive.com domain), `WAYSTATION_PUBLIC_BASE_URL` (sender-page base for the links).

**Per-browser recent transfers.** `client/src/recentTransfers.ts` remembers recent share links in this browser's `localStorage` for convenience only; it never reaches the server.

**UNKNOWN (operator).** Whether `RESEND_API_KEY` is supplied on the host and how: it appears in neither compose file nor `.env.example` (it is now listed in `.env.example` as a name). Whether the sending domain is verified in Resend. The value of `WAYSTATION_PUBLIC_BASE_URL` on the host.

**Observations, not changed.** `fromEmail` is typed by the sender and not verified: it becomes Reply-To, the BCC target and the name in "X has sent you…". An authenticated sender could therefore make OrbiStation mail a link to chosen recipients with a chosen "from" name (bounded by the recipient cap and 20 requests/minute). When `WAYSTATION_PUBLIC_BASE_URL` is unset, `publicBaseUrl` falls back to the request's `Origin` header (restricted to the allowed origins by `enforceOrigin`, so it cannot point elsewhere). Neither is addressed in this change.

## Admin activity dashboard

**What it does.** The "Manage access codes" panel (admin session only) has an activity section with a window toggle (24 h, 7 d, all). `GET /api/admin/stats?window=24h|7d|all` returns read-only aggregates from the existing meter and payments ledgers: completed transfers, GB uploaded, GB egressed, downloads (grants), active uploads, payments (paid orders, revenue, pending, per-gateway split), and the 8 most recent transfers and paid orders. Download counts are exact; GB downloaded is the once-per-download egress meter, not a byte-accurate count.

**Source.** `gateway/src/routes.ts` (`/admin/stats`), `gateway/src/db.ts` (`adminStats`), `client/src/admin.ts`, `client/index.html` (`#adminStats`).

**Rules.** `requireAdmin` (neutral 404 for anyone else), 30 requests/minute. It adds no tracking of its own.

**Configuration.** None beyond the admin access code (`WAYSTATION_ACCESS_CODE_HASH`).

**UNKNOWN (operator).** None specific to this feature.

## Embedded Stripe card checkout

**What it does.** A public sender picks files, downloads and link weeks, sees an up-front rate card, and pays by card in the page. The gateway creates a Stripe **PaymentIntent** (card only) and returns its client secret and the publishable key; the client mounts a Stripe Payment Element and confirms with `redirect: "if_required"`, so the page does not navigate away and the queued file handles survive. A 3-D Secure challenge is the one case that still redirects; the client keeps a descriptor in `sessionStorage` to name the files on return. The upload is authorized by the paid order, not by the browser's claim (ADR-031, ADR-040).

**Source.** `gateway/src/payments.ts` (`createStripeCheckout`, webhook and lookup), `gateway/src/routes.ts` (`/payments/*`), `gateway/src/pricing.ts`, `client/src/main.ts` (Payment Element), `client/src/config.ts`.

**Server-side rules.**
- The signed webhook (`constructEvent` over the raw body) or a direct provider lookup marks the order paid; `payment_intent.succeeded` is recognised, and the legacy `checkout.session.completed` is still honoured. An underpayment is refused.
- `POST /payments/:orderId/session` mints the payment-backed session only for a paid order. The session's owner is the per-order `pay_…` id (ADR-039).
- Coinbase Commerce remains in source and is offered only when its keys are present; the 2026-09-30 record says it is off.

**Configuration (names only).** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` (public by design), `WAYSTATION_PAYMENTS_MODE` (`live` or `test`; `test` short-circuits the network and is used by `scripts/payment-gateway-proof.sh`), optional `STRIPE_FEE_PCT`, `STRIPE_FLAT_FEE_CENTS`, `STRIPE_MIN_CHARGE_CENTS`, and `WAYSTATION_PUBLIC_BASE_URL` (payment return redirects).

**UNKNOWN (operator).** Whether the Stripe account is in live mode and which webhook endpoint and events are registered (the code accepts `payment_intent.succeeded`). `docs/DEPLOY.md` records only a checkout that reached the Stripe card form without payment on 2026-09-30, and that 3-D Secure under the enforced CSP was not yet exercised then.

## Verification status of this document

Read from source only. The proofs that cover related behaviour are `scripts/payment-gateway-proof.sh` (test-mode payments), `scripts/upload-recovery-proof.sh` and `scripts/access-codes-proof.sh`. No proof exercises Resend or the live Stripe Payment Element, and no test of the email route or the stats route exists.
