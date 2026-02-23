from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel
import os

# Khi chạy local từ apps/api, load infra/.env nếu có (để có MINIO_*, POSTGRES_*)
# config.py -> core -> app -> api -> apps -> repo_root
_repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
_infra_env = _repo_root / "infra" / ".env"
if _infra_env.exists():
    load_dotenv(_infra_env)


def _database_url() -> str:
    """Ưu tiên DATABASE_URL; không có thì lắp từ POSTGRES_*."""
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        return url
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    user = os.getenv("POSTGRES_USER", "ocr")
    password = os.getenv("POSTGRES_PASSWORD", "ocr")
    db = os.getenv("POSTGRES_DB", "ocr")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _database_url_async() -> str:
    """URL async cho SQLAlchemy: postgresql -> postgresql+asyncpg, mysql -> mysql+aiomysql, v.v."""
    url = os.getenv("DATABASE_URL_ASYNC", "").strip()
    if url:
        return url
    sync_url = os.getenv("DATABASE_URL") or _database_url()
    if sync_url.startswith("postgresql://") or sync_url.startswith("postgresql+psycopg"):
        return sync_url.replace("postgresql://", "postgresql+asyncpg://", 1).replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
    if sync_url.startswith("mysql://"):
        return sync_url.replace("mysql://", "mysql+aiomysql://", 1)
    if sync_url.startswith("sqlite:"):
        return sync_url.replace("sqlite:", "sqlite+aiosqlite:", 1)
    return sync_url


def _s3_endpoint() -> str:
    """MinIO endpoint từ MINIO_ENDPOINT + MINIO_SECURE."""
    minio_ep = os.getenv("MINIO_ENDPOINT", "").strip()
    if not minio_ep:
        return ""
    scheme = "https" if os.getenv("MINIO_SECURE", "false").lower() in ("true", "1") else "http"
    return f"{scheme}://{minio_ep}"


def _postgres_host_db() -> tuple[str, str]:
    """(host, db) để ghi log, không chứa mật khẩu."""
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        from urllib.parse import urlparse
        p = urlparse(url)
        return (p.hostname or "?", p.path.lstrip("/") or "?")
    return (os.getenv("POSTGRES_HOST", "localhost"), os.getenv("POSTGRES_DB", "ocr"))


class Settings(BaseModel):
    database_url: str = os.getenv("DATABASE_URL") or _database_url()
    database_url_async: str = _database_url_async()
    postgres_host: str = _postgres_host_db()[0]
    postgres_db: str = _postgres_host_db()[1]
    s3_endpoint: str = _s3_endpoint()
    s3_access_key: str = os.getenv("MINIO_ACCESS_KEY", "")
    s3_secret_key: str = os.getenv("MINIO_SECRET_KEY", "")
    s3_bucket: str = os.getenv("MINIO_OCR_BUCKET", "ocr")
    celery_broker_url: str = os.getenv("CELERY_BROKER_URL", "")
    celery_result_backend: str = os.getenv("CELERY_RESULT_BACKEND", "")
    log_level: str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_file: str | None = (
        os.getenv("LOG_FILE", "").strip()
        or str(_repo_root / "logs" / "api.log")
    )


settings = Settings()
