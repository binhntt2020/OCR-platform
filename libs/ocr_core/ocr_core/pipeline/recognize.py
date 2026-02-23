from typing import List, Tuple
from PIL import Image

Box = Tuple[int, int, int, int]


def recognize(img: Image.Image, boxes: List[Box]) -> List[tuple[str, float]]:
    """
    TODO: Replace with VietOCR batch.
    Return list of (text, conf) aligned with boxes.
    """
    return [("DUMMY_OCR_TEXT", 0.5) for _ in boxes]
