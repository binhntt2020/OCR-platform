from pydantic import BaseModel
import os


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
    database_url: str = os.getenv("DATABASE_URL", "")
    s3_endpoint: str = os.getenv("S3_ENDPOINT") or _s3_endpoint()
    s3_access_key: str = os.getenv("S3_ACCESS_KEY") or os.getenv("MINIO_ACCESS_KEY", "")
    s3_secret_key: str = os.getenv("S3_SECRET_KEY") or os.getenv("MINIO_SECRET_KEY", "")
    s3_bucket: str = os.getenv("S3_BUCKET") or os.getenv("MINIO_OCR_BUCKET", "ocr")
    celery_broker_url: str = os.getenv("CELERY_BROKER_URL", "")
    celery_result_backend: str = os.getenv("CELERY_RESULT_BACKEND", "")


settings = Settings()
