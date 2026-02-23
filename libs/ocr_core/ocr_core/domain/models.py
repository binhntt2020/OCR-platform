from __future__ import annotations
from typing import List, Optional, Tuple
from pydantic import BaseModel, Field

Box = Tuple[int, int, int, int]  # x, y, w, h


class OcrBlock(BaseModel):
    block_id: str
    box: Box
    score: float = 1.0
    text: Optional[str] = None
    conf: Optional[float] = None


class OcrPage(BaseModel):
    page_index: int
    width: int
    height: int
    blocks: List[OcrBlock] = Field(default_factory=list)


class OcrResult(BaseModel):
    job_id: str
    pages: List[OcrPage]
    pipeline_version: str = "v2-commercial"
