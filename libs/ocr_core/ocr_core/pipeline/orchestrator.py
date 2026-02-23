from __future__ import annotations
from PIL import Image
import uuid

from ocr_core.domain.models import OcrResult, OcrPage, OcrBlock
from ocr_core.pipeline.preprocess import preprocess_image
from ocr_core.pipeline.detect import detect_text_boxes
from ocr_core.pipeline.recognize import recognize
from ocr_core.pipeline.postprocess import postprocess_texts


def run_ocr(job_id: str, pages: list[Image.Image]) -> OcrResult:
    ocr_pages = []
    for page_index, img in enumerate(pages):
        img = preprocess_image(img)
        w, h = img.size

        boxes = detect_text_boxes(img)
        rec = recognize(img, boxes)
        texts = postprocess_texts([t for t, _ in rec])

        blocks = []
        for i, (box, (raw_text, conf), text) in enumerate(zip(boxes, rec, texts)):
            blocks.append(
                OcrBlock(
                    block_id=f"{page_index}-{i}-{uuid.uuid4().hex[:8]}",
                    box=box,
                    score=1.0,
                    text=text,
                    conf=conf,
                )
            )

        ocr_pages.append(OcrPage(page_index=page_index, width=w, height=h, blocks=blocks))

    return OcrResult(job_id=job_id, pages=ocr_pages)
