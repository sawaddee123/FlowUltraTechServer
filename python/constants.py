#!/usr/bin/env python3
"""Central configuration for all captcha solvers."""

from pathlib import Path

# Model directories
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PYTHON_DIR = PROJECT_ROOT / "python"
SYMBOL_MODELS_DIR = PYTHON_DIR / "symbol" / "models"
SLIDE_MODELS_DIR = PYTHON_DIR / "slide" / "models"

# Symbol solver models
FASTSAM_MODEL_NAME = "FastSAM-s.pt"
FASTSAM_MODEL_PATH = SYMBOL_MODELS_DIR / FASTSAM_MODEL_NAME
AUTO_DOWNLOAD_MODELS = True
DINO_MODEL_NAME = "facebook/dinov2-small"

# Symbol preprocessing and detection
RGB_BACKGROUND_THRESHOLD = 190
BINARY_IMAGE_THRESHOLD = 127
FASTSAM_CONF_THRESHOLD = 0.65
FASTSAM_IOU_THRESHOLD = 0.3
FASTSAM_IMAGE_SIZE = 640
SYMBOL_MIN_AREA = 1500
SYMBOL_MAX_AREA = 35000
SCREEN_THRESHOLD_RATIO = 0.7
SYMBOL_SIMILARITY_THRESHOLD = 0.75
SYMBOL_DEBUG_PATH = PYTHON_DIR / "debug_symbol"

# Slide solver
SLIDE_MODEL_NAME = "jigsaw-model.pt"
SLIDE_MODEL_PATH = SLIDE_MODELS_DIR / SLIDE_MODEL_NAME
SLIDE_DEBUG_PATH = PYTHON_DIR / "debug_slide"
SLIDE_PUZZLE_CLASS_ID = 0
SLIDE_CONF_THRESHOLD = 0.8
