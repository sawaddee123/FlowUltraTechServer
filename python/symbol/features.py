#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Feature Extraction Module: DINOv2-based feature extraction
"""

import cv2
import numpy as np
import torch
from typing import Optional

from python.constants import BINARY_IMAGE_THRESHOLD, DINO_MODEL_NAME

DINO_MODEL = DINO_MODEL_NAME


class FeatureExtractor:
    """DINOv2-based feature extractor"""
    
    def __init__(self, model_name: str = DINO_MODEL, device: Optional[str] = None):
        """
        Initialize DINOv2 feature extractor
        
        Args:
            model_name: Model name or PyTorch hub model
            device: Device to run on ('cuda' or 'cpu'). Auto-detect if None.
        """
        self.device = device if device else ('cuda' if torch.cuda.is_available() else 'cpu')
        self.use_hub = True
        try:
            # 1. Primary: Native PyTorch Hub DINOv2 (Zero dependencies on torchvision/torchaudio)
            self.model = torch.hub.load('facebookresearch/dinov2', 'dinov2_vits14')
            self.model = self.model.to(self.device)
            self.model.eval()
            self.use_hub = True
            print(f"✅ DINOv2 (PyTorch Hub) loaded on {self.device}")
        except Exception as hub_err:
            # 2. Secondary Fallback: Transformers AutoModel
            try:
                from transformers import AutoImageProcessor, AutoModel
                self.processor = AutoImageProcessor.from_pretrained(model_name)
                self.model = AutoModel.from_pretrained(model_name).to(self.device)
                self.model.eval()
                self.use_hub = False
                print(f"✅ DINOv2 (Transformers) loaded on {self.device}")
            except Exception as trans_err:
                raise RuntimeError(f"Failed to load DINOv2 via PyTorch Hub ({hub_err}) and Transformers ({trans_err})")
    
    def _extract_dino_embedding(self, binary_rgb_image: np.ndarray) -> np.ndarray:
        """Run a single 3-channel binary image through DINOv2 and L2-normalize."""
        if getattr(self, "use_hub", True):
            resized = cv2.resize(binary_rgb_image, (224, 224), interpolation=cv2.INTER_CUBIC)
            norm_arr = resized.astype(np.float32) / 255.0
            mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
            std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
            norm_arr = (norm_arr - mean) / std
            tensor = torch.from_numpy(norm_arr.transpose(2, 0, 1)).unsqueeze(0).to(self.device)

            with torch.no_grad():
                out = self.model(tensor)
                if isinstance(out, torch.Tensor):
                    features = out.cpu().numpy().flatten()
                elif hasattr(out, "last_hidden_state"):
                    features = out.last_hidden_state[:, 0].cpu().numpy().flatten()
                else:
                    features = np.array(out).flatten()
        else:
            from PIL import Image
            pil_image = Image.fromarray(binary_rgb_image)
            inputs = self.processor(images=pil_image, return_tensors="pt")
            inputs = {k: v.to(self.device) for k, v in inputs.items()}

            with torch.no_grad():
                outputs = self.model(**inputs)

            features = outputs.last_hidden_state[:, 0].cpu().numpy().flatten()

        return features / (np.linalg.norm(features) + 1e-8)

    def extract(
        self,
        image: np.ndarray,
        binary_threshold: int = BINARY_IMAGE_THRESHOLD,
    ) -> np.ndarray:
        """
        Extract hybrid features from a binary black-and-white silhouette image.

        Combines:
        1. Aspect-normalized 224x224 DINOv2 embedding (0.72 weight)
        2. Aspect-damped letterbox-padded 224x224 DINOv2 embedding with 16% margin (0.64 weight)
        3. 32x32 Gaussian-smoothed silhouette spatial density vector (0.26 weight)
        """
        if image is None or image.size == 0:
            raise ValueError("Cannot extract features from an empty image")
        if not 0 <= binary_threshold <= 255:
            raise ValueError("binary_threshold must be between 0 and 255")

        if image.ndim == 2:
            gray_image = image
        elif image.ndim == 3 and image.shape[2] == 1:
            gray_image = image[:, :, 0]
        elif image.ndim == 3 and image.shape[2] == 3:
            gray_image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        else:
            raise ValueError("Expected a grayscale image or a 3-channel BGR image")

        _, binary_image = cv2.threshold(
            gray_image, binary_threshold, 255, cv2.THRESH_BINARY
        )
        binary_rgb_image = cv2.cvtColor(binary_image, cv2.COLOR_GRAY2RGB)

        # 1. Standard 224x224 DINOv2 embedding
        f_norm = self._extract_dino_embedding(binary_rgb_image)

        # 2. Aspect-damped letterbox-padded 224x224 DINOv2 embedding
        h, w = binary_rgb_image.shape[:2]
        max_dim = max(h, w)
        margin = int(0.16 * max_dim)
        target_w = int(w + 0.55 * (max_dim - w)) + 2 * margin
        target_h = int(h + 0.55 * (max_dim - h)) + 2 * margin
        pad_left = (target_w - w) // 2
        pad_right = target_w - w - pad_left
        pad_top = (target_h - h) // 2
        pad_bot = target_h - h - pad_top
        padded_rgb = cv2.copyMakeBorder(
            binary_rgb_image,
            pad_top,
            pad_bot,
            pad_left,
            pad_right,
            cv2.BORDER_CONSTANT,
            value=(255, 255, 255),
        )
        f_pad = self._extract_dino_embedding(padded_rgb)

        # 3. 32x32 smoothed binary silhouette spatial density vector
        mask_bin = (binary_image < 128).astype(np.float32)
        grid = cv2.resize(mask_bin, (32, 32), interpolation=cv2.INTER_AREA)
        grid = cv2.GaussianBlur(grid, (5, 5), 1.0).flatten()
        f_grid = grid / (np.linalg.norm(grid) + 1e-8)

        combined = np.concatenate([f_norm * 0.72, f_pad * 0.64, f_grid * 0.26])
        return combined / (np.linalg.norm(combined) + 1e-8)


def extract_features(image: np.ndarray, extractor: Optional[FeatureExtractor] = None) -> np.ndarray:
    """
    Convenience function to extract features
    
    Args:
        image: BGR image
        extractor: FeatureExtractor instance (creates new one if None)
    
    Returns:
        Feature vector
    """
    if extractor is None:
        extractor = FeatureExtractor()
    
    return extractor.extract(image)


def compute_similarity(feat1: np.ndarray, feat2: np.ndarray) -> float:
    """
    Compute cosine similarity between two feature vectors
    
    Args:
        feat1: First feature vector
        feat2: Second feature vector
    
    Returns:
        Cosine similarity score (0-1)
    """
    # Normalize vectors
    feat1_norm = feat1 / (np.linalg.norm(feat1) + 1e-8)
    feat2_norm = feat2 / (np.linalg.norm(feat2) + 1e-8)
    
    # Cosine similarity
    cos_sim = np.dot(feat1_norm, feat2_norm)
    
    return float(cos_sim)
