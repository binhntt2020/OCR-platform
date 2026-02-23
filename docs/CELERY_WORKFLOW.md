# Luồng sau khi upload lên MinIO — CELERY_BROKER_URL

## Sau khi upload vào MinIO rồi, bước tiếp theo là gì?

Sau khi file đã được lưu vào **MinIO** và job được ghi vào **Postgres** (trạng thái `QUEUED`), API sẽ **gửi task vào hàng đợi Celery** (qua **CELERY_BROKER_URL**, thường là Redis). Bước tiếp theo liên quan tới `CELERY_BROKER_URL` là:

---

## 1. API gửi task vào broker (Redis)

- API dùng **CELERY_BROKER_URL** (ví dụ `redis://10.192.4.50:6379/0`) để kết nối Redis và **đẩy task** `ocr.run_job` với `args=[job_id]`.
- Task nằm trong Redis; nếu **không có worker nào chạy** thì task chỉ nằm trong queue, job sẽ mãi ở trạng thái QUEUED.

---

## 2. Bước tiếp theo: Chạy Celery Worker

Cần **chạy ít nhất một process Celery worker** để:

- Kết nối tới **cùng CELERY_BROKER_URL** (và **CELERY_RESULT_BACKEND** nếu dùng) như API.
- Lắng nghe queue, nhận task `ocr.run_job`, lấy file từ MinIO, chạy OCR, ghi kết quả lên MinIO và cập nhật trạng thái job trong Postgres (RUNNING → DONE hoặc FAILED).

**Chạy worker (từ thư mục gốc repo):**

```bash
# Cấu hình env giống API (Postgres, MinIO, Celery)
export DATABASE_URL="postgresql://ocr:ocr@10.192.4.50:5432/ocr"
export CELERY_BROKER_URL="redis://10.192.4.50:6379/0"
export CELERY_RESULT_BACKEND="redis://10.192.4.50:6379/1"
export MINIO_ENDPOINT="10.192.4.50:9002"
export MINIO_ACCESS_KEY="minioadmin"
export MINIO_SECRET_KEY="minioadmin123"
export MINIO_SECURE="false"
export MINIO_OCR_BUCKET="ocr"

# Chạy worker (trong apps/worker)
cd apps/worker
celery -A app.worker:celery_app worker -l info
```

Hoặc dùng file env (ví dụ `infra/.env`):

```bash
cd apps/worker
set -a && source ../../infra/.env && set +a
celery -A app.worker:celery_app worker -l info
```

**Lưu ý:** Worker cần đọc được **cùng** `CELERY_BROKER_URL` và `CELERY_RESULT_BACKEND` mà API đang dùng; đồng thời cần **DATABASE_URL** và **MinIO** (MINIO_* hoặc S3_*) để đọc job từ Postgres và file từ MinIO.

---

## 3. Tóm tắt luồng

| Bước | Thành phần | Việc làm |
|------|------------|----------|
| 1 | API | Nhận upload → lưu file MinIO, tạo/cập nhật job Postgres (QUEUED). |
| 2 | API | Gửi task `ocr.run_job(job_id)` vào **CELERY_BROKER_URL** (Redis). |
| 3 | **Celery Worker** | Kết nối **CELERY_BROKER_URL**, nhận task → đọc job từ Postgres, lấy file từ MinIO → chạy OCR → ghi kết quả MinIO, cập nhật job (DONE/FAILED). |

Nếu không chạy worker, task sẽ nằm trong Redis và job sẽ không bao giờ chuyển sang RUNNING/DONE.

---

## 4. Kiểm tra nhanh

- **Redis đang chạy:** `redis-cli -h 10.192.4.50 -p 6379 ping` → trả về `PONG`.
- **API có gửi task:** Trong log API có dòng kiểu "Đã lưu job vào Postgres và file vào MinIO" và không có cảnh báo "Redis/Celery lỗi".
- **Worker đang chạy:** Process `celery -A app.worker:celery_app worker` đang chạy và log có dòng nhận task `ocr.run_job` và "[OCR] Job started" / "[OCR] ✅ Job completed".
