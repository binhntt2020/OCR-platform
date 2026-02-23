import boto3
from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def s3_client():
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
    )


def ensure_bucket():
    logger.info(f"[STORAGE] Ensuring bucket exists: {settings.s3_bucket}")
    c = s3_client()
    try:
        c.head_bucket(Bucket=settings.s3_bucket)
        logger.info(f"[STORAGE] ✅ Bucket already exists: {settings.s3_bucket}")
    except Exception:
        c.create_bucket(Bucket=settings.s3_bucket)
        logger.info(f"[STORAGE] ✅ Bucket created: {settings.s3_bucket}")


def put_bytes(key: str, data: bytes, content_type: str):
    logger.debug(f"[STORAGE] put_bytes: key={key}, size={len(data)}")
    c = s3_client()
    c.put_object(Bucket=settings.s3_bucket, Key=key, Body=data, ContentType=content_type)


def get_bytes(key: str) -> bytes:
    logger.debug(f"[STORAGE] get_bytes: key={key}")
    c = s3_client()
    obj = c.get_object(Bucket=settings.s3_bucket, Key=key)
    return obj["Body"].read()
