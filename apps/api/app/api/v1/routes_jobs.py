import hashlib
import io
import uuid
from fastapi import APIRouter, UploadFile, File, Header, HTTPException, Depends
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.schemas.jobs import CreateJobResponse, JobStatusResponse
from app.services.jobs_service import create_job, update_job, get_job, list_jobs
from app.services.storage_service import put_bytes, storage_configured

logger = get_logger("app.api.jobs")

router = APIRouter(prefix="/v1/ocr", tags=["ocr"])


@router.get("/jobs")
async def list_ocr_jobs(
    session: AsyncSession = Depends(get_session),
    x_tenant_id: str | None = Header(default=None),
    limit: int = 50,
):
    """Danh sách job (để kiểm tra dữ liệu đã ghi trong Postgres)."""
    jobs = await list_jobs(session, tenant_id=x_tenant_id, limit=limit)
    return {"jobs": jobs, "count": len(jobs)}


@router.post("/jobs", response_model=CreateJobResponse)
async def create_ocr_job(
    session: AsyncSession = Depends(get_session),
    x_tenant_id: str = Header(default="default"),
):
    job_id = uuid.uuid4().hex  # Tự sinh ID duy nhất cho job
    await create_job(session, job_id=job_id, tenant_id=x_tenant_id, status="PENDING_UPLOAD")
    return CreateJobResponse(job_id=job_id, status="PENDING_UPLOAD")


@router.post("/jobs/{job_id}/upload")
async def upload_file(
    job_id: str,
    file: UploadFile = File(...),
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if not storage_configured():
        raise HTTPException(
            503,
            "MinIO chưa cấu hình. Đặt MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY trong .env.",
        )

    data = await file.read()
    key = f"inputs/{x_tenant_id}/{job_id}/{file.filename}"
    content_type = file.content_type or "application/octet-stream"
    put_bytes(key, data, content_type)

    size_bytes = len(data)
    checksum = hashlib.sha256(data).hexdigest()
    page_count = None
    if content_type == "application/pdf" or (file.filename or "").lower().endswith(".pdf"):
        try:
            reader = PdfReader(io.BytesIO(data))
            page_count = len(reader.pages)
        except Exception:
            pass

    await update_job(
        session,
        job_id,
        status="UPLOADED",
        input_object_key=key,
        original_filename=file.filename or "",
        content_type=content_type,
        size_bytes=size_bytes,
        checksum=checksum,
        page_count=page_count,
    )
    await update_job(session, job_id, status="QUEUED")
    logger.info("Đã lưu job vào Postgres và file vào MinIO: job_id=%s, file=%s", job_id, file.filename)

    # Gửi task Celery (Redis lỗi vẫn trả 200 — job và file đã lưu Postgres/MinIO)
    worker_queued = True
    try:
        from app.core.deps import celery_app
        celery_app.send_task("ocr.run_job", args=[job_id])
    except Exception as e:
        logger.warning(
            "Redis/Celery lỗi, không gửi được task OCR. Job và file đã lưu vào Postgres và MinIO. Lỗi: %s",
            e,
        )
        worker_queued = False

    return {
        "job_id": job_id,
        "status": "QUEUED",
        "input_object_key": key,
        "original_filename": file.filename or "",
        "content_type": content_type,
        "size_bytes": size_bytes,
        "checksum": checksum,
        "page_count": page_count,
        "worker_queued": worker_queued,
    }


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def job_status(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        input_object_key=job.get("input_object_key"),
        result_object_key=job.get("result_object_key"),
        original_filename=job.get("original_filename"),
        content_type=job.get("content_type"),
        size_bytes=job.get("size_bytes"),
        checksum=job.get("checksum"),
        page_count=job.get("page_count"),
        processed_pages=job.get("processed_pages"),
        progress=job.get("progress"),
        error=job.get("error"),
    )
