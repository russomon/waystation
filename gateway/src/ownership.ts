// Who may act on an in-progress upload.
//
// Ownership is the SERVER-recorded owner of the upload (`uploads.owner_id`, an
// access code id, "admin", or a per-order `pay_…` id) compared with the owner in
// the caller's signed session. Identity is never read from the request body, a
// query string or a header, so a client cannot claim another owner.
//
// This replaces a comparison on `session_id`, which made an upload unrecoverable
// the moment the sender's session lapsed or was replaced by logging in again:
// the new session has a new id, ListParts reattachment returned a neutral 404,
// and the sender had to start over.
//
// Rules (pure; unit-tested in gateway/test/ownership.test.ts):
//   * No session                      -> denied.
//   * Row has an owner                -> allowed iff the session's owner equals it.
//     There is NO session fallback when the owner comparison fails: a different
//     owner holding the same session id is still a different owner.
//   * Row has NO owner (pre-identity) -> legacy rule: allowed iff the stored
//     session id equals the caller's session id.
//   * Recovery by a DIFFERENT session than the one that started the upload is
//     further bounded: the upload must be `active` or `complete` (a lost
//     completion response may be retried) and younger than the active-upload
//     window, matching B2's sweep of unfinished multipart uploads. A session that
//     started the upload keeps its pre-existing behaviour.
//
// Entitlement is not decided here. requireSession re-checks, on every call, that
// a named code has not been revoked and that a paid order is still paid, so a new
// session can never revive a revoked or unpaid entitlement; and a paid upload's
// owner id is minted per order, so only a session for that order can match it.

export interface OwnableUpload {
  ownerId?: string | null;
  sessionId: string | null;
  state: string;
  createdAt: number;
}
export interface OwnerSession { sid: string; ownerId: string }

const RECOVERABLE_STATES = new Set(["active", "complete"]);

export function mayUseUpload(
  row: OwnableUpload,
  session: OwnerSession | null,
  opts: { now: number; recoveryWindowMs: number },
): boolean {
  if (!session || !session.sid || !session.ownerId) return false;
  const sameSession = row.sessionId !== null && row.sessionId === session.sid;
  const rowOwner = typeof row.ownerId === "string" && row.ownerId ? row.ownerId : null;
  if (rowOwner === null) return sameSession; // legacy: owner genuinely absent
  if (rowOwner !== session.ownerId) return false;
  if (sameSession) return true;
  return RECOVERABLE_STATES.has(row.state) && opts.now - row.createdAt <= opts.recoveryWindowMs;
}
