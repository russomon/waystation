# U.S. Broadcast MXF OP1a / XDCAM HD 4:2:2 Baseline

Policy ID: `us_broadcast_xdcam_hd_422_baseline`
Version: `1.0.0`
Profile: `us_broadcast_xdcam_hd_422_v1`
Source: `pipeline/policies/us_broadcast_xdcam_hd_422_v1.json`

## Scope

This is a versioned Waystation house baseline for one common U.S. HD broadcast
delivery shape. It is not a universal U.S. network specification, a substitute
for a broadcaster's current delivery document, or proof that a network will
accept a file. Customer/network variations must be expressed as explicit
overrides and tested against that customer's acceptance fixtures.

The v1 assumptions are:

- one MXF OP1a file;
- XDCAM HD 4:2:2 MPEG-2, nominal 50 Mb/s;
- 1920x1080, exact `30000/1001`, interlaced top-field-first;
- 8-bit `yuv422p` picture essence;
- one 24-bit, 48 kHz PCM stereo programme track;
- material-package UMID and SMPTE drop-frame start timecode;
- captions embedded or supplied as an SRT/VTT sidecar;
- 1 to 5 seconds of black at the head and tail;
- programme loudness -24 LKFS +/-2 LU and true peak no higher than -2 dBTP.

## Active Checks

Hard policy decisions use deterministic evidence only:

| Rule class | Evidence and decision |
|---|---|
| Decode/streams | FFmpeg full decode; ffprobe video/audio stream inventory |
| Wrapper | ffprobe MXF format and exact OP1a operational-pattern UL; MediaInfo and MediaConch metadata cross-checks |
| Video essence | codec/profile, exact rational frame rate, raster, field order, bit depth, chroma, and bitrate |
| Timeline | bounded 1,800-frame GOP/key-frame and timestamp scan; wrapper/stream duration agreement |
| Audio | track/channel layout, PCM/sample rate/bit depth, full-program EBU R128 loudness and true peak |
| Metadata | material-package UMID and start timecode presence |
| Captions | embedded-stream or SRT/VTT sidecar presence; existing caption timing/readability/coverage checks then run |
| Boundaries | measured black head/tail duration |

The following deterministic screens are active but advisory because they have
not been calibrated against a representative network-accepted/rejected corpus:

- unexpected programme black;
- freeze/duplicate-frame runs;
- prolonged silence;
- tiled legal-range amplitude/area evidence.

They may produce `ISSUE` findings but do not hard-reject this baseline. The
policy contains no composite quality or trust score.

## Evidence Contract

Each baseline finding preserves separate fields for:

- `expectation`: the effective policy value;
- `observation`: the measured fact or explicit `not_checked` state;
- `evidence`: probe fields, sampled frame counts, hashes, and time ranges;
- `provenance`: tool, version, and method;
- `decision`: outcome and deterministic policy/advisory authority;
- `policy`: policy ID, version, and effective-policy SHA-256.

The report also includes the full `policy_pack` descriptor and
`tool_provenance`. Missing optional tools or unavailable measurements are FYI /
`not_checked`; they never become a pass.

MediaConch is used only for its supported MediaInfo/MAXML metadata reporting on
MXF. Waystation applies the versioned pure reducer to those facts and retains
the MAXML SHA-256 plus all expected/actual assertions. This is not a claim that
MediaConch's implementation checker certifies MXF essence. QCTools `qcli`
remains installed and provenance-visible but is not active until a bounded,
validated report extractor exists.

## Overrides

Set `WAYSTATION_BROADCAST_POLICY_OVERRIDES` to a JSON object containing nested
rule values, for example:

```text
WAYSTATION_BROADCAST_POLICY_OVERRIDES={"audio":{"total_channels":8}}
```

Unknown keys fail closed. Overrides do not change the policy ID or source-pack
hash; the report records the override object and a different effective-policy
hash. The fixed MediaConch metadata assertion set is explicitly `not_checked`
when overrides are active, rather than applying mismatched assumptions.

## Proofs

```bash
bash scripts/broadcast-qc-proof.sh
bash scripts/broadcast-qc-docker-proof.sh
```

The first constructs an actual passing MXF and failing MP4, then exercises
known-good/known-bad timestamp, GOP, boundary, artifact, audio, caption, and
override reducers. The second builds the worker and proves pinned MediaConch
25.04 produces passing/failing metadata-policy outcomes in Docker. Synthetic
fixtures prove Waystation reducer behavior, not live broadcaster acceptance.
