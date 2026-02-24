"""VietOCR engine: load model 1 lần/worker process (lru_cache). Config từ infra/system_config.yml (vietocr.config, vietocr.weights, device)."""
from __future__ import annotations
import os
from functools import lru_cache
from pathlib import Path

from PIL import Image

from ocr_core.config_loader import get_config, load_system_config, resolve_path


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