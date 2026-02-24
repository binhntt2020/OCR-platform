from pathlib import Path

from pydantic import BaseModel
import os

# Load infra/.env khi chạy worker (apps/worker/app/core/config.py -> repo root = 4 levels up)
_repo_root = Path(__file__).resolve().parent.parent.parent.parent.parent
_infra_env = _repo_root / "infra" / ".env"
if _infra_env.exists():
    from dotenv import load_dotenv
    load_dotenv(_infra_env)


def _database_url() -> str:
    """Ưu tiên DATABASE_URL; không có thì lắp từ POSTGRES_* (sync với API)."""
    url = os.getenv("DATABASE_URL", "").strip()
    if url:
        return url
    host = os.getenv("POSTGRES_HOST", "localhost")
    port = os.getenv("POSTGRES_PORT", "5432")
    user = os.getenv("POSTGRES_USER", "ocr")
    password = os.getenv("POSTGRES_PASSWORD", "ocr")
    db = os.getenv("POSTGRES_DB", "ocr")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _s3_endpoint() -> str:
    """S3/MinIO endpoint: ưu tiên S3_ENDPOINT, fallback MINIO_ENDPOINT + MINIO_SECURE."""
    ep = os.getenv("S3_ENDPOINT")
    if ep:
        return ep
    minio_ep = os.getenv("MINIO_ENDPOINT", "")
    if not minio_ep:
        return ""
    scheme = "https" if os.getenv("MINIO_SECURE", "false").lower() in ("true", "1") else "http"
    return f"{scheme}://{minio_ep}"


class Settings(BaseModel):
    database_url: str = os.getenv("DATABASE_URL", "").strip() or _database_url()
    s3_endpoint: str = os.getenv("S3_ENDPOINT") or _s3_endpoint()
    s3_access_key: str = os.getenv("S3_ACCESS_KEY") or os.getenv("MINIO_ACCESS_KEY", "")
    s3_secret_key: str = os.getenv("S3_SECRET_KEY") or os.getenv("MINIO_SECRET_KEY", "")
    s3_bucket: str = os.getenv("S3_BUCKET") or os.getenv("MINIO_OCR_BUCKET", "ocr")
    celery_broker_url: str = os.getenv("CELERY_BROKER_URL", "")
    celery_result_backend: str = os.getenv("CELERY_RESULT_BACKEND", "")


settings = Settings()
