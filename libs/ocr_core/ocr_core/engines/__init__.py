"""OCR engines: VietOCR (recognize), CRAFT (detect). Load model 1 lần/process (lru_cache)."""
from ocr_core.engines.vietocr_engine import get_vietocr_model, vietocr_predict_batch

__all__ = ["get_vietocr_model", "vietocr_predict_batch"]
