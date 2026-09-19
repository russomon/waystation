// Pricing for pay-per-gig transfers.
//
// Deterministic and env-driven. Everything is computed in cents and rounded UP to
// the nearest whole cent exactly once, at the end — so a client is never charged a
// fraction of a cent and never a cent less than the model says. GB is DECIMAL
// (bytes / 1e9) to match the metering ledger (gateway/src/metering.ts), so a price
// and its meter line agree on what "a gigabyte" is.
//
// The model, per gateway, on the base transfer cost (size * rate) plus a
// per-download surcharge for links that allow more than the included downloads:
//
//   base     = (bytes / 1e9) * PRICE_CENTS_PER_GB
//   extra    = max(0, downloads - INCLUDED_DOWNLOADS) * base * EXTRA_DOWNLOAD_PCT
//   subtotal = base + extra                                   ("our cost")
//   Stripe   = ceil( subtotal * (1 + STRIPE_FEE_PCT) + STRIPE_FLAT_FEE_CENTS )
//   Coinbase = ceil( subtotal * (1 + COINBASE_FEE_PCT) )
//
// Worked check, 40 GB (base 80c), 2 downloads: Stripe 80*1.03+30 = 112.4 -> 113c
// ($1.13); Coinbase 80*1.02 = 81.6 -> 82c ($0.82).
const env = process.env as Record<string, string | undefined>;

/** Non-negative finite env number, else the fallback. Fees and floors may be 0,
 *  so this does NOT require > 0 (unlike limits.ts, whose ceilings must be). */
const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Decimal gigabyte, matching `bytes / 1e9` in metering.ts. */
export const BYTES_PER_GB = 1e9;

/** Base transfer rate: two cents per decimal gigabyte. */
export const PRICE_CENTS_PER_GB = num(env.PRICE_CENTS_PER_GB, 2);

/** Downloads every link includes before the surcharge applies, and the ceiling a
 *  sender may raise the count to from the UI. */
export const INCLUDED_DOWNLOADS = Math.max(1, Math.trunc(num(env.INCLUDED_DOWNLOADS, 2)));
export const MAX_DOWNLOADS = Math.max(INCLUDED_DOWNLOADS, Math.trunc(num(env.MAX_DOWNLOADS, 10)));

/** Each download beyond the included ones costs this fraction of the BASE transfer
 *  cost — flat per extra download, and NO processing fee. */
export const EXTRA_DOWNLOAD_PCT = num(env.EXTRA_DOWNLOAD_PCT, 0.02);

/** Gateway markups. Stripe: a percentage of our cost plus a flat per-transaction
 *  fee. Coinbase: a percentage only, no flat fee. */
export const STRIPE_FEE_PCT = num(env.STRIPE_FEE_PCT, 0.03);
export const STRIPE_FLAT_FEE_CENTS = num(env.STRIPE_FLAT_FEE_CENTS, 30);
export const COINBASE_FEE_PCT = num(env.COINBASE_FEE_PCT, 0.02);

/** Stripe rejects charges below $0.50, so the card total is floored here — a tiny
 *  file still checks out, it just costs the floor. Coinbase has no hard USD floor,
 *  but crypto dust makes sub-dollar charges impractical (default 0; set in prod). */
export const STRIPE_MIN_CHARGE_CENTS = num(env.STRIPE_MIN_CHARGE_CENTS, 50);
export const COINBASE_MIN_CHARGE_CENTS = num(env.COINBASE_MIN_CHARGE_CENTS, 0);

export type Gateway = "stripe" | "coinbase";
export const GATEWAYS: readonly Gateway[] = ["stripe", "coinbase"] as const;
export const isGateway = (v: unknown): v is Gateway => v === "stripe" || v === "coinbase";

export interface Quote {
  gateway: Gateway;
  bytes: number;
  gb: number;
  downloads: number;
  /** Rounded-up breakdown, for display and receipts. `amountCents` is the only
   *  value we actually charge and is computed from the unrounded subtotal, so the
   *  parts may each round up independently and need not sum to it exactly. */
  baseCents: number;
  extraCents: number;
  subtotalCents: number;
  feeCents: number;
  amountCents: number;
  currency: "USD";
}

export interface PriceInvalid {
  error: string;
  code: string;
  status: 400 | 413;
}

/** Clamp a requested download count into [INCLUDED_DOWNLOADS, MAX_DOWNLOADS].
 *  Out-of-range and non-integer values are corrected rather than rejected, so a
 *  live price preview never fails on a stray select value. Checkout re-clamps
 *  server-side, which is the authoritative bound. */
export function clampDownloads(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return INCLUDED_DOWNLOADS;
  return Math.min(MAX_DOWNLOADS, Math.max(INCLUDED_DOWNLOADS, n));
}

/** Round UP to the nearest whole cent, after clearing floating-point noise so a
 *  value that is mathematically an integer (e.g. 51.00000000000001 from 50*1.02)
 *  is not pushed to the next cent. One definition, so no two callers disagree. */
export const ceilCents = (cents: number): number => Math.ceil(Number(cents.toFixed(6)));

/** Validate a declared byte count for pricing. Mirrors validateSize in limits.ts
 *  but is fee-facing: the hard upload ceiling is still enforced there at initiate. */
export function validatePriceBytes(raw: unknown): PriceInvalid | { bytes: number } {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || !Number.isInteger(bytes) || bytes <= 0)
    return { error: "A positive, finite file size is required.", code: "bad_size", status: 400 };
  return { bytes };
}

/** The price for one gateway. `bytes` and `downloads` are assumed already
 *  validated/clamped by the caller (quoteAll / the checkout route do this). */
export function quote(bytes: number, downloads: number, gateway: Gateway): Quote {
  const gb = bytes / BYTES_PER_GB;
  const base = gb * PRICE_CENTS_PER_GB;
  const extraDownloads = Math.max(0, downloads - INCLUDED_DOWNLOADS);
  const extra = extraDownloads * base * EXTRA_DOWNLOAD_PCT;
  const subtotal = base + extra;

  const [markedUp, floor] =
    gateway === "stripe"
      ? [subtotal * (1 + STRIPE_FEE_PCT) + STRIPE_FLAT_FEE_CENTS, STRIPE_MIN_CHARGE_CENTS]
      : [subtotal * (1 + COINBASE_FEE_PCT), COINBASE_MIN_CHARGE_CENTS];

  const amountCents = Math.max(floor, ceilCents(markedUp));
  const subtotalCents = ceilCents(subtotal);
  return {
    gateway,
    bytes,
    gb,
    downloads,
    baseCents: ceilCents(base),
    extraCents: ceilCents(extra),
    subtotalCents,
    feeCents: amountCents - subtotalCents,
    amountCents,
    currency: "USD",
  };
}

/** Both gateways at once, for the price preview the UI shows before the sender
 *  commits. Validates bytes and clamps downloads so the preview is authoritative. */
export function quoteAll(
  bytes: unknown,
  downloads: unknown,
): PriceInvalid | { downloads: number; stripe: Quote; coinbase: Quote } {
  const checked = validatePriceBytes(bytes);
  if ("error" in checked) return checked;
  const dl = clampDownloads(downloads);
  return {
    downloads: dl,
    stripe: quote(checked.bytes, dl, "stripe"),
    coinbase: quote(checked.bytes, dl, "coinbase"),
  };
}
