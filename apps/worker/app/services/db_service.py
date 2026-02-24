"""Service job OCR — dùng SQLAlchemy 2.x sync (Session). Thống nhất với API (jobs_service)."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import select, update

from app.core.logging import get_logger
from app.db.models import OcrJob
from app.db.session import get_session

logger = get_logger(__name__)

ALLOWED_UPDATE_FIELDS = frozenset({
    "status",
    "input_object_key",
    "result_object_key",
    "original_filename",
    "content_type",
    "size_bytes",
    "checksum",
    "page_count",
    "processed_pages",
    "progress",
    "error",
    "detect_result",
    "result",
})


def get_job(job_id: str) -> dict | None:
    """Lấy job theo job_id. Trả về dict hoặc None."""
    logger.debug("[DB] get_job: job_id=%s", job_id)
    with get_session() as session:
        stmt = select(OcrJob).where(OcrJob.job_id == job_id)
        result = session.execute(stmt)
        job = result.scalars().one_or_none()
        if job is None:
            logger.debug("[DB] Job not found: job_id=%s", job_id)
            return None
        return job.to_dict()


def update_job(job_id: str, **fields: str | int | None) -> None:
    """Cập nhật job. Chỉ cho phép các field trong ALLOWED_UPDATE_FIELDS."""
    if not fields:
        return
    allowed = {k: v for k, v in fields.items() if k in ALLOWED_UPDATE_FIELDS}
    if not allowed:
        return
    allowed["updated_at"] = datetime.now(timezone.utc)
    logger.debug("[DB] update_job: job_id=%s, fields=%s", job_id, list(allowed.keys()))
    with get_session() as session:
        stmt = update(OcrJob).where(OcrJob.job_id == job_id).values(**allowed)
        session.execute(stmt)
