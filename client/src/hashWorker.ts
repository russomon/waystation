import { hashFile, hashFileRootOnly } from "./blake3.js";

type Request = { file: File; mode: "range" | "root" };

self.onmessage = async (event: MessageEvent<Request>) => {
  const { file, mode } = event.data;
  try {
    const progress = (bytes: number) => self.postMessage({ type: "progress", bytes });
    const finalizing = () => self.postMessage({ type: "finalizing" });
    const result = mode === "range"
      ? await hashFile(file, progress, 16 << 20, finalizing)
      : await hashFileRootOnly(file, progress, 16 << 20, finalizing);
    if ("outboard" in result) {
      const outboard = (result as { root: string; outboard: Uint8Array }).outboard;
      (self as any).postMessage({ type: "complete", root: result.root, outboard }, [outboard.buffer]);
    } else {
      self.postMessage({ type: "complete", root: result.root });
    }
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};

export {};
