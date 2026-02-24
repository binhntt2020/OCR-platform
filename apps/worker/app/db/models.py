"""ORM models — bảng ocr_jobs. Giữ đồng bộ với apps/api/app/db/models.py."""
from datetime import datetime
from sqlalchemy import BigInteger, DateTime, Integer, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OcrJob(Base):
    """Bảng ocr_jobs: job_id, tenant_id, status, metadata file, page/progress, error."""
    __tablename__ = "ocr_jobs"

    job_id: Mapped[str] = mapped_column(String, primary_key=True)
    tenant_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, nullable=False, index=True)
    input_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    result_object_key: Mapped[str | None] = mapped_column(Text, nullable=True)
    original_filename: Mapped[str | None] = mapped_column(Text, nullable=True)
    content_type: Mapped[str | None] = mapped_column(Text, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    checksum: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    processed_pages: Mapped[int | None] = mapped_column(Integer, default=0, nullable=True)
    progress: Mapped[int | None] = mapped_column(Integer, default=0, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

    def to_dict(self) -> dict:
        return {
            "job_id": self.job_id,
            "tenant_id": self.tenant_id,
            "status": self.status,
            "input_object_key": self.input_object_key,
            "result_object_key": self.result_object_key,
            "original_filename": self.original_filename,
            "content_type": self.content_type,
            "size_bytes": self.size_bytes,
            "checksum": self.checksum,
            "page_count": self.page_count,
            "processed_pages": self.processed_pages,
            "progress": self.progress,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }
