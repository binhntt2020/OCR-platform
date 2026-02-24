import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { Document, Output, DetectResult } from './rag-api.service';

/** Block OCR được chọn trong tree — dùng để highlight box tương ứng trên PDF */
export interface SelectedOcrBlock {
  pageIndex: number;
  blockIndex: number;
}

export interface AppState {
  docs: Document[];
  selectedDocId: string | null;
  outputs: Output[];
  selectedOutputName: string | null;
  jsonStructure: any | null;
  pdfViewerComponentRef: any | null; // Reference to PDF viewer component
  showOcrBboxOnPdf: boolean;
  /** Kết quả Detect (CRAFT) theo docId — vẽ vùng lên PDF */
  detectResult: Record<string, DetectResult>;
  showDetectBboxOnPdf: boolean;
  /** Block OCR đang chọn (từ tree) — PDF viewer sẽ highlight box tương ứng */
  selectedOcrBlock: SelectedOcrBlock | null;
}

@Injectable({
  providedIn: 'root'
})
export class DocumentService {
  private stateSubject = new BehaviorSubject<AppState>({
    docs: [],
    selectedDocId: null,
    outputs: [],
    selectedOutputName: null,
    jsonStructure: null,
    pdfViewerComponentRef: null,
    showOcrBboxOnPdf: true,
    detectResult: {},
    showDetectBboxOnPdf: true,
    selectedOcrBlock: null,
  });

  state$: Observable<AppState> = this.stateSubject.asObservable();

  get state(): AppState {
    return this.stateSubject.value;
  }

  setDocs(docs: Document[]): void {
    this.stateSubject.next({ ...this.state, docs });
  }

  setSelectedDocId(docId: string | null): void {
    this.stateSubject.next({ ...this.state, selectedDocId: docId });
  }

  setOutputs(outputs: Output[]): void {
    this.stateSubject.next({ ...this.state, outputs });
  }

  setSelectedOutputName(name: string | null): void {
    this.stateSubject.next({ ...this.state, selectedOutputName: name });
  }

  setJsonStructure(structure: any | null): void {
    this.stateSubject.next({ ...this.state, jsonStructure: structure });
  }

  getSelectedDoc(): Document | null {
    return this.state.docs.find(d => d.id === this.state.selectedDocId) || null;
  }

  setPdfViewerComponentRef(ref: any): void {
    this.stateSubject.next({ ...this.state, pdfViewerComponentRef: ref });
  }

  setShowOcrBboxOnPdf(value: boolean): void {
    this.stateSubject.next({ ...this.state, showOcrBboxOnPdf: value });
  }

  setDetectResult(docId: string, data: DetectResult | null): void {
    const next = { ...this.state.detectResult };
    if (data) next[docId] = data; else delete next[docId];
    this.stateSubject.next({ ...this.state, detectResult: next });
  }

  setShowDetectBboxOnPdf(value: boolean): void {
    this.stateSubject.next({ ...this.state, showDetectBboxOnPdf: value });
  }

  setSelectedOcrBlock(block: SelectedOcrBlock | null): void {
    this.stateSubject.next({ ...this.state, selectedOcrBlock: block });
  }
}
