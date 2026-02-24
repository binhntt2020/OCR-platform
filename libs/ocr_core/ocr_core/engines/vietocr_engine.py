"""VietOCR engine: load model 1 lần/worker process (lru_cache), dùng lại cho mọi task."""
from __future__ import annotations
import os
from functools import lru_cache
from PIL import Image


@lru_cache(maxsize=1)
def get_vietocr_model():
    """Load VietOCR predictor 1 lần; cache theo process."""
    from vietocr.tool.predictor import Predictor
    from vietocr.tool.config import Cfg

    cfg = Cfg.load_config_from_name("vgg_transformer")
    cfg["device"] = os.getenv("OCR_DEVICE", "cpu")  # "cuda:0" nếu có GPU
    if os.getenv("VIETOCR_WEIGHTS"):
        cfg["weights"] = os.getenv("VIETOCR_WEIGHTS")
    return Predictor(cfg)


def _prob_to_float(prob) -> float:
    """Convert VietOCR prob (tensor hoặc float) sang float."""
    if hasattr(prob, "item"):
        return float(prob.item())
    return float(prob) if prob is not None else 1.0


def vietocr_predict_batch(model, crops: list[Image.Image]) -> list[tuple[str, float]]:
    """Predict từng crop; dùng return_prob=True để lấy confidence (tham chiếu OCRPipelineV2.ocr_text)."""
    out: list[tuple[str, float]] = []
    for im in crops:
        res = model.predict(im, return_prob=True)
        if isinstance(res, tuple):
            text, prob = res
            out.append((text, _prob_to_float(prob)))
        else:
            out.append((res, 1.0))
    return out