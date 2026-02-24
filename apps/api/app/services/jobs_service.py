"""Service job OCR — dùng SQLAlchemy 2.x async (AsyncSession)."""
from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger
from app.db.models import OcrJob

logger = get_logger("app.services.jobs")

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
})


async def create_job(session: AsyncSession, job_id: str, tenant_id: str, status: str) -> None:
    try:
        job = OcrJob(job_id=job_id, tenant_id=tenant_id, status=status)
        session.add(job)
        await session.flush()
        logger.info(
            "Postgres INSERT job: job_id=%s, tenant_id=%s, status=%s (DB: host=%s, db=%s)",
            job_id, tenant_id, status, settings.postgres_host, settings.postgres_db,
        )
    except Exception as e:
        logger.exception("Lỗi ghi Postgres (create_job): %s", e)
        raise


async def update_job(session: AsyncSession, job_id: str, **fields: str | int | None) -> None:
    if not fields:
        return
    allowed = {k: v for k, v in fields.items() if k in ALLOWED_UPDATE_FIELDS}
    if not allowed:
        return
    allowed["updated_at"] = datetime.now(timezone.utc)
    try:
        stmt = update(OcrJob).where(OcrJob.job_id == job_id).values(**allowed)
        await session.execute(stmt)
        await session.flush()
        logger.info(
            "Postgres UPDATE job: job_id=%s, fields=%s (DB: host=%s, db=%s)",
            job_id, list(allowed.keys()), settings.postgres_host, settings.postgres_db,
        )
    except Exception as e:
        logger.exception("Lỗi ghi Postgres (update_job job_id=%s): %s", job_id, e)
        raise


async def get_job(session: AsyncSession, job_id: str) -> dict | None:
    stmt = select(OcrJob).where(OcrJob.job_id == job_id)
    result = await session.execute(stmt)
    job = result.scalars().one_or_none()
    if job is None:
        return None
    return job.to_dict()


async def list_jobs(
    session: AsyncSession,
    tenant_id: str | None = None,
    limit: int = 50,
) -> list[dict]:
    stmt = select(OcrJob).order_by(OcrJob.created_at.desc()).limit(limit)
    if tenant_id:
        stmt = stmt.where(OcrJob.tenant_id == tenant_id)
    result = await session.execute(stmt)
    rows = result.scalars().all()
    return [r.to_dict() for r in rows]
