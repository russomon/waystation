"""
OrbitXfer Web — Genblaze pipeline worker.

Triggered by the gateway when B2 reports a new original media object. Fans out
concurrent AI steps on GMI Cloud, writes derivatives + a provenance manifest
back to B2 (under a `derivatives/` prefix so it does NOT re-trigger the
event), and streams progress to the gateway, which relays it to the browser.

Run:  uvicorn worker:app --port 8000 --reload
"""
import asyncio
import os

import httpx
from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
SHARED = os.environ["PIPELINE_SHARED_SECRET"]

# Genblaze + GMI integration points (confirm exact API against backblaze-labs/genblaze):
#   from genblaze import Pipeline
#   from genblaze_gmicloud import GMICloud
#   from genblaze_s3 import S3Store        # writes manifests/assets to B2


class Job(BaseModel):
    bucket: str
    key: str
    transferId: str
    gatewayUrl: str


async def progress(job: Job, event: dict) -> None:
    """Relay a progress event to the gateway → SSE → browser."""
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            await c.post(
                f"{job.gatewayUrl}/api/internal/progress",
                headers={"authorization": f"Bearer {SHARED}"},
                json={"transferId": job.transferId, **event},
            )
        except Exception as e:  # progress is best-effort
            print("progress post failed:", e)


async def run_step(job: Job, name: str) -> None:
    await progress(job, {"type": "step_started", "step": name})
    # TODO: real Genblaze pipeline call, e.g.
    #   run = Pipeline(provider=GMICloud(api_key=os.environ["GMI_API_KEY"]))
    #            .step(model=..., input=src, params=...)
    #            .run()
    #   S3Store(bucket=job.bucket).put(
    #       run.manifest, key=f"derivatives/{job.transferId}/{name}.manifest.json")
    await asyncio.sleep(0.3)  # placeholder for GMI inference latency
    await progress(job, {"type": "step_done", "step": name})


async def run_pipeline(job: Job) -> None:
    await progress(job, {"type": "pipeline_started", "key": job.key})

    # 1. Fetch the original from B2 (boto3 presigned GET / genblaze-s3) → tmp.
    # 2. Probe with ffprobe → branch by media type.
    # 3. Fan out concurrent steps (the "pipeline doing real work"):
    steps = ["transcode_preview", "transcribe", "caption", "summarize", "tag"]
    try:
        await asyncio.gather(*(run_step(job, s) for s in steps))
    except Exception as e:
        await progress(job, {"type": "pipeline_error", "error": str(e)})
        return

    # 4. Write the combined provenance manifest to B2 under Object Lock
    #    (derivatives/ prefix → no event loop).
    await progress(job, {"type": "pipeline_complete"})


@app.post("/jobs")
async def jobs(job: Job, bg: BackgroundTasks, authorization: str = Header(default="")):
    if authorization != f"Bearer {SHARED}":
        raise HTTPException(status_code=401, detail="forbidden")
    bg.add_task(run_pipeline, job)  # return fast; work happens in the background
    return {"accepted": True}


@app.get("/healthz")
async def healthz():
    return {"ok": True}
