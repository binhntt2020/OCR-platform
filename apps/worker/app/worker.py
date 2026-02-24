from celery import Celery
from celery.signals import worker_init

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@worker_init.connect
def _init_redis_and_bucket(**kwargs):
    # 1) Redis (broker): kiểm tra kết nối
    if settings.celery_broker_url:
        try:
            logger.info("[REDIS] Đang kiểm tra kết nối Redis (broker)...")
            with celery_app.connection_or_acquire() as conn:
                conn.ensure_connection(max_retries=2)
            logger.info("[REDIS] ✅ Kết nối Redis thành công")
        except Exception as e:
            logger.exception("[REDIS] ❌ Không kết nối được Redis (broker): %s", e)
            raise
    else:
        logger.warning("[REDIS] CELERY_BROKER_URL chưa cấu hình")
    # 2) MinIO/S3 bucket (không crash worker nếu S3 chưa cấu hình; task sẽ lỗi khi gọi get/put)
    try:
        if settings.s3_endpoint:
            logger.info("[WORKER] Đang kiểm tra S3 bucket...")
            from app.services.storage_service import ensure_bucket
            ensure_bucket()
            logger.info("[WORKER] ✅ S3 bucket sẵn sàng")
        else:
            logger.warning("[WORKER] S3/MinIO chưa cấu hình (MINIO_ENDPOINT/S3_ENDPOINT); task OCR sẽ lỗi khi đọc/ghi file.")
    except Exception:
        logger.exception("[WORKER] ⚠️ Không đảm bảo được S3 bucket; worker vẫn chạy, task có thể lỗi khi dùng storage.")


celery_app = Celery(
    "ocr_worker",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.tasks.ocr_tasks"],
)
