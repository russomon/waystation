#!/usr/bin/env bash
# Full local gateway -> worker -> MinIO loop for explicit interpretation.
# GMI is an OpenAI-compatible local mock; no cloud calls or production access.
set -euo pipefail
export PATH="/opt/homebrew/bin:$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/pipeline/.venv/bin/python"
DATA=$(mktemp -d); WORK=$(mktemp -d)
BUCKET=waystation-test SHARED=proof-shared
export B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1
export B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true
cleanup(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:8009; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; rm -rf "$DATA" "$WORK"; }
trap cleanup EXIT
cleanup_ports(){ { lsof -ti:8787; lsof -ti:8000; lsof -ti:8009; lsof -ti:9000; } 2>/dev/null | xargs kill -9 2>/dev/null || true; }
cleanup_ports

"$PY" - <<'PYEOF' >/tmp/ai-interpretive-mock-gmi.log 2>&1 &
import json, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
RISK_IDS = ["perceptual_visual_defect", "temporal_continuity_defect", "typography_defect",
            "lip_sync_error", "audible_defect", "caption_semantic_mismatch",
            "spoken_language_mismatch", "caption_text_quality",
            "editorial_intent", "creative_intent", "aesthetic_quality"]
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        content = body["messages"][0]["content"]
        text = " ".join(item.get("text", "") for item in content if isinstance(item, dict))
        if "AI review planner" in text:
            payload = json.dumps({"review_objective":"bounded proof review",
              "risk_targets":[{"risk_id":"perceptual_visual_defect",
                "review_question":"Is an artifact visible?"}],
              "evidence_requests":[
                {"type":"frame_sequence","time_seconds":0.6,"start_seconds":None,"duration_seconds":None,
                 "risk_ids":["temporal_continuity_defect"],
                 "reason":"temporal proof","review_question":"Continuity defect visible?"},
                {"type":"audio","time_seconds":None,"start_seconds":0.2,"duration_seconds":1.0,
                 "risk_ids":["audible_defect"],"reason":"audio proof",
                 "review_question":"Defect audible?"}],"coverage_limits":["mock sample"]})
            response = json.dumps({"model": body.get("model"),
              "choices":[{"finish_reason":"stop","message":{"content":payload}}],
              "usage":{"prompt_tokens":80,"completion_tokens":20,"total_tokens":100}}).encode()
            self.send_response(200); self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(response))); self.end_headers(); self.wfile.write(response)
            return
        stage = next((name for name in ("gmi_visual_analysis", "gmi_audio_analysis", "synthesis")
                      if f"stage {name}" in text), "analysis")
        evidence = re.findall(r'interpretive-evidence-\d+', text)
        risks = RISK_IDS if stage == "synthesis" else [
            "perceptual_visual_defect" if stage == "gmi_visual_analysis" else "audible_defect"]
        observations = []
        for risk in risks:
            concern = risk == "perceptual_visual_defect"
            cited = ["interpretive-evidence-02"] if risk == "aesthetic_quality" else evidence[:1]
            observations.append({"issue_description": f"Mock {stage.replace('_', ' ')} observation",
                "risk_id": risk, "finding_state": "concern" if concern else "no_concern",
                "severity": "reject" if concern else "info",
                "context": "bounded proof evidence", "confidence": 0.96,
                "uncertainty": "local mock, not a live GMI judgment",
                "evidence_ids": cited, "evidence_location": "interior",
                "intent_state": "confirmed_defect" if concern else "not_applicable",
                "evidence_transcriptions": [],
                "review_question": "Does the cited sample need human follow-up?",
                })
        payload = json.dumps({"observations": observations})
        response = json.dumps({"model": body.get("model"),
                               "choices": [{"finish_reason": "stop", "message": {"content": payload}}],
                               "usage": {"prompt_tokens": 120, "completion_tokens": 30,
                                         "total_tokens": 150}}).encode()
        time.sleep(0.08)
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(response))); self.end_headers(); self.wfile.write(response)
    def log_message(self, *_args): pass
ThreadingHTTPServer(("127.0.0.1", 8009), Handler).serve_forever()
PYEOF
until curl -s -o /dev/null -X POST http://localhost:8009/v1/chat/completions \
  -H 'content-type: application/json' --data '{"model":"probe","messages":[{"content":[]}]}' ; do sleep .2; done

MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin minio server "$DATA" \
  --address :9000 --console-address :9011 >/tmp/ai-interpretive-minio.log 2>&1 &
until curl -sf -o /dev/null http://localhost:9000/minio/health/live; do sleep .2; done

