#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Object Detection Module: FastSAM-based object detection
"""

import cv2
import numpy as np
import torch
from ultralytics import FastSAM
from typing import List, Tuple, Optional
from pathlib import Path

from ultralytics.utils.downloads import attempt_download_asset

from python.constants import (
    AUTO_DOWNLOAD_MODELS,
    FASTSAM_CONF_THRESHOLD as CONF_THRESHOLD,
    FASTSAM_IMAGE_SIZE as IMG_SIZE,
    FASTSAM_IOU_THRESHOLD as IOU_THRESHOLD,
    FASTSAM_MODEL_NAME,
    FASTSAM_MODEL_PATH,
    SCREEN_THRESHOLD_RATIO,
    SYMBOL_MAX_AREA as MAX_AREA,
    SYMBOL_MIN_AREA as MIN_AREA,
)

FASTSAM_MODEL = str(FASTSAM_MODEL_PATH)


class ObjectDetector:
    """FastSAM-based object detector"""
    
    def __init__(self, model_path: str = FASTSAM_MODEL, device: Optional[str] = None):
        """
        Initialize FastSAM detector.

        Relative model names are resolved from ``python/symbol/models`` first,
        then from the project working directory for backward compatibility.
        """
        model_path = self._resolve_model_path(model_path)
        self.device = device if device else ('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = FastSAM(model_path)
        print(f"✅ FastSAM loaded on {self.device}")

    @staticmethod
    def _resolve_model_path(model_path: str) -> str:
        path = Path(model_path)
        bundled_path = Path(FASTSAM_MODEL_PATH).parent / path.name

        if path.is_absolute():
            if path.exists():
                return str(path)
            # The default absolute path points inside python/symbol/models.
            # Allow that default model to be downloaded automatically.
            if path.resolve() != Path(FASTSAM_MODEL_PATH).resolve():
                raise FileNotFoundError(f"FastSAM model not found: {model_path}")
        elif bundled_path.exists():
            return str(bundled_path)
        elif path.exists():
            return str(path)

        if AUTO_DOWNLOAD_MODELS and path.name == FASTSAM_MODEL_NAME:
            return ObjectDetector._download_model(bundled_path)

        raise FileNotFoundError(f"FastSAM model not found: {model_path}")

    @staticmethod
    def _download_model(destination: Path) -> str:
        """Download weights through Ultralytics and place them in our model folder."""
        destination.parent.mkdir(parents=True, exist_ok=True)
        print(f"⬇️  FastSAM model not found. Downloading to: {destination}")

        try:
            downloaded_path = Path(
                attempt_download_asset(str(destination), release="v8.3.0")
            )
            if downloaded_path.resolve() != destination.resolve():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(downloaded_path.read_bytes())
        except Exception as error:
            raise RuntimeError(
                f"Could not download FastSAM model with Ultralytics: {error}"
            ) from error

        if not destination.exists():
            raise RuntimeError(f"Ultralytics download completed but file is missing: {destination}")

        print("✅ FastSAM model downloaded")
        return str(destination)
    
    def detect(self, img_filtered: np.ndarray, 
               conf: float = CONF_THRESHOLD,
               iou: float = IOU_THRESHOLD,
               min_area: int = MIN_AREA,
               max_area: int = MAX_AREA,
               debug: bool = False,
               debug_path: str = None) -> List[Tuple[np.ndarray, Tuple[int, int, int, int]]]:
        """
        Detect objects in preprocessed image
        
        Args:
            img_filtered: Preprocessed image (background removed)
            conf: Confidence threshold
            iou: IoU threshold for NMS
            min_area: Minimum object area
            max_area: Maximum object area
            debug: Save debug images
            debug_path: Directory to save debug images
        
        Returns:
            List of (binary_silhouette, (x, y, w, h)). Each silhouette is a
            three-channel image with the FastSAM mask drawn in black on a
            white background.
        """
        # Run FastSAM
        results = self.model(
            img_filtered,
            device=self.device,
            retina_masks=True,
            imgsz=IMG_SIZE,
            conf=conf,
            iou=iou,
            verbose=False
        )
        
        if len(results) == 0 or results[0].masks is None:
            return []
        
        masks = results[0].masks.data.cpu().numpy()
        boxes = results[0].boxes.xyxy.cpu().numpy()
        
        # Filter objects
        objects = self._filter_objects(img_filtered, masks, boxes, min_area, max_area, debug, debug_path)
        
        return objects
    
    def _filter_objects(self, img: np.ndarray, masks: np.ndarray, boxes: np.ndarray,
                       min_area: int, max_area: int, debug: bool = False, debug_path: str = None) -> List[Tuple[np.ndarray, Tuple[int, int, int, int]]]:
        """
        Filter detected objects by area and containment
        """
        objects = []
        large_objects = []
        img_h, img_w = img.shape[:2]
        screen_area = img_h * img_w
        screen_threshold = screen_area * SCREEN_THRESHOLD_RATIO
        non_white = np.any(img < 250, axis=2)

        # Detect if image is an uncropped full-modal screenshot with a wide bottom confirm button
        ui_bottom_y = img_h
        ui_top_y = 0
        for box in boxes:
            bx1, by1, bx2, by2 = box.astype(int)
            bw, bh = bx2 - bx1, by2 - by1
            if bw > 0.55 * img_w and bh < 0.22 * img_h and by1 > 0.60 * img_h:
                ui_bottom_y = min(ui_bottom_y, int(by1) - 5)
                ui_top_y = max(ui_top_y, int(0.08 * img_h))

        # Debug visualization
        if debug:
            debug_img = img.copy()
            all_objects_img = img.copy()
            filtered_img = img.copy()

        # First pass: collect candidate foreground objects
        candidates = []
        for i, (mask, box) in enumerate(zip(masks, boxes)):
            m_bool = mask > 0.5
            area = int(np.sum(m_bool))

            # Skip screen-filling objects
            if area >= screen_threshold:
                if debug:
                    x1, y1, x2, y2 = box.astype(int)
                    cv2.rectangle(all_objects_img, (x1, y1), (x2, y2), (0, 0, 255), 2)
                    cv2.putText(all_objects_img, "SCREEN", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)
                continue

            # Skip by area
            if area < min_area or area > max_area:
                if debug and area > max_area:
                    x1, y1, x2, y2 = box.astype(int)
                    cv2.rectangle(all_objects_img, (x1, y1), (x2, y2), (0, 165, 255), 2)
                    cv2.putText(all_objects_img, f"LARGE ({area})", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 165, 255), 1)
                continue

            x1, y1, x2, y2 = box.astype(int)
            x1 = max(0, x1)
            y1 = max(0, y1)
            x2 = min(img_w, x2)
            y2 = min(img_h, y2)

            w = x2 - x1
            h = y2 - y1
            if w <= 0 or h <= 0:
                continue

            cx, cy = x1 + w // 2, y1 + h // 2
            # Skip uncropped modal header/footer UI elements or wide horizontal banners
            if cy >= ui_bottom_y or cy <= ui_top_y or (w / float(max(1, h)) > 2.8):
                continue

            # Reject inner background holes (masks that mostly cover white background pixels)
            fg_pixels = int(np.sum(m_bool & non_white))
            fg_ratio = fg_pixels / float(max(1, area))
            if fg_ratio < 0.22:
                if debug:
                    cv2.rectangle(all_objects_img, (x1, y1), (x2, y2), (128, 128, 128), 1)
                    cv2.putText(all_objects_img, f"HOLE ({fg_ratio:.2f})", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (128, 128, 128), 1)
                continue

            candidates.append((fg_pixels, area, m_bool, (x1, y1, w, h)))

        # Sort by foreground pixel count descending so complete objects precede partial sub-parts
        candidates.sort(key=lambda item: item[0], reverse=True)
        kept = []
        for fg_pixels, area, m_bool, bbox in candidates:
            x1, y1, w, h = bbox
            is_subpart = False
            for _, _, kept_m, (kx1, ky1, kw, kh) in kept:
                ix1, iy1 = max(x1, kx1), max(y1, ky1)
                ix2, iy2 = min(x1 + w, kx1 + kw), min(y1 + h, ky1 + kh)
                inter_box = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                if inter_box / float(max(1, w * h)) > 0.65:
                    is_subpart = True
                    break
                mask_inter = int(np.sum(m_bool & kept_m))
                if mask_inter / float(max(1, area)) > 0.50:
                    is_subpart = True
                    break

            if is_subpart:
                if debug:
                    cv2.rectangle(all_objects_img, (x1, y1), (x1 + w, y1 + h), (255, 0, 255), 1)
                    cv2.putText(all_objects_img, "SUBPART", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 0, 255), 1)
                continue

            kept.append((fg_pixels, area, m_bool, bbox))

        # Second pass: build binary silhouettes while preserving enclosed interior holes
        erode_kernel = np.ones((5, 5), np.uint8)
        valid_count = 0
        for _, area, m_bool, (x1, y1, w, h) in kept:
            valid_count += 1
            cx, cy = x1 + w // 2, y1 + h // 2

            if debug:
                cv2.rectangle(all_objects_img, (x1, y1), (x1 + w, y1 + h), (0, 255, 0), 2)
                cv2.circle(all_objects_img, (cx, cy), 5, (0, 255, 0), -1)
                cv2.putText(all_objects_img, f"#{valid_count} ({area})", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

                cv2.rectangle(filtered_img, (x1, y1), (x1 + w, y1 + h), (0, 255, 0), 3)
                cv2.circle(filtered_img, (cx, cy), 8, (0, 0, 255), -1)
                cv2.putText(filtered_img, f"Object #{valid_count}", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

            padding = 5
            x1_pad = max(0, x1 - padding)
            y1_pad = max(0, y1 - padding)
            x2_pad = min(img_w, x1 + w + padding)
            y2_pad = min(img_h, y1 + h + padding)

            mask_crop = (m_bool[y1_pad:y2_pad, x1_pad:x2_pad]).astype(np.uint8)
            nw_crop = non_white[y1_pad:y2_pad, x1_pad:x2_pad]
            # Preserve true enclosed interior holes (e.g. inside 8, B, 9, O, e, a, wheel spokes)
            mask_inner = cv2.erode(mask_crop, erode_kernel)
            enclosed_holes = (mask_inner > 0) & (~nw_crop)
            mask_crop[enclosed_holes] = 0

            silhouette = np.full((*mask_crop.shape, 3), 255, dtype=np.uint8)
            silhouette[mask_crop > 0] = (0, 0, 0)
            objects.append((silhouette, (x1, y1, w, h)))
        
        # Save debug images
        if debug and debug_path:
            from pathlib import Path
            Path(debug_path).mkdir(parents=True, exist_ok=True)
            
            cv2.imwrite(f"{debug_path}/01_preprocessed.jpg", img)
            cv2.imwrite(f"{debug_path}/02_all_detections.jpg", all_objects_img)
            cv2.imwrite(f"{debug_path}/03_valid_objects.jpg", filtered_img)
            print(f"  💾 Debug images saved to: {debug_path}/")
        
        return objects


def detect_objects(img_filtered: np.ndarray, detector: Optional[ObjectDetector] = None) -> List[Tuple[np.ndarray, Tuple[int, int, int, int]]]:
    """
    Convenience function to detect objects
    
    Args:
        img_filtered: Preprocessed image
        detector: ObjectDetector instance (creates new one if None)
    
    Returns:
        List of (binary_silhouette, (x, y, w, h))
    """
    if detector is None:
        detector = ObjectDetector()
    
    return detector.detect(img_filtered)
