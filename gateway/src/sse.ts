// Tiny in-process pub/sub so pipeline progress reaches the sender + recipient
// pages over SSE. For multi-instance production, back this with Redis pub/sub
// or Cloudflare Durable Objects — same publish()/subscribe() surface.
type Client = (event: unknown) => void;
const channels = new Map<string, Set<Client>>();

export function subscribe(transferId: string, fn: Client): () => void {
  let set = channels.get(transferId);
  if (!set) channels.set(transferId, (set = new Set()));
  set.add(fn);
  return () => { set!.delete(fn); if (set!.size === 0) channels.delete(transferId); };
}

export function publish(transferId: string, event: unknown): void {
  channels.get(transferId)?.forEach((fn) => fn(event));
}
