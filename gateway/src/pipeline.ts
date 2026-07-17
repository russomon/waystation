// Bridge: turn a B2 object-created event into a Genblaze pipeline job.
// Fire-and-forget — we hand the job to the Python worker and return fast so
// B2 doesn't retry the webhook. The worker streams progress back to
// /api/internal/progress, which the SSE hub relays to the browser.
const env = process.env as Record<string, string>;

export interface PipelineJob {
  bucket: string;
  key: string;
  transferId: string;
  // Sender-selected services + QC profile + self-heal; undefined = everything on.
  options?: Record<string, boolean | string>;
}

export async function dispatchPipeline(job: PipelineJob): Promise<void> {
  try {
    await fetch(`${env.PIPELINE_URL}/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PIPELINE_SHARED_SECRET}`,
      },
      body: JSON.stringify({ ...job, gatewayUrl: env.GATEWAY_PUBLIC_URL }),
    });
  } catch (err) {
    // Don't fail the webhook; log and rely on a future re-drive / retry queue.
    console.error("pipeline dispatch failed", job.key, err);
  }
}
