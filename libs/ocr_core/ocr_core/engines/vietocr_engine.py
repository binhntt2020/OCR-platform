"""VietOCR engine: load model 1 lần/worker process (lru_cache). Config từ infra/system_config.yml (vietocr.config, vietocr.weights, device).
VietOCR được train cho ảnh một dòng (height≈32). Vùng cao (nhiều dòng) sẽ được tách thành từng dòng, nhận dạng rồi ghép lại.
"""
from __future__ import annotations
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image

from ocr_core.config_loader import get_config, load_system_config, resolve_path

# VietOCR mong đợi ảnh ~1 dòng (height 32). Vùng cao hơn ngưỡng này sẽ tách thành nhiều strip theo chiều ngang.
MAX_SINGLE_LINE_HEIGHT = 56
LINE_STRIP_HEIGHT = 32
LINE_STRIP_OVERLAP = 4


def _vietocr_cfg():
    """Đọc cấu hình VietOCR từ system_config.yml (vietocr.config, vietocr.weights) và device (env hoặc config)."""
    from vietocr.tool.config import Cfg

    system_config, base = load_system_config()
    device = os.getenv("OCR_DEVICE") or get_config(system_config, ["vietocr", "device"]) or "cpu"

    config_path = get_config(system_config, ["vietocr", "config"])
    weights_path = get_config(system_config, ["vietocr", "weights"])

    if config_path:
        config_path = resolve_path(config_path, base)
    if weights_path:
        weights_path = resolve_path(weights_path, base)

    if config_path and Path(config_path).is_file():
        cfg = Cfg.load_config_from_file(config_path)
    else:
        cfg = Cfg.load_config_from_name("vgg_transformer")

    cfg["device"] = device
    if weights_path:
        cfg["weights"] = weights_path
    if os.getenv("VIETOCR_WEIGHTS"):
        cfg["weights"] = os.getenv("VIETOCR_WEIGHTS")
    return cfg


@lru_cache(maxsize=1)
def get_vietocr_model():
    """Load VietOCR predictor 1 lần; cache theo process. Config từ infra/system_config.yml."""
    from vietocr.tool.predictor import Predictor

    cfg = _vietocr_cfg()
    return Predictor(cfg)


def _prob_to_float(prob) -> float:
    """Convert VietOCR prob (tensor hoặc float) sang float."""
    if hasattr(prob, "item"):
        return float(prob.item())
    return float(prob) if prob is not None else 1.0


def _split_tall_crop_into_strips(
    img: Image.Image,
    original_height_px: int | None = None,
) -> list[Image.Image]:
    """Tách ảnh cao (nhiều dòng) thành các strip ngang ~1 dòng để VietOCR nhận dạng đúng thứ tự.
    Nếu original_height_px > 56 (chiều cao box gốc từ detect_result), dùng nó để quyết định số strip
    vì crop có thể đã bị scale nhỏ (preprocess resize)."""
    w, h = img.size
    use_original = original_height_px is not None and original_height_px > MAX_SINGLE_LINE_HEIGHT
    if use_original:
        # Strip theo chiều cao gốc: mỗi dòng ~32px, overlap 4px. Map tọa độ gốc → crop (crop có thể đã scale)
        # để tránh cắt qua chữ (vd. "Ban" của dòng 2 lẫn vào strip 1). Số strip = số dòng ước lượng.
        num_strips = max(1, round(original_height_px / LINE_STRIP_HEIGHT))
        step_orig = max(1, LINE_STRIP_HEIGHT - LINE_STRIP_OVERLAP)
        strips = []
        for i in range(num_strips):
            y_orig = i * step_orig
            if i == num_strips - 1:
                y2_orig = original_height_px
            else:
                y2_orig = min(y_orig + LINE_STRIP_HEIGHT, original_height_px)
            y1_crop = int(y_orig * h / original_height_px)
            y2_crop = int(y2_orig * h / original_height_px)
            if y2_crop > y1_crop and (y2_crop - y1_crop) >= 8:
                strips.append(img.crop((0, y1_crop, w, y2_crop)))
        return strips if strips else [img]
    if h <= MAX_SINGLE_LINE_HEIGHT:
        return [img]
    step = max(1, LINE_STRIP_HEIGHT - LINE_STRIP_OVERLAP)
    strips = []
    y = 0
    while y < h:
        y2 = min(y + LINE_STRIP_HEIGHT, h)
        strip = img.crop((0, y, w, y2))
        if strip.size[1] >= 8:
            strips.append(strip)
        y += step
    return strips if strips else [img]


def _predict_one_crop_maybe_multiline(
    model,
    im: Image.Image,
    original_height_px: int | None = None,
) -> tuple[str, float]:
    """Một crop: nếu ảnh cao hoặc original_height_px > 56 thì tách dòng, nhận dạng từng dòng rồi ghép bằng \\n."""
    strips = _split_tall_crop_into_strips(im, original_height_px)
    if len(strips) == 1:
        res = model.predict(im, return_prob=True)
        if isinstance(res, tuple):
            return (res[0], _prob_to_float(res[1]))
        return (res, 1.0)
    texts: list[str] = []
    probs: list[float] = []
    for strip in strips:
        res = model.predict(strip, return_prob=True)
        if isinstance(res, tuple):
            texts.append(res[0])
            probs.append(_prob_to_float(res[1]))
        else:
            texts.append(res)
            probs.append(1.0)
    joined = "\n".join(texts)
    conf = min(probs) if probs else 1.0
    return (joined, conf)


def vietocr_predict_batch(
    model,
    crops: list[Image.Image],
    original_heights: list[int] | None = None,
) -> list[tuple[str, float]]:
    """Predict từng crop. Crop cao (vùng nhiều dòng) được tách thành dòng, nhận dạng rồi ghép.
    original_heights: chiều cao box gốc (page coords) từ detect_result; dùng để tách dòng dù crop đã scale."""
    out: list[tuple[str, float]] = []
    for i, im in enumerate(crops):
        oh = original_heights[i] if original_heights and i < len(original_heights) else None
        out.append(_predict_one_crop_maybe_multiline(model, im, oh))
    return out