"""CRAFT text detection: load detector 1 lần/process (lru_cache). Config từ infra/system_config.yml + get_config."""
from __future__ import annotations
import os
from functools import lru_cache
from typing import List, Tuple

import cv2
import numpy as np
from PIL import Image

from ocr_core.config_loader import get_config, load_system_config, resolve_path

Box = Tuple[int, int, int, int]


def _resize_by_max_side(img: np.ndarray, max_side: int) -> np.ndarray:
    """Resize ảnh giữ độ dài cạnh max (tham chiếu pipeline đã chạy ổn)."""
    h, w = img.shape[:2]
    scale = max(h, w) / max_side
    if scale <= 1:
        return img
    new_w, new_h = int(w / scale), int(h / scale)
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def _craft_params():
    """Đọc tham số CRAFT từ system_config.yml (nếu có) hoặc env. Tham chiếu OCRPipelineV2."""
    system_config, base = load_system_config()
    device = os.getenv("OCR_DEVICE", "cpu")
    cuda = "cuda" in device

    detect_lines = os.getenv("CRAFT_REFINER", "true").lower() in ("true", "1")
    if system_config and get_config(system_config, ["craft_net"]) is not None:
        pass  # giữ detect_lines từ env; có thể bổ sung key trong yml sau

    weight_craft = get_config(system_config, ["craft_net", "weights"])
    weight_refine = get_config(system_config, ["refine_net", "weights"])
    if weight_craft is not None:
        weight_craft = resolve_path(weight_craft, base)
    if weight_refine is not None:
        weight_refine = resolve_path(weight_refine, base)
    if weight_craft is None:
        weight_craft = os.getenv("CRAFT_WEIGHTS_CRAFT_NET") or None
    if weight_refine is None:
        weight_refine = os.getenv("CRAFT_WEIGHTS_REFINE_NET") or None

    max_side = 0
    if system_config:
        max_side = get_config(system_config, ["craft_net", "max_side"]) or 0
    if not max_side:
        try:
            max_side = int(os.getenv("CRAFT_MAX_SIDE", "0"))
        except ValueError:
            max_side = 0

    return {
        "refiner": detect_lines,
        "output_dir": None,
        "crop_type": "box",
        "cuda": cuda,
        "export_extra": False,
        "weight_path_craft_net": weight_craft,
        "weight_path_refine_net": weight_refine,
        "max_side": max_side,
    }


@lru_cache(maxsize=1)
def get_craft_detector():
    """Load CRAFT detector 1 lần; cache theo process. Config từ system_config.yml (craft_net/refine_net)."""
    from craft_text_detector import Craft

    params = _craft_params()
    return Craft(
        output_dir=params["output_dir"],
        crop_type=params["crop_type"],
        cuda=params["cuda"],
        refiner=params["refiner"],
        export_extra=params["export_extra"],
        weight_path_craft_net=params["weight_path_craft_net"],
        weight_path_refine_net=params["weight_path_refine_net"],
    )


def detect_text_boxes(img: Image.Image) -> List[Box]:
    """Detect text regions; trả về list (x1, y1, x2, y2) từ polygon CRAFT. Có resize theo max_side nếu cấu hình."""
    craft = get_craft_detector()
    np_img = np.array(img)  # RGB
    h0, w0 = np_img.shape[:2]
    params = _craft_params()
    max_side = params.get("max_side") or 0
    scale = 1.0
    if max_side > 0:
        scale = max(h0, w0) / max_side
        if scale > 1:
            np_img = _resize_by_max_side(np_img, max_side)
    prediction_result = craft.detect_text(np_img)
    # CRAFT trả về "boxes" (N,4,2); xử lý vectorized như pipeline tham chiếu
    raw = prediction_result.get("boxes")
    if raw is None:
        return []
    arr = np.asarray(raw, dtype=np.float32)
    if arr.size == 0:
        return []
    xs = arr[..., 0]
    ys = arr[..., 1]
    x_min = xs.min(axis=1)
    x_max = xs.max(axis=1)
    y_min = ys.min(axis=1)
    y_max = ys.max(axis=1)
    valid = (x_max > x_min) & (y_max > y_min)
    x1 = x_min[valid]
    y1 = y_min[valid]
    x2 = x_max[valid]
    y2 = y_max[valid]
    if scale > 1:
        x1, x2 = x1 * scale, x2 * scale
        y1, y2 = y1 * scale, y2 * scale
    return list(zip(x1.astype(int).tolist(), y1.astype(int).tolist(), x2.astype(int).tolist(), y2.astype(int).tolist()))