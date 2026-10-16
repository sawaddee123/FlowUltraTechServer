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
    
    @staticmethod
    def _get_color_palette_masks(img_filtered: np.ndarray) -> dict:
        """Partition non-white foreground pixels into the 7 recurring 3D material color buckets."""
        hsv = cv2.cvtColor(img_filtered, cv2.COLOR_BGR2HSV)
        H, S, V = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
        nw = np.any(img_filtered < 250, axis=2)

        return {
            "orange": nw & (((H <= 16) | ((H >= 168) & (S < 135))) & (S >= 68)),
            "rose":   nw & ((H >= 168) & (S >= 135)),
            "brown":  nw & ((((H <= 16) | (H >= 168)) & (S >= 10) & (S < 68)) | ((H >= 17) & (H <= 39) & (S >= 10) & (S < 42))) & (V <= 225),
            "yellow": nw & ((H >= 17) & (H <= 39) & (S >= 42)),
            "green":  nw & ((H >= 40) & (H <= 85)),
            "blue":   nw & ((H >= 86) & (H <= 127)),
            "purple": nw & ((H >= 128) & (H <= 167)),
        }

    @staticmethod
    def _extract_components(m_bool: np.ndarray, min_area: int):
        num_labels, cc, stats, _ = cv2.connectedComponentsWithStats(m_bool.astype(np.uint8), connectivity=8)
        comps = []
        for cid in range(1, num_labels):
            c_area = int(stats[cid, cv2.CC_STAT_AREA])
            if c_area >= min_area:
                x = int(stats[cid, cv2.CC_STAT_LEFT])
                y = int(stats[cid, cv2.CC_STAT_TOP])
                w = int(stats[cid, cv2.CC_STAT_WIDTH])
                h = int(stats[cid, cv2.CC_STAT_HEIGHT])
                comps.append((c_area, (cc == cid), (x, y, w, h)))
        return comps

    @classmethod
    def _split_by_palette_and_ab(cls, img_filtered: np.ndarray, m_bool: np.ndarray, min_area: int):
        c_max = np.max(img_filtered, axis=2).astype(np.int16)
        c_min = np.min(img_filtered, axis=2).astype(np.int16)
        if np.percentile(c_max - c_min, 99) < 10:
            return []

        palette = cls._get_color_palette_masks(img_filtered)
        kernel_open = np.ones((3, 3), np.uint8)
        kernel_dilate = np.ones((5, 5), np.uint8)
        non_white = np.any(img_filtered < 250, axis=2)

        palette_comps = []
        for _, cmask in palette.items():
            sub = (m_bool & cmask).astype(np.uint8)
            if int(np.sum(sub)) < min_area:
                continue
            sub = cv2.morphologyEx(sub, cv2.MORPH_OPEN, kernel_open)
            for _, c_m, _ in cls._extract_components(sub > 0, min_area):
                c_expanded = (cv2.dilate(c_m.astype(np.uint8), kernel_dilate) > 0) & m_bool & non_white
                ys, xs = np.where(c_expanded)
                if len(ys) >= min_area:
                    bx1, by1, bx2, by2 = int(np.min(xs)), int(np.min(ys)), int(np.max(xs)) + 1, int(np.max(ys)) + 1
                    palette_comps.append((len(ys), c_expanded, (bx1, by1, bx2 - bx1, by2 - by1)))

        palette_comps.sort(key=lambda item: item[0], reverse=True)
        dedup_palette = []
        for c_area, c_m, (x, y, w, h) in palette_comps:
            overlaps = False
            for _, _, (kx, ky, kw, kh) in dedup_palette:
                ix1, iy1 = max(x, kx), max(y, ky)
                ix2, iy2 = min(x + w, kx + kw), min(y + h, ky + kh)
                inter_box = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                if inter_box / float(max(1, min(w * h, kw * kh))) > 0.48:
                    overlaps = True
                    break
            if not overlaps:
                dedup_palette.append((c_area, c_m, (x, y, w, h)))

        if len(dedup_palette) >= 2:
            return dedup_palette

        ys, xs = np.where(m_bool & non_white)
        if len(ys) < min_area * 2:
            return []
        lab = cv2.cvtColor(img_filtered, cv2.COLOR_BGR2LAB)
        ab_pts = lab[ys, xs, 1:3].astype(np.float32)
        criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
        _, labels, centers = cv2.kmeans(ab_pts, 2, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
        ab_dist = float(np.linalg.norm(centers[0] - centers[1]))
        if ab_dist < 13.0:
            return []
        out = []
        for k in (0, 1):
            sub_m = np.zeros_like(m_bool, dtype=np.uint8)
            sel = (labels.flatten() == k)
            sub_m[ys[sel], xs[sel]] = 1
            sub_m = cv2.morphologyEx(sub_m, cv2.MORPH_OPEN, kernel_open)
            out.extend(cls._extract_components(sub_m > 0, min_area))
        return out if len(out) >= 2 else []

    @classmethod
    def _split_by_neck(cls, m_bool: np.ndarray, bbox: Tuple[int, int, int, int], img_w: int, img_h: int, min_area: int):
        x1, y1, w, h = bbox
        crop = m_bool[y1:y1 + h, x1:x1 + w].astype(np.uint8)
        fill_ratio = float(np.sum(crop)) / float(max(1, w * h))
        out = []
        if h > 0.31 * img_h:
            row_sums = np.sum(crop, axis=1)
            s, e = int(h * 0.20), int(h * 0.80)
            if e > s:
                neck = s + int(np.argmin(row_sums[s:e]))
                if row_sums[neck] < 0.60 * min(np.max(row_sums[:neck]), np.max(row_sums[neck:])):
                    m1 = np.zeros_like(m_bool)
                    m2 = np.zeros_like(m_bool)
                    m1[y1:y1 + neck, x1:x1 + w] = m_bool[y1:y1 + neck, x1:x1 + w]
                    m2[y1 + neck:y1 + h, x1:x1 + w] = m_bool[y1 + neck:y1 + h, x1:x1 + w]
                    out.extend(cls._extract_components(m1, min_area))
                    out.extend(cls._extract_components(m2, min_area))
                    if len(out) >= 2:
                        return out
        if w >= 0.15 * img_w:
            col_sums = np.sum(crop, axis=0)
            s, e = int(w * 0.30), int(w * 0.70)
            if e > s:
                neck = s + int(np.argmin(col_sums[s:e]))
                thresh = 0.80 if fill_ratio < 0.56 else 0.58
                if col_sums[neck] < thresh * min(np.max(col_sums[:neck]), np.max(col_sums[neck:])):
                    m1 = np.zeros_like(m_bool)
                    m2 = np.zeros_like(m_bool)
                    m1[y1:y1 + h, x1:x1 + neck] = m_bool[y1:y1 + h, x1:x1 + neck]
                    m2[y1:y1 + h, x1 + neck:x1 + w] = m_bool[y1:y1 + h, x1 + neck:x1 + w]
                    out.extend(cls._extract_components(m1, min_area))
                    out.extend(cls._extract_components(m2, min_area))
                    if len(out) >= 2:
                        return out
        return []

    def _filter_objects(self, img: np.ndarray, masks: np.ndarray, boxes: np.ndarray,
                       min_area: int, max_area: int, debug: bool = False, debug_path: str = None) -> List[Tuple[np.ndarray, Tuple[int, int, int, int]]]:
        """
        Filter detected objects by area, color palette decomposition, and containment.
        """
        objects = []
        img_h, img_w = img.shape[:2]
        screen_area = img_h * img_w
        screen_threshold = screen_area * SCREEN_THRESHOLD_RATIO
        non_white = np.any(img < 250, axis=2)
        c_max = np.max(img, axis=2).astype(np.int16)
        c_min = np.min(img, axis=2).astype(np.int16)
        is_gray = bool(np.percentile(c_max - c_min, 99) < 10)
        fg_strict_mask = (c_min < 212) if is_gray else non_white

        # Detect if image is an uncropped modal screenshot with header text or bottom confirm button
        ui_bottom_y = img_h
        ui_top_y = 0
        top_strip_white = np.mean(img[:max(1, int(0.05 * img_h)), :, :] >= 250)
        if top_strip_white > 0.96:
            has_header_boxes = any(int(b[1]) <= 5 and (int(b[3]) - int(b[1])) < 0.10 * img_h for b in boxes)
            if has_header_boxes:
                ui_top_y = int(0.10 * img_h)

        for box in boxes:
            bx1, by1, bx2, by2 = box.astype(int)
            bw, bh = bx2 - bx1, by2 - by1
            if bw > 0.55 * img_w and bh < 0.22 * img_h and by1 > 0.60 * img_h:
                ui_bottom_y = min(ui_bottom_y, int(by1) - 5)
                ui_top_y = max(ui_top_y, int(0.10 * img_h))

        if debug:
            all_objects_img = img.copy()
            filtered_img = img.copy()

        palette = self._get_color_palette_masks(img) if not is_gray else {}

        raw_candidates = []
        oversized_compound = []
        for mask, box in zip(masks, boxes):
            m_bool = mask > 0.5
            area = int(np.sum(m_bool))

            if area >= screen_threshold or area < min_area:
                continue

            x1, y1, x2, y2 = box.astype(int)
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(img_w, x2), min(img_h, y2)
            w, h = x2 - x1, y2 - y1
            if w <= 0 or h <= 0:
                continue

            cx, cy = x1 + w // 2, y1 + h // 2
            if cy >= ui_bottom_y or cy <= ui_top_y or h < int(0.075 * img_h) or (w / float(max(1, h)) > 2.8) or (h / float(max(1, w)) > 4.8):
                continue
            if (x1 <= 2 or x2 >= img_w - 2) and (w < 0.065 * img_w and h > 0.25 * img_h):
                continue
            if (y1 <= 2 or y2 >= img_h - 2) and (h < 0.065 * img_h and w > 0.25 * img_w):
                continue

            fg_strict = int(np.sum(m_bool & fg_strict_mask))
            if fg_strict / float(max(1, area)) < 0.22:
                continue
            fg_pixels = int(np.sum(m_bool & non_white))

            fill_ratio = fg_pixels / float(max(1, w * h))
            is_diagonal_pair = (w >= 0.15 * img_w and h >= 0.22 * img_h and fill_ratio < 0.54)
            is_multicolor = False
            if not is_gray and area >= min_area * 2 and (h >= 0.24 * img_h or w >= 0.14 * img_w):
                n_cols = sum(1 for cm in palette.values() if int(np.sum(m_bool & cm)) >= min_area)
                is_multicolor = n_cols >= 2

            if area > max_area or w > 0.19 * img_w or h > 0.365 * img_h or is_diagonal_pair or is_multicolor:
                oversized_compound.append((fg_pixels, area, m_bool, (x1, y1, w, h)))
            else:
                raw_candidates.append((fg_pixels, area, m_bool, (x1, y1, w, h)))

        # Split oversized or touching compound masks via child subtraction, 7-color palette, and neck pinch
        dilate_k = np.ones((5, 5), np.uint8)
        for fg_pixels, area, m_bool, (x1, y1, w, h) in oversized_compound:
            rem = m_bool.copy()
            subtracted_any = False
            for _, c_area, c_m, _ in raw_candidates:
                inter = int(np.sum(rem & c_m))
                if inter / float(max(1, c_area)) > 0.55 and c_area < 0.85 * area:
                    c_dil = cv2.dilate(c_m.astype(np.uint8), dilate_k) > 0
                    rem = rem & (~c_dil)
                    subtracted_any = True

            rem_comps = self._extract_components(rem, min_area) if subtracted_any else [(area, m_bool, (x1, y1, w, h))]
            final_splits = []
            for r_area, r_m, (rx, ry, rw, rh) in rem_comps:
                r_fg = int(np.sum(r_m & non_white))
                r_fill = r_fg / float(max(1, rw * rh))
                r_diag = (rw >= 0.15 * img_w and rh >= 0.22 * img_h and r_fill < 0.54)
                r_geom_over = (r_area > max_area or rw > 0.19 * img_w or rh > 0.365 * img_h or r_diag)
                r_multi = (not is_gray and r_area >= min_area * 2 and sum(1 for cm in palette.values() if int(np.sum(r_m & cm)) >= min_area) >= 2)
                if r_geom_over or r_multi:
                    c_splits = self._split_by_palette_and_ab(img, r_m, min_area)
                    if c_splits:
                        for s_area, s_m, (sx, sy, sw, sh) in c_splits:
                            if sw > 0.19 * img_w or sh > 0.365 * img_h:
                                n_sub = self._split_by_neck(s_m, (sx, sy, sw, sh), img_w, img_h, min_area)
                                final_splits.extend(n_sub if n_sub else [(s_area, s_m, (sx, sy, sw, sh))])
                            else:
                                final_splits.append((s_area, s_m, (sx, sy, sw, sh)))
                    elif r_geom_over:
                        n_sub = self._split_by_neck(r_m, (rx, ry, rw, rh), img_w, img_h, min_area)
                        if n_sub:
                            final_splits.extend(n_sub)
                        elif r_area <= max_area and rw <= 0.21 * img_w and rh <= 0.375 * img_h:
                            final_splits.append((r_area, r_m, (rx, ry, rw, rh)))
                    else:
                        final_splits.append((r_area, r_m, (rx, ry, rw, rh)))
                else:
                    final_splits.append((r_area, r_m, (rx, ry, rw, rh)))

            for s_area, s_m, (sx, sy, sw, sh) in final_splits:
                if sw <= 0.21 * img_w and int(0.075 * img_h) <= sh <= 0.38 * img_h and s_area <= max_area and (sh / float(max(1, sw)) <= 4.8):
                    s_strict = int(np.sum(s_m & fg_strict_mask))
                    if s_strict / float(max(1, s_area)) >= 0.22:
                        s_fg = int(np.sum(s_m & non_white))
                        raw_candidates.append((s_fg, s_area, s_m, (sx, sy, sw, sh)))

        # Direct Chromatic Color-Palette Rescue for colored objects missed or merged by FastSAM
        if not is_gray:
            palette = self._get_color_palette_masks(img)
            kernel_open = np.ones((3, 3), np.uint8)
            for cname in ("orange", "rose", "yellow", "green", "blue", "purple"):
                cmask = palette[cname]
                cmask_u8 = cv2.morphologyEx(cmask.astype(np.uint8), cv2.MORPH_OPEN, kernel_open)
                raw_color_comps = self._extract_components(cmask_u8 > 0, min_area)
                expanded_color_comps = []
                for c_area, c_m, (cx1, cy1, cw, ch) in raw_color_comps:
                    if cw > 0.19 * img_w or ch > 0.345 * img_h or c_area > max_area:
                        n_sub = self._split_by_neck(c_m, (cx1, cy1, cw, ch), img_w, img_h, min_area)
                        if n_sub:
                            expanded_color_comps.extend(n_sub)
                    else:
                        expanded_color_comps.append((c_area, c_m, (cx1, cy1, cw, ch)))

                for c_area, c_m, (cx1, cy1, cw, ch) in expanded_color_comps:
                    ccx, ccy = cx1 + cw // 2, cy1 + ch // 2
                    if ccy >= ui_bottom_y or ccy <= ui_top_y:
                        continue
                    if cw < 32 or cw > 0.19 * img_w or ch < 55 or ch > 0.375 * img_h or c_area > max_area:
                        continue
                    if (cw / float(max(1, ch)) > 1.8) or (ch / float(max(1, cw)) > 4.8):
                        continue
                    covered = False
                    for _, _, _, (kx1, ky1, kw, kh) in raw_candidates:
                        ix1, iy1 = max(cx1, kx1), max(cy1, ky1)
                        ix2, iy2 = min(cx1 + cw, kx1 + kw), min(cy1 + ch, ky1 + kh)
                        inter_box = max(0, ix2 - ix1) * max(0, iy2 - iy1)
                        if inter_box / float(max(1, min(cw * ch, kw * kh))) > 0.45:
                            covered = True
                            break
                    if not covered:
                        c_expanded = (cv2.dilate(c_m.astype(np.uint8), dilate_k) > 0) & non_white
                        ys, xs = np.where(c_expanded)
                        if len(ys) >= min_area:
                            bx1, by1, bx2, by2 = int(np.min(xs)), int(np.min(ys)), int(np.max(xs)) + 1, int(np.max(ys)) + 1
                            bw, bh = bx2 - bx1, by2 - by1
                            if bw <= 0.20 * img_w and bh <= 0.38 * img_h:
                                raw_candidates.append((len(ys), len(ys), c_expanded, (bx1, by1, bw, bh)))

        # Sort by foreground pixel count descending so complete objects precede partial sub-parts
        raw_candidates.sort(key=lambda item: item[0], reverse=True)
        kept = []
        for fg_pixels, area, m_bool, bbox in raw_candidates:
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

            if not is_subpart:
                kept.append((fg_pixels, area, m_bool, bbox))

        close_k = np.ones((3, 3), np.uint8)
        occ_dilate_k = np.ones((9, 9), np.uint8)
        valid_count = 0
        for idx_k, (fg_pixels, area, m_bool, (x1, y1, w, h)) in enumerate(kept):
            valid_count += 1
            cx, cy = x1 + w // 2, y1 + h // 2

            if debug:
                cv2.rectangle(all_objects_img, (x1, y1), (x1 + w, y1 + h), (0, 255, 0), 2)
                cv2.circle(all_objects_img, (cx, cy), 5, (0, 255, 0), -1)
                cv2.putText(all_objects_img, f"#{valid_count} ({area})", (x1, y1 - 5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

                cv2.rectangle(filtered_img, (x1, y1), (x1 + w, y1 + h), (0, 255, 0), 3)
                cv2.circle(filtered_img, (cx, cy), 8, (0, 0, 255), -1)
                cv2.putText(filtered_img, f"Object #{valid_count}", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

            m_work = (m_bool & non_white).astype(np.uint8)
            # Restore occluded corner on large solid 3D primitives (e.g. overlapping cylinders)
            if area >= 14000 and w >= 95 and h >= 190 and (fg_pixels / float(max(1, area))) >= 0.90:
                cnts, _ = cv2.findContours(m_work, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                if cnts:
                    hull = np.zeros_like(m_work)
                    cv2.drawContours(hull, [cv2.convexHull(np.vstack(cnts))], -1, 1, -1)
                    for idx_o, (_, _, o_m, (ox1, oy1, ow, oh)) in enumerate(kept):
                        if idx_o != idx_k:
                            ix1, iy1 = max(x1, ox1), max(y1, oy1)
                            ix2, iy2 = min(x1 + w, ox1 + ow), min(y1 + h, oy1 + oh)
                            if ix2 > ix1 and iy2 > iy1:
                                o_dil = cv2.dilate(o_m.astype(np.uint8), occ_dilate_k)
                                m_work = m_work | (hull & o_dil)

            padding = 5
            x1_pad = max(0, x1 - padding)
            y1_pad = max(0, y1 - padding)
            x2_pad = min(img_w, x1 + w + padding)
            y2_pad = min(img_h, y1 + h + padding)

            m_crop = m_work[y1_pad:y2_pad, x1_pad:x2_pad]
            mask_crop = cv2.morphologyEx(m_crop, cv2.MORPH_CLOSE, close_k)

            silhouette = np.full((*mask_crop.shape, 3), 255, dtype=np.uint8)
            silhouette[mask_crop > 0] = (0, 0, 0)
            objects.append((silhouette, (x1, y1, w, h)))

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
