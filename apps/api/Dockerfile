FROM python:3.11-slim

WORKDIR /app
RUN pip install uv

COPY libs/ocr_core /app/libs/ocr_core
COPY apps/api /app/apps/api

WORKDIR /app/apps/api
RUN uv sync

EXPOSE 8000
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
