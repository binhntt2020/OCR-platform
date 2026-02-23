import psycopg
from app.core.config import settings
from app.core.logging import get_logger
from datetime import datetime, timezone

logger = get_logger(__name__)


def db_conn():
    return psycopg.connect(settings.database_url)


def get_job(job_id: str):
    logger.debug(f"[DB] get_job: job_id={job_id}")
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """SELECT job_id, tenant_id, status, input_object_key, result_object_key,
                   original_filename, content_type, size_bytes, checksum,
                   page_count, processed_pages, progress, error, created_at, updated_at
                   FROM ocr_jobs WHERE job_id=%s""",
                (job_id,),
            )
            row = cur.fetchone()
            if not row:
                logger.debug(f"[DB] Job not found: job_id={job_id}")
                return None
            keys = [
                "job_id",
                "tenant_id",
                "status",
                "input_object_key",
                "result_object_key",
                "original_filename",
                "content_type",
                "size_bytes",
                "checksum",
                "page_count",
                "processed_pages",
                "progress",
                "error",
                "created_at",
                "updated_at",
            ]
            return dict(zip(keys, row))


ALLOWED_UPDATE_FIELDS = frozenset(
    {
        "status",
        "input_object_key",
        "result_object_key",
        "original_filename",
        "content_type",
        "size_bytes",
        "checksum",
        "page_count",
        "processed_pages",
        "progress",
        "error",
    }
)


def update_job(job_id: str, **fields):
    if not fields:
        return
    allowed = {k: v for k, v in fields.items() if k in ALLOWED_UPDATE_FIELDS}
    if not allowed:
        return
    logger.debug(f"[DB] update_job: job_id={job_id}, fields={list(allowed.keys())}")
    sets = []
    vals = []
    for k, v in allowed.items():
        sets.append(f"{k}=%s")
        vals.append(v)
    sets.append("updated_at=%s")
    vals.append(datetime.now(timezone.utc))
    vals.append(job_id)
    q = "UPDATE ocr_jobs SET " + ", ".join(sets) + " WHERE job_id=%s"
    with db_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(q, vals)
