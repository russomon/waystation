// Payment-gateway adapters: Stripe (cards) and Coinbase Commerce (crypto).
//
// The gateway creates a hosted checkout, the sender pays off-site, and the provider
// tells us it happened two ways: a webhook (authoritative, signed) and — as a race
// fallback for a sender who returns before the webhook lands — a direct status
// lookup. Both are verified server-side; a browser's word that it paid is never
// trusted. Amounts are re-checked against the order in the route.
//
// Two providers, kept deliberately apart. Stripe ships a pure-JS SDK (no native
// build — safe for node:22-slim, unlike the native modules db.ts avoids), so we use
// it for both checkout creation and the fiddly timestamped webhook-signature check.
// Coinbase Commerce's official SDK is stale, so we call its REST API with fetch and
// verify its webhook with a plain HMAC-SHA256 over the raw body (node:crypto).
//
// WAYSTATION_PAYMENTS_MODE=test short-circuits every network call and verifies
// webhooks with a plain HMAC, so scripts/payment-gateway-proof.sh can drive the
// whole flow without real provider credentials.
import Stripe from "stripe";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Gateway } from "./pricing.js";

const env = process.env as Record<string, string | undefined>;

export const PAYMENTS_MODE = (env.WAYSTATION_PAYMENTS_MODE || "live").trim();
export const IS_TEST_PAYMENTS = PAYMENTS_MODE === "test";
if (PAYMENTS_MODE !== "live" && PAYMENTS_MODE !== "test")
  throw new Error(`WAYSTATION_PAYMENTS_MODE must be "live" or "test" (got "${PAYMENTS_MODE}")`);

const STRIPE_SECRET_KEY = (env.STRIPE_SECRET_KEY || "").trim();
const STRIPE_WEBHOOK_SECRET = (env.STRIPE_WEBHOOK_SECRET || "").trim();
const COINBASE_API_KEY = (env.COINBASE_COMMERCE_API_KEY || "").trim();
const COINBASE_WEBHOOK_SECRET = (env.COINBASE_COMMERCE_WEBHOOK_SECRET || "").trim();
const COINBASE_API = "https://api.commerce.coinbase.com";

// A gateway is offerable when it has the keys it needs (or in test mode, always).
export const stripeEnabled = IS_TEST_PAYMENTS || (!!STRIPE_SECRET_KEY && !!STRIPE_WEBHOOK_SECRET);
export const coinbaseEnabled = IS_TEST_PAYMENTS || (!!COINBASE_API_KEY && !!COINBASE_WEBHOOK_SECRET);
export const gatewayEnabled = (g: Gateway): boolean =>
  g === "stripe" ? stripeEnabled : coinbaseEnabled;

// Lazily constructed so importing this module without keys (dev, tests) never
// throws. Only the live path touches it.
let _stripe: Stripe | null = null;
const stripe = (): Stripe => {
  if (!_stripe) {
    if (!STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not configured");
    _stripe = new Stripe(STRIPE_SECRET_KEY);
  }
  return _stripe;
};

export const paymentsBanner = (): string =>
  `payments: mode=${PAYMENTS_MODE} stripe=${stripeEnabled ? "on" : "off"} ` +
  `coinbase=${coinbaseEnabled ? "on" : "off"}`;

export interface CheckoutInput {
  orderId: string;
  gateway: Gateway;
  amountCents: number;
  gb: number;
  downloads: number;
  successUrl: string;
  cancelUrl: string;
}
export interface CheckoutResult {
  url: string; // hosted payment page the client redirects to
  gatewayRef: string; // stripe checkout-session id / coinbase charge id
  expiresAt?: number; // ms epoch — Coinbase locks a ~60-minute window
}

/** A verified, normalized webhook/lookup outcome the routes act on. */
export interface PaymentEvent {
  orderId?: string;
  paid: boolean;
  amountCents?: number;
  currency?: string;
  email?: string;
}

const describe = (gb: number, downloads: number): string =>
  `Waystation transfer — ${gb.toFixed(gb < 10 ? 2 : 1)} GB, ${downloads} download${downloads === 1 ? "" : "s"}`;

export async function createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  if (IS_TEST_PAYMENTS)
    return { url: input.successUrl, gatewayRef: `test_${input.orderId}`, expiresAt: Date.now() + 3_600_000 };
  return input.gateway === "stripe" ? createStripeCheckout(input) : createCoinbaseCharge(input);
}

async function createStripeCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: input.amountCents,
          product_data: { name: describe(input.gb, input.downloads) },
        },
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.orderId,
    metadata: { order_id: input.orderId },
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return {
    url: session.url,
    gatewayRef: session.id,
    expiresAt: session.expires_at ? session.expires_at * 1000 : undefined,
  };
}

