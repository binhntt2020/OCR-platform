from celery import Celery
from celery.signals import worker_init

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


@worker_init.connect
def _ensure_bucket_on_start(**kwargs):
    try:
        logger.info("[WORKER] Initializing worker: ensuring S3 bucket...")
        from app.services.storage_service import ensure_bucket
        ensure_bucket()
        logger.info("[WORKER] ✅ S3 bucket ready")
    except Exception:
        logger.exception("[WORKER] ❌ Failed to ensure S3 bucket")
        raise


celery_app = Celery(
    "ocr_worker",
    broker=settings.celery_broker_url,
    backend=settings.celery_result_backend,
    include=["app.tasks.ocr_tasks"],
)
