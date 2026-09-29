#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Slide Captcha Solver using YOLO
"""

import cv2
import numpy as np
import torch
from ultralytics import YOLO
from pathlib import Path
from typing import Union, Tuple, Optional

from python.constants import (
    SLIDE_CONF_THRESHOLD,
    SLIDE_DEBUG_PATH,
    SLIDE_MODEL_PATH,
    SLIDE_MODEL_NAME,
    SLIDE_PUZZLE_CLASS_ID,
)

DEFAULT_MODEL = SLIDE_MODEL_NAME


class SlideCaptchaSolver:
    """Slide/Jigsaw captcha solver using YOLO object detection"""
    
    def __init__(self, model_path: str = DEFAULT_MODEL):
        """
        Initialize slide captcha solver
        
        Args:
            model_path: Path to YOLO model weights
        """
        # Resolve relative model names from python/slide/models first, then
        # fall back to the current working directory.
        requested_model_path = Path(model_path)
        if requested_model_path.is_absolute():
            if not requested_model_path.exists():
                raise FileNotFoundError(f"Model not found: {model_path}")
            model_path = str(requested_model_path)
        else:
            bundled_model = Path(SLIDE_MODEL_PATH).parent / requested_model_path.name
            if bundled_model.exists():
                model_path = str(bundled_model)
            elif requested_model_path.exists():
                model_path = str(requested_model_path)
            else:
                raise FileNotFoundError(f"Model not found: {model_path}")
        
        print(f"🚀 Loading YOLO model: {model_path}")
        self.model = YOLO(model_path)
        print("✅ Model loaded\n")
    
    def find_position(self, image: Union[str, np.ndarray], conf_threshold: float = 0.0) -> Tuple[int, int]:
        """
        Find the position of the puzzle piece
        
        Args:
            image: Input image (path or numpy array)
            conf_threshold: Minimum confidence threshold
        
        Returns:
            Tuple of (x, y) center position of the puzzle piece
        """
        # Load image if path
        if isinstance(image, str):
            img = cv2.imread(image)
            if img is None:
                raise ValueError(f"Cannot load image: {image}")
        else:
            img = image
        
        # Run YOLO detection
        results = self.model(img, verbose=False)
        result = results[0]
        detections = result.boxes.data
        
        # Find puzzle piece (class 0) with highest confidence
        pos = [0, 0]
        conf_now = 0
        
        for x1, y1, x2, y2, conf, cls in detections:
            if cls == 0 and conf > conf_now and conf >= conf_threshold:
                conf_now = conf
                # Calculate center
                center_x = ((x2 + x1) / 2).item()
                center_y = ((y2 + y1) / 2).item()
                pos = [int(center_x), int(center_y)]
        
        return tuple(pos)

    def detect_with_result(
        self,
        image: Union[str, np.ndarray],
        conf_threshold: float = SLIDE_CONF_THRESHOLD,
    ) -> Tuple[Tuple[int, int], np.ndarray]:
        """Detect once and return position plus the annotated result image."""
        if isinstance(image, str):
            img = cv2.imread(image)
            if img is None:
                raise ValueError(f"Cannot load image: {image}")
        else:
            img = image.copy()

        result_img = img.copy()
        detections = self.model(img, verbose=False)[0].boxes.data
        position = [0, 0]
        confidence = 0.0
        best_box = None

        for x1, y1, x2, y2, conf, cls in detections:
            x1_i, y1_i, x2_i, y2_i = map(int, (x1, y1, x2, y2))
            cv2.rectangle(result_img, (x1_i, y1_i), (x2_i, y2_i), (0, 255, 0), 2)
            cv2.putText(
                result_img, f"{int(cls)}: {conf:.2f}",
                (x1_i, y1_i - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2,
            )
            if (
                int(cls) == SLIDE_PUZZLE_CLASS_ID
                and conf > confidence
                and conf >= conf_threshold
            ):
                confidence = conf
                position = [int((x1 + x2).item() / 2), int((y1 + y2).item() / 2)]
                best_box = (x1_i, y1_i, x2_i, y2_i)

        if best_box is not None:
            x1_i, y1_i, x2_i, y2_i = best_box
            cv2.rectangle(result_img, (x1_i, y1_i), (x2_i, y2_i), (0, 0, 255), 3)
            cv2.circle(result_img, tuple(position), 10, (0, 0, 255), -1)
            cv2.circle(result_img, tuple(position), 15, (0, 0, 255), 2)
            cv2.putText(
                result_img, f"Target: ({position[0]}, {position[1]})",
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2,
            )
            cv2.putText(
                result_img, f"Confidence: {confidence:.3f}",
                (10, 70), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2,
            )

        return tuple(position), result_img
    
    def detect_with_visualization(self, image_path: str, show: bool = True, save_path: Optional[str] = None, debug: bool = False, debug_path: str = "debug_slide") -> Tuple[int, int]:
        """
        Detect puzzle piece and visualize result
        
        Args:
            image_path: Path to input image
            show: Whether to show the image
            save_path: Optional path to save visualization
            debug: Save debug images
            debug_path: Directory to save debug images
        
        Returns:
            Tuple of (x, y) center position
        """
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError(f"Cannot load image: {image_path}")
        
        if debug:
            from pathlib import Path
            Path(debug_path).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(f"{debug_path}/00_original.jpg", img)
            print(f"🐛 Debug mode - output: {debug_path}/")
        
        # Run detection
        results = self.model(img, verbose=False)
        result = results[0]
        detections = result.boxes.data
        
        # Find best puzzle piece
        pos = [0, 0]
        conf_now = 0
        best_box = None
        
        # Debug: All detections image
        if debug:
            all_detections_img = img.copy()
        
        for idx, (x1, y1, x2, y2, conf, cls) in enumerate(detections):
            # Draw all detections
            cv2.rectangle(img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
            cv2.putText(img, f'{int(cls)}: {conf:.2f}', (int(x1), int(y1) - 10),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 255, 0), 2)
            
            if debug:
                cv2.rectangle(all_detections_img, (int(x1), int(y1)), (int(x2), int(y2)), (0, 255, 0), 2)
                cv2.putText(all_detections_img, f'Class {int(cls)}: {conf:.3f}', (int(x1), int(y1) - 10),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            
            # Track best puzzle piece (class 0)
            if cls == 0 and conf > conf_now:
                conf_now = conf
                center_x = ((x2 + x1) / 2).item()
                center_y = ((y2 + y1) / 2).item()
                pos = [int(center_x), int(center_y)]
                best_box = (int(x1), int(y1), int(x2), int(y2))
        
        if debug:
            cv2.imwrite(f"{debug_path}/01_all_detections.jpg", all_detections_img)
        
        # Highlight best match
        if best_box:
            x1, y1, x2, y2 = best_box
            cv2.rectangle(img, (x1, y1), (x2, y2), (0, 0, 255), 3)  # Red for best
            cv2.circle(img, tuple(pos), 10, (0, 0, 255), -1)  # Center point
            cv2.circle(img, tuple(pos), 15, (0, 0, 255), 2)  # Outer ring
            cv2.putText(img, f'Target: ({pos[0]}, {pos[1]})', (10, 30),
                       cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
            cv2.putText(img, f'Confidence: {conf_now:.3f}', (10, 70),
                       cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
        
        # Save or show
        if save_path:
            cv2.imwrite(save_path, img)
            print(f"💾 Saved to: {save_path}")
        
        if debug:
            cv2.imwrite(f"{debug_path}/02_final_result.jpg", img)
            print(f"  💾 Debug images saved to: {debug_path}/")
        
        if show:
            cv2.imshow('Slide Captcha Detection', img)
            cv2.waitKey(0)
            cv2.destroyAllWindows()
        
        return tuple(pos)
    
    def solve(self, image: Union[str, np.ndarray], verbose: bool = True) -> Tuple[int, int]:
        """
        Solve slide captcha and return position
        
        Args:
            image: Input image (path or numpy array)
            verbose: Print results
        
        Returns:
            Tuple of (x, y) position to slide to
        """
        if verbose:
            print("="*70)
            print("🧩 Solving Slide Captcha")
            print("="*70)
        
        pos = self.find_position(image)
        
        if verbose:
            if pos[0] > 0 or pos[1] > 0:
                print(f"\n✅ Puzzle piece found at: ({pos[0]}, {pos[1]})")
            else:
                print(f"\n❌ No puzzle piece detected")
            print("="*70)
        
        return pos


def solve_slide_captcha(image: Union[str, np.ndarray], 
                        model_path: str = DEFAULT_MODEL,
                        visualize: bool = False) -> Tuple[int, int]:
    """
    Convenience function to solve slide captcha
    
    Args:
        image: Input image (path or numpy array)
        model_path: Path to YOLO model
        visualize: Whether to show visualization
    
    Returns:
        Tuple of (x, y) position
    """
    solver = SlideCaptchaSolver(model_path)
    
    if visualize and isinstance(image, str):
        return solver.detect_with_visualization(image)
    else:
        return solver.solve(image)
