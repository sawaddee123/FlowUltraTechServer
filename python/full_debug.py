#!/usr/bin/env python3
"""Run full debug processing and benchmark every captcha image."""

import argparse
import csv
import sys
import time
import uuid

import cv2
from pathlib import Path
from statistics import mean
from typing import Dict, List

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python.constants import (
    SLIDE_CONF_THRESHOLD,
    SLIDE_MODEL_NAME,
    SYMBOL_SIMILARITY_THRESHOLD,
)
from python.slide import SlideCaptchaSolver
from python.symbol import SymbolCaptchaSolver

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def image_files(folder: Path) -> List[Path]:
    if not folder.exists():
        return []
    return sorted(
        [
            path
            for path in folder.iterdir()
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        ],
        key=lambda path: path.name.lower(),
    )


def result_path(output_root: Path, captcha_type: str) -> Path:
    """Return a collision-resistant result filename in the type folder."""
    output_dir = output_root / captcha_type
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir / f"{uuid.uuid4().hex}.jpg"


def wait_for_gpu() -> None:
    """Make GPU inference complete before stopping the solve timer."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.synchronize()
    except ImportError:
        pass


def save_csv(rows: List[Dict[str, object]], output_root: Path) -> Path:
    output_root.mkdir(parents=True, exist_ok=True)
    summary_path = output_root / "summary.csv"
    fields = sorted({key for row in rows for key in row})
    with summary_path.open("w", newline="", encoding="utf-8") as summary_file:
        writer = csv.DictWriter(summary_file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return summary_path


def save_speed_summary(rows: List[Dict[str, object]], output_root: Path) -> Path:
    """Write min/max/average solve time by captcha type in milliseconds."""
    output_root.mkdir(parents=True, exist_ok=True)
    summary_path = output_root / "speed_summary.csv"
    grouped = {"symbol": [], "slide": []}
    for row in rows:
        solve_time = row.get("solve_time_ms")
        captcha_type = row.get("type")
        if captcha_type in grouped and isinstance(solve_time, (int, float)):
            grouped[captcha_type].append(float(solve_time))

    with summary_path.open("w", newline="", encoding="utf-8") as summary_file:
        writer = csv.DictWriter(
            summary_file,
            fieldnames=["type", "count", "min_ms", "max_ms", "average_ms"],
        )
        writer.writeheader()
        for captcha_type, values in grouped.items():
            if not values:
                continue
            writer.writerow(
                {
                    "type": captcha_type,
                    "count": len(values),
                    "min_ms": f"{min(values):.3f}",
                    "max_ms": f"{max(values):.3f}",
                    "average_ms": f"{mean(values):.3f}",
                }
            )
    return summary_path


def print_speed_summary(rows: List[Dict[str, object]]) -> None:
    print("\nSolve speed (image saving excluded)")
    print("-" * 70)
    for captcha_type in ("symbol", "slide"):
        values = [
            float(row["solve_time_ms"])
            for row in rows
            if row.get("type") == captcha_type
            and isinstance(row.get("solve_time_ms"), (int, float))
        ]
        if values:
            print(
                f"{captcha_type.title():6} | count={len(values):3d} | "
                f"min={min(values):8.3f} ms | max={max(values):8.3f} ms | "
                f"avg={mean(values):8.3f} ms"
            )
        else:
            print(f"{captcha_type.title():6} | no successful timing samples")


def run_symbol(folder: Path, output_root: Path, threshold: float) -> List[Dict[str, object]]:
    files = image_files(folder)
    if not files:
        print(f"No images found in {folder}")
        return []

    print(f"\n=== SYMBOL: {len(files)} images ===")
    solver = SymbolCaptchaSolver()
    rows: List[Dict[str, object]] = []

    for index, image_path in enumerate(files, start=1):
        debug_dir = output_root / "symbol"
        debug_dir.mkdir(parents=True, exist_ok=True)
        result_file = result_path(output_root, "symbol")
        print(f"\n[{index}/{len(files)}] {image_path.name}")
        try:
            wait_for_gpu()
            started = time.perf_counter()
            match = solver.solve(
                str(image_path),
                threshold=threshold,
                debug=False,
                debug_path=str(debug_dir),
            )
            wait_for_gpu()
            solve_time_ms = (time.perf_counter() - started) * 1000

            # Save only after the solve timer has stopped.
            solver.visualize_result(str(image_path), match, save_path=str(result_file))
            row: Dict[str, object] = {
                "type": "symbol",
                "image": str(image_path),
                "status": "success" if match is not None else "no_match",
                "solve_time_ms": solve_time_ms,
                "result_file": str(result_file),
                "debug_dir": str(debug_dir),
            }
            if match is not None:
                first_idx, second_idx = match["object_indices"]
                row.update(
                    {
                        "object_1": first_idx + 1,
                        "object_2": second_idx + 1,
                        "position_1": match["positions"][0],
                        "position_2": match["positions"][1],
                        "similarity": f"{match['similarity']:.6f}",
                    }
                )
            rows.append(row)
            print(f"Solve time: {solve_time_ms:.3f} ms")
        except Exception as error:
            print(f"ERROR: {error}")
            rows.append(
                {
                    "type": "symbol",
                    "image": str(image_path),
                    "status": "error",
                    "solve_time_ms": "",
                    "result_file": "",
                    "debug_dir": str(debug_dir),
                    "error": str(error),
                }
            )

    return rows


def run_slide(folder: Path, output_root: Path) -> List[Dict[str, object]]:
    files = image_files(folder)
    if not files:
        print(f"No images found in {folder}")
        return []

    print(f"\n=== SLIDE: {len(files)} images ===")
    solver = SlideCaptchaSolver(SLIDE_MODEL_NAME)
    rows: List[Dict[str, object]] = []

    for index, image_path in enumerate(files, start=1):
        debug_dir = output_root / "slide"
        debug_dir.mkdir(parents=True, exist_ok=True)
        result_file = result_path(output_root, "slide")
        print(f"\n[{index}/{len(files)}] {image_path.name}")
        try:
            wait_for_gpu()
            started = time.perf_counter()
            position, result_img = solver.detect_with_result(
                str(image_path), conf_threshold=SLIDE_CONF_THRESHOLD
            )
            wait_for_gpu()
            solve_time_ms = (time.perf_counter() - started) * 1000

            # Save only after the solve timer has stopped.
            cv2.imwrite(str(result_file), result_img)
            success = position[0] > 0 or position[1] > 0
            rows.append(
                {
                    "type": "slide",
                    "image": str(image_path),
                    "status": "success" if success else "no_detection",
                    "position": position,
                    "solve_time_ms": solve_time_ms,
                    "result_file": str(result_file),
                    "debug_dir": str(debug_dir),
                }
            )
            print(f"Solve time: {solve_time_ms:.3f} ms")
        except Exception as error:
            print(f"ERROR: {error}")
            rows.append(
                {
                    "type": "slide",
                    "image": str(image_path),
                    "status": "error",
                    "solve_time_ms": "",
                    "result_file": "",
                    "debug_dir": str(debug_dir),
                    "error": str(error),
                }
            )

    return rows


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run full debug and benchmark every captcha image."
    )
    parser.add_argument(
        "--type",
        choices=("symbol", "slide", "all"),
        default="all",
        help="Captcha type to process (default: all)",
    )
    parser.add_argument(
        "--images-dir",
        type=Path,
        default=PROJECT_ROOT / "images",
        help="Root directory containing symbol/ and slide/ (default: images)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=PROJECT_ROOT / "python" / "full_debug",
        help="Debug output directory",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=SYMBOL_SIMILARITY_THRESHOLD,
        help=f"Symbol pair threshold (default: {SYMBOL_SIMILARITY_THRESHOLD})",
    )
    args = parser.parse_args()

    rows: List[Dict[str, object]] = []
    if args.type in ("symbol", "all"):
        rows.extend(run_symbol(args.images_dir / "symbol", args.output, args.threshold))
    if args.type in ("slide", "all"):
        rows.extend(run_slide(args.images_dir / "slide", args.output))

    summary_path = save_csv(rows, args.output)
    speed_path = save_speed_summary(rows, args.output)
    print_speed_summary(rows)
    print("\n" + "=" * 70)
    print(f"Processed: {len(rows)}")
    print(f"Summary: {summary_path}")
    print(f"Speed summary: {speed_path}")
    print(f"Debug root: {args.output}")
    print("=" * 70)
    return 1 if rows and all(row.get("status") == "error" for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
