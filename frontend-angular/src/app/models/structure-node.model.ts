import { SourceMap } from './source-map.model';

export interface StructureNodeAnchorsFullRange {
  start_page: number;
  end_page: number;
}

export interface StructureNodeQc {
  text_length?: number;
  boundary_leak?: boolean;
}

/** Văn bản liên quan / signals từ content (owner, docno, time). */
export interface ContentSignals {
  contains_owner?: boolean;
  contains_docno?: boolean;
  contains_time?: boolean;
  owner?: Array<{ role: string; value: string; span?: number[] }>;
  docno?: Array<{ kind: string; value: string; date?: string; issued_by?: string; span?: number[] }>;
  time?: Array<{ type?: string; value: string; span?: number[] }>;
}

export interface StructureNode {
  node_id: string;
  structure: string;
  level: number;
  display_number: string;
  title: string;
  full_title: string;
  summary: string;
  ocr_text?: string;
  /** Văn bản liên quan (signals: đơn vị chủ trì/phối hợp, số hiệu văn bản, thời gian) */
  signals?: ContentSignals;
  anchors_full_range?: StructureNodeAnchorsFullRange;
  qc: StructureNodeQc;
  status: string;
  source_map?: SourceMap;
}
