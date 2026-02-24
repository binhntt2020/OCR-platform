# OCR Platform – API

FastAPI app: tạo job OCR, upload file, xem trạng thái. Cần PostgreSQL, Redis, MinIO (S3).

---

## Chạy (Run)

### 1. Bằng Docker (khuyến nghị)

Từ **thư mục gốc** repo (có `infra/docker-compose.yml`):

```bash
docker compose -f infra/docker-compose.yml up --build
```

Service `api` chạy tại **http://localhost:8000**. Cần có Redis, Postgres, MinIO (đã bỏ MinIO trong compose; cấu hình qua `infra/.env`).

### 2. Chạy local (uv)

**Yêu cầu:** Python 3.11+, [uv](https://docs.astral.sh/uv/), Postgres + Redis + MinIO đang chạy.

```bash
# Cài uv (nếu chưa): curl -LsSf https://astral.sh/uv/install.sh | sh
# Từ thư mục gốc repo
cd apps/api
uv sync
```

Đặt biến môi trường (hoặc tạo file `.env` trong `apps/api`):

```bash
export DATABASE_URL="postgresql+psycopg://ocr:ocr@localhost:5432/ocr"
export CELERY_BROKER_URL="redis://localhost:6379/0"
export CELERY_RESULT_BACKEND="redis://localhost:6379/1"
export S3_ENDPOINT="http://localhost:9000"   # hoặc MINIO_ENDPOINT=host:port
export S3_ACCESS_KEY="minio"
export S3_SECRET_KEY="minio123"
export S3_BUCKET="ocr"
```

Chạy server:

```bash
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

API: **http://localhost:8000**. Docs: http://localhost:8000/docs .

---

## Test

### Health

```bash
curl http://localhost:8000/health
# → {"ok":true}
```

### Tạo job

```bash
curl -X POST http://localhost:8000/v1/ocr/jobs -H "X-Tenant-Id: demo"
# → {"job_id":"...","status":"PENDING_UPLOAD"}
```

### Upload file (thay `<JOB_ID>`)

```bash
curl -X POST "http://localhost:8000/v1/ocr/jobs/<JOB_ID>/upload" \
  -H "X-Tenant-Id: demo" \
  -F "file=@/path/to/image.jpg"
```

### Xem trạng thái job

```bash
curl http://localhost:8000/v1/ocr/jobs/<JOB_ID> -H "X-Tenant-Id: demo"
```

### Luồng Detect → chỉnh sửa → OCR

- Sau upload, worker chạy **Detect** (CRAFT), lưu kết quả vào DB (`detect_result`) và MinIO; status = `DETECT_DONE`.
- **GET** `/v1/ocr/jobs/<JOB_ID>` trả về `detect_result` (JSON). **GET** `/v1/ocr/jobs/<JOB_ID>/detect` trả về cùng nội dung (ưu tiên DB).
- **PATCH** `/v1/ocr/jobs/<JOB_ID>/detect` — body JSON `{ "job_id", "pages": [ { "page_index", "width", "height", "boxes": [...] } ] }` — cập nhật `detect_result` trong DB (chỉnh sửa boxes trước khi OCR).
- **POST** `/v1/ocr/jobs/<JOB_ID>/run-ocr` — gửi task `ocr.run_ocr_job` (chạy Recognize dùng `detect_result` trong DB), sau khi chỉnh sửa xong.

### Unit test (khi đã thêm pytest)

```bash
cd apps/api
uv run pytest tests/ -v
```

(Hiện tại `tests/` có thể trống; thêm test rồi dùng lệnh trên.)

### Migration DB: cột `detect_result`

Nếu bảng `ocr_jobs` đã tồn tại, chạy migration một lần:

```bash
psql "$DATABASE_URL" -f infra/migrations/add_ocr_jobs_detect_result.sql
```

Hoặc với SQLAlchemy `create_all`, đảm bảo model đã có cột `detect_result` rồi tạo bảng mới / thêm cột thủ công.

### Lint & type check (Ruff + Pyright)

```bash
cd apps/api
uv add --dev ruff pyright
uv run ruff check app
uv run ruff format app
uv run pyright app
```

---

## Docker

### Build image API (từ thư mục gốc repo)

Context phải là repo root (để copy `libs/ocr_core`):

```bash
docker build -f apps/api/Dockerfile -t ocr-api:local .
```

### Chạy container (ví dụ)

```bash
docker run --rm -p 8000:8000 \
  -e DATABASE_URL="postgresql+psycopg://ocr:ocr@host.docker.internal:5432/ocr" \
  -e CELERY_BROKER_URL="redis://host.docker.internal:6379/0" \
  -e CELERY_RESULT_BACKEND="redis://host.docker.internal:6379/1" \
  -e S3_ENDPOINT="http://host.docker.internal:9000" \
  -e S3_ACCESS_KEY="minio" \
  -e S3_SECRET_KEY="minio123" \
  -e S3_BUCKET="ocr" \
  ocr-api:local
```

### Dùng docker-compose (cả stack)

Từ thư mục gốc:

```bash
docker compose -f infra/docker-compose.yml up -d
```

API: http://localhost:8000. Biến môi trường lấy từ `infra/.env` (xem `infra/.env.example`).

---

## Biến môi trường

| Biến | Mô tả |
|------|--------|
| `DATABASE_URL` | PostgreSQL (vd: `postgresql+psycopg://user:pass@host:5432/db`) |
| `CELERY_BROKER_URL` | Redis broker (vd: `redis://localhost:6379/0`) |
| `CELERY_RESULT_BACKEND` | Redis backend (vd: `redis://localhost:6379/1`) |
| `S3_ENDPOINT` | MinIO/S3 endpoint (vd: `http://localhost:9000`) |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | Credentials S3/MinIO |
| `S3_BUCKET` | Bucket (mặc định: `ocr`) |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_SECURE` | Dùng thay `S3_*` nếu cần |

## Tóm tắt kiến trúc logic

    Client
      ↓
    FastAPI
      ├── Postgres (metadata)
      ├── MinIO (file storage)
      └── Redis → Celery
                  ↓
              Worker
                  ↓
              OCR Core
                  ↓
              MinIO result
                  ↓
              Update DB
📌 Bước 1 – Lưu file vào MinIO --> File đã được lưu vào object storage (MinIO).
📌 Bước 2 – Update DB  -->  Lưu metadata vào Postgres.
📌 Bước 3 – GỌI REDIS (thông qua Celery)  
    Đây là đoạn quan trọng:
      from app.core.deps import celery_app
      celery_app.send_task("ocr.run_job", args=[job_id])
    ⚠ Chính dòng này sẽ gửi message vào Redis.
    Redis chỉ dùng làm: Message Queue trung gian giữa API và Worker
    Redis hoạt động  Khi dòng này chạy: celery_app.send_task("ocr.run_job", args=[job_id])
4️⃣ Worker nhận task từ Redis (apps/worker/app/tasks/ocr_tasks.py)
5️⃣ Vai trò thực sự của Redis trong project này
    🔹 1. Message Broker: Giúp API không phải chờ OCR xử lý. 
           - Nếu không có Redis: API → chạy OCR trực tiếp → block request 10–30s
           - Có Redis: API → gửi message → trả 200 ngay Worker xử lý nền
    🔹 2. Buffer chống quá tải: → Giúp hệ thống không sập.
           - Nếu 1000 user upload cùng lúc: 
             + API vẫn nhận bình thường
             + Redis xếp hàng queue
             + Worker xử lý dần
    🔹 3. Tách biệt service: Chỉ cần push message vào Redis.
          - API không cần biết:
          + Worker đang chạy ở đâu
          + Có bao nhiêu worker
6️⃣ Tại sao không gọi trực tiếp worker?
    Nếu làm vậy:
              + API sẽ bị block
              + Không scale được
              + Không retry được
              + Không có queue

    
7️⃣ Tổng flow đầy đủ có Redis:
            Client
              ↓
            FastAPI
              ↓
            Save file → MinIO
            Update DB → Postgres
              ↓
            Send task → Redis
              ↓
            Worker lấy task từ Redis
              ↓
            OCR xử lý
              ↓
            Save result → MinIO
            Update DB → DONE
  🔟 Tóm lại
        Đoạn call Redis:
        celery_app.send_task("ocr.run_job", args=[job_id])
        Vai trò Redis:
        ✅ Làm message queue
        ✅ Tách API và Worker
        ✅ Giúp xử lý async
        ✅ Giúp scale system
        ❌ Không lưu file
        ❌ Không lưu metadata


## Celery là một distributed task queue (hệ thống xử lý tác vụ bất đồng bộ phân tán) cho Python.:
Celery giúp bạn chạy các công việc nặng (OCR, gửi email, xử lý ảnh, AI…) ở background thay vì chạy trực tiếp trong API.
1️⃣ Vấn đề nếu KHÔNG có Celery
    Giả sử API upload xong chạy OCR ngay:
      run_ocr(file)
      return result
    Nếu OCR mất 15–30 giây:
      ❌ API bị block
      ❌ User phải chờ
      ❌ Server dễ quá tải
      ❌ Không scale tốt
2️⃣ Celery giải quyết như thế nào?
    Celery tách hệ thống thành 2 phần: 
    API (Producer)  →  Queue (Redis)  →  Worker (Consumer)
    Flow:
      API nhận request
      API gửi task vào queue
      Trả response ngay
      Worker xử lý task ở background
3️⃣ Celery gồm những thành phần gì?
    🔹 1. Producer (API) : celery_app.send_task("ocr.run_job", args=[job_id])
    🔹 2. Broker (Redis hoặc RabbitMQ): Celery không tự lưu task — nó dùng broker.
    🔹 3. Worker: celery -A app worker -l info
        Worker:
          Lắng nghe Redis
          Khi có task → lấy xuống
          Thực thi function
          @shared_task(name="ocr.run_job")
          def run_job(job_id):
              ...
4️⃣ Celery hoạt động nội bộ ra sao?
    send_task("ocr.run_job", args=[job_id])
  
  Celery sẽ:
        Serialize task thành JSON
        Đẩy vào Redis queue
        Worker polling Redis
        Worker lấy task
        Deserialize
        Chạy function
  5️⃣ Celery dùng để làm gì trong thực tế?
      Rất phổ biến trong production:
            Use case	Ví dụ
            OCR	Xử lý file
            AI inference	Chạy model
            Email	Gửi email async
            SMS	Gửi SMS
            Video processing	Encode video
            Data pipeline	ETLZ
  8️⃣ Trong project OCR của bạn
        FastAPI → gửi task → Redis 
        Worker → nhận task → chạy OCR

Một hệ thống giúp chạy các công việc nặng ở background, thông qua queue (Redis/RabbitMQ), tách biệt API và Worker.
    cd /mnt/data/code/ocr-platform/apps/worker
    uv run celery -A app.worker:celery_app worker -l info