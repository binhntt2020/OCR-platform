from typing import List, Tuple
from PIL import Image
import numpy as np

Box = Tuple[int, int, int, int]


def detect_text_boxes(img: Image.Image) -> List[Box]:
    """
    TODO: Replace with CRAFT/DBNet actual detector.
    This stub returns a single full-image box.
    """
    np_img = np.asarray(img)
    h, w = np_img.shape[:2]
    return [(0, 0, w, h)]
