from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text
from app.api.v1.routes_docs import router as docs_router
from app.api.v1.routes_jobs import router as jobs_router
from app.core.config import settings
from app.core.logging import setup_logging, get_logger
from app.db.base import Base
from app.db import models  # noqa: F401  # đăng ký model với Base.metadata
from app.db.session import async_engine, async_session_factory
from app.services.storage_service import ensure_bucket

setup_logging()


def _mask_broker_url(url: str) -> str:
    """Ẩn mật khẩu trong URL khi log."""
    if not url or "@" not in url:
        return url.split("/")[0] if url else ""
    try:
        before_at = url.split("@", 1)[0]
        after_at = url.split("@", 1)[1].split("/")[0]
        return f"...@{after_at}"
    except Exception:
        return "..."


@asynccontextmanager
async def lifespan(app: FastAPI):
    log = get_logger("app")
    try:
        async with async_session_factory() as session:
            await session.execute(text("SELECT 1"))
        log.info("[DB] Kết nối Postgres thành công (host=%s, db=%s)", settings.postgres_host, settings.postgres_db)
    except Exception as e:
        log.exception("[DB] Lỗi kết nối Postgres khi khởi động (host=%s, db=%s): %s", settings.postgres_host, settings.postgres_db, e)
        raise
    try:
        log.info("[DB] Kiểm tra / tạo bảng (create_all)...")
        async with async_engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        log.info("[DB] ✅ Bảng đã sẵn sàng (ocr_jobs)")
    except Exception as e:
        log.exception("[DB] Lỗi tạo bảng khi khởi động: %s", e)
        raise
    if settings.s3_endpoint:
        ensure_bucket()
    # Redis (Celery broker): kiểm tra kết nối để đảm bảo gửi task được
    if settings.celery_broker_url:
        try:
            log.info("[REDIS] Đang kiểm tra kết nối Redis (broker)...")
            from app.core.deps import celery_app
            with celery_app.connection_or_acquire() as conn:
                conn.ensure_connection(max_retries=1)
            log.info("[REDIS] ✅ Kết nối Redis thành công (broker=%s)", _mask_broker_url(settings.celery_broker_url))
        except Exception as e:
            log.exception("[REDIS] ❌ Không kết nối được Redis (broker). Gửi task OCR sẽ thất bại: %s", e)
            # Không raise để API vẫn chạy (upload/minio vẫn dùng được)
    else:
        log.warning("[REDIS] CELERY_BROKER_URL chưa cấu hình. Sẽ không gửi được task OCR.")
    yield
    await async_engine.dispose()


app = FastAPI(title="OCR Platform API", lifespan=lifespan)

# CORS: cho phép frontend (vd. Angular localhost:4200) gọi API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(jobs_router)
app.include_router(docs_router)


@app.get("/health")
def health():
    return {"ok": True}
