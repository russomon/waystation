// Central gateway configuration and transport.
//
// The page is served from https://orbitolive.com/waystation/ while the control
// API lives at https://api.orbitolive.com/api — cross-ORIGIN but same-SITE, so
// a SameSite=Strict session cookie is delivered on these requests. Every
// gateway call must go through this module so credentials, base resolution, and
// status handling stay consistent.
//
// The base comes from a <meta> tag rather than a build-time env var, so the
// deployed API host can be changed by editing one line of the published HTML
// without rebuilding and re-exporting the release.
//
// IMPORTANT: presigned Backblaze URLs are NOT gateway requests. They must be
// fetched with a bare fetch() — never with credentials, the session cookie, or
// any gateway header. Sending a cookie to B2 would both fail CORS and leak the
// session to a third party.

const metaContent = (name: string): string =>
  document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content?.trim() ?? "";

/** Gateway API base. Dev default "/api" keeps the vite proxy working. */
export const API_BASE: string = metaContent("waystation-api") || "/api";

/** When set, every job uses this compute target and the selector is locked.
 *  The hosted MVP is all-cloud — gateway and worker live together on one VPS,
 *  so there is no second machine to route to and a visible Local/Cloud toggle
 *  would imply a choice that does not exist. Empty (dev) keeps the selector,
 *  and the dual-worker routing in the gateway is left intact for later.
 *  The gateway enforces the same thing independently; this is UI only. */
export const FORCED_COMPUTE: string = metaContent("waystation-compute");

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayError";
  }
  /** No session, or it expired/was revoked — the sender must re-enter the code. */
  get needsSession(): boolean {
    return this.status === 401;
  }
}

const url = (path: string): string =>
  `${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;

/** Status-aware JSON: never decode before checking the status. */
async function decode(res: Response): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page — fall through to the status-based message */
  }
  if (res.ok) return body;

  const code = String(body?.code ?? "");
  const detail = String(body?.error ?? body?.message ?? "");
  const message =
    detail ||
    ({
      401: "Session required or expired — enter the access code again.",
      403: "Not permitted for this session.",
      413: "That file exceeds the maximum upload size.",
      429: "Too many requests — please wait a moment and retry.",
      503: "Uploads are temporarily disabled.",
    } as Record<number, string>)[res.status] ||
    `Gateway error (HTTP ${res.status}).`;
  throw new GatewayError(res.status, code, message);
}

/** Credentialed gateway fetch. Use for EVERY gateway call, never for B2. */
export async function gwFetch(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url(path), { credentials: "include", ...init });
  return decode(res);
}

export const gwGet = (path: string): Promise<any> => gwFetch(path);

export const gwPost = (path: string, body?: unknown): Promise<any> =>
  gwFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

/** SSE carries the session cookie — EventSource cannot send headers, which is
 *  exactly why cookie auth (not a bearer header) is the right choice here. */
export const gwEventSource = (path: string): EventSource =>
  new EventSource(url(path), { withCredentials: true });

/** Exchange the access code for a session cookie. The code is sent exactly
 *  once and is never persisted client-side — the cookie is HttpOnly, so this
 *  page cannot read it back either. Throws GatewayError(401) on a bad code. */
export const createSession = (code: string): Promise<any> =>
  gwPost("/session", { code });

export const endSession = (): Promise<any> => gwPost("/session/logout");

/** Share/recipient link that preserves the deployed subpath (/waystation/).
 *  location.origin alone drops it and produces a dead link. */
export const recipientLink = (transferId: string): string => {
  const here = new URL(window.location.href);
  here.search = "";
  here.hash = "";
  here.pathname = here.pathname.replace(/[^/]*$/, ""); // drop index.html if present
  const link = new URL(here.toString());
  link.searchParams.set("t", transferId);
  return link.toString();
};

// ───────── payments (pay-per-gig) ─────────
//
// A public sender is authorized by PAYMENT, not an access code: quote the price,
// send them to the provider's hosted checkout, and on their return claim the paid
// order for a payment-backed upload session. See docs/COMMERCIAL_DELIVERY_PLAN.md.

export type PayGateway = "stripe" | "coinbase";

export interface GatewayQuote {
  gateway: PayGateway;
  bytes: number;
  gb: number;
  downloads: number;
  weeks: number;
  baseCents: number;
  extraDownloadsCents: number;
  extraWeeksCents: number;
  feeCents: number;
  amountCents: number;
  currency: string;
}
export interface QuoteResponse {
  downloads: number;
  weeks: number;
  includedDownloads: number;
  maxDownloads: number;
  includedWeeks: number;
  maxWeeks: number;
  stripe: GatewayQuote | null;
  coinbase: GatewayQuote | null;
}
export interface CheckoutResponse {
  orderId: string;
  url: string;
  gateway: PayGateway;
  amountCents: number;
  downloads: number;
  weeks: number;
  expiresAt: number | null;
}
export interface PaymentStatus {
  status: "pending" | "paid" | "expired" | "canceled";
  gateway?: PayGateway;
  amountCents?: number;
  downloads?: number;
  pricedBytes?: number;
  expiresAt?: number | null;
}
export interface PaymentSession {
  status: string;
  authorized: boolean;
  downloads?: number;
  pricedBytes?: number;
}

/** Live price for both gateways. Pure server-side math — no charge is created. */
export const paymentQuote = (bytes: number, downloads: number, weeks: number): Promise<QuoteResponse> =>
  gwPost("/payments/quote", { bytes, downloads, weeks });

/** Create a hosted checkout and a pending order; the caller redirects to `.url`. */
export const startCheckout = (
  gateway: PayGateway, bytes: number, downloads: number, weeks: number,
): Promise<CheckoutResponse> => gwPost("/payments/checkout", { gateway, bytes, downloads, weeks });

/** Where an order stands. Never mints a session. */
export const getPayment = (orderId: string): Promise<PaymentStatus> =>
  gwGet(`/payments/${encodeURIComponent(orderId)}`);

/** Claim a PAID order and mint the payment-backed upload session (cookie). Throws
 *  GatewayError(402, "payment_pending") when the payment has not landed yet. */
export const claimPaymentSession = (orderId: string): Promise<PaymentSession> =>
  gwPost(`/payments/${encodeURIComponent(orderId)}/session`, {});
