// Transactional email via Resend. The one job: email a completed transfer's
// share link(s) to the recipients the sender named, with a copy to the sender.
//
// The Resend API key lives ONLY here (server-side); the browser never sends mail
// or sees the key. We send from a verified domain — noreply@orbitolive.com — with
// the sender's own address as Reply-To, because a provider cannot send *as* the
// sender's domain (their SPF/DKIM don't authorize us). This From/Reply-To shape is
// the standard, deliverable one: the recipient sees it's from Waystation on behalf
// of the sender, and a reply reaches the sender directly.
const env = process.env as Record<string, string | undefined>;

const RESEND_API_KEY = (env.RESEND_API_KEY || "").trim();
const EMAIL_FROM = (env.WAYSTATION_EMAIL_FROM || "Waystation <noreply@orbitolive.com>").trim();

/** Offerable only when the key is present — the route returns 503 otherwise. */
export const emailEnabled = (): boolean => !!RESEND_API_KEY;

export const emailBanner = (): string =>
  `email: resend=${emailEnabled() ? "on" : "off"} from=${emailEnabled() ? EMAIL_FROM : "-"}`;

// Deliberately conservative: trims, requires a single @, a dotted domain, and no
// spaces. Real validation is the provider's; this just rejects obvious garbage.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (s: string): boolean => EMAIL_RE.test(s.trim());

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface LinkEntry { name: string; url: string; }
export interface SendLinkEmailInput {
  to: string[];
  bcc?: string[];
  replyTo: string;
  subject: string;
  message: string;
  links: LinkEntry[];
  hasPassword: boolean;
}

function render(input: SendLinkEmailInput): { html: string; text: string } {
  const { message, links, hasPassword, replyTo } = input;
  const linkLines = links
    .map((l) => `• ${l.name}: ${l.url}`)
    .join("\n");
  const pwLine = hasPassword
    ? "\nThis transfer is password-protected. The sender will share the download password with you separately."
    : "";
  const text =
    (message ? `${message}\n\n` : "") +
    `${replyTo} has sent you ${links.length === 1 ? "a file" : "files"} via Waystation:\n\n` +
    `${linkLines}\n` +
    pwLine +
    `\n\nOpen the link to download. Reply to this email to reach the sender directly.`;

  const linkHtml = links
    .map((l) => `<li style="margin:0 0 8px"><a href="${esc(l.url)}" style="color:#c8922a">${esc(l.name)}</a></li>`)
    .join("");
  const pwHtml = hasPassword
    ? `<p style="color:#6b6257;font-size:13px">This transfer is password-protected — the sender will share the download password with you separately.</p>`
    : "";
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:auto;color:#1a1a1a">` +
    (message ? `<p style="white-space:pre-wrap">${esc(message)}</p>` : "") +
    `<p><strong>${esc(replyTo)}</strong> has sent you ${links.length === 1 ? "a file" : "files"} via Waystation:</p>` +
    `<ul style="list-style:none;padding:0">${linkHtml}</ul>` +
    pwHtml +
    `<p style="color:#6b6257;font-size:13px">Open the link to download. Reply to this email to reach the sender directly.</p>` +
    `</div>`;
  return { html, text };
}

export async function sendLinkEmail(input: SendLinkEmailInput): Promise<void> {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const { html, text } = render(input);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: input.to,
      bcc: input.bcc?.length ? input.bcc : undefined,
      reply_to: input.replyTo,
      subject: input.subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend send failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
}
