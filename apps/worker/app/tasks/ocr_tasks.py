"""
OCR tasks: hai bước tách rời.

1) run_job (Detect):
   - Chạy CRAFT detect_text_boxes theo từng trang.
   - Lưu kết quả vào CSDL (detect_result) và MinIO (detect.json).
   - Cập nhật status = DETECT_DONE. Frontend có thể chỉnh sửa boxes rồi PATCH detect_result.

2) run_ocr_job (Recognize theo vùng đã lưu):
   - Đọc detect_result từ CSDL (vùng đã detect, có thể đã chỉnh sửa).
   - Gọi run_ocr_with_boxes → preprocess ảnh, recognize bằng VietOCR, postprocess.
   - Lưu kết quả OCR lên MinIO và cập nhật job DONE.

Luồng: Detect → lưu CSDL → (chỉnh sửa boxes qua API, lưu lại CSDL) → run_ocr_job đọc CSDL → VietOCR theo từng vùng.
"""
from __future__ import annotations
import io
import json
import time
from celery import shared_task
from PIL import Image

from app.core.logging import get_logger
from app.services.db_service import get_job, update_job
from app.services.storage_service import get_bytes, put_bytes

from ocr_core.domain.models import OcrResult, OcrPage
from ocr_core.pipeline.detect import detect_text_boxes
from ocr_core.pipeline.orchestrator import run_ocr, run_ocr_with_boxes

logger = get_logger(__name__)


def _raw_to_pages(raw: bytes, content_type: str | None, filename: str | None) -> list[Image.Image]:
    """Chuyển raw bytes thành danh sách ảnh (1 ảnh nếu image, nhiều ảnh nếu PDF)."""
    is_pdf = (
        (content_type or "").lower() == "application/pdf"
        or (filename or "").lower().endswith(".pdf")
    )
    if is_pdf:
        import fitz
        doc = fitz.open(stream=raw, filetype="pdf")
        pages = []
        try:
            for i in range(len(doc)):
                page = doc[i]
                pix = page.get_pixmap(dpi=150)
                img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                pages.append(img)
            logger.info("[OCR] PDF đã chuyển thành %s trang ảnh", len(pages))
        finally:
            doc.close()
        return pages
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    return [img]


@shared_task(
    name="ocr.run_job",
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
    retry_kwargs={"max_retries": 3},
)
def run_job(job_id: str):
    logger.info("[OCR] Run job: job_id=%s", job_id)
    job = get_job(job_id)
    if not job:
        logger.warning("[OCR] Job not found: job_id=%s", job_id)
        return

    if job.get("status") == "DONE" and job.get("result_object_key"):
        logger.info("[OCR] Job already DONE, skip: job_id=%s", job_id)
        return

    # Đã có DETECT_DONE thì không chạy lại detect (chờ user chỉnh sửa rồi gọi run_ocr_job)
    if job.get("status") == "DETECT_DONE":
        logger.info("[OCR] Job đã DETECT_DONE, bỏ qua run_job. Gọi run_ocr_job khi đã chỉnh sửa boxes.")
        return

    if not job.get("input_object_key"):
        logger.warning("[OCR] Missing input_object_key: job_id=%s", job_id)
        update_job(job_id, status="FAILED", error="missing input_object_key")
        return

    update_job(job_id, status="RUNNING", processed_pages=0, progress=0)
    logger.info("[OCR] Job started: job_id=%s, input_key=%s", job_id, job["input_object_key"])

    try:
        logger.info("[OCR] Bước 1/4 - Lấy input: key=%s", job["input_object_key"])
        raw = get_bytes(job["input_object_key"])
        logger.info("[OCR] Input đã tải: size=%s bytes", len(raw))

        pages = _raw_to_pages(
            raw,
            job.get("content_type"),
            job.get("original_filename"),
        )
        if not pages:
            update_job(job_id, status="FAILED", error="Không đọc được trang nào từ file")
            return

        page_count = len(pages)
        update_job(job_id, page_count=page_count)
        logger.info("[OCR] Đã load %s trang (ảnh/PDF)", page_count)

        # Detect: chạy CRAFT cho từng trang, lưu detect.json để frontend vẽ vùng lên PDF
        detect_pages = []
        for i, img in enumerate(pages):
            boxes = detect_text_boxes(img)
            w, h = img.size
            detect_pages.append({
                "page_index": i,
                "width": w,
                "height": h,
                "boxes": [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for (x1, y1, x2, y2) in boxes],
            })
        detect_key = f"results/{job['tenant_id']}/{job_id}/detect.json"
        detect_payload = {"job_id": job_id, "pages": detect_pages}
        detect_json_str = json.dumps(detect_payload, indent=2)
        put_bytes(detect_key, detect_json_str.encode("utf-8"), "application/json")
        update_job(job_id, detect_result=detect_json_str, status="DETECT_DONE")
        logger.info("[OCR] Đã lưu kết quả Detect vào DB + MinIO: %s trang. Status=DETECT_DONE. Chỉnh sửa boxes (nếu cần) rồi gọi run_ocr_job.", len(detect_pages))
    except Exception as e:
        logger.exception("[OCR] Job failed: job_id=%s, error=%r", job_id, e)
        update_job(job_id, status="FAILED", error=str(e))
        raise


