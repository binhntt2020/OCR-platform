# OCR Platform

Monorepo cho nền tảng OCR với cấu trúc chuẩn: FastAPI, Celery Worker, MinIO, PostgreSQL, Redis.

## Cấu trúc thư mục

```
ocr-platform/
├── apps/
│   ├── api/              # FastAPI REST API
│   │   ├── app/
│   │   │   ├── main.py
│   │   │   ├── api/v1/routes_jobs.py
│   │   │   ├── core/     # config, logging, deps
│   │   │   ├── schemas/  # jobs, ocr
│   │   │   └── services/ # jobs_service, storage_service
│   │   ├── pyproject.toml
│   │   └── Dockerfile
│   ├── worker/           # Celery worker xử lý OCR
│   │   ├── app/
│   │   │   ├── worker.py
│   │   │   ├── tasks/ocr_tasks.py
│   │   │   ├── core/
│   │   │   └── services/
│   │   ├── pyproject.toml
│   │   └── Dockerfile
│   └── frontend-angular/ # Giao diện test API (Angular)
├── libs/
│   └── ocr_core/         # Thư viện OCR pipeline dùng chung
│       ├── ocr_core/
│       │   ├── domain/models.py
│       │   ├── pipeline/  # orchestrator, preprocess, detect, recognize, postprocess
│       │   └── infra/
│       └── pyproject.toml
└── infra/
    └── docker-compose.yml
```

## Services

| Service   | Port | Mô tả                    |
|-----------|------|--------------------------|
| API       | 8000 | REST API nhận job, upload file |
| MinIO     | 9000 | S3-compatible storage (API)   |
| MinIO Console | 9001 | Giao diện quản lý MinIO       |
| PostgreSQL| 5432 | Database lưu jobs             |
| Redis     | 6379 | Message broker cho Celery     |

## Chạy với Docker

Từ thư mục gốc project, dùng **Make** (khuyến nghị):

```bash
make help       # Xem danh sách lệnh
make up         # Chạy toàn bộ stack
make postgres   # Chỉ chạy Postgres
make redis      # Chỉ chạy Redis
make api        # Chạy API (tự động up postgres + redis trước)
make worker     # Chạy Worker
make down       # Dừng tất cả
make logs       # Xem logs
```

Hoặc dùng docker compose trực tiếp:

```bash
docker compose -f infra/docker-compose.yml up --build
```

- **API**: http://localhost:8000
- **MinIO Console**: http://localhost:9001 (user: `minio`, pass: `minio123`)

### Dùng MinIO có sẵn

Nếu đã có MinIO server (vd: `10.192.4.50:9002`), copy `infra/.env.example` → `infra/.env` và chỉnh:

```env
S3_ENDPOINT=
MINIO_ENDPOINT=10.192.4.50:9002
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin123
MINIO_SECURE=false
MINIO_OCR_BUCKET=ocr
```

Khi dùng MinIO ngoài Docker, có thể tắt service `minio` trong docker-compose.

## API Endpoints

### Tạo job mới

```bash
curl -X POST http://localhost:8000/v1/ocr/jobs -H "X-Tenant-Id: demo"
```

Response: `{"job_id": "...", "status": "PENDING_UPLOAD"}`

### Upload file ảnh

```bash
curl -X POST "http://localhost:8000/v1/ocr/jobs/<JOB_ID>/upload" \
  -H "X-Tenant-Id: demo" \
  -F "file=@/path/to/image.jpg"
```

### Kiểm tra trạng thái job

```bash
curl http://localhost:8000/v1/ocr/jobs/<JOB_ID> -H "X-Tenant-Id: demo"
```

### Health check

```bash
curl http://localhost:8000/health
```

## Giao diện test & Test API (Frontend Angular)

- **Chạy backend:** `docker compose -f infra/docker-compose.yml up` (API: http://localhost:8000).
- **Chạy frontend:** `cd apps/frontend-angular && npm install && npm start` → http://localhost:4200 (proxy `/api` → API).
- **Test API bằng curl:** tạo job, upload file, xem trạng thái — ví dụ lệnh nằm trong `apps/frontend-angular/README.md`.
- **Chạy unit test frontend:** trong `apps/frontend-angular` chạy `npm test`.

Hướng dẫn chi tiết (kết nối API, đổi URL, test curl, test frontend): **apps/frontend-angular/README.md**.

## Luồng xử lý

1. **Tạo job** → Trạng thái `PENDING_UPLOAD`
2. **Upload file** → Lưu vào MinIO, cập nhật `QUEUED`, gửi task Celery
3. **Worker** nhận task → Chạy pipeline OCR (preprocess → detect → recognize → postprocess)
4. **Kết quả** → Lưu JSON vào MinIO `results/<tenant_id>/<job_id>/result.json`, cập nhật `DONE`

## Tech stack

- **API**: FastAPI, Pydantic, psycopg, boto3
- **Worker**: Celery, Redis
- **OCR**: ocr_core (Pillow, NumPy) — pipeline stub, có thể thay bằng CRAFT/VietOCR
- **Storage**: MinIO (S3-compatible)
- **Database**: PostgreSQL 16
