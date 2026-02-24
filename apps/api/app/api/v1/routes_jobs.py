import hashlib
import io
import json
import uuid
from fastapi import APIRouter, UploadFile, File, Header, HTTPException, Depends
from fastapi.responses import Response
from pypdf import PdfReader
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.db.session import get_session
from app.schemas.jobs import CreateJobResponse, JobStatusResponse
from app.services.jobs_service import create_job, update_job, get_job, list_jobs
from app.services.storage_service import get_bytes, put_bytes, storage_configured

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
        logger.info(
            "Đã gửi task OCR tới worker: job_id=%s (log OCR sẽ ghi ở worker: logs/worker_YYYY-MM-DD.log)",
            job_id,
        )
    except Exception as e:
        logger.warning(
            "Redis/Celery lỗi, không gửi được task OCR. Job và file đã lưu vào Postgres và MinIO. Lỗi: %s",
            e,
        )
        worker_queued = False
        await update_job(session, job_id, status="QUEUED_NO_WORKER")

    return {
        "job_id": job_id,
        "status": "QUEUED" if worker_queued else "QUEUED_NO_WORKER",
        "input_object_key": key,
        "original_filename": file.filename or "",
        "content_type": content_type,
        "size_bytes": size_bytes,
        "checksum": checksum,
        "page_count": page_count,
        "worker_queued": worker_queued,
    }


@router.post("/jobs/{job_id}/requeue")
async def requeue_job(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Đưa job lại vào hàng đợi (khi trước đó worker_queued=false hoặc cần chạy lại)."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if not job.get("input_object_key"):
        raise HTTPException(400, "Job chưa có file upload, không thể requeue.")
    requeued = False
    try:
        from app.core.deps import celery_app
        celery_app.send_task("ocr.run_job", args=[job_id])
        requeued = True
        await update_job(session, job_id, status="QUEUED", error=None)
        logger.info("[OCR] Requeue job: job_id=%s", job_id)
    except Exception as e:
        logger.warning("Redis/Celery lỗi, không gửi được task: %s", e)
    return {"job_id": job_id, "status": "QUEUED", "requeued": requeued}


@router.post("/jobs/{job_id}/rerun")
async def rerun_job(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Chạy lại: reset job (xóa result) và đưa vào hàng đợi để worker chạy lại Detect. Commit trước khi gửi task để worker thấy status mới."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if not job.get("input_object_key"):
        raise HTTPException(400, "Job chưa có file upload, không thể chạy lại.")
    await update_job(
        session, job_id,
        status="QUEUED",
        error=None,
        result_object_key=None,
        result=None,
    )
    await session.commit()
    worker_queued = False
    try:
        from app.core.deps import celery_app
        celery_app.send_task("ocr.run_job", args=[job_id])
        worker_queued = True
        logger.info("[OCR] Rerun job: job_id=%s (đã reset result, worker sẽ chạy lại Detect)", job_id)
    except Exception as e:
        logger.warning("Redis/Celery lỗi, không gửi được task: %s", e)
    return {"job_id": job_id, "status": "QUEUED", "worker_queued": worker_queued}


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
        detect_result=job.get("detect_result"),
        result=job.get("result"),
    )


@router.get("/jobs/{job_id}/detect")
async def job_detect_result(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Trả về kết quả Detect (CRAFT boxes) — ưu tiên từ DB, fallback MinIO."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if job.get("detect_result"):
        return Response(content=job["detect_result"], media_type="application/json")
    if storage_configured():
        detect_key = f"results/{job['tenant_id']}/{job_id}/detect.json"
        try:
            data = get_bytes(detect_key)
            return Response(content=data, media_type="application/json")
        except Exception as e:
            logger.debug("[OCR] Detect từ MinIO thất bại: job_id=%s, %s", job_id, e)
    raise HTTPException(404, "Kết quả Detect chưa sẵn sàng.")

@router.patch("/jobs/{job_id}/detect")
async def update_job_detect(
    job_id: str,
    body: dict,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Cập nhật kết quả Detect (chỉnh sửa boxes) trước khi chạy OCR. Body: { "job_id", "pages": [ { "page_index", "width", "height", "boxes": [...] } ] }."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    try:
        detect_str = json.dumps(body, ensure_ascii=False)
    except (TypeError, ValueError) as e:
        raise HTTPException(400, f"Body không hợp lệ: {e}") from e
    await update_job(session, job_id, detect_result=detect_str)
    await session.commit()
    return {"job_id": job_id, "updated": True}


@router.patch("/jobs/{job_id}/result")
async def update_job_result(
    job_id: str,
    body: dict,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Cập nhật kết quả OCR (JSON) trong DB. Body: { "result": "<json string>" }."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    result = body.get("result")
    if result is not None and not isinstance(result, str):
        raise HTTPException(400, "result phải là chuỗi JSON")
    await update_job(session, job_id, result=result)
    await session.commit()
    return {"job_id": job_id, "updated": True}


@router.post("/jobs/{job_id}/run-ocr")
async def trigger_run_ocr(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Gửi task OCR (recognize) dùng detect_result trong DB. Gọi sau khi đã chỉnh sửa boxes (nếu cần)."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if not job.get("detect_result"):
        raise HTTPException(400, "Chưa có kết quả Detect. Chạy job trước (upload xong worker sẽ chạy Detect).")
    worker_queued = False
    try:
        from app.core.deps import celery_app
        celery_app.send_task("ocr.run_ocr_job", args=[job_id])
        worker_queued = True
        await update_job(session, job_id, status="QUEUED_OCR")
        await session.commit()
    except Exception as e:
        logger.warning("Redis/Celery lỗi: %s", e)
    return {"job_id": job_id, "worker_queued": worker_queued}


@router.post("/jobs/{job_id}/run-detect")
async def trigger_run_detect(
    job_id: str,
    x_tenant_id: str = Header(default="default"),
    session: AsyncSession = Depends(get_session),
):
    """Gửi task chỉ chạy lại Detect (CRAFT), ghi đè detect_result."""
    job = await get_job(session, job_id)
    if not job:
        raise HTTPException(404, "job not found")
    if job["tenant_id"] != x_tenant_id:
        raise HTTPException(403, "tenant mismatch")
    if not job.get("input_object_key"):
        raise HTTPException(400, "Chưa có file input. Upload file trước.")
    worker_queued = False
    try:
        from app.core.deps import celery_app
        celery_app.send_task("ocr.run_detect_job", args=[job_id])
        worker_queued = True
        await update_job(session, job_id, status="QUEUED_DETECT")
        await session.commit()
    except Exception as e:
        logger.warning("Redis/Celery lỗi: %s", e)
    return {"job_id": job_id, "worker_queued": worker_queued}
