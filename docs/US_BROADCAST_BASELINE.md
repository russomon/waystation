# U.S. Broadcast MXF OP1a / XDCAM HD 4:2:2 Baseline

Policy ID: `us_broadcast_xdcam_hd_422_baseline`
Version: `1.2.0`
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
- square pixels, 16:9 display aspect, and declared `tv`/`bt709` range/matrix;
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
| Video essence | codec/profile, exact rational frame rate, raster/aspect, field order, bit depth, chroma, bitrate, and range/matrix metadata |
| Timeline | bounded 1,800-frame GOP/key-frame and timestamp scan spread across the programme; wrapper/stream duration agreement; A/V programme-start alignment |
| Audio | track/channel layout, PCM/sample rate/bit depth, full-program EBU R128 loudness and true peak |
| Metadata | material-package UMID and start timecode presence |
| Captions | embedded-stream or SRT/VTT sidecar presence; existing caption timing/readability/coverage checks then run |
| Boundaries | measured black head/tail duration |

The following deterministic screens are active but advisory because they have
not been calibrated against a representative network-accepted/rejected corpus:

- unexpected programme black;
- freeze/repeated-frame runs;
- prolonged silence;
- tiled legal-range amplitude/area evidence.
- bounded blockiness, blur, contouring/banding, temporal-outlier/repeated-line,
  active-picture crop/matte, and boundary color-bars candidates;
- bounded phase/polarity, clipping, click/pop, short-dropout, and per-channel
  level/dead-channel candidates;
- SRT/VTT cue continuity and timeline coverage;
- cross-tool metadata contradictions across ffprobe, MediaInfo, and MediaConch.

They may produce `ISSUE` findings but do not hard-reject this baseline. The
policy contains no composite quality or trust score. Each event carries start,
end, duration, threshold, authority, and truncation state. Head/tail black that
satisfies the boundary rule is excluded from the programme-black finding.

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
MediaConch's implementation checker certifies MXF essence.

QCTools `qcli` analyzes at most three eight-second excerpts spread across the
timeline. Waystation reduces only the validated `signalstats` fields, records
the exact qcli version/source revision and SHA-256/size/time range of every raw
compressed XML report, and labels the result advisory. Missing binaries,
timeouts, failed excerpts, and malformed XML are `FYI / not_checked`, never a
pass. These measurements do not make a broadcast-compliance decision and stay
advisory until calibrated against representative accepted/rejected masters.
Its Phase 2 reducer discloses temporal-outlier, repeated-line, and low-used-luma
bit candidates without granting QCTools delivery-policy authority.

Phase 2 FFmpeg extraction is similarly bounded: at most three four-second
picture windows and three eight-second audio windows, selected within the
programme region after intended head/tail black is excluded. Color bars use
only two downscaled boundary frames. Event lists are capped by policy. A failed
or unavailable measurement is `not_checked`; it cannot become a clean pass.

Caption continuity currently applies only where Waystation can parse SRT or
WebVTT text cues. Runtime coverage means the union of cue intervals, not proof
that dialogue was captioned. Persistent programme silence remains the existing
`broadcast_silence_runs` advisory; short silence candidates are separately
reported as dropouts.

See `docs/QC_CALIBRATION.md` and `calibration/intake.schema.json` for the
accepted/rejected corpus workflow. Synthetic fixtures establish reducer
behavior only and can never be labelled network-acceptance evidence.

Unresolved deterministic timeline findings compile into versioned, bounded AI
review packets containing only the relevant finding, evidence, timestamp range,
review question, and requested still/audio excerpt. The optional AI
Interpretive Pass is shadow-only (`AI_INTERPRETIVE_SHADOW=false` by default),
records model/prompt/input provenance and uncertainty, and cannot alter the
deterministic verdict or tier counts.

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
bash scripts/qctools-analysis-proof.sh
bash scripts/phase2-quality-proof.sh
bash scripts/qc-calibration-proof.sh
bash scripts/interpretive-shadow-proof.sh
```

The first constructs an actual passing MXF and failing MP4, then exercises
known-good/known-bad timestamp, GOP, boundary, artifact, audio, caption, and
override reducers. The second builds the worker and proves pinned MediaConch
25.04 produces passing/failing metadata-policy outcomes and the Phase 2 FFmpeg
filters execute in Docker. Synthetic fixtures prove Waystation reducer
behavior, not live broadcaster acceptance.
