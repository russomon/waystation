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
