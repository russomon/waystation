export interface HashResult { root: string; outboard?: Uint8Array; }
export type HashEvent =
  | { type: "progress"; bytes: number }
  | { type: "finalizing" }
  | { type: "complete" };

export function hashInWorker(
  file: File,
  mode: "range" | "root",
  onEvent: (event: HashEvent) => void,
  signal?: AbortSignal,
): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hashWorker.ts", import.meta.url), { type: "module" });
    // Hashing is local and costs no bandwidth, but it is not free: it reads the
    // whole file. A paused upload that left it running would keep a core busy,
    // and resuming would start a SECOND worker over the same file. Terminate on
    // abort — resume re-hashes from the start anyway, since nothing carries a
    // partial BLAKE3 state across sessions.
    const stop = () => {
      worker.terminate();
      reject(new DOMException("Integrity check aborted", "AbortError"));
    };
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop, { once: true });
    worker.onmessage = (event: MessageEvent<any>) => {
      const message = event.data;
      if (message.type === "progress" || message.type === "finalizing") {
        onEvent(message);
        return;
      }
      worker.terminate();
      if (message.type === "error") {
        reject(new Error(message.message || "Integrity check failed."));
        return;
      }
      onEvent({ type: "complete" });
      resolve({
        root: message.root,
        outboard: message.outboard ? new Uint8Array(message.outboard) : undefined,
      });
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Integrity worker failed."));
    };
    worker.postMessage({ file, mode });
  });
}
