"""
Pipeline OCR: Preprocess → CRAFT (detect) → VietOCR (recognize) → Postprocess.
orchestrator gọi detect_text_boxes (CRAFT) và recognize (VietOCR); không phụ thuộc trực tiếp vào từng engine.
Có thể chạy OCR với boxes có sẵn (run_ocr_with_boxes) khi đã lưu/chỉnh sửa kết quả Detect trong DB.
"""
from __future__ import annotations
from PIL import Image
import logging
import time
import uuid

from ocr_core.domain.models import OcrResult, OcrPage, OcrBlock
from ocr_core.pipeline.preprocess import preprocess_image
from ocr_core.pipeline.detect import detect_text_boxes
from ocr_core.pipeline.recognize import recognize
from ocr_core.pipeline.postprocess import postprocess_texts

logger = logging.getLogger(__name__)


def _boxes_from_detect_page(page_data: dict) -> list[tuple[int, int, int, int]]:
    """Chuyển detect page (boxes [{x1,y1,x2,y2}]) thành list (x1,y1,x2,y2)."""
    boxes = page_data.get("boxes") or []
    return [(b["x1"], b["y1"], b["x2"], b["y2"]) for b in boxes]


def run_ocr(job_id: str, pages: list[Image.Image]) -> OcrResult:
    logger.info(f"[OCR Pipeline] Bắt đầu: job_id={job_id}, số_trang={len(pages)}")
    ocr_pages = []
    for page_index, img in enumerate(pages):
        t_page = time.perf_counter()
        logger.info(f"[OCR Pipeline] Trang {page_index + 1}/{len(pages)}: bắt đầu xử lý")

        # Preprocess
        t0 = time.perf_counter()
        img = preprocess_image(img)
        w, h = img.size
        logger.info(
            f"[OCR Pipeline]   - Preprocess xong: kích thước {w}x{h} px, "
            f"thời gian={time.perf_counter() - t0:.3f}s"
        )

        # Detect
        t0 = time.perf_counter()
        boxes = detect_text_boxes(img)
        logger.info(
            f"[OCR Pipeline]   - Detect text boxes: phát hiện {len(boxes)} vùng, "
            f"thời gian={time.perf_counter() - t0:.3f}s"
        )

        # Recognize
        t0 = time.perf_counter()
        rec = recognize(img, boxes)
        logger.info(
            f"[OCR Pipeline]   - Recognize: nhận dạng {len(rec)} đoạn, "
            f"thời gian={time.perf_counter() - t0:.3f}s"
        )

        # Postprocess
        t0 = time.perf_counter()
        texts = postprocess_texts([t for t, _ in rec])
        logger.info(
            f"[OCR Pipeline]   - Postprocess: {len(texts)} text đã xử lý, "
            f"thời gian={time.perf_counter() - t0:.3f}s"
        )

        # Đảm bảo số lượng khớp (boxes từ CRAFT, rec/texts từ VietOCR)
        n = min(len(boxes), len(rec), len(texts))
        if n != len(boxes) or n != len(rec):
            logger.warning(
                "[OCR Pipeline] Số boxes/rec/texts không khớp: boxes=%s, rec=%s, texts=%s; dùng n=%s",
                len(boxes), len(rec), len(texts), n,
            )
        blocks = []
        for i in range(n):
            box = boxes[i]
            raw_text, conf = rec[i]
            text = texts[i]
            blocks.append(
                OcrBlock(
                    block_id=f"{page_index}-{i}-{uuid.uuid4().hex[:8]}",
                    box=box,
                    score=1.0,
                    text=text,
                    conf=conf,
                )
            )
        if blocks:
            logger.debug(
                f"[OCR Pipeline]   - Blocks trang {page_index}: "
                f"conf trung bình={sum(b.conf for b in blocks) / len(blocks):.3f}"
            )

        ocr_pages.append(OcrPage(page_index=page_index, width=w, height=h, blocks=blocks))
        elapsed_page = time.perf_counter() - t_page
        logger.info(
            f"[OCR Pipeline] Trang {page_index + 1}/{len(pages)} xong: "
            f"{len(blocks)} blocks, tổng thời gian trang={elapsed_page:.3f}s"
        )

    total_blocks = sum(len(p.blocks) for p in ocr_pages)
    logger.info(
        f"[OCR Pipeline] Kết thúc: job_id={job_id}, {len(ocr_pages)} trang, "
        f"{total_blocks} blocks"
    )
    return OcrResult(job_id=job_id, pages=ocr_pages)


def run_ocr_with_boxes(
    job_id: str,
    pages: list[Image.Image],
    detect_pages: list[dict],
) -> OcrResult:
    """Chạy OCR dùng boxes có sẵn (từ DB, đã chỉnh sửa). Bỏ qua bước Detect."""
    logger.info(
        "[OCR Pipeline] Bắt đầu với boxes có sẵn: job_id=%s, số_trang=%s",
        job_id, len(pages),
    )
    by_index = {p["page_index"]: p for p in detect_pages}
    ocr_pages = []
    for page_index, img in enumerate(pages):
        page_data = by_index.get(page_index, {})
        boxes = _boxes_from_detect_page(page_data)
        img = preprocess_image(img)
        w, h = img.size
        rec = recognize(img, boxes)
        texts = postprocess_texts([t for t, _ in rec])
        n = min(len(boxes), len(rec), len(texts))
        blocks = []
        for i in range(n):
            raw_text, conf = rec[i]
            text = texts[i]
            blocks.append(
                OcrBlock(
                    block_id=f"{page_index}-{i}-{uuid.uuid4().hex[:8]}",
                    box=boxes[i],
                    score=1.0,
                    text=text,
                    conf=conf,
                )
            )
        ocr_pages.append(OcrPage(page_index=page_index, width=w, height=h, blocks=blocks))
    return OcrResult(job_id=job_id, pages=ocr_pages)
