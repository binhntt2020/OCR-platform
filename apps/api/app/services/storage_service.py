import boto3
from app.core.config import settings


def storage_configured() -> bool:
    """True nếu đã cấu hình S3/MinIO (endpoint không rỗng)."""
    return bool(settings.s3_endpoint and settings.s3_endpoint.strip())


def s3_client():
    if not storage_configured():
        raise RuntimeError(
            "MinIO chưa cấu hình. Đặt MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY trong .env."
        )
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )


def ensure_bucket():
    c = s3_client()
    try:
        c.head_bucket(Bucket=settings.s3_bucket)
    except Exception:
        c.create_bucket(Bucket=settings.s3_bucket)


def put_bytes(key: str, data: bytes, content_type: str):
    c = s3_client()
    c.put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type)


def get_bytes(key: str) -> bytes:
    c = s3_client()
    obj = c.get_object(Bucket=settings.s3_bucket, Key=key)
    return obj["Body"].read()
