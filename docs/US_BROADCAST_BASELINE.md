# U.S. Broadcast MXF OP1a / XDCAM HD 4:2:2 Baseline

Policy ID: `us_broadcast_xdcam_hd_422_baseline`
Version: `1.4.0`
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
- captions embedded or supplied as an SRT/VTT/SCC/MCC/RCWT sidecar;
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
| Audio | declared track order/count/channel map, PCM/sample rate/bit depth, full-program EBU R128 loudness and true peak |
| Metadata | material-package UMID and start timecode presence |
| Captions | embedded-stream or SRT/VTT/SCC/MCC/RCWT sidecar visibility; bounded text decode and timing/coverage checks where supported |
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
- the bounded YDIF luma-transition PSE/flash candidate screen.
- bounded deep MXF fact inventory with unsupported partition/index/ancillary/
  AS-profile facts explicitly `not_checked`;
- bounded IMF manifest/reference/hash inspection, separate from application-
  profile conformance;
- HDR/color metadata discovery and cross-tool contradiction evidence;
- Dolby-related marker disclosure without Dolby conformance claims.

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

SCC, MCC, and RCWT sidecars can be bounded-demuxed by FFmpeg into canonical cue
text. Waystation reports transport visibility, decode/parse integrity,
ordering, overlap, invalid timing, long-gap candidates, and bounded coverage.
FFmpeg's text reduction does not preserve every CEA-708 service/window or prove
SMPTE 436 ANC structure, so service-level and full CEA-608/708 conformance are
explicitly `not_checked` pending qualified tooling and authoritative fixtures.
SRT/VTT behavior is unchanged. Runtime coverage means the union of cue
intervals, not proof that dialogue was captioned.

The `pse_flash_risk` result is a sampled FFmpeg `signalstats` YDIF heuristic,
not a compliance analyzer. It cites ITU-R BT.1702-3 (11/2023) only as guidance,
emits `ISSUE` candidates or FYI evidence, and can never create a BLOCKER. Full
PSE/flash compliance remains deferred to a qualified analyzer with
authoritative test vectors.

Policy v1.4 retains the declared one stereo program track by ordinal, channel count,
and layout. Language, title, role, disposition, or stream index are enforced
only when an effective profile explicitly declares them and ffprobe exposes
the corresponding metadata. Semantic L/R or stem interpretation remains
advisory unless authoritative reference metadata exists.

See `docs/QC_CALIBRATION.md` and `calibration/intake.schema.json` for the
accepted/rejected corpus workflow. Synthetic fixtures establish reducer
behavior only and can never be labelled network-acceptance evidence.

Unresolved deterministic timeline findings compile into versioned, bounded AI
review packets containing only the relevant finding, evidence, timestamp range,
review question, and requested still/audio excerpt. The optional AI
Interpretive Pass is shadow-only (`AI_INTERPRETIVE_SHADOW=false` by default),
records model/prompt/input provenance and uncertainty, receives detached packet
copies, and emits `advisory_observations` outside canonical checks. It cannot
alter deterministic status, tier counts, packets, or delivery outcome.
Packets are schema/hash validated before extraction or spend, and model
citations are restricted to evidence IDs supplied for that packet. Offline
review dispositions and Wilson evaluation are described in
`docs/DEEP_PACKAGE_AND_SHADOW_EVALUATION.md`.

## Delivery templates

Profile `waystation_house_xdcam_hd_422_v1` selects the versioned local template
in `pipeline/policies/delivery_templates/`. The report retains its source hash,
scope, overrides, and effective policy hash. This example is a Waystation house
template, not a broadcaster's specification. No private network rules are
invented or implied.

## Overrides

Set `WAYSTATION_BROADCAST_POLICY_OVERRIDES` to a JSON object containing nested
rule values, for example:

```text
WAYSTATION_BROADCAST_POLICY_OVERRIDES={"audio":{"total_channels":8,"track_map":{"tracks":[{"ordinal":0,"channels":8,"channel_layout":"7.1"}]}}}
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
bash scripts/authority-boundary-proof.sh
bash scripts/caption-transport-proof.sh
bash scripts/audio-map-proof.sh
bash scripts/deep-package-proof.sh
bash scripts/qc-benchmark-proof.sh
bash scripts/shadow-evaluation-proof.sh
```

The first constructs an actual passing MXF and failing MP4, then exercises
known-good/known-bad timestamp, GOP, boundary, artifact, audio, caption, and
override reducers. The second builds the worker and proves pinned MediaConch
25.04 produces passing/failing metadata-policy outcomes and the Phase 2 FFmpeg
filters execute in Docker. Synthetic fixtures prove Waystation reducer
behavior, not live broadcaster acceptance.
