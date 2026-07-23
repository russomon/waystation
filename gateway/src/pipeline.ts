// Bridge: turn a B2 object-created event into a Genblaze pipeline job.
// Fire-and-forget — we hand the job to the Python worker and return fast so
// B2 doesn't retry the webhook. The worker streams progress back to
// /api/internal/progress, which the SSE hub relays to the browser.
const env = process.env as Record<string, string>;

export interface PipelineJob {
  bucket: string;
  key: string;
  transferId: string;
  // Sender-selected services + QC profile/compute target; undefined = everything on.
  options?: Record<string, boolean | string>;
}

export async function dispatchPipeline(job: PipelineJob): Promise<void> {
  // Sender-selected compute location: "cloud" routes to the Docker/cloud
  // worker when one is registered (PIPELINE_URL_CLOUD); anything else — or
  // no cloud worker configured — goes to the default worker (PIPELINE_URL).
  const wantCloud = job.options?.compute === "cloud";
  const url = (wantCloud && env.PIPELINE_URL_CLOUD) || env.PIPELINE_URL;
  if (wantCloud && !env.PIPELINE_URL_CLOUD)
    console.warn("compute=cloud requested but PIPELINE_URL_CLOUD not set — using default worker");
  try {
    await fetch(`${url}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PIPELINE_SHARED_SECRET}`,
      },
      body: JSON.stringify({ ...job, gatewayUrl: env.GATEWAY_PUBLIC_URL }),
    });
  } catch (err) {
    // Don't fail the webhook; log and rely on a future re-drive / retry queue.
    console.error("pipeline dispatch failed", job.key, url, err);
  }
}
