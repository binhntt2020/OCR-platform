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
