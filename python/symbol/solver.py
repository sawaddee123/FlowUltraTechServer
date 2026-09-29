#!/usr/bin/env python3
"""Complete pairwise 3D-object captcha solver pipeline."""

from pathlib import Path
from typing import Dict, Optional, Union

import cv2
import numpy as np

from .detection import ObjectDetector
from .features import FeatureExtractor
from .matching import find_best_object_pair
from .preprocessing import preprocess_image
from python.constants import (
    DINO_MODEL_NAME,
    FASTSAM_MODEL_PATH,
    SYMBOL_SIMILARITY_THRESHOLD,
    SYMBOL_DEBUG_PATH,
)


class SymbolCaptchaSolver:
    """Find the most visually similar pair among objects detected on a screen."""

    def __init__(
        self,
        fastsam_model: str = str(FASTSAM_MODEL_PATH),
        dino_model: str = DINO_MODEL_NAME,
    ):
        print("Initializing Symbol Captcha Solver...")
        self.detector = ObjectDetector(fastsam_model)
        self.extractor = FeatureExtractor(dino_model)
        print("Solver ready\n")

    def solve(
        self,
        screen_image: Union[str, np.ndarray],
        threshold: float = SYMBOL_SIMILARITY_THRESHOLD,
        debug: bool = False,
        debug_path: str = SYMBOL_DEBUG_PATH,
    ) -> Optional[Dict]:
        """Return the best matching pair of distinct objects in ``screen_image``.

        The detector supplies all candidate objects. Each unordered pair is
        compared exactly once using DINOv2 cosine similarity.
        """
        print("=" * 70)
        print("Starting pairwise object captcha solver")
        print("=" * 70)

        if debug:
            Path(debug_path).mkdir(parents=True, exist_ok=True)
            print(f"Debug output: {debug_path}/")

        if isinstance(screen_image, str):
            screen_img = cv2.imread(screen_image)
            if screen_img is None:
                raise ValueError(f"Cannot load screen image: {screen_image}")
            print(f"Screen: {Path(screen_image).name}")
        else:
            screen_img = screen_image.copy()
            print(f"Screen: {screen_img.shape[1]}x{screen_img.shape[0]}")

        print("\n[1/4] Preprocessing...")
        screen_filtered, _ = preprocess_image(screen_img)
        print("  Background removed")
        if debug:
            cv2.imwrite(f"{debug_path}/00_original.jpg", screen_img)
            cv2.imwrite(f"{debug_path}/01_filtered.jpg", screen_filtered)

        print("\n[2/4] Detecting objects...")
        detected_objects = self.detector.detect(
            screen_filtered, debug=debug, debug_path=debug_path
        )
        print(f"  Found {len(detected_objects)} objects")
        if len(detected_objects) < 2:
            print("  At least two detected objects are required for pairwise matching.")
            return None

        print("\n[3/4] Extracting object features...")
        object_features = []
        object_positions = []
        for index, (silhouette, bbox) in enumerate(detected_objects):
            object_features.append(self.extractor.extract(silhouette))
            object_positions.append(bbox)
            if debug:
                cv2.imwrite(
                    f"{debug_path}/detected_object_{index + 1}_silhouette.png",
                    silhouette,
                )
        print(f"  Extracted {len(object_features)} object features")

        print("\n[4/4] Comparing object pairs...")
        comparison_count = len(object_features) * (len(object_features) - 1) // 2
        print(f"  Comparing {comparison_count} unique pairs")
        match = find_best_object_pair(object_features, object_positions, threshold)

        print("\n" + "=" * 70)
        print("Results")
        print("=" * 70)
        if match is None:
            print(f"No object pair reached the threshold ({threshold:.2f}).")
            return None

        first_idx, second_idx = match["object_indices"]
        first_pos, second_pos = match["positions"]
        print(
            f"Best pair: Object #{first_idx + 1} at {first_pos} and "
            f"Object #{second_idx + 1} at {second_pos} | "
            f"Similarity: {match['similarity']:.3f}"
        )
        print("=" * 70)

        if debug:
            self._save_debug_match(screen_img, match, debug_path)

        return match

    @staticmethod
    def _draw_match(img: np.ndarray, match: Dict) -> np.ndarray:
        """Draw both members of a matched object pair on a copy of an image."""
        result = img.copy()
        colors = [(0, 255, 0), (255, 0, 0)]
        for object_idx, bbox, position, color in zip(
            match["object_indices"],
            match["bboxes"],
            match["positions"],
            colors,
        ):
            x, y, width, height = bbox
            cv2.rectangle(result, (x, y), (x + width, y + height), color, 3)
            cv2.circle(result, position, 10, color, -1)
            cv2.circle(result, position, 15, color, 2)
            cv2.putText(
                result,
                f"Object #{object_idx + 1}",
                (x, max(25, y - 10)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.7,
                color,
                2,
            )

        cv2.putText(
            result,
            f"Pair similarity: {match['similarity']:.3f}",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 0, 0),
            3,
        )
        cv2.putText(
            result,
            f"Pair similarity: {match['similarity']:.3f}",
            (10, 30),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (255, 255, 255),
            1,
        )
        return result

    def _save_debug_match(self, screen_img: np.ndarray, match: Dict, debug_path: str) -> None:
        result = self._draw_match(screen_img, match)
        output_path = f"{debug_path}/04_best_pair.jpg"
        cv2.imwrite(output_path, result)
        print(f"  Saved best-pair result: {output_path}")

    def visualize_result(
        self,
        screen_image: Union[str, np.ndarray],
        match: Optional[Dict],
        save_path: Optional[str] = None,
    ) -> None:
        """Display or save the best pair selected by :meth:`solve`."""
        if isinstance(screen_image, str):
            img = cv2.imread(screen_image)
            if img is None:
                raise ValueError(f"Cannot load screen image: {screen_image}")
        else:
            img = screen_image.copy()

        if match is None:
            result = img
            cv2.putText(
                result,
                "No matching pair found",
                (10, 35),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.9,
                (0, 0, 255),
                2,
            )
        else:
            result = self._draw_match(img, match)

        if save_path:
            cv2.imwrite(save_path, result)
            print(f"Saved result to: {save_path}")
        else:
            cv2.imshow("Pairwise Object Matching Result", result)
            cv2.waitKey(0)
            cv2.destroyAllWindows()


def solve_symbol_captcha(
    screen_image: Union[str, np.ndarray],
    threshold: float = SYMBOL_SIMILARITY_THRESHOLD,
    visualize: bool = False,
) -> Optional[Dict]:
    """Convenience API for finding the best object pair in one screen image."""
    solver = SymbolCaptchaSolver()
    match = solver.solve(screen_image, threshold)
    if visualize:
        solver.visualize_result(screen_image, match)
    return match