async function coinbaseFetch(path: string, init: RequestInit): Promise<any> {
  const res = await fetch(`${COINBASE_API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-CC-Api-Key": COINBASE_API_KEY,
      "X-CC-Version": "2018-03-22",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Coinbase ${path} failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function createCoinbaseCharge(input: CheckoutInput): Promise<CheckoutResult> {
  const body = await coinbaseFetch("/charges", {
    method: "POST",
    body: JSON.stringify({
      name: "Waystation transfer",
      description: describe(input.gb, input.downloads),
      pricing_type: "fixed_price",
      local_price: { amount: (input.amountCents / 100).toFixed(2), currency: "USD" },
      metadata: { order_id: input.orderId },
      redirect_url: input.successUrl,
      cancel_url: input.cancelUrl,
    }),
  });
  const charge = body?.data;
  if (!charge?.hosted_url || !charge?.id) throw new Error("Coinbase did not return a charge");
  return {
    url: charge.hosted_url,
    gatewayRef: charge.id,
    expiresAt: charge.expires_at ? Date.parse(charge.expires_at) : undefined,
  };
}

// ── webhook verification + extraction ──

const hmacHex = (raw: string, secret: string): string =>
  createHmac("sha256", secret).update(raw, "utf8").digest("hex");

/** Constant-time compare of two hex strings of possibly different length. */
function hexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

/** Verify + normalize a Stripe webhook. Returns null on a bad signature. In live
 *  mode the SDK enforces the timestamped scheme; in test mode a plain HMAC over the
 *  raw body (same secret) lets the proof forge a valid event. */
export function parseStripeEvent(raw: string, signature: string | undefined): PaymentEvent | null {
  let event: any;
  if (IS_TEST_PAYMENTS) {
    if (!signature || !STRIPE_WEBHOOK_SECRET || !hexEqual(signature, hmacHex(raw, STRIPE_WEBHOOK_SECRET)))
      return null;
    try { event = JSON.parse(raw); } catch { return null; }
  } else {
    if (!signature) return null;
    try {
      event = stripe().webhooks.constructEvent(raw, signature, STRIPE_WEBHOOK_SECRET);
    } catch { return null; }
  }
  if (event?.type !== "checkout.session.completed") return { orderId: undefined, paid: false };
  const s = event.data?.object ?? {};
  return {
    orderId: s.metadata?.order_id ?? s.client_reference_id ?? undefined,
    paid: s.payment_status === "paid",
    amountCents: typeof s.amount_total === "number" ? s.amount_total : undefined,
    currency: typeof s.currency === "string" ? s.currency.toUpperCase() : undefined,
    email: s.customer_details?.email ?? s.customer_email ?? undefined,
  };
}

/** Verify + normalize a Coinbase Commerce webhook (X-CC-Webhook-Signature is an
 *  HMAC-SHA256 of the raw body). `charge:confirmed`/`charge:resolved` mean paid. */
export function parseCoinbaseEvent(raw: string, signature: string | undefined): PaymentEvent | null {
  if (!signature || !COINBASE_WEBHOOK_SECRET || !hexEqual(signature, hmacHex(raw, COINBASE_WEBHOOK_SECRET)))
    return null;
  let body: any;
  try { body = JSON.parse(raw); } catch { return null; }
  const ev = body?.event ?? {};
  const charge = ev.data ?? {};
  const paid = ev.type === "charge:confirmed" || ev.type === "charge:resolved";
  const local = charge.pricing?.local;
  return {
    orderId: charge.metadata?.order_id ?? undefined,
    paid,
    amountCents: local?.amount ? Math.round(parseFloat(local.amount) * 100) : undefined,
    currency: typeof local?.currency === "string" ? local.currency.toUpperCase() : undefined,
  };
}

// ── direct status lookup (webhook-race fallback) ──
//
// A sender who returns from checkout before the webhook lands would otherwise be
// stuck "pending". These confirm the payment straight from the provider so the
// upload session can be issued immediately.

export async function lookupPaid(gateway: Gateway, gatewayRef: string): Promise<PaymentEvent> {
  if (IS_TEST_PAYMENTS) return { paid: false }; // test flow drives the webhook explicitly
  return gateway === "stripe" ? lookupStripe(gatewayRef) : lookupCoinbase(gatewayRef);
}

async function lookupStripe(sessionId: string): Promise<PaymentEvent> {
  try {
    const s = await stripe().checkout.sessions.retrieve(sessionId);
    return {
      orderId: s.metadata?.order_id ?? s.client_reference_id ?? undefined,
      paid: s.payment_status === "paid",
      amountCents: typeof s.amount_total === "number" ? s.amount_total : undefined,
      currency: typeof s.currency === "string" ? s.currency.toUpperCase() : undefined,
      email: s.customer_details?.email ?? undefined,
    };
  } catch {
    return { paid: false };
  }
}

async function lookupCoinbase(chargeId: string): Promise<PaymentEvent> {
  try {
    const body = await coinbaseFetch(`/charges/${encodeURIComponent(chargeId)}`, { method: "GET" });
    const charge = body?.data ?? {};
    const statuses: string[] = Array.isArray(charge.timeline)
      ? charge.timeline.map((t: any) => String(t.status).toUpperCase())
      : [];
    const paid = statuses.some((s) => s === "COMPLETED" || s === "RESOLVED" || s === "CONFIRMED");
    const local = charge.pricing?.local;
    return {
      orderId: charge.metadata?.order_id ?? undefined,
      paid,
      amountCents: local?.amount ? Math.round(parseFloat(local.amount) * 100) : undefined,
      currency: typeof local?.currency === "string" ? local.currency.toUpperCase() : undefined,
    };
  } catch {
    return { paid: false };
  }
}
