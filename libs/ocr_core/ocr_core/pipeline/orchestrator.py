"""
Pipeline OCR: Preprocess → CRAFT (detect) → VietOCR (recognize) → Postprocess.

- CRAFT chỉ phát hiện vùng (box); user có thể chỉnh sửa/gộp vùng rồi lưu vào cột detect_result (DB).
- run_ocr_with_boxes: đọc boxes từ detect_result (DB), Recognize bằng VietOCR. Vùng cao (nhiều dòng)
  được VietOCR engine tách thành từng dòng rồi ghép kết quả để nội dung khớp PDF.
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


def _box_from_detect_box(b: dict) -> tuple[int, int, int, int]:
    """Lấy (x1,y1,x2,y2) từ một phần tử boxes trong detect_result (DB)."""
    return (int(b["x1"]), int(b["y1"]), int(b["x2"]), int(b["y2"]))


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
    """Chạy OCR theo vùng đã detect lưu trong CSDL: boxes lấy từ cột detect_result (DB).
    Tọa độ trong blocks.box luôn lấy nguyên từ detect_result để khớp với PDF.
    Nếu ảnh bị preprocess (resize) thì chỉ scale box khi crop cho VietOCR, không đổi giá trị lưu.
    """
    logger.info(
        "[OCR Pipeline] Bắt đầu với boxes có sẵn: job_id=%s, số_trang=%s",
        job_id, len(pages),
    )
    by_index = {p["page_index"]: p for p in detect_pages}
    ocr_pages = []
    for page_index, img in enumerate(pages):
        page_data = by_index.get(page_index, {})
        raw_boxes = page_data.get("boxes") or []
        if not raw_boxes:
            w_orig = page_data.get("width") or img.size[0]
            h_orig = page_data.get("height") or img.size[1]
            ocr_pages.append(OcrPage(page_index=page_index, width=w_orig, height=h_orig, blocks=[]))
            continue
        # Box gốc từ DB (detect_result) — dùng để lưu vào block (khớp PDF)
        boxes_orig = [_box_from_detect_box(b) for b in raw_boxes]
        img_prep = preprocess_image(img)
        w_prep, h_prep = img_prep.size
        w_orig = page_data.get("width") or img.size[0]
        h_orig = page_data.get("height") or img.size[1]
        scale_x = w_prep / w_orig if w_orig else 1.0
        scale_y = h_prep / h_orig if h_orig else 1.0
        boxes_for_crop = []
        original_heights = []
        for (x1, y1, x2, y2) in boxes_orig:
            x1_s = int(x1 * scale_x)
            y1_s = int(y1 * scale_y)
            x2_s = int(x2 * scale_x)
            y2_s = int(y2 * scale_y)
            boxes_for_crop.append((x1_s, y1_s, x2_s, y2_s))
            original_heights.append(y2 - y1)
        rec = recognize(img_prep, boxes_for_crop, original_heights=original_heights)
        texts = postprocess_texts([t for t, _ in rec])
        n = min(len(boxes_orig), len(rec), len(texts))
        blocks = []
        for i in range(n):
            raw_text, conf = rec[i]
            text = texts[i]
            box_for_output = boxes_orig[i]
            blocks.append(
                OcrBlock(
                    block_id=f"{page_index}-{i}-{uuid.uuid4().hex[:8]}",
                    box=box_for_output,
                    score=1.0,
                    text=text,
                    conf=conf,
                )
            )
        ocr_pages.append(OcrPage(page_index=page_index, width=w_orig, height=h_orig, blocks=blocks))
    return OcrResult(job_id=job_id, pages=ocr_pages)
