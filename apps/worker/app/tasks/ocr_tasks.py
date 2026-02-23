from __future__ import annotations
from celery import shared_task
from app.services.db_service import get_job, update_job
from app.services.storage_service import get_bytes, put_bytes
from app.core.logging import get_logger
from PIL import Image
import io

from ocr_core.pipeline.orchestrator import run_ocr

logger = get_logger(__name__)


@shared_task(name="ocr.run_job")
def run_job(job_id: str):
    logger.info(f"[OCR] Run job: job_id={job_id}")
    job = get_job(job_id)
    if not job:
        logger.warning(f"[OCR] Job not found: job_id={job_id}")
        return

    if not job.get("input_object_key"):
        logger.warning(f"[OCR] Missing input_object_key: job_id={job_id}")
        update_job(job_id, status="FAILED", error="missing input_object_key")
        return

    update_job(job_id, status="RUNNING", processed_pages=0, progress=0)
    logger.info(f"[OCR] Job started: job_id={job_id}")

    try:
        logger.debug(f"[OCR] Fetching input: key={job['input_object_key']}")
        raw = get_bytes(job["input_object_key"])

        # MVP: assume input is image.
        # TODO: if PDF -> convert to pages (pdf2image) in preprocess service.
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        result = run_ocr(job_id=job_id, pages=[img])

        result_key = f"results/{job['tenant_id']}/{job_id}/result.json"
        put_bytes(
            result_key,
            result.model_dump_json(indent=2).encode("utf-8"),
            "application/json",
        )
        logger.debug(f"[OCR] Result saved: key={result_key}")

        page_count = job.get("page_count") or 1
        update_job(
            job_id,
            status="DONE",
            result_object_key=result_key,
            error=None,
            processed_pages=page_count,
            progress=100,
        )
        logger.info(f"[OCR] ✅ Job completed: job_id={job_id}, result_key={result_key}")
    except Exception as e:
        logger.exception(f"[OCR] ❌ Job failed: job_id={job_id}, error={e!r}")
        update_job(job_id, status="FAILED", error=str(e))
        raise
