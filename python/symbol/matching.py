#!/usr/bin/env python3
"""Pairwise matching for detected captcha objects."""

from itertools import combinations
import math
from typing import Dict, List, Optional, Tuple

import numpy as np

from .features import compute_similarity
from python.constants import SYMBOL_SIMILARITY_THRESHOLD

SIMILARITY_THRESHOLD = SYMBOL_SIMILARITY_THRESHOLD
MIN_CENTER_DISTANCE = 32.0
MAX_BBOX_IOU = 0.25


def _bbox_iou(b1: Tuple[int, int, int, int], b2: Tuple[int, int, int, int]) -> float:
    x1, y1, w1, h1 = b1
    x2, y2, w2, h2 = b2
    xa = max(x1, x2)
    ya = max(y1, y2)
    xb = min(x1 + w1, x2 + w2)
    yb = min(y1 + h1, y2 + h2)
    inter = max(0, xb - xa) * max(0, yb - ya)
    if inter <= 0:
        return 0.0
    union = w1 * h1 + w2 * h2 - inter
    return float(inter) / float(max(1, union))


def find_best_object_pair(
    object_features: List[np.ndarray],
    object_positions: List[Tuple[int, int, int, int]],
    threshold: float = SIMILARITY_THRESHOLD,
) -> Optional[Dict]:
    """Return the highest-similarity unique pair of distinct detected objects.

    Each unordered pair is compared once, skipping pairs whose bounding boxes
    overlap heavily or whose centers are too close (duplicate masks of the same
    object).
    """
    if len(object_features) != len(object_positions):
        raise ValueError("object_features and object_positions must have the same length")

    if len(object_features) < 2:
        return None

    def center(bbox: Tuple[int, int, int, int]) -> Tuple[int, int]:
        x, y, width, height = bbox
        return int(x + width // 2), int(y + height // 2)

    best_similarity = float("-inf")
    best_pair: Optional[Tuple[int, int]] = None

    for first_idx, second_idx in combinations(range(len(object_features)), 2):
        b1 = object_positions[first_idx]
        b2 = object_positions[second_idx]
        c1 = center(b1)
        c2 = center(b2)
        if math.hypot(c1[0] - c2[0], c1[1] - c2[1]) < MIN_CENTER_DISTANCE:
            continue
        if _bbox_iou(b1, b2) > MAX_BBOX_IOU:
            continue

        similarity = compute_similarity(
            object_features[first_idx], object_features[second_idx]
        )
        if similarity > best_similarity:
            best_similarity = similarity
            best_pair = (first_idx, second_idx)

    effective_min = min(threshold, 0.55)
    if best_pair is None or best_similarity < effective_min:
        return None

    first_idx, second_idx = best_pair
    first_bbox = object_positions[first_idx]
    second_bbox = object_positions[second_idx]

    return {
        "object_indices": (int(first_idx), int(second_idx)),
        "positions": (center(first_bbox), center(second_bbox)),
        "similarity": float(best_similarity),
        "bboxes": (first_bbox, second_bbox),
    }
