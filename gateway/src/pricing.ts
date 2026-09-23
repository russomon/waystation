// Pricing for pay-per-gig transfers.
//
// Deterministic and env-driven. Everything is computed in cents and rounded UP to
// the nearest whole cent exactly once, at the end — so a client is never charged a
// fraction of a cent and never a cent less than the model says. GB is DECIMAL
// (bytes / 1e9) to match the metering ledger (gateway/src/metering.ts), so a price
// and its meter line agree on what "a gigabyte" is.
//
// The model — a base transfer (which carries the included downloads and the
// included link week) plus two FLAT add-ons that carry no gateway percentage and no
// processing fee (the flat card fee is charged once, on the transfer):
//
//   base       = (bytes / 1e9) * PRICE_CENTS_PER_GB            // includes 2 downloads + 1 week
//   extraDl    = max(0, downloads - INCLUDED_DOWNLOADS) * gb * EXTRA_DOWNLOAD_CENTS_PER_GB
//   extraWeeks = max(0, weeks - INCLUDED_WEEKS)         * gb * EXTRA_WEEK_CENTS_PER_GB
//   Stripe     = ceil( base*(1+STRIPE_FEE_PCT) + STRIPE_FLAT_FEE_CENTS + extraDl + extraWeeks )  // floored to min
//   Coinbase   = ceil( base*(1+COINBASE_FEE_PCT) + extraDl + extraWeeks )
//
// 40 GB (base 80c): 2 dl / 1 wk -> Stripe 80*1.03+30 = 112.4 -> 113c ($1.13). Each
// extra download and each extra week both add a flat 40c (1c/GB): 3 dl -> $1.53,
// 10 dl -> $4.33; 2 wk -> $1.53; 5 wk -> $2.73; 4 dl + 3 wk -> $2.73.
//
// Two behaviours the price does NOT reflect but the transfer record does:
//   * a HIDDEN bonus download — the link is enforced at (chosen + FREE_BONUS_DOWNLOADS),
//     while the sender only sees/pays for the chosen count;
//   * link lifetime is weeks*7 + EXPIRY_EXTRA_DAYS (a 1-week link lasts 8 days).
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
 *  sender may raise the count to from the UI. Each download beyond the included
 *  ones costs a flat EXTRA_DOWNLOAD_CENTS_PER_GB (1c/GB). */
export const INCLUDED_DOWNLOADS = Math.max(1, Math.trunc(num(env.INCLUDED_DOWNLOADS, 2)));
export const MAX_DOWNLOADS = Math.max(INCLUDED_DOWNLOADS, Math.trunc(num(env.MAX_DOWNLOADS, 10)));
export const EXTRA_DOWNLOAD_CENTS_PER_GB = num(env.EXTRA_DOWNLOAD_CENTS_PER_GB, 1);

/** Link-lifetime weeks: the included week, the ceiling a sender may choose, and
 *  the flat per-extra-week rate (1c/GB). Lifetime in days is weeks*7 + the extra
 *  day (a 1-week link lasts 8 days). */
export const INCLUDED_WEEKS = Math.max(1, Math.trunc(num(env.INCLUDED_WEEKS, 1)));
export const MAX_WEEKS = Math.max(INCLUDED_WEEKS, Math.trunc(num(env.MAX_WEEKS, 5)));
export const EXTRA_WEEK_CENTS_PER_GB = num(env.EXTRA_WEEK_CENTS_PER_GB, 1);
export const EXPIRY_EXTRA_DAYS = Math.trunc(num(env.EXPIRY_EXTRA_DAYS, 1));

/** A silent extra download added to every paid link's enforced allowance — the
 *  sender neither sees nor pays for it (goodwill so a test/failed pull doesn't
 *  burn a paid credit). */
export const FREE_BONUS_DOWNLOADS = Math.trunc(num(env.FREE_BONUS_DOWNLOADS, 1));

