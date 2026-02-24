from __future__ import annotations
from celery import shared_task
from app.services.db_service import get_job, update_job
from app.services.storage_service import get_bytes, put_bytes
from app.core.logging import get_logger
from PIL import Image
import io
import time

from ocr_core.domain.models import OcrResult, OcrPage
from ocr_core.pipeline.orchestrator import run_ocr

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

        logger.info("[OCR] Bước 2/4 - Chạy pipeline OCR (%s trang)", page_count)
        t0 = time.perf_counter()
        all_pages_result = []
        for i, img in enumerate(pages):
            result_page = run_ocr(job_id=job_id, pages=[img])
            p0 = result_page.pages[0]
            all_pages_result.append(
                OcrPage(page_index=i, width=p0.width, height=p0.height, blocks=p0.blocks)
            )
            update_job(
                job_id,
                processed_pages=i + 1,
                progress=int((i + 1) * 100 / page_count),
            )
        elapsed = time.perf_counter() - t0
        total_blocks = sum(len(p.blocks) for p in all_pages_result)
        logger.info(
            "[OCR] Pipeline xong: %s trang, %s blocks, thời gian=%.2fs",
            len(all_pages_result), total_blocks, elapsed,
        )

        result = OcrResult(job_id=job_id, pages=all_pages_result)

        result_key = f"results/{job['tenant_id']}/{job_id}/result.json"
        logger.info("[OCR] Bước 3/4 - Lưu kết quả: key=%s", result_key)
        result_json = result.model_dump_json(indent=2).encode("utf-8")
        put_bytes(result_key, result_json, "application/json")
        logger.info("[OCR] Kết quả đã lưu: size=%s bytes", len(result_json))

        logger.info("[OCR] Bước 4/4 - Cập nhật job: status=DONE, processed_pages=%s", page_count)
        update_job(
            job_id,
            status="DONE",
            result_object_key=result_key,
            error=None,
            processed_pages=page_count,
            progress=100,
        )
        logger.info(
            "[OCR] Job hoàn thành: job_id=%s, result_key=%s, pages=%s, blocks=%s, total_time=%.2fs",
            job_id, result_key, page_count, total_blocks, elapsed,
        )
    except Exception as e:
        logger.exception("[OCR] Job failed: job_id=%s, error=%r", job_id, e)
        update_job(job_id, status="FAILED", error=str(e))
        raise
