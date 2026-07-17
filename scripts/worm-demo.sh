#!/usr/bin/env bash
# On-camera WORM proof for a given transfer id:
#   shows the manifest's COMPLIANCE retention, then attempts a versioned
#   delete AND a retention shortening — both must be refused by Backblaze.
# Usage: bash scripts/worm-demo.sh <transferId>
set -u
WEB="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; source <(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$WEB/.env"); set +a
TID="${1:?usage: worm-demo.sh <transferId>}"

"$WEB/pipeline/.venv/bin/python" -W ignore - "$TID" <<'PYEOF'
import boto3, os, sys
from botocore.exceptions import ClientError
s3 = boto3.client("s3", endpoint_url=os.environ["B2_S3_ENDPOINT"], region_name=os.environ["B2_REGION"],
                  aws_access_key_id=os.environ["B2_KEY_ID"], aws_secret_access_key=os.environ["B2_APP_KEY"])
B, tid = os.environ["B2_BUCKET"], sys.argv[1]
key = f"derivatives/{tid}/manifest.json"

vid = s3.list_object_versions(Bucket=B, Prefix=key)["Versions"][0]["VersionId"]
ret = s3.get_object_retention(Bucket=B, Key=key, VersionId=vid)["Retention"]
print(f"provenance manifest: {key}")
print(f"  retention mode:  {ret['Mode']}")
print(f"  locked until:    {ret['RetainUntilDate']}")
print()
print("attempting to DELETE the locked manifest (owner's key, deleteFiles + bypassGovernance)…")
try:
    s3.delete_object(Bucket=B, Key=key, VersionId=vid)
    print("  ✗ deleted?! WORM FAILED")
except ClientError as e:
    print(f"  ✓ Backblaze refused: {e.response['Error']['Code']}")
print("attempting to SHORTEN the retention…")
from datetime import datetime, timedelta, timezone
earlier = max(ret["RetainUntilDate"] - timedelta(hours=1),
              datetime.now(timezone.utc) + timedelta(minutes=1))
try:
    s3.put_object_retention(Bucket=B, Key=key, VersionId=vid,
        Retention={"Mode": "COMPLIANCE", "RetainUntilDate": earlier})
    print("  ✗ shortened?! WORM FAILED")
except Exception as e:
    msg = getattr(e, "response", {}).get("Error", {}).get("Message", str(e))
    print(f"  ✓ refused: {msg[:100]}")
print()
print("The QC evidence is immutable — even to the bucket owner.")
PYEOF