(cd "$ROOT/gateway" && env \
  B2_S3_ENDPOINT=http://localhost:9000 B2_REGION=us-east-1 B2_KEY_ID=minioadmin B2_APP_KEY=minioadmin \
  B2_BUCKET=$BUCKET B2_FORCE_PATH_STYLE=true B2_EVENT_SIGNING_SECRET=unused \
  PIPELINE_URL=http://localhost:8000 PIPELINE_SHARED_SECRET=$SHARED GATEWAY_PUBLIC_URL=http://localhost:8787 \
  CDN_BASE=https://cdn.test CDN_TOKEN_SECRET=dev DEV_TRIGGER_ON_COMPLETE=true \
  ALLOW_AI_INTERPRETIVE=true WAYSTATION_AUTH_MODE=disabled PORT=8787 \
  npx tsx src/server.ts >/tmp/ai-interpretive-gateway.log 2>&1) &
until curl -sf -o /dev/null http://localhost:8787/healthz; do sleep .2; done

(cd "$ROOT/pipeline" && env \
  PIPELINE_SHARED_SECRET=$SHARED GMI_API_KEY=mock GMI_BASE_URL=http://localhost:8009 \
  GMI_MULTIMODAL_MODEL=mock/multimodal GMI_MODEL=mock/text AI_QC_MIN_INTERVAL=0 \
  AI_INTERPRETIVE_RUN_ENABLED=true AI_INTERPRETIVE_MAX_FRAMES=2 \
  AI_INTERPRETIVE_MAX_AUDIO_WINDOWS=1 AI_INTERPRETIVE_TIMEOUT_SECONDS=10 \
  ./.venv/bin/uvicorn worker:app --port 8000 >/tmp/ai-interpretive-worker.log 2>&1) &
until curl -sf -o /dev/null http://localhost:8000/healthz; do sleep .2; done

"$PY" - <<PYEOF
import boto3
from botocore.config import Config
s3=boto3.client('s3',endpoint_url='http://localhost:9000',region_name='us-east-1',
    aws_access_key_id='minioadmin',aws_secret_access_key='minioadmin',
    config=Config(s3={'addressing_style':'path'}))
s3.create_bucket(Bucket='$BUCKET')
PYEOF
ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:duration=2 -c:v libx264 -pix_fmt yuv420p \
  -c:a aac -shortest "$WORK/master.mp4" >/dev/null 2>&1

