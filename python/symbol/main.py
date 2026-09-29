#!/usr/bin/env python3
"""Main entry point for pairwise 3D-object captcha matching.

Usage:
    python -m python.symbol.main --screen screen.jpg
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from python.constants import SYMBOL_DEBUG_PATH, SYMBOL_SIMILARITY_THRESHOLD
from python.symbol.solver import SymbolCaptchaSolver


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Find the most similar pair of 3D objects in a captcha image.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python -m python.symbol.main --screen screen.jpg
  python -m python.symbol.main --screen screen.jpg --threshold 0.80 --debug
  python -m python.symbol.main --screen screen.jpg --save result.jpg
        """,
    )
    parser.add_argument(
        "--screen", "--image",
        dest="screen",
        required=True,
        help="Captcha screen image path",
    )
    parser.add_argument(
        "--threshold",
        "-t",
        type=float,
        default=SYMBOL_SIMILARITY_THRESHOLD,
        help=f"Minimum similarity required for the best pair (default: {SYMBOL_SIMILARITY_THRESHOLD})",
    )
    parser.add_argument(
        "--visualize", "-v", action="store_true", help="Show the matched pair"
    )
    parser.add_argument(
        "--debug", action="store_true", help="Save debug images for each stage"
    )
    parser.add_argument(
        "--debug-path",
        default="debug_output",
        help="Directory for debug images (default: debug_output)",
    )
    parser.add_argument("--save", help="Path for the result visualization")
    args = parser.parse_args()

    try:
        solver = SymbolCaptchaSolver()
        match = solver.solve(
            args.screen,
            threshold=args.threshold,
            debug=args.debug,
            debug_path=args.debug_path,
        )

        if args.visualize or args.save:
            solver.visualize_result(args.screen, match, args.save)

        if match is None:
            print("\nNo object pair found above the similarity threshold.")
            return 1

        first_idx, second_idx = match["object_indices"]
        first_pos, second_pos = match["positions"]
        print("\nSuccess")
        print(f"Object #{first_idx + 1}: {first_pos}")
        print(f"Object #{second_idx + 1}: {second_pos}")
        return 0
    except Exception as error:
        print(f"\nError: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
