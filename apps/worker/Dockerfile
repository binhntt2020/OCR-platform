FROM python:3.11-slim

WORKDIR /app
RUN pip install uv

COPY libs/ocr_core /app/libs/ocr_core
COPY apps/worker /app/apps/worker

WORKDIR /app/apps/worker
RUN uv sync

CMD ["uv", "run", "celery", "-A", "app.worker:celery_app", "worker", "--loglevel=INFO", "-Q", "celery"]
