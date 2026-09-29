"""Pairwise 3D-object captcha solver."""

from .detection import detect_objects
from .features import compute_similarity, extract_features
from .matching import find_best_object_pair
from .preprocessing import preprocess_image
from .solver import SymbolCaptchaSolver, solve_symbol_captcha

__all__ = [
    "SymbolCaptchaSolver",
    "compute_similarity",
    "detect_objects",
    "extract_features",
    "find_best_object_pair",
    "preprocess_image",
    "solve_symbol_captcha",
]
