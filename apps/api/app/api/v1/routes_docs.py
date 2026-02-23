"""Endpoint trả file đã upload (từ MinIO) để frontend xem PDF."""

from fastapi import APIRouter, Header, HTTPException, Depends
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.services.jobs_service import get_job
from app.services.storage_service import get_bytes, storage_configured

logger = get_logger(__name__)
router = APIRouter(prefix="/docs", tags=["docs"])


def _content_type_from_key(key: str) -> str:
    key_lower = key.lower()
    if key_lower.endswith(".pdf"):
        return "application/pdf"
    if key_lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp")):
        return "image/" + key_lower.split(".")[-1].replace("jpg", "jpeg")
    return "application/octet-stream"


@router.get("/{job_id}/file")
async def get_doc_file(
    job_id: str,
    x_tenant_id: str = Header(default="demo"),
    session: AsyncSession = Depends(get_session),
):
    """Lấy file đã upload của job (từ MinIO) để hiển thị trong '2. Xem PDF'."""
    logger.info("[DOCS] get_doc_file: job_id=%s, x_tenant_id=%s", job_id, x_tenant_id)
    if not storage_configured():
        logger.warning("[DOCS] MinIO chưa cấu hình")
        raise HTTPException(
            503,
            "MinIO chưa cấu hình. Đặt MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY trong .env.",
        )
    job = await get_job(session, job_id)
    if not job:
        logger.warning("[DOCS] Job not found: job_id=%s", job_id)
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        logger.warning("[DOCS] Tenant mismatch: job_id=%s, job_tenant=%s, x_tenant_id=%s", job_id, job["tenant_id"], x_tenant_id)
        raise HTTPException(403, "tenant mismatch")
    input_key = job.get("input_object_key")
    if not input_key:
        logger.info("[DOCS] Chưa có file upload cho job: job_id=%s", job_id)
        raise HTTPException(404, "Chưa có file upload cho job này.")
    try:
        logger.debug("[DOCS] Fetching file from storage: key=%s", input_key)
        data = get_bytes(input_key)
    except Exception as e:
        logger.exception("[DOCS] Không đọc được file từ storage: job_id=%s, key=%s", job_id, input_key)
        raise HTTPException(404, f"Không đọc được file từ storage: {e}") from e
    content_type = _content_type_from_key(input_key)
    logger.info("[DOCS] ✅ Trả file: job_id=%s, key=%s, content_type=%s, size=%s", job_id, input_key, content_type, len(data))
    return Response(content=data, media_type=content_type)