"$PY" - "$WORK/master.mp4" <<'PYEOF' > "$WORK/transfer-id"
import json, sys, urllib.request
path=sys.argv[1]; data=open(path,'rb').read(); base='http://localhost:8787/api'
def post(route, body):
    req=urllib.request.Request(base+route, data=json.dumps(body).encode(),
        headers={'content-type':'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(req))
init=post('/uploads', {'filename':'master.mp4','contentType':'video/mp4','size':len(data)})
signed=post('/uploads/parts', {'key':init['key'],'uploadId':init['uploadId'],'partNumbers':[1]})
url=signed['urls'].get('1') or signed['urls'].get(1)
urllib.request.urlopen(urllib.request.Request(url,data=data,method='PUT')).read()
captions=b'1\n00:00:00,200 --> 00:00:01,200\nProof caption\n'
sidecar=post('/uploads/sidecar-url', {'key':init['key'],'filename':'proof.srt'})
urllib.request.urlopen(urllib.request.Request(sidecar['url'],data=captions,method='PUT')).read()
post('/uploads/complete', {'key':init['key'],'uploadId':init['uploadId'],
    'options': {'qc_av':True,'qc_captions':True,'qc_ai':False,'qc_synthetic':False,
                'ai_interpretive':True,'thumbnail':True,'summarize':False,
                'review_brief':'Expected title remains TEST CARD.' + ('x' * 2100),
                'profile':'standard','compute':'local'}})
print(init['transferId'])
PYEOF
TID=$(cat "$WORK/transfer-id")

for _ in $(seq 1 180); do
  COUNT=$("$PY" - "$TID" <<'PYEOF'
import boto3,sys
from botocore.config import Config
s3=boto3.client('s3',endpoint_url='http://localhost:9000',region_name='us-east-1',
 aws_access_key_id='minioadmin',aws_secret_access_key='minioadmin',config=Config(s3={'addressing_style':'path'}))
keys=[o['Key'] for o in s3.list_objects_v2(Bucket='waystation-test',Prefix=f'derivatives/{sys.argv[1]}/').get('Contents',[])]
print(sum(key.endswith('manifest.json') for key in keys))
PYEOF
  )
  [ "$COUNT" = 1 ] && break
  sleep .25
done
[ "$COUNT" = 1 ] || { echo "FAIL explicit pipeline timeout"; tail -30 /tmp/ai-interpretive-worker.log; exit 1; }

"$PY" - "$TID" <<'PYEOF'
import hashlib, json, sys, urllib.request
from genblaze_core.models import parse_manifest
tid=sys.argv[1]; base='http://localhost:8787/api'
transfer=json.load(urllib.request.urlopen(f'{base}/transfers/{tid}'))
by_name={item['key'].split('/')[-1]:item for item in transfer['derivatives']}
assert 'ai_interpretive.json' in by_name and 'qc_report.json' in by_name
ai=json.load(urllib.request.urlopen(by_name['ai_interpretive.json']['url']))
qc=json.load(urllib.request.urlopen(by_name['qc_report.json']['url']))
manifest=json.load(urllib.request.urlopen(transfer['manifestUrl']))
gb=parse_manifest(manifest); assert gb.verify_hash()
assert ai['state']=='complete' and ai['raw_model_output_direct_authority'] is False
assert ai['delivery_authority']=='dual_key_deterministic_and_ai_policy'
assert ai['authority_mode']=='shadow'
assert ai['delivery_decision']['ai_interpretive_gate']['proposed_disposition']=='HOLD', json.dumps(ai['delivery_decision'], indent=2)
assert ai['spend_accounting']['explicit_gmi_model_calls']==4
assert ai['review_context']['provided'] is True and ai['review_context']['characters'] == 2000
assert 'brief' not in ai['review_context']
assert ai['caption_context']['state']=='available' and ai['caption_context']['cue_count']==1
assert ai['consolidated_capabilities']['legacy_ai_qc_model_calls']==0
assert ai['consolidated_capabilities']['temporal_sequence_evidence'] is True
assert ai['compute_route'] == {'requested':'local','actual':'local','request_honored':True}
assert [stage['name'] for stage in ai['timeline']] == [
 'intake','deterministic_grounding','ai_review_planning','evidence_selection','gmi_visual_analysis',
 'gmi_audio_analysis','gmi_independent_jury','synthesis','artifact_storage']
assert next(stage for stage in ai['timeline'] if stage['name']=='gmi_independent_jury')['outcome']=='not_configured'
assert ai['review_plan']['source']=='ai_planner'
assert ai['interpretive_observations'] and all(item['authority']=='eligible_for_versioned_policy_reducer' for item in ai['interpretive_observations'])
assert len(ai['interpretive_observations']) == 11
audio=next(item for item in ai['evidence'] if item['type']=='audio_window')
assert audio['sampling_window']['sample_edges_are_not_source_edits'] is True
assert audio['signal_metrics']['state']=='measured'
assert any(item['type']=='frame_sequence' for item in ai['evidence'])
assert all('tier' not in item and 'status' not in item for item in ai['interpretive_observations'])
assert qc['ai_interpretive_analysis']['deterministic_verdict_unchanged'] is True
assert qc['delivery_decision']==ai['delivery_decision']
assert not any(check.get('source')=='ai_interpretive' for check in qc['checks'])
steps=manifest['run']['steps']
assert any(step['step_id']=='ai-interpretive' for step in steps)
assert any(step['step_id']=='ai-interpretive/gmi_visual_analysis' for step in steps)
assert manifest['run']['metadata']['requested_compute']=='local'
assert manifest['run']['metadata']['compute']=='local'
assert manifest['run']['metadata']['compute_request_honored'] is True
thumb=json.load(urllib.request.urlopen(by_name['thumbnail_selection.json']['url']))
assert thumb['selection_method']=='interpretive_reuse'
assert thumb['candidate_policy']['reused_interpretive_evidence'] is True
assert thumb['usage']['billable_events']==0
urls={item['key']:item['url'] for item in transfer['derivatives']}
for step in steps:
  for asset in step.get('assets') or []:
    key=asset['url'].split('/',3)[-1]
    if key not in urls: continue
    body=urllib.request.urlopen(urls[key]).read()
    assert hashlib.sha256(body).hexdigest()==asset['sha256']
usage=json.load(urllib.request.urlopen(f'{base}/transfers/{tid}/usage'))
ai_units=[item for item in usage['events'] if item.get('event') in {
 'ai_review_planning','gmi_visual_analysis','gmi_audio_analysis','synthesis'}]
assert len(ai_units)==4 and sum(float(item['units']) for item in ai_units)==4
print(f"PASS full explicit loop: {len(ai['evidence'])} B2 evidence objects, 4 metered mock GMI calls, SDK manifest verified")
PYEOF
