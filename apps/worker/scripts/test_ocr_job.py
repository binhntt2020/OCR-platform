#!/usr/bin/env python3
"""
Test chạy OCR (run_ocr_job) cho một job_id: đọc detect_result từ DB, recognize VietOCR, in kết quả và (mặc định) lưu vào DB + MinIO.

Cách chạy (từ repo root hoặc apps/worker, cần DB + MinIO đang chạy):
  cd apps/worker
  uv run python scripts/test_ocr_job.py
  uv run python scripts/test_ocr_job.py 613ee70d1a0c46a1aa7a00107783da62
  uv run python scripts/test_ocr_job.py --job-id 613ee70d1a0c46a1aa7a00107783da62 --no-update

Cần OCR_CONFIG_BASE trỏ tới thư mục gốc repo (để VietOCR/CRAFT load config từ infra/system_config.yml).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Thư mục worker để import app.*
_script_dir = Path(__file__).resolve().parent
_worker_dir = _script_dir.parent
_repo_root = _worker_dir.parent.parent
if not os.environ.get("OCR_CONFIG_BASE"):
    os.environ["OCR_CONFIG_BASE"] = str(_repo_root)
sys.path.insert(0, str(_worker_dir))
# libs/ocr_core
_libs = _repo_root / "libs"
_ocr_core_src = _libs / "ocr_core"
if _ocr_core_src.is_dir():
    for key in list(sys.modules):
        if key == "ocr_core" or key.startswith("ocr_core."):
            del sys.modules[key]
    sys.path.insert(0, str(_libs))

from app.services.db_service import get_job, update_job
from app.services.storage_service import get_bytes, put_bytes
from app.tasks.ocr_tasks import _raw_to_pages
from ocr_core.pipeline.orchestrator import run_ocr_with_boxes


DEFAULT_JOB_ID = "613ee70d1a0c46a1aa7a00107783da62"


def main() -> int:
    parser = argparse.ArgumentParser(description="Test OCR cho job_id (đọc detect_result từ DB, chạy VietOCR).")
    parser.add_argument(
        "job_id",
        nargs="?",
        default=DEFAULT_JOB_ID,
        help=f"Job ID (mặc định: {DEFAULT_JOB_ID})",
    )
    parser.add_argument(
        "--no-update",
        action="store_true",
        help="Chỉ chạy OCR và in kết quả, không ghi DB/MinIO",
    )
    parser.add_argument(
        "-o", "--output",
        type=str,
        default=None,
        help="Ghi JSON kết quả ra file (luôn ghi nếu chỉ định, bất kể --no-update)",
    )
    args = parser.parse_args()
    job_id = args.job_id or DEFAULT_JOB_ID

    print(f"Job ID: {job_id}")
    job = get_job(job_id)
    if not job:
        print(f"Lỗi: Không tìm thấy job job_id={job_id}")
        return 1

    detect_json = job.get("detect_result")
    if not detect_json:
        print("Lỗi: Job chưa có detect_result (chưa chạy Detect). Chạy run_job trước.")
        return 1

    try:
        detect_payload = json.loads(detect_json)
    except json.JSONDecodeError as e:
        print(f"Lỗi: detect_result không hợp lệ: {e}")
        return 1

    detect_pages = detect_payload.get("pages") or []
    if not detect_pages:
        print("Lỗi: detect_result không có trang nào.")
        return 1

    if not job.get("input_object_key"):
        print("Lỗi: Job không có input_object_key.")
        return 1

    print("Đang tải input từ storage...")
    raw = get_bytes(job["input_object_key"])
    pages = _raw_to_pages(
        raw,
        job.get("content_type"),
        job.get("original_filename"),
    )
    if not pages:
        print("Lỗi: Không đọc được trang nào từ file.")
        return 1

    print(f"Đã load {len(pages)} trang. Đang chạy VietOCR (run_ocr_with_boxes)...")
    t0 = time.perf_counter()
    result = run_ocr_with_boxes(job_id, pages, detect_pages)
    elapsed = time.perf_counter() - t0
    total_blocks = sum(len(p.blocks) for p in result.pages)
    print(f"OCR xong: {len(result.pages)} trang, {total_blocks} blocks, thời gian={elapsed:.2f}s")

    result_json_str = result.model_dump_json(indent=2)

    if args.output:
        out_path = Path(args.output)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(result_json_str)
        print(f"Đã ghi kết quả ra file: {out_path}")

    if not args.no_update:
        result_key = f"results/{job['tenant_id']}/{job_id}/result.json"
        put_bytes(result_key, result_json_str.encode("utf-8"), "application/json")
        update_job(
            job_id,
            status="DONE",
            result_object_key=result_key,
            result=result_json_str,
            error=None,
            processed_pages=len(pages),
            progress=100,
        )
        print(f"Đã cập nhật DB và MinIO: result_object_key={result_key}")
    else:
        print("(Bỏ qua ghi DB/MinIO do --no-update)")

    # In vài dòng đầu của kết quả
    lines = result_json_str.splitlines()
    print("\n--- Mẫu kết quả (một phần JSON) ---")
    for line in lines[:30]:
        print(line)
    if len(lines) > 30:
        print("...")

    return 0


if __name__ == "__main__":
    sys.exit(main())
