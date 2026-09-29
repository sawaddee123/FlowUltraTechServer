#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Preprocessing Module: Background removal and image filtering
"""

import cv2
import numpy as np
from typing import Tuple

from python.constants import RGB_BACKGROUND_THRESHOLD

RGB_THRESHOLD = RGB_BACKGROUND_THRESHOLD

def preprocess_image(img: np.ndarray, rgb_threshold: int = RGB_THRESHOLD) -> Tuple[np.ndarray, np.ndarray]:
    """
    Remove background from image using RGB threshold
    
    Args:
        img: Input BGR image
        rgb_threshold: RGB value threshold (pixels >= this become white)
    
    Returns:
        Tuple of (filtered_image, mask)
        - filtered_image: Image with background removed (white)
        - mask: Boolean mask (True = background, False = objects)
    """
    # Create mask for light pixels (background)
    mask_light = (
        (img[:, :, 0] >= rgb_threshold) & 
        (img[:, :, 1] >= rgb_threshold) & 
        (img[:, :, 2] >= rgb_threshold)
    )
    
    # Copy image and set background to white
    img_filtered = img.copy()
    img_filtered[mask_light] = [255, 255, 255]
    
    return img_filtered, mask_light


def preprocess_from_path(image_path: str, rgb_threshold: int = RGB_THRESHOLD) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Load and preprocess image from file path
    
    Args:
        image_path: Path to image file
        rgb_threshold: RGB value threshold
    
    Returns:
        Tuple of (original_image, filtered_image, mask)
    """
    img = cv2.imread(image_path)
    if img is None:
        raise ValueError(f"Cannot load image: {image_path}")
    
    img_filtered, mask = preprocess_image(img, rgb_threshold)
    
    return img, img_filtered, mask