@shared_task(
    name="ocr.run_detect_job",
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
    retry_kwargs={"max_retries": 2},
)
def run_detect_job(job_id: str):
    """Chỉ chạy Detect (CRAFT) lại, ghi đè detect_result. Dùng khi user bấm 'Chạy lại Detect'."""
    logger.info("[OCR] Run detect job: job_id=%s", job_id)
    job = get_job(job_id)
    if not job:
        logger.warning("[OCR] Job not found: job_id=%s", job_id)
        return
    if not job.get("input_object_key"):
        logger.warning("[OCR] Missing input_object_key: job_id=%s", job_id)
        update_job(job_id, status="FAILED", error="missing input_object_key")
        return
    update_job(job_id, status="RUNNING", processed_pages=0, progress=0)
    try:
        raw = get_bytes(job["input_object_key"])
        pages = _raw_to_pages(
            raw,
            job.get("content_type"),
            job.get("original_filename"),
        )
        if not pages:
            update_job(job_id, status="FAILED", error="Không đọc được trang nào từ file")
            return
        page_count = len(pages)
        update_job(job_id, page_count=page_count)
        detect_pages = []
        for i, img in enumerate(pages):
            boxes = detect_text_boxes(img)
            w, h = img.size
            detect_pages.append({
                "page_index": i,
                "width": w,
                "height": h,
                "boxes": [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for (x1, y1, x2, y2) in boxes],
            })
        detect_key = f"results/{job['tenant_id']}/{job_id}/detect.json"
        detect_payload = {"job_id": job_id, "pages": detect_pages}
        detect_json_str = json.dumps(detect_payload, indent=2)
        put_bytes(detect_key, detect_json_str.encode("utf-8"), "application/json")
        update_job(job_id, detect_result=detect_json_str, status="DETECT_DONE")
        logger.info("[OCR] Chạy lại Detect xong: job_id=%s, %s trang.", job_id, len(detect_pages))
    except Exception as e:
        logger.exception("[OCR] Run detect failed: job_id=%s, error=%r", job_id, e)
        update_job(job_id, status="FAILED", error=str(e))
        raise


@shared_task(
    name="ocr.run_ocr_job",
    autoretry_for=(Exception,),
    retry_backoff=True,
    retry_backoff_max=600,
    retry_kwargs={"max_retries": 2},
)
def run_ocr_job(job_id: str):
    """Chạy OCR (recognize) theo vùng đã detect lưu trong CSDL: đọc detect_result từ DB, recognize bằng VietOCR (run_ocr_with_boxes), lưu result."""
    logger.info("[OCR] Run OCR job: job_id=%s", job_id)
    job = get_job(job_id)
    if not job:
        logger.warning("[OCR] Job not found: job_id=%s", job_id)
        return
    detect_json = job.get("detect_result")
    if not detect_json:
        logger.warning("[OCR] Job chưa có detect_result (chưa chạy Detect). job_id=%s", job_id)
        update_job(job_id, status="FAILED", error="Chưa có kết quả Detect. Chạy job trước để tạo detect_result.")
        return
    try:
        detect_payload = json.loads(detect_json)
    except json.JSONDecodeError as e:
        update_job(job_id, status="FAILED", error=f"detect_result không hợp lệ: {e}")
        return
    detect_pages = detect_payload.get("pages") or []
    if not detect_pages:
        update_job(job_id, status="FAILED", error="detect_result không có trang nào.")
        return

    if not job.get("input_object_key"):
        update_job(job_id, status="FAILED", error="missing input_object_key")
        return

    update_job(job_id, status="RUNNING", processed_pages=0, progress=0)
    try:
        raw = get_bytes(job["input_object_key"])
        pages = _raw_to_pages(
            raw,
            job.get("content_type"),
            job.get("original_filename"),
        )
        if not pages:
            update_job(job_id, status="FAILED", error="Không đọc được trang nào từ file")
            return
        page_count = len(pages)
        t0 = time.perf_counter()
        # VietOCR: recognize từng vùng (boxes từ detect_result trong CSDL)
        result = run_ocr_with_boxes(job_id, pages, detect_pages)
        elapsed = time.perf_counter() - t0
        total_blocks = sum(len(p.blocks) for p in result.pages)
        result_key = f"results/{job['tenant_id']}/{job_id}/result.json"
        result_json_str = result.model_dump_json(indent=2)
        put_bytes(result_key, result_json_str.encode("utf-8"), "application/json")
        update_job(
            job_id,
            status="DONE",
            result_object_key=result_key,
            result=result_json_str,
            error=None,
            processed_pages=page_count,
            progress=100,
        )
        logger.info(
            "[OCR] OCR job hoàn thành: job_id=%s, pages=%s, blocks=%s, time=%.2fs",
            job_id, page_count, total_blocks, elapsed,
        )
    except Exception as e:
        logger.exception("[OCR] OCR job failed: job_id=%s, error=%r", job_id, e)
        update_job(job_id, status="FAILED", error=str(e))
        raise
