#!/usr/bin/env python3
"""Pairwise matching for detected captcha objects."""

from itertools import combinations
from typing import Dict, List, Optional, Tuple

import numpy as np

from .features import compute_similarity
from python.constants import SYMBOL_SIMILARITY_THRESHOLD

SIMILARITY_THRESHOLD = SYMBOL_SIMILARITY_THRESHOLD


def find_best_object_pair(
    object_features: List[np.ndarray],
    object_positions: List[Tuple[int, int, int, int]],
    threshold: float = SIMILARITY_THRESHOLD,
) -> Optional[Dict]:
    """Return the highest-similarity unique pair of detected objects.

    Each unordered pair is compared once, so objects 1 and 2 are not also
    compared as objects 2 and 1. The result is ``None`` when fewer than two
    objects exist or when the best pair does not pass ``threshold``.
    """
    if len(object_features) != len(object_positions):
        raise ValueError("object_features and object_positions must have the same length")

    if len(object_features) < 2:
        return None

    best_similarity = float("-inf")
    best_pair: Optional[Tuple[int, int]] = None

    for first_idx, second_idx in combinations(range(len(object_features)), 2):
        similarity = compute_similarity(
            object_features[first_idx], object_features[second_idx]
        )
        if similarity > best_similarity:
            best_similarity = similarity
            best_pair = (first_idx, second_idx)

    if best_pair is None or best_similarity < threshold:
        return None

    first_idx, second_idx = best_pair
    first_bbox = object_positions[first_idx]
    second_bbox = object_positions[second_idx]

    def center(bbox: Tuple[int, int, int, int]) -> Tuple[int, int]:
        x, y, width, height = bbox
        return int(x + width // 2), int(y + height // 2)

    return {
        "object_indices": (int(first_idx), int(second_idx)),
        "positions": (center(first_bbox), center(second_bbox)),
        "similarity": float(best_similarity),
        "bboxes": (first_bbox, second_bbox),
    }
