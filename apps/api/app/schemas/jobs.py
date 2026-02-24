from pydantic import BaseModel
from typing import Optional


class CreateJobResponse(BaseModel):
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    input_object_key: Optional[str] = None  # path/key file đã upload (MinIO)
    result_object_key: Optional[str] = None
    original_filename: Optional[str] = None
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    checksum: Optional[str] = None
    page_count: Optional[int] = None
    processed_pages: Optional[int] = None
    progress: Optional[int] = None
    error: Optional[str] = None
    detect_result: Optional[str] = None  # JSON kết quả Detect (CRAFT), có thể chỉnh sửa trước khi chạy OCR
    result: Optional[str] = None  # JSON kết quả OCR (pages, blocks, text, box, conf)
