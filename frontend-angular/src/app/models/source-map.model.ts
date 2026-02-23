export interface SourceBlockRef {
  page: number;
  block_idx: number;
  bbox: [number, number, number, number];
  text: string;
  match?: number; // 0–1, optional
}

export interface SourceMap {
  page_start: number;
  page_end: number;
  mapped_blocks: SourceBlockRef[];
  span_bbox_union?: {
    page: number;
    bbox: [number, number, number, number];
  };
}

