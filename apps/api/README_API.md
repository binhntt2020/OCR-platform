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

### Unit test (khi đã thêm pytest)

```bash
cd apps/api
uv run pytest tests/ -v
```

(Hiện tại `tests/` có thể trống; thêm test rồi dùng lệnh trên.)

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
