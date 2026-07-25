"""Proficiency Foundry renderer — manufactures challenge assets with EXACT,
recorded ground truth. Deterministic by construction: every random choice comes
from the seeded spec produced by qc/foundry.plan_suite; this module adds no
randomness of its own. Text is drawn with Pillow (the host ffmpeg may lack
drawtext), video is assembled with ffmpeg. Ground truth lives in a JSON sidecar
next to each asset; the runner hides it from the models.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

RENDERER_VERSION = "waystation-foundry-render/1.0"
SIZE = (640, 360)

_FONT_CANDIDATES = [
    "/System/Library/Fonts/Helvetica.ttc",            # macOS
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",  # Debian
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]


def _font(px: int):
    for path in _FONT_CANDIDATES:
        if os.path.exists(path):
            return ImageFont.truetype(path, px)
    try:
        return ImageFont.load_default(size=px)   # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


def _text_frame(word: str, position: list, font_px: int) -> Image.Image:
    """A simple storefront-like card: flat background, one sign. The scene is
    deliberately plain — the challenge measures glyph perception, not scene
    clutter (parameter ranges are recorded in the manifest)."""
    img = Image.new("RGB", SIZE, (52, 74, 94))
    draw = ImageDraw.Draw(img)
    draw.rectangle([20, SIZE[1] - 60, SIZE[0] - 20, SIZE[1] - 20], fill=(38, 54, 70))
    x = int(position[0] * SIZE[0])
    y = int(position[1] * SIZE[1])
    font = _font(font_px)
    box = draw.textbbox((x, y), word, font=font)
    draw.rectangle([box[0] - 12, box[1] - 8, box[2] + 12, box[3] + 8], fill=(24, 34, 46))
    draw.text((x, y), word, fill=(240, 240, 235), font=font)
    return img


def _assemble(frames_dir: str, fps: int, out: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-framerate", str(fps),
                    "-i", os.path.join(frames_dir, "f%03d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", out],
                   capture_output=True, check=True)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def render(spec: dict, out_dir: str) -> tuple[str, str]:
    """Render one challenge asset + its ground-truth sidecar.
    Returns (asset_path, sidecar_path)."""
    os.makedirs(out_dir, exist_ok=True)
    asset = os.path.join(out_dir, f"{spec['asset_id']}.mp4")
    sidecar = os.path.join(out_dir, f"{spec['asset_id']}.truth.json")
    class_id = spec["class_id"]

    if class_id == "rendered_text_mutation":
        fps, duration = spec["fps"], spec["duration_s"]
        total = int(fps * duration)
        mutate_at = (int(spec["mutation_time_s"] * fps)
                     if spec["planted"] else total + 1)
        frames_dir = os.path.join(out_dir, f"{spec['asset_id']}-frames")
        os.makedirs(frames_dir, exist_ok=True)
        for index in range(total):
            word = spec["mutated_word"] if index >= mutate_at else spec["word"]
            _text_frame(word, spec["position"], spec["font_px"]).save(
                os.path.join(frames_dir, f"f{index:03d}.png"))
        _assemble(frames_dir, fps, asset)
        for name in os.listdir(frames_dir):
            os.unlink(os.path.join(frames_dir, name))
        os.rmdir(frames_dir)

    elif class_id == "loudness_delta_lu":
        # Calibrated by MEASUREMENT, not assumption: a sine's integrated
        # loudness is not its dBFS gain (K-weighting shifts it ~3 LU). Measure
        # the raw tone once with ebur128, then apply the exact gain that puts
        # the twin AT the -24 LUFS delivery target and the plant delta_lu
        # hotter. Ground truth is exact by construction + measurement.
        tone = f"sine=frequency=440:duration={spec['duration_s']}"
        measure = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "lavfi", "-i", tone,
             "-af", "ebur128", "-f", "null", "-"], capture_output=True, text=True)
        import re as _re
        matches = _re.findall(r"I:\s*(-?[\d.]+) LUFS", measure.stderr)
        base_lufs = float(matches[-1])
        gain = (-24.0 - base_lufs) + float(spec["delta_lu"])
        subprocess.run(["ffmpeg", "-y",
                        "-f", "lavfi", "-i", f"testsrc2=duration={spec['duration_s']}:size=320x180:rate=24",
                        "-f", "lavfi", "-i", tone,
                        "-af", f"volume={gain:.2f}dB",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                        asset], capture_output=True, check=True)
        spec = {**spec, "base_tone_lufs": base_lufs, "applied_gain_db": round(gain, 2)}

    elif class_id == "bad_framerate":
        subprocess.run(["ffmpeg", "-y",
                        "-f", "lavfi", "-i",
                        f"testsrc2=duration={spec['duration_s']}:size=320x180:rate={spec['fps']}",
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", asset],
                       capture_output=True, check=True)
    else:
        raise ValueError(f"no renderer for class {class_id}")

    truth = {"renderer_version": RENDERER_VERSION, **spec,
             "asset_sha256": sha256_file(asset)}
    with open(sidecar, "w") as f:
        json.dump(truth, f, indent=2, sort_keys=True)
    return asset, sidecar


if __name__ == "__main__":
    # foundry_render.py <class_id> <out_dir> [seed] — render the seeded suite.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from qc import foundry
    class_id, out_dir = sys.argv[1], sys.argv[2]
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 20260724
    specs = foundry.plan_suite(class_id, seed=seed)
    for item in specs:
        asset, sidecar = render(item, out_dir)
        print(f"rendered {os.path.basename(asset)} planted={item['planted']}")
    print(f"suite_sha256={foundry.suite_fingerprint(specs)}")
