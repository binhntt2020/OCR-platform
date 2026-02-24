#!/usr/bin/env python3
"""
Test CRAFT detection (detect.py) với file PDF: đọc PDF, detect text boxes, lưu ảnh vẽ box + JSON ra thư mục.

Cách chạy (từ repo root hoặc apps/worker):
  cd apps/worker
  uv run python scripts/test_detect_pdf.py /path/to/file.pdf [--output-dir ./detect_output]

Cần OCR_CONFIG_BASE trỏ tới thư mục gốc repo (chứa infra/system_config.yml và models/) để CRAFT load weights.
Script tự set OCR_CONFIG_BASE nếu chưa có (tính từ vị trí script).
export OCR_CONFIG_BASE=/mnt/data/code/ocr-platform
uv run python scripts/test_detect_pdf.py /apps/worker/scripts/data/kv17.pdf -o ./detect_output
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Trước khi import ocr_core: repo root + bắt buộc load ocr_core từ libs/ (tránh bản cũ trong site-packages)
_script_dir = Path(__file__).resolve().parent
_repo_root = _script_dir.parent.parent.parent  # scripts -> worker -> apps -> repo
if not os.environ.get("OCR_CONFIG_BASE"):
    os.environ["OCR_CONFIG_BASE"] = str(_repo_root)
_libs = _repo_root / "libs"
_ocr_core_src = _libs / "ocr_core"
if not _ocr_core_src.is_dir():
    sys.exit("Không tìm thấy libs/ocr_core trong repo.")
# Xóa module ocr_core đã cache (nếu có) để import lại từ libs
for key in list(sys.modules):
    if key == "ocr_core" or key.startswith("ocr_core."):
        del sys.modules[key]
sys.path.insert(0, str(_libs))

from PIL import Image, ImageDraw

import fitz
from ocr_core.pipeline.detect import detect_text_boxes


def _resolve_pdf_path(pdf_path: str | Path) -> Path:
    """Resolve đường dẫn PDF; nếu là absolute mà không tồn tại, thử theo OCR_CONFIG_BASE (vd: /apps/worker/... -> $OCR_CONFIG_BASE/apps/worker/...)."""
    path = Path(pdf_path)
    if path.is_file():
        return path
    base = os.environ.get("OCR_CONFIG_BASE", "").strip()
    if path.is_absolute() and base:
        fallback = Path(base) / Path(*path.parts[1:])
        if fallback.is_file():
            return fallback
    raise FileNotFoundError(f"PDF not found: {path}")


def pdf_to_pages(pdf_path: str | Path, dpi: int = 150) -> list[Image.Image]:
    """Chuyển PDF thành danh sách ảnh PIL (cùng logic worker)."""
    path = _resolve_pdf_path(pdf_path)
    doc = fitz.open(path)
    pages = []
    try:
        for i in range(len(doc)):
            page = doc[i]
            pix = page.get_pixmap(dpi=dpi)
            img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
            pages.append(img)
    finally:
        doc.close()
    return pages


def draw_boxes(img: Image.Image, boxes: list[tuple[int, int, int, int]], color: str = "lime") -> Image.Image:
    """Vẽ các box lên ảnh (copy để không sửa ảnh gốc)."""
    out = img.copy()
    draw = ImageDraw.Draw(out)
    for (x1, y1, x2, y2) in boxes:
        draw.rectangle([x1, y1, x2, y2], outline=color, width=2)
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="Test CRAFT detect trên PDF, lưu ảnh + JSON kết quả.")
    parser.add_argument("pdf", type=str, help="Đường dẫn file PDF")
    parser.add_argument(
        "--output-dir", "-o",
        type=str,
        default="./detect_output",
        help="Thư mục lưu kết quả (mặc định: ./detect_output)",
    )
    parser.add_argument("--dpi", type=int, default=150, help="DPI render PDF (mặc định 150)")
    args = parser.parse_args()

    pdf_path = Path(args.pdf)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"PDF: {pdf_path}")
    print(f"Output: {out_dir.absolute()}")
    print("Đang đọc PDF...")
    pages = pdf_to_pages(pdf_path, dpi=args.dpi)
    print(f"Đã load {len(pages)} trang.")

    all_pages_data = []
    for i, img in enumerate(pages):
        print(f"  Detect trang {i + 1}/{len(pages)}...")
        boxes = detect_text_boxes(img)  # List[(x1,y1,x2,y2)]; rỗng nếu không có box

        # JSON: list dict để dễ đọc
        boxes_json = [{"x1": x1, "y1": y1, "x2": x2, "y2": y2} for (x1, y1, x2, y2) in boxes]
        all_pages_data.append({"page_index": i, "boxes": boxes_json, "count": len(boxes)})

        # Lưu ảnh có vẽ box
        img_with_boxes = draw_boxes(img, boxes)
        img_path = out_dir / f"page_{i:04d}.png"
        img_with_boxes.save(img_path)
        print(f"    -> {len(boxes)} boxes, đã lưu {img_path.name}")

        # Lưu JSON từng trang (tùy chọn, có thể chỉ lưu 1 file tổng)
        json_path = out_dir / f"page_{i:04d}_boxes.json"
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(boxes_json, f, indent=2, ensure_ascii=False)

    # Lưu file tổng (tất cả trang)
    summary_path = out_dir / "detect_summary.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(
            {"pdf": str(pdf_path), "num_pages": len(pages), "pages": all_pages_data},
            f,
            indent=2,
            ensure_ascii=False,
        )
    print(f"Đã lưu tổng kết: {summary_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
