// A per-browser memory of the share links this device recently created, so a
// sender who navigates away and comes back can still find the link. It is a
// convenience only: entries live in localStorage (this browser, this device),
// never reach the gateway, and are pruned by age. The durable copy of a link is
// the email the sender/recipient receive — this is the offline stopgap.
const KEY = "ws_recent_transfers";
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 40 * 24 * 60 * 60 * 1000; // links live at most ~5 weeks + a day; 40d covers it

export interface RecentTransfer {
  name: string;
  link: string;
  savedAt: number; // ms epoch
}

function read(): RecentTransfer[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    const now = Date.now();
    return list
      .filter((e): e is RecentTransfer =>
        e && typeof e.link === "string" && typeof e.name === "string" &&
        typeof e.savedAt === "number" && now - e.savedAt < MAX_AGE_MS)
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function write(list: RecentTransfer[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ENTRIES))); }
  catch { /* private windows / quota — the list is optional */ }
}

/** Remember one just-created link. Newest first; de-duplicated by link. */
export function rememberTransfer(entry: { name: string; link: string }): void {
  const list = read().filter((e) => e.link !== entry.link);
  list.unshift({ name: entry.name, link: entry.link, savedAt: Date.now() });
  write(list);
}

/** The remembered, non-expired links, newest first. */
export const recentTransfers = (): RecentTransfer[] => read();

export function clearRecentTransfers(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
