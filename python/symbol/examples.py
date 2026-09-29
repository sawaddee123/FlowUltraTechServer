#!/usr/bin/env python3
"""Examples for pairwise 3D-object captcha matching."""

import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from python.symbol import SymbolCaptchaSolver, solve_symbol_captcha


SCREEN = "images/symbol/screen.jpg"


def print_match(match):
    if match is None:
        print("No matching pair found")
        return

    first_idx, second_idx = match["object_indices"]
    first_pos, second_pos = match["positions"]
    print(
        f"Object #{first_idx + 1} at {first_pos} + "
        f"Object #{second_idx + 1} at {second_pos} | "
        f"Similarity: {match['similarity']:.3f}"
    )


def example_1_simple():
    """Find the best pair in a screen image."""
    match = solve_symbol_captcha(SCREEN, threshold=0.75)
    print_match(match)


def example_2_reusable_solver():
    """Reuse the loaded models for multiple captcha screens."""
    solver = SymbolCaptchaSolver(
        fastsam_model="FastSAM-x.pt",
        dino_model="facebook/dinov2-small",
    )

    for screen in [SCREEN]:
        match = solver.solve(screen, threshold=0.75)
        print_match(match)


def example_3_with_numpy_array():
    """Pass an OpenCV/NumPy image instead of a file path."""
    screen_img = cv2.imread(SCREEN)
    match = solve_symbol_captcha(screen_img, threshold=0.75)
    print_match(match)


def example_4_custom_threshold():
    """Compare the selected pair against different minimum thresholds."""
    solver = SymbolCaptchaSolver()
    for threshold in [0.70, 0.75, 0.80, 0.85]:
        match = solver.solve(SCREEN, threshold=threshold)
        print(f"Threshold {threshold}: ", end="")
        print_match(match)


def example_5_with_visualization():
    """Save a visualization of the selected pair."""
    solver = SymbolCaptchaSolver()
    match = solver.solve(SCREEN, threshold=0.75)
    solver.visualize_result(SCREEN, match, save_path="symbol_result.jpg")


if __name__ == "__main__":
    example_1_simple()
