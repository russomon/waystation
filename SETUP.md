# Setup — accounts, B2 bucket, keys

These are the steps only **you** can do (they need your identity/credentials).
Each takes a couple of minutes. When you finish step 4, run the one-command
verifier at the bottom.

## 1. Register for the hackathon
- Go to **https://backblaze-generative-media.devpost.com** and click **Register**.
  (Devpost sign-in with GitHub/Google works.)
- Registration is open through **Aug 3, 2026**. Registering early matters:
  **GMI Cloud credits go to the first 270 participants.**

## 2. Create a Backblaze account
- Sign up at **https://www.backblaze.com/sign-up/cloud-storage** (B2 Cloud Storage).
- Free tier includes **10 GB** — plenty for the demo.
- Verify your email and sign in to the B2 console.

## 3. Create the bucket (with Object Lock)
In the B2 console → **Buckets → Create a Bucket**:
- **Name:** something unique, e.g. `orbitxfer-<yourname>` → put this in `.env` as `B2_BUCKET`.
- **Files in Bucket are:** **Private**.
- **Object Lock:** **Enable** ← important, must be set at creation (needed for the
  WORM manifest / `MANIFEST_LOCK_DAYS`). If you skip it, everything else still
  works; only manifest-locking needs it.
- Create it, then open the bucket and note its **Endpoint**, e.g.
  `s3.us-west-004.backblazeb2.com`. The middle part (`us-west-004`) is your
  **region**.
  - `.env` → `B2_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com`
  - `.env` → `B2_REGION=us-west-004`

## 4. Create an Application Key (scoped to the bucket)
B2 console → **Application Keys → Add a New Application Key**:
- **Name:** `orbitxfer-web`
- **Allow access to Bucket(s):** select the bucket you just made.
- **Type of Access:** Read and Write.
- Create it. Backblaze shows the **keyID** and the **applicationKey** (secret)
  **once** — copy both now.
  - `.env` → `B2_KEY_ID=<keyID>`
  - `.env` → `B2_APP_KEY=<applicationKey>`

## 5. (Optional) GMI Cloud key — for the real summarize/transcribe step
- The hackathon page links a **GMI Cloud** signup with credits (first 270).
  Get an API key and set `.env` → `GMI_API_KEY=…`. Skip for now if you like —
  the pipeline runs fine without it (the summarize step just skips).

## 6. Verify it works on real B2
The repo's `.env` already has the non-secret bits filled; you only pasted the
B2 values above. Then:

```bash
bash scripts/verify-b2.sh
```

This points the gateway at your bucket and runs the full transfer test
(upload → resume → outboard → complete → delivery → verified range download).
It never prints your secrets. Green = you're live on B2.

To also WORM-lock manifests, set `MANIFEST_LOCK_DAYS=1` in `.env` (bucket must
have Object Lock enabled) and run `bash scripts/object-lock-proof.sh` pointed
at your bucket.
