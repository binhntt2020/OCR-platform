-- Thêm cột detect_result vào bảng ocr_jobs (kết quả Detect CRAFT, JSON, có thể chỉnh sửa trước khi chạy OCR).
-- Chạy một lần khi nâng cấp: psql -f add_ocr_jobs_detect_result.sql hoặc thực thi trong DB.

ALTER TABLE ocr_jobs
ADD COLUMN IF NOT EXISTS detect_result TEXT NULL;

COMMENT ON COLUMN ocr_jobs.detect_result IS 'JSON: { "job_id", "pages": [ { "page_index", "width", "height", "boxes": [ { "x1", "y1", "x2", "y2" } ] } ] }';