/** Gateway markups. Stripe: a percentage of the transfer plus a flat per-
 *  transaction fee. Coinbase: a percentage only, no flat fee. */
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
  weeks: number;
  /** Breakdown for display/receipts, whole cents that sum to `amountCents`: the
   *  base transfer, the flat extra-download charge, the flat extra-week charge, and
   *  the gateway fee. `amountCents` is the only value we actually charge. */
  baseCents: number;
  extraDownloadsCents: number;
  extraWeeksCents: number;
  feeCents: number;
  amountCents: number;
  currency: "USD";
}

export interface PriceInvalid {
  error: string;
  code: string;
  status: 400 | 413;
}

const clampInt = (raw: unknown, lo: number, hi: number): number => {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
};

/** Clamp requested counts into their allowed ranges. Out-of-range / non-integer
 *  values are corrected rather than rejected, so a live price preview never fails
 *  on a stray select value; checkout re-clamps server-side (authoritative). */
export const clampDownloads = (raw: unknown): number => clampInt(raw, INCLUDED_DOWNLOADS, MAX_DOWNLOADS);
export const clampWeeks = (raw: unknown): number => clampInt(raw, INCLUDED_WEEKS, MAX_WEEKS);

/** The download allowance actually enforced on the link (chosen + the hidden
 *  bonus). The sender is shown/charged the chosen count. */
export const enforcedDownloads = (chosen: number): number => chosen + FREE_BONUS_DOWNLOADS;

/** How many days a link of `weeks` weeks lives: weeks*7 plus the extra day. */
export const linkExpiryDays = (weeks: number): number => weeks * 7 + EXPIRY_EXTRA_DAYS;

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

/** The price for one gateway. `bytes`, `downloads`, `weeks` are assumed already
 *  validated/clamped by the caller (quoteAll / the checkout route do this). */
export function quote(bytes: number, downloads: number, weeks: number, gateway: Gateway): Quote {
  const gb = bytes / BYTES_PER_GB;
  const base = gb * PRICE_CENTS_PER_GB;
  // Flat add-ons: no gateway percentage, no processing fee.
  const extraDl = Math.max(0, downloads - INCLUDED_DOWNLOADS) * gb * EXTRA_DOWNLOAD_CENTS_PER_GB;
  const extraWk = Math.max(0, weeks - INCLUDED_WEEKS) * gb * EXTRA_WEEK_CENTS_PER_GB;

  const [transferCharge, floor] =
    gateway === "stripe"
      ? [base * (1 + STRIPE_FEE_PCT) + STRIPE_FLAT_FEE_CENTS, STRIPE_MIN_CHARGE_CENTS]
      : [base * (1 + COINBASE_FEE_PCT), COINBASE_MIN_CHARGE_CENTS];

  const amountCents = Math.max(floor, ceilCents(transferCharge + extraDl + extraWk));
  const baseCents = ceilCents(base);
  const extraDownloadsCents = ceilCents(extraDl);
  const extraWeeksCents = ceilCents(extraWk);
  return {
    gateway,
    bytes,
    gb,
    downloads,
    weeks,
    baseCents,
    extraDownloadsCents,
    extraWeeksCents,
    // The gateway markup, as whatever is left after base + the flat extras — so the
    // parts sum to amountCents even under the min-charge floor.
    feeCents: Math.max(0, amountCents - baseCents - extraDownloadsCents - extraWeeksCents),
    amountCents,
    currency: "USD",
  };
}

/** Both gateways at once, for the price preview the UI shows before the sender
 *  commits. Validates bytes and clamps downloads/weeks so the preview is
 *  authoritative. */
export function quoteAll(
  bytes: unknown,
  downloads: unknown,
  weeks: unknown,
): PriceInvalid | { downloads: number; weeks: number; stripe: Quote; coinbase: Quote } {
  const checked = validatePriceBytes(bytes);
  if ("error" in checked) return checked;
  const dl = clampDownloads(downloads);
  const wk = clampWeeks(weeks);
  return {
    downloads: dl,
    weeks: wk,
    stripe: quote(checked.bytes, dl, wk, "stripe"),
    coinbase: quote(checked.bytes, dl, wk, "coinbase"),
  };
}
