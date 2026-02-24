"""Preprocess ảnh: resize theo max_side (giữ tỉ lệ), convert RGB. Tham chiếu OCRPipelineV2.resize."""
from __future__ import annotations
import os
from PIL import Image


def _max_side() -> int:
    return int(os.getenv("OCR_MAX_SIDE", "1200"))


def preprocess_image(img: Image.Image) -> Image.Image:
    img = img.convert("RGB")
    max_side = _max_side()
    w, h = img.size
    scale = max(w, h) / max_side
    if scale > 1:
        new_w = int(w / scale)
        new_h = int(h / scale)
        img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    return img
