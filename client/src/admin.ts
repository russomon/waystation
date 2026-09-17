// Access-code administration panel. Mounted only when GET /session says this
// browser holds the admin session; every other sender never sees it and the
// gateway answers its routes with a neutral 404 for them anyway.
//
// A newly issued code is shown once, in the reveal block, and discarded the
// moment the admin dismisses it. It is never written to storage of any kind.
import { Check, Copy, createElement as createIcon } from "lucide";
import { copyText } from "./clipboard.js";
import { GatewayError, gwGet, gwPost } from "./config.js";

interface CodeRow {
  codeId: string;
  label: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  transfers: number;
}

const icon = (glyph: Parameters<typeof createIcon>[0]) => createIcon(glyph, { width: 16, height: 16 });
// Date AND time: two codes made minutes apart must be tellable apart.
const when = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "never";

export function mountAdmin(root: HTMLDetailsElement): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const label = $<HTMLInputElement>("#codeLabel");
  const custom = $<HTMLInputElement>("#codeCustom");
  const add = $<HTMLButtonElement>("#codeAdd");
  const reveal = $("#codeReveal");
  const msg = $("#adminMsg");
  const table = $<HTMLTableElement>("#codeTable");
  const body = table.tBodies[0];
  const empty = $("#codeEmpty");

  const fail = (e: unknown) => {
    msg.textContent = e instanceof GatewayError ? e.message : "Could not reach the waystation.";
    msg.classList.add("bad");
  };
  const note = (text: string) => { msg.textContent = text; msg.classList.remove("bad"); };

  const render = (codes: CodeRow[]) => {
    body.replaceChildren();
    table.hidden = codes.length === 0;
    empty.hidden = codes.length > 0;
    for (const c of codes) {
      const tr = document.createElement("tr");
      if (c.revokedAt) tr.className = "revoked";
      const cell = (text: string, cls?: string) => {
        const td = document.createElement("td");
        td.textContent = text;
        if (cls) td.className = cls;
        tr.append(td);
        return td;
      };
      cell(c.label);
      cell(when(c.createdAt));
      cell(when(c.lastUsedAt));
      cell(String(c.transfers), "num");
      cell(c.revokedAt ? `Revoked ${when(c.revokedAt)}` : "Active");
      const actions = document.createElement("td");
      if (!c.revokedAt) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn-small";
        btn.textContent = "Revoke";
        // Two clicks, no modal: the first arms the button, the second acts.
        // Anything else on the page disarms it.
        btn.onclick = async () => {
          if (btn.dataset.armed !== "1") {
            btn.dataset.armed = "1";
            btn.textContent = `Revoke "${c.label}"?`;
            const disarm = () => { btn.dataset.armed = ""; btn.textContent = "Revoke"; };
            window.setTimeout(() => document.addEventListener("click", disarm, { once: true }), 0);
            return;
          }
          btn.disabled = true;
          try {
            await gwPost(`/admin/codes/${encodeURIComponent(c.codeId)}/revoke`);
            note(`"${c.label}" revoked. That client is cut off from their next request.`);
            await refresh();
          } catch (e) { fail(e); btn.disabled = false; }
        };
        actions.append(btn);
      }
      tr.append(actions);
      body.append(tr);
    }
  };

  const refresh = async () => {
    try {
      const { codes } = await gwGet("/admin/codes");
      render(codes as CodeRow[]);
    } catch (e) { fail(e); }
  };

  const showCode = (row: { label: string; code: string; custom?: boolean }) => {
    reveal.replaceChildren();
    const head = document.createElement("strong");
    head.textContent = row.custom
      ? `Access code for ${row.label} — as you chose it`
      : `Access code for ${row.label} — shown once`;
    const code = document.createElement("code");
    code.textContent = row.code;
    const actions = document.createElement("div");
    actions.className = "reveal-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "btn-small";
    copy.append(icon(Copy), document.createTextNode(" Copy"));
    const status = document.createElement("span");
    status.className = "muted";
    copy.onclick = async () => {
      try {
        await copyText(row.code);
        copy.replaceChildren(icon(Check), document.createTextNode(" Copied"));
        status.textContent = "";
      } catch { status.textContent = "Could not copy — select the code to copy it manually."; }
    };
    const done = document.createElement("button");
    done.type = "button";
    done.className = "btn-small";
    done.textContent = "I've saved it";
    done.onclick = () => { reveal.replaceChildren(); reveal.hidden = true; };
    const warn = document.createElement("p");
    warn.className = "muted";
    warn.style.margin = ".5rem 0 0";
    warn.textContent = row.custom
      ? "Tell the client privately, exactly as written — it is case-sensitive. The page will not show it again, but you chose it, so you know it."
      : "Send it to the client privately. It cannot be shown again; if it is lost, revoke it and add a new one.";
    actions.append(copy, done, status);
    reveal.append(head, code, actions, warn);
    reveal.hidden = false;
  };

  const create = async () => {
    const text = label.value.trim();
    if (!text) { note("Give the code a label — usually the client's name."); label.focus(); return; }
    const chosen = custom.value.trim();
    if (chosen && chosen.length < 8) { note("A code you choose must be at least 8 characters."); custom.focus(); return; }
    add.disabled = true;
    note("Issuing…");
    try {
      const row = await gwPost("/admin/codes", chosen ? { label: text, code: chosen } : { label: text });
      label.value = "";
      custom.value = "";
      showCode(row);
      note("");
      await refresh();
    } catch (e) { fail(e); }
    add.disabled = false;
  };
  add.onclick = () => void create();
  label.onkeydown = custom.onkeydown = (e) => { if (e.key === "Enter") void create(); };

  root.hidden = false;
  root.addEventListener("toggle", () => { if (root.open) void refresh(); }, { once: true });
}
