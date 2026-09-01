export interface HashResult { root: string; outboard?: Uint8Array; }
export type HashEvent =
  | { type: "progress"; bytes: number }
  | { type: "finalizing" }
  | { type: "complete" };

export function hashInWorker(
  file: File,
  mode: "range" | "root",
  onEvent: (event: HashEvent) => void,
): Promise<HashResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hashWorker.ts", import.meta.url), { type: "module" });
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
