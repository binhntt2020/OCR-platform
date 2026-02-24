from __future__ import annotations
from typing import List, Optional, Tuple
from PIL import Image

from ocr_core.engines.vietocr_engine import get_vietocr_model, vietocr_predict_batch

Box = Tuple[int, int, int, int]

def _crop(img: Image.Image, box: Box) -> Image.Image:
    x1, y1, x2, y2 = box
    x1 = max(0, x1); y1 = max(0, y1)
    x2 = max(x1 + 1, x2); y2 = max(y1 + 1, y2)
    return img.crop((x1, y1, x2, y2))

def recognize(
    img: Image.Image,
    boxes: List[Box],
    original_heights: Optional[List[int]] = None,
) -> List[tuple[str, float]]:
    """Recognize từng box. original_heights: chiều cao gốc (page coords) từ detect_result;
    nếu height > 56 thì tách dòng theo strip dù crop đã bị scale nhỏ."""
    model = get_vietocr_model()
    crops = [_crop(img, b) for b in boxes]
    return vietocr_predict_batch(model, crops, original_heights=original_heights)