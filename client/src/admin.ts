// Access-code administration panel. Mounted only when GET /session says this
// browser holds the admin session; every other sender never sees it and the
// gateway answers its routes with a neutral 404 for them anyway.
//
// A newly issued code is shown once, in the reveal block, and discarded the
// moment the admin dismisses it. It is never written to storage of any kind.
import { Check, Copy, createElement as createIcon } from "lucide";
import { copyText } from "./clipboard.js";
import { GatewayError, gwGet, gwPost } from "./config.js";
import { formatBytes, formatUsd } from "./format.js";

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

type SortDir = "asc" | "desc";
type SortKey = string | number;

/** Make a header cell a sort control. `dir` is the current direction when this
 *  column is the sorted one, else null. A real <button> so it is reachable and
 *  operable from the keyboard; aria-sort tells assistive tech the state. */
function sortableHeader(th: HTMLElement, text: string, dir: SortDir | null, onClick: () => void): void {
  th.replaceChildren();
  th.setAttribute("aria-sort", dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none");
  const b = document.createElement("button");
  b.type = "button";
  b.className = "sort-btn";
  b.append(document.createTextNode(text));
  const arrow = document.createElement("span");
  arrow.className = "sort-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = dir === "asc" ? " ▲" : dir === "desc" ? " ▼" : "";
  b.append(arrow);
  b.onclick = onClick;
  th.append(b);
}

/** Compare two sort keys: numbers numerically, text case-insensitively. */
const compareKeys = (a: SortKey, b: SortKey): number =>
  typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });

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

  // Client-side sort: the code list is small and arrives whole.
  const CODE_COLS: { text: string; key: (c: CodeRow) => SortKey; first: SortDir }[] = [
    { text: "Label", key: (c) => c.label, first: "asc" },
    { text: "Created", key: (c) => Date.parse(c.createdAt) || 0, first: "desc" },
    { text: "Last used", key: (c) => (c.lastUsedAt ? Date.parse(c.lastUsedAt) : 0), first: "desc" },
    { text: "Transfers", key: (c) => c.transfers, first: "desc" },
    { text: "Status", key: (c) => (c.revokedAt ? 1 : 0), first: "asc" },
  ];
  let codeRows: CodeRow[] = [];
  let codeSort: { col: number; dir: SortDir } | null = null;
  const codeHeads = Array.from(table.tHead!.rows[0].cells);
  const paintCodeHeads = () => {
    CODE_COLS.forEach((c, i) => sortableHeader(
      codeHeads[i], c.text, codeSort?.col === i ? codeSort.dir : null,
      () => {
        codeSort = codeSort?.col === i
          ? { col: i, dir: codeSort.dir === "asc" ? "desc" : "asc" }
          : { col: i, dir: c.first };
        render(codeRows);
      },
    ));
  };

  const render = (codesIn: CodeRow[]) => {
    codeRows = codesIn;
    const codes = codeSort
      ? codesIn
          .map((c, i) => ({ c, i }))
          .sort((x, y) => {
            const k = CODE_COLS[codeSort!.col].key;
            const d = compareKeys(k(x.c), k(y.c));
            return (codeSort!.dir === "asc" ? d : -d) || x.i - y.i;
          })
          .map((x) => x.c)
      : codesIn;
    paintCodeHeads();
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

  // ── activity / usage stats ──
  const statTiles = $("#statTiles");
  const statRecent = $("#statRecent");
  const windowBtns = Array.from(root.querySelectorAll<HTMLButtonElement>(".admin-window button"));
  let statWindow = "all";

  const tile = (value: string, lbl: string): HTMLElement => {
    const d = document.createElement("div");
    d.className = "stat-tile";
    const v = document.createElement("div"); v.className = "v"; v.textContent = value;
    const l = document.createElement("div"); l.className = "l"; l.textContent = lbl;
    d.append(v, l);
    return d;
  };
  /** A small read-only table. With `keys` (one sort key per cell, parallel to
   *  `rows`) every header sorts the rows client-side; without, it is static.
   *  Numeric columns open largest-first, text columns A-Z. */
  const miniTable = (title: string, head: string[], rows: string[][], keys?: SortKey[][]): HTMLElement => {
    const wrap = document.createElement("div");
    const h = document.createElement("h4"); h.textContent = title; wrap.append(h);
    if (!rows.length) {
      const p = document.createElement("p"); p.className = "muted";
      p.style.cssText = "font-size:12px;margin:0"; p.textContent = "Nothing yet.";
      wrap.append(p); return wrap;
    }
    const t = document.createElement("table");
    const thead = document.createElement("thead"); const htr = document.createElement("tr");
    const ths = head.map((x) => { const th = document.createElement("th"); th.textContent = x; htr.append(th); return th; });
    thead.append(htr);
    const tb = document.createElement("tbody");
    let sort: { col: number; dir: SortDir } | null = null;
    const paint = () => {
      const order = rows.map((_, i) => i);
      if (keys && sort) {
        const { col, dir } = sort;
        order.sort((x, y) => {
          const d = compareKeys(keys[x][col], keys[y][col]);
          return (dir === "asc" ? d : -d) || x - y;
        });
      }
      tb.replaceChildren();
      for (const i of order) {
        const tr = document.createElement("tr");
        for (const cell of rows[i]) { const td = document.createElement("td"); td.textContent = cell; tr.append(td); }
        tb.append(tr);
      }
      if (keys) ths.forEach((th, c) => sortableHeader(th, head[c], sort?.col === c ? sort.dir : null, () => {
        const numeric = typeof keys[0][c] === "number";
        sort = sort?.col === c
          ? { col: c, dir: sort.dir === "asc" ? "desc" : "asc" }
          : { col: c, dir: numeric ? "desc" : "asc" };
        paint();
      }));
    };
    paint();
    t.append(thead, tb); wrap.append(t);
    return wrap;
  };

  // Sizes: whole-GB formatting hid small files as "0.00 GB", so use the shared
  // decimal byte formatter (kB/MB/GB) everywhere on this panel.
  const size = (gbVal: number): string => formatBytes(Math.round(gbVal * 1e9));
  const statChart = $("#statChart");
  const statExtra = $("#statExtra");
  const xferList = $("#xferList");
  const xferMore = $<HTMLButtonElement>("#xferMore");
  const xferFilter = $<HTMLSelectElement>("#xferFilter");
  const PAGE = 25;
  let xferOffset = 0;
  // Sorting is the gateway's job: the list is paged, so sorting only the rows
  // already loaded would show a misleading order. Defaults match the gateway's.
  type XferSort = "when" | "name" | "sender" | "size" | "downloads" | "expires" | "status";
  const XFER_COLS: { text: string; key: XferSort; first: SortDir }[] = [
    { text: "When", key: "when", first: "desc" },
    { text: "File", key: "name", first: "asc" },
    { text: "Sender", key: "sender", first: "asc" },
    { text: "Size", key: "size", first: "desc" },
    { text: "Downloads", key: "downloads", first: "desc" },
    { text: "Link expires", key: "expires", first: "asc" },
    { text: "Status", key: "status", first: "asc" },
  ];
  let xferSort: XferSort = "when";
  let xferDir: SortDir = "desc";
  let xferReq = 0; // drops a slow response that a newer click has superseded

  const pill = (status: string): HTMLElement => {
    const s = document.createElement("span");
    s.className = `pill${status === "expiring" ? " warn" : status === "revoked" || status === "expired" ? " bad" : ""}`;
    s.textContent = status === "expiring" ? "expires soon" : status === "uploading" ? "uploading" : status;
    return s;
  };
  const xferRow = (r: any): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    const cells: (string | HTMLElement)[] = [
      when(r.createdAt),
      `${r.kind === "folder" ? "📁 " : ""}${r.name}`,
      r.owner,
      size(r.gb),
      `${r.downloadsUsed}${r.downloadsAllowed != null ? "/" + r.downloadsAllowed : ""}`,
      r.expiresAt ? when(r.expiresAt) : "—",
      pill(r.status),
    ];
    cells.forEach((cell, i) => {
      const td = document.createElement("td");
      if (i === 1) td.className = "name";
      if (typeof cell === "string") td.textContent = cell; else td.append(cell);
      tr.append(td);
    });
    return tr;
  };
  const xferTable = (): HTMLTableSectionElement => {
    let tb = xferList.querySelector("tbody");
    if (tb) return tb;
    xferList.replaceChildren();
    const t = document.createElement("table");
    const thead = document.createElement("thead"); const htr = document.createElement("tr");
    for (const c of XFER_COLS) {
      const th = document.createElement("th");
      sortableHeader(th, c.text, xferSort === c.key ? xferDir : null, () => {
        if (xferSort === c.key) xferDir = xferDir === "asc" ? "desc" : "asc";
        else { xferSort = c.key; xferDir = c.first; }
        void loadTransfers(false);
      });
      htr.append(th);
    }
    thead.append(htr); tb = document.createElement("tbody"); t.append(thead, tb); xferList.append(t);
    return tb;
  };
  const loadTransfers = async (append: boolean): Promise<void> => {
    try {
      if (!append) xferOffset = 0;
      const req = ++xferReq;
      const q = `window=${statWindow}&status=${xferFilter.value}&sort=${xferSort}&dir=${xferDir}&limit=${PAGE}&offset=${xferOffset}`;
      const r = await gwGet(`/admin/transfers?${q}`);
      if (req !== xferReq) return;
      if (!append) xferList.replaceChildren();
      if (!r.rows.length && !append) {
        const p = document.createElement("p"); p.className = "muted";
        p.style.cssText = "font-size:12px;margin:0"; p.textContent = "Nothing matches.";
        xferList.append(p); xferMore.hidden = true; return;
      }
      const tb = xferTable();
      for (const row of r.rows) tb.append(xferRow(row));
      xferOffset += r.rows.length;
      xferMore.hidden = xferOffset >= r.total;
      xferMore.textContent = `Load more (${r.total - xferOffset} left)`;
    } catch (e) { fail(e); }
  };
  xferMore.onclick = () => void loadTransfers(true);
  xferFilter.onchange = () => void loadTransfers(false);

  const renderChart = (daily: { day: string; transfers: number; gb: number }[]): void => {
    const NS = "http://www.w3.org/2000/svg";
    const max = Math.max(1, ...daily.map((d) => d.transfers));
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${daily.length * 10} 80`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Transfers per day, last ${daily.length} days (UTC)`);
    daily.forEach((d, i) => {
      const h = d.transfers ? Math.max(3, (d.transfers / max) * 76) : 1.5;
      const rect = document.createElementNS(NS, "rect");
      rect.setAttribute("x", String(i * 10 + 1)); rect.setAttribute("width", "8");
      rect.setAttribute("y", String(80 - h)); rect.setAttribute("height", String(h));
      rect.setAttribute("class", d.transfers ? "bar" : "bar zero");
      const t = document.createElementNS(NS, "title");
      t.textContent = `${d.day}: ${d.transfers} transfer${d.transfers === 1 ? "" : "s"}, ${size(d.gb)}`;
      rect.append(t); svg.append(rect);
    });
    const h4 = document.createElement("h4"); h4.textContent = "Transfers per day — last 30 days (UTC)";
    const axis = document.createElement("div"); axis.className = "axis";
    const first = document.createElement("span"); first.textContent = daily[0]?.day ?? "";
    const peak = document.createElement("span"); peak.textContent = `peak ${max}/day`;
    const last = document.createElement("span"); last.textContent = daily[daily.length - 1]?.day ?? "";
    axis.append(first, peak, last);
    statChart.replaceChildren(h4, svg, axis);
  };

  const loadStats = async (): Promise<void> => {
    try {
      const s = await gwGet(`/admin/stats?window=${statWindow}`);
      const q = s.quota;
      statTiles.replaceChildren(
        tile(String(s.transfers), "Transfers"),
        tile(size(s.gbUploaded), "Uploaded"),
        tile(String(s.downloads), "Downloads"),
        tile(size(s.gbEgressed), "Downloaded ~"),
        tile(formatUsd(s.payments.revenueCents), "Revenue"),
        tile(String(s.payments.paidOrders), "Paid orders"),
        tile(q ? `${q.jobsLast24h} / ${q.dailyCap}` : "—", "Jobs in last 24 h / daily cap"),
        tile(String(s.links.active), "Active links"),
        tile(String(s.links.expiringSoon), "Expiring in 3 days"),
        tile(String(s.links.expired), "Expired links"),
        tile(String(s.links.revoked), "Revoked links"),
        tile(String(s.activeUploads), "Unfinished uploads"),
      );
      renderChart(s.daily ?? []);
      const bySender: string[][] = (s.bySender ?? []).map((r: any) => [
        r.owner, String(r.transfers), size(r.gb), String(r.downloads), when(r.lastAt),
      ]);
      const bySenderKeys: SortKey[][] = (s.bySender ?? []).map((r: any) => [
        r.owner, r.transfers, r.gb, r.downloads, r.lastAt ? Date.parse(r.lastAt) : 0,
      ]);
      const unfinished: string[][] = (s.unfinished ?? []).map((r: any) => [
        when(r.createdAt), r.name, r.owner, r.sizeBytes == null ? "—" : formatBytes(r.sizeBytes),
        r.holdsSlot ? "yes — counts toward the in-flight cap" : "no — older than 24 h",
      ]);
      const unfinishedKeys: SortKey[][] = (s.unfinished ?? []).map((r: any) => [
        Date.parse(r.createdAt), r.name, r.owner, r.sizeBytes ?? -1, r.holdsSlot ? 1 : 0,
      ]);
      const byGw = Object.entries(s.payments.byGateway ?? {})
        .map(([g, v]: [string, any]) => `${g} ${v.orders}`).join(" · ");
      const recentO: string[][] = (s.recentOrders ?? []).map((r: any) => [
        when(r.paidAt), r.gateway, formatUsd(r.amountCents), `${r.downloads} dl · ${r.weeks} wk`, size(r.gb),
      ]);
      const recentOKeys: SortKey[][] = (s.recentOrders ?? []).map((r: any) => [
        r.paidAt ? Date.parse(r.paidAt) : 0, r.gateway, r.amountCents, r.downloads * 100 + r.weeks, r.gb,
      ]);
      statExtra.replaceChildren(
        miniTable("By sender", ["Sender", "Transfers", "Size", "Downloads", "Last transfer"], bySender, bySenderKeys),
        miniTable("Unfinished uploads", ["Started", "File", "Sender", "Declared size", "Holds an upload slot?"], unfinished, unfinishedKeys),
      );
      statRecent.replaceChildren(
        miniTable(`Recent paid orders${byGw ? ` — ${byGw}` : ""}`, ["When", "Method", "Amount", "Bought", "Size"], recentO, recentOKeys),
      );
      await loadTransfers(false);
    } catch (e) { fail(e); }
  };
  for (const b of windowBtns) {
    b.onclick = () => {
      statWindow = b.dataset.window ?? "all";
      for (const x of windowBtns) x.setAttribute("aria-pressed", String(x === b));
      void loadStats();
    };
  }

  root.hidden = false;
  root.addEventListener("toggle", () => { if (root.open) { void refresh(); void loadStats(); } }, { once: true });
}
