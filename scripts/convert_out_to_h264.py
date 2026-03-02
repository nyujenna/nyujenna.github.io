#!/usr/bin/env python3
"""
Batch-convert MP4 videos to browser-safe H.264 (avc1) for fast web playback.

Default behavior:
- Input:  ./out
- Output: ./out_h264
- Keeps directory structure
- Runs ffmpeg in parallel
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path


@dataclass
class JobResult:
    src: Path
    dst: Path
    status: str
    detail: str = ""


def run_cmd(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def detect_codec(path: Path) -> tuple[str, str]:
    proc = run_cmd(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,codec_tag_string",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ]
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "ffprobe failed")
    parts = [p.strip() for p in proc.stdout.splitlines() if p.strip()]
    if len(parts) < 2:
        raise RuntimeError(f"ffprobe returned unexpected output for {path}")
    return parts[0], parts[1]


def convert_one(src: Path, dst: Path, overwrite: bool, preset: str, crf: int) -> JobResult:
    try:
        dst.parent.mkdir(parents=True, exist_ok=True)

        if dst.exists() and not overwrite and dst.stat().st_size > 0:
            return JobResult(src, dst, "skip", "already exists")

        codec_name, codec_tag = detect_codec(src)
        if codec_name == "h264" and codec_tag in {"avc1", "h264"}:
            if src.resolve() != dst.resolve():
                shutil.copy2(src, dst)
                return JobResult(src, dst, "copy", "already h264")
            return JobResult(src, dst, "skip", "already h264 in-place")

        cmd = [
            "ffmpeg",
            "-y" if overwrite else "-n",
            "-i",
            str(src),
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            str(crf),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(dst),
        ]
        proc = run_cmd(cmd)
        if proc.returncode != 0:
            tail = (proc.stderr.strip() or proc.stdout.strip()).splitlines()[-6:]
            return JobResult(src, dst, "error", " | ".join(tail))

        if not dst.exists() or dst.stat().st_size == 0:
            return JobResult(src, dst, "error", "output missing or empty")

        return JobResult(src, dst, "convert", f"{codec_name}/{codec_tag} -> h264")
    except Exception as exc:  # noqa: BLE001
        return JobResult(src, dst, "error", str(exc))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert out/*.mp4 to web-playable H.264.")
    parser.add_argument("--input-root", default="out", help="Input root containing MP4 files (default: out)")
    parser.add_argument(
        "--output-root",
        default="out_h264",
        help="Output root for converted videos (default: out_h264)",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, (os.cpu_count() or 4) // 2),
        help="Parallel worker count (default: cpu_count/2)",
    )
    parser.add_argument("--preset", default="veryfast", help="ffmpeg x264 preset (default: veryfast)")
    parser.add_argument("--crf", type=int, default=23, help="ffmpeg CRF quality (default: 23)")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite existing output files")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    input_root = Path(args.input_root).resolve()
    output_root = Path(args.output_root).resolve()

    if not input_root.exists() or not input_root.is_dir():
        print(f"Input root not found: {input_root}", file=sys.stderr)
        return 1

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("ffmpeg/ffprobe not found in PATH.", file=sys.stderr)
        return 1

    sources = sorted(input_root.rglob("*.mp4"))
    if not sources:
        print(f"No mp4 files found under: {input_root}")
        return 0

    jobs: list[tuple[Path, Path]] = []
    for src in sources:
        rel = src.relative_to(input_root)
        dst = output_root / rel
        jobs.append((src, dst))

    print(f"Found {len(jobs)} mp4 files")
    print(f"Input root:  {input_root}")
    print(f"Output root: {output_root}")
    print(f"Workers:     {args.workers}")

    results: list[JobResult] = []
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [
            ex.submit(convert_one, src, dst, args.overwrite, args.preset, args.crf)
            for (src, dst) in jobs
        ]
        for i, fut in enumerate(as_completed(futures), 1):
            res = fut.result()
            results.append(res)
            print(f"[{i}/{len(jobs)}] {res.status.upper()}: {res.src.relative_to(input_root)}")

    converted = sum(1 for r in results if r.status == "convert")
    copied = sum(1 for r in results if r.status == "copy")
    skipped = sum(1 for r in results if r.status == "skip")
    errors = [r for r in results if r.status == "error"]

    print("\nSummary")
    print(f"- converted: {converted}")
    print(f"- copied:    {copied}")
    print(f"- skipped:   {skipped}")
    print(f"- errors:    {len(errors)}")

    if errors:
        print("\nErrors:")
        for err in errors[:20]:
            rel = err.src.relative_to(input_root)
            print(f"- {rel}: {err.detail}")
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

