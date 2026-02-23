import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, Input, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DocumentService } from '../../services/document.service';
import { RagApiService } from '../../services/rag-api.service';
import { SourceMap } from '../../models/source-map.model';
import { StructureNode, ContentSignals } from '../../models/structure-node.model';
import { Subject, takeUntil, firstValueFrom } from 'rxjs';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

// Worker PDF.js dùng file local (tránh lỗi fetch từ CDN)
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

@Component({
  selector: 'app-pdf-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './pdf-viewer.component.html',
  styleUrl: './pdf-viewer.component.scss'
})
export class PdfViewerComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('pdfCanvasContainer', { static: false }) pdfCanvasContainer!: ElementRef<HTMLDivElement>;
  @ViewChild('pdfAnnotationsOverlay', { static: false }) pdfAnnotationsOverlay!: ElementRef<HTMLDivElement>;
  @ViewChild('pdfViewerPlaceholder', { static: false }) pdfViewerPlaceholder!: ElementRef<HTMLDivElement>;
  @ViewChild('coordsPanel', { static: false }) coordsPanelRef!: ElementRef<HTMLDivElement>;
  
  /** PDF.js document và pages */
  private pdfDoc: PDFDocumentProxy | null = null;
  private pdfPages: PDFPageProxy[] = [];
  pdfPageWidth: number = 595.32; // Default A4 width
  pdfPageHeight: number = 842.04; // Default A4 height
  totalPages: number = 0;
  currentPage: number = 1;

  /** Optional mapping of the currently selected structure node to PDF blocks. */
  @Input() activeSourceMap: SourceMap | null = null;

  /** Node được chọn hiện tại từ cây mục lục, dùng để vẽ icon điểm bắt đầu. */
  selectedNode: StructureNode | null = null;
  /** Trạng thái lưu file mới */
  saveNewVersionStatus: string = '';

  /** Raw PDF URL để load bằng PDF.js */
  private rawPdfUrl: string | null = null;
  showPlaceholder = true;
  showPdf = false;
  isFullscreen = false;
  isLoadingPdf = false;
  /** Lỗi khi tải PDF (vẫn giữ trạng thái đã chọn doc, không quay về "Chọn file..."). */
  pdfLoadError: string | null = null;
  
  /** Hiển thị tọa độ cố định khi di chuột (như ban đầu) */
  showCoordinates = true;
  /** Tab đang active trong panel tọa độ: 'node' hoặc 'coordinates' */
  coordsPanelActiveTab: 'node' | 'coordinates' = 'node';
  /** Hiển thị OCR bbox trên PDF (đồng bộ với documentService.state.showOcrBboxOnPdf) */
  get showOcrBbox(): boolean {
    return this.documentService.state.showOcrBboxOnPdf;
  }
  /** Vị trí panel tọa độ (kéo thả); null = dùng vị trí mặc định CSS */
  coordsPanelLeft: number | null = null;
  coordsPanelTop: number | null = null;
  /** Kích thước panel (to/nhỏ); null = dùng mặc định CSS */
  coordsPanelWidth: number | null = null;
  coordsPanelHeight: number | null = null;
  private coordsPanelDragging = false;
  private coordsPanelResizing = false;
  private coordsDragStartX = 0;
  private coordsDragStartY = 0;
  private coordsDragStartLeft = 0;
  private coordsDragStartTop = 0;
  private coordsResizeStartX = 0;
  private coordsResizeStartY = 0;
  private coordsResizeStartWidth = 0;
  private coordsResizeStartHeight = 0;
  private readonly COORDS_PANEL_MIN_W = 200;
  private readonly COORDS_PANEL_MIN_H = 180;
  /** Popup phóng to nội dung: khi set thì hiện cửa sổ popup với title + content; field = key cập nhật lại vào selectedNode khi đóng */
  textPopup: { title: string; content: string; field?: 'full_title' | 'summary' | 'ocr_text' | 'signals' } | null = null;
  /** Nội dung đang chỉnh sửa trong popup (two-way với textarea) */
  textPopupEditContent = '';
  /** Vị trí và kích thước popup (để kéo thả + co giãn) */
  textPopupPosition: { left: number; top: number } | null = null;
  textPopupSize: { width: number; height: number } | null = null;
  private textPopupDragging = false;
  private textPopupResizing = false;
  private textPopupDragStartX = 0;
  private textPopupDragStartY = 0;
  private textPopupDragStartLeft = 0;
  private textPopupDragStartTop = 0;
  private textPopupResizeStartX = 0;
  private textPopupResizeStartY = 0;
  private textPopupResizeStartW = 0;
  private textPopupResizeStartH = 0;
  private readonly TEXT_POPUP_MIN_W = 320;
  private readonly TEXT_POPUP_MIN_H = 200;
  pdfCoordinates: { page?: number; x?: number; y?: number } = {};
  screenCoordinates: { x?: number; y?: number } = {};
  /** Thông tin node từ JSON được tìm thấy gần vị trí click */
  matchedNode: {
    node?: any;
    distance?: number;
    jsonX0?: number;
    jsonY0?: number;
    jsonPage?: number;
    accuracy?: 'exact' | 'close' | 'far' | 'not_found';
  } | null = null;

  /** Bbox đang chỉnh (x0,y0,x1,y1) cho node được chọn; dùng khi user kéo góc để sửa vùng. */
  editableBbox: { nodeId: string; page: number; x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Vị trí handle kéo góc (góc dưới-phải) của vùng khoanh, để đặt trong template. */
  regionResizeHandle: { leftPx: number; topPx: number } | null = null;
  /** Anchor (page, x0, y0) của vùng đang vẽ; dùng khi kết thúc resize để tính x1, y1. */
  private regionResizeAnchor: { page: number; x0: number; y0: number } | null = null;
  private regionResizing = false;
  private regionResizeStartClientX = 0;
  private regionResizeStartClientY = 0;
  private regionResizeStartW = 0;
  private regionResizeStartH = 0;
  private regionResizeBox: HTMLElement | null = null;
  
  /** Scale để render PDF (tự động tính từ container width) */
  private pdfScale: number = 1.0;
  /** Đang load doc này (tránh gọi load 2 lần cho cùng doc). */
  private loadingDocId: string | null = null;
  /** Đang render canvas (tránh render trùng/đồng thời). */
  private isRenderingPages = false;
  
  private destroy$ = new Subject<void>();

  constructor(
    public documentService: DocumentService,
    private ragApi: RagApiService,
    private sanitizer: DomSanitizer,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Register this component reference in document service
    this.documentService.setPdfViewerComponentRef(this);
    
    // Listen for ESC key to exit fullscreen
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isFullscreen) {
        this.exitFullscreen();
      }
      // Đóng coordinates display với phím ESC hoặc C
      if ((e.key === 'Escape' || e.key === 'c' || e.key === 'C') && this.showCoordinates) {
        this.showCoordinates = false;
      }
    });

    document.addEventListener('mousemove', this.onCoordsPanelMouseMove);
    document.addEventListener('mouseup', this.onCoordsPanelMouseUp);

    this.documentService.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      if (state.selectedDocId) {
        const docId = state.selectedDocId;
        // Tránh load 2 lần cho cùng doc (subscription có thể chạy 2 lần)
        if (this.loadingDocId === docId && this.isLoadingPdf) return;
        this.loadingDocId = docId;
        this.rawPdfUrl = this.ragApi.getDocumentFile(docId);
        this.showPlaceholder = false;
        this.showPdf = true;
        this.isLoadingPdf = true;
        this.pdfLoadError = null;
        
        // Load PDF bằng PDF.js (fetch qua HttpClient để tránh CORS)
        this.loadPdfWithPdfJs(docId).then(() => {
          this.loadingDocId = null;
          this.isLoadingPdf = false;
          this.pdfLoadError = null;
          // Render lại sau khi container đã hiển thị (có kích thước)
          setTimeout(() => {
            if (this.pdfDoc && this.documentService.state.selectedDocId === docId) {
              this.renderAllPages();
              if (state.jsonStructure) this.renderPdfAnnotations();
            }
          }, 100);
        }).catch((error) => {
          this.loadingDocId = null;
          console.error('Lỗi load PDF:', error);
          this.isLoadingPdf = false;
          // Giữ trạng thái đã chọn doc, chỉ hiển thị lỗi (không quay về "Chọn file...")
          let msg = error?.error?.message || error?.message || error?.statusText;
          if (error?.status) msg = (msg ? `HTTP ${error.status}: ${msg}` : `HTTP ${error.status}`);
          this.pdfLoadError = msg || 'Không tải được PDF. Kiểm tra API (localhost:8100) và CORS.';
        });
      } else {
        this.loadingDocId = null;
        this.rawPdfUrl = null;
        this.pdfDoc = null;
        this.pdfPages = [];
        this.showPlaceholder = true;
        this.showPdf = false;
        this.pdfLoadError = null;
        this.clearAnnotations();
        // Exit fullscreen if no document selected
        if (this.isFullscreen) {
          this.exitFullscreen();
        }
      }
      
      // Render annotations when JSON structure changes
      if (state.jsonStructure && state.selectedDocId && this.showPdf && this.pdfDoc) {
        setTimeout(() => this.renderPdfAnnotations(), 500);
      } else if (!state.jsonStructure) {
        this.clearAnnotations();
      }
      // Cập nhật panel "Văn bản liên quan" khi jsonStructure thay đổi (selectedNodeSignals đọc từ đây)
      if (state.jsonStructure && this.selectedNode) {
        this.cdr.markForCheck();
      }
    });
  }

  /** Xử lý mouse move trên layer capture để cập nhật tọa độ real-time. */
  onOverlayMouseMove(event: MouseEvent): void {
    if (!this.showCoordinates) {
      // Nếu panel đang tắt thì chỉ update internal state, không cần làm gì thêm
      this.updateCoordinates(event);
      return;
    }
    this.updateCoordinates(event);
  }

  ngAfterViewInit(): void {
    // Initial render check
    setTimeout(() => {
      const state = this.documentService.state;
      if (state.jsonStructure && state.selectedDocId && this.showPdf && this.pdfDoc) {
        this.renderPdfAnnotations();
      }
    }, 1000);
  }

  /** Load PDF bằng PDF.js (fetch qua HttpClient để tránh CORS). */
  private async loadPdfWithPdfJs(docId: string): Promise<void> {
    try {
      // Fetch PDF qua HttpClient (cùng origin / proxy, tránh CORS)
      const arrayBuffer = await firstValueFrom(
        this.ragApi.getDocumentFileAsArrayBuffer(docId)
      );
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      this.pdfDoc = await loadingTask.promise;
      this.totalPages = this.pdfDoc.numPages;

      // Lấy page đầu tiên để lấy kích thước
      const firstPage = await this.pdfDoc.getPage(1);
      const viewport = firstPage.getViewport({ scale: 1.0 });
      this.pdfPageWidth = viewport.width;
      this.pdfPageHeight = viewport.height;

      // Load tất cả pages (chưa render canvas - chờ container hiển thị)
      this.pdfPages = [];
      for (let i = 1; i <= this.totalPages; i++) {
        const page = await this.pdfDoc.getPage(i);
        this.pdfPages.push(page);
      }
      // renderAllPages() được gọi sau khi isLoadingPdf = false và setTimeout 100ms
    } catch (error) {
      console.error('Lỗi load PDF với PDF.js:', error);
      throw error;
    }
  }

  /** Render tất cả pages lên canvas container */
  private async renderAllPages(): Promise<void> {
    if (!this.pdfCanvasContainer || !this.pdfDoc) return;
    if (this.isRenderingPages) return;
    this.isRenderingPages = true;

    const container = this.pdfCanvasContainer.nativeElement;
    container.innerHTML = ''; // Clear previous content

    // Tính scale dựa trên container width (nếu container đang ẩn thì retry sau)
    let containerWidth = container.clientWidth || container.offsetWidth;
    if (!containerWidth) {
      this.isRenderingPages = false;
      setTimeout(() => this.renderAllPages(), 150);
      return;
    }
    this.pdfScale = containerWidth / this.pdfPageWidth;

    try {
    // Render từng page
    for (let i = 0; i < this.pdfPages.length; i++) {
      const page = this.pdfPages[i];
      const viewport = page.getViewport({ scale: this.pdfScale });

      // Tạo canvas cho page này
      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page-canvas';
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.display = 'block';
      canvas.style.margin = '0 auto';
      canvas.style.marginBottom = '10px'; // Khoảng cách nhỏ giữa các trang

      const context = canvas.getContext('2d');
      if (!context) continue;

      // Render page lên canvas
      const renderContext = {
        canvasContext: context,
        viewport: viewport
      };

      await page.render(renderContext).promise;
      container.appendChild(canvas);
    }

    // Cập nhật chiều cao overlay để khớp với canvas container
    if (this.pdfAnnotationsOverlay) {
      const overlay = this.pdfAnnotationsOverlay.nativeElement;
      const containerHeight = container.scrollHeight;
      overlay.style.height = `${containerHeight}px`;
    }

    console.log(`Đã render ${this.pdfPages.length} trang PDF với scale ${this.pdfScale.toFixed(2)}`);
    } finally {
      this.isRenderingPages = false;
    }
  }

  onCoordsPanelMouseDown(e: MouseEvent): void {
    if (!this.coordsPanelRef?.nativeElement) return;
    const el = this.coordsPanelRef.nativeElement;
    const rect = el.getBoundingClientRect();
    if (this.coordsPanelLeft == null) this.coordsPanelLeft = rect.left;
    if (this.coordsPanelTop == null) this.coordsPanelTop = rect.top;
    this.coordsPanelDragging = true;
    this.coordsDragStartX = e.clientX;
    this.coordsDragStartY = e.clientY;
    this.coordsDragStartLeft = this.coordsPanelLeft;
    this.coordsDragStartTop = this.coordsPanelTop;
  }

  /** Bắt đầu kéo góc để chỉnh vùng (x1, y1). Handle nằm ở góc dưới-phải của .pdf-node-region. */
  onRegionResizeStart(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.pdfAnnotationsOverlay || !this.selectedNode || !this.regionResizeAnchor) return;
    const overlay = this.pdfAnnotationsOverlay.nativeElement;
    const box = overlay.querySelector('.pdf-node-region') as HTMLElement;
    if (!box) return;
    this.regionResizing = true;
    this.regionResizeBox = box;
    this.regionResizeStartClientX = e.clientX;
    this.regionResizeStartClientY = e.clientY;
    this.regionResizeStartW = box.offsetWidth;
    this.regionResizeStartH = box.offsetHeight;
  }

  /** Chuỗi JSON của selectedNodeSignals để mở popup chỉnh sửa. */
  getSignalsJson(): string {
    const s = this.selectedNodeSignals;
    if (!s || (typeof s === 'object' && !s.owner?.length && !s.docno?.length && !s.time?.length)) {
      return '{\n  "contains_time": false,\n  "contains_owner": false,\n  "contains_docno": false,\n  "time": [],\n  "owner": [],\n  "docno": []\n}';
    }
    return JSON.stringify(s, null, 2);
  }

  /** Mở popup phóng to nội dung (Full title / Summary / OCR Text / Văn bản liên quan); cho phép chỉnh sửa, khi đóng cập nhật vào thông tin tọa độ và lưu cùng file version mới. */
  openTextPopup(title: string, content: string, field?: 'full_title' | 'summary' | 'ocr_text' | 'signals'): void {
    this.textPopupEditContent = content ?? '';
    this.textPopup = { title, content: content ?? '', field };
    const w = 600;
    const h = 400;
    this.textPopupPosition = {
      left: Math.max(0, (typeof window !== 'undefined' ? window.innerWidth : 800) / 2 - w / 2),
      top: Math.max(0, (typeof window !== 'undefined' ? window.innerHeight : 600) / 2 - h / 2),
    };
    this.textPopupSize = { width: w, height: h };
  }

  closeTextPopup(): void {
    const field = this.textPopup?.field;
    const val = this.textPopupEditContent ?? '';
    if (field === 'signals' && this.selectedNode) {
      const raw = this.findRawNodeInStructure(this.selectedNode);
      if (raw) {
        try {
          const parsed = val.trim() ? JSON.parse(val) : null;
          if (parsed && typeof parsed === 'object') {
            raw.content = raw.content || {};
            raw.content.signals = parsed;
          }
          this.cdr.markForCheck();
        } catch {
          // JSON không hợp lệ, không ghi
        }
      }
    } else if (field && field !== 'signals' && this.selectedNode) {
      (this.selectedNode as any)[field] = val;
      this.onNodeDetailChange();
    }
    this.textPopup = null;
    this.textPopupPosition = null;
    this.textPopupSize = null;
    this.textPopupEditContent = '';
  }

  onTextPopupDragStart(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.textPopupPosition) return;
    this.textPopupDragging = true;
    this.textPopupDragStartX = e.clientX;
    this.textPopupDragStartY = e.clientY;
    this.textPopupDragStartLeft = this.textPopupPosition.left;
    this.textPopupDragStartTop = this.textPopupPosition.top;
  }

  onTextPopupResizeStart(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    if (!this.textPopupSize) return;
    this.textPopupResizing = true;
    this.textPopupResizeStartX = e.clientX;
    this.textPopupResizeStartY = e.clientY;
    this.textPopupResizeStartW = this.textPopupSize.width;
    this.textPopupResizeStartH = this.textPopupSize.height;
  }

  onCoordsPanelResizeMouseDown(e: MouseEvent): void {
    e.stopPropagation();
    if (!this.coordsPanelRef?.nativeElement) return;
    const el = this.coordsPanelRef.nativeElement;
    const rect = el.getBoundingClientRect();
    this.coordsPanelWidth = this.coordsPanelWidth ?? rect.width;
    this.coordsPanelHeight = this.coordsPanelHeight ?? rect.height;
    this.coordsPanelResizing = true;
    this.coordsResizeStartX = e.clientX;
    this.coordsResizeStartY = e.clientY;
    this.coordsResizeStartWidth = this.coordsPanelWidth;
    this.coordsResizeStartHeight = this.coordsPanelHeight;
  }

  private onCoordsPanelMouseMove = (e: MouseEvent): void => {
    if (this.textPopupDragging && this.textPopupPosition) {
      const left = this.textPopupDragStartLeft + (e.clientX - this.textPopupDragStartX);
      const top = this.textPopupDragStartTop + (e.clientY - this.textPopupDragStartY);
      this.textPopupPosition = { left: Math.max(0, left), top: Math.max(0, top) };
      this.cdr.markForCheck();
      return;
    }
    if (this.textPopupResizing && this.textPopupSize) {
      const dw = e.clientX - this.textPopupResizeStartX;
      const dh = e.clientY - this.textPopupResizeStartY;
      const w = Math.max(this.TEXT_POPUP_MIN_W, this.textPopupResizeStartW + dw);
      const h = Math.max(this.TEXT_POPUP_MIN_H, this.textPopupResizeStartH + dh);
      this.textPopupSize = { width: w, height: h };
      this.cdr.markForCheck();
      return;
    }
    if (this.regionResizing && this.regionResizeBox && this.regionResizeAnchor) {
      const newW = Math.max(2, this.regionResizeStartW + (e.clientX - this.regionResizeStartClientX));
      const newH = Math.max(2, this.regionResizeStartH + (e.clientY - this.regionResizeStartClientY));
      this.regionResizeBox.style.width = `${newW}px`;
      this.regionResizeBox.style.height = `${newH}px`;
      this.regionResizeHandle = {
        leftPx: this.regionResizeBox.offsetLeft + newW - 14,
        topPx: this.regionResizeBox.offsetTop + newH - 14,
      };
      return;
    }
    if (this.coordsPanelResizing) {
      const w = this.coordsResizeStartWidth + (e.clientX - this.coordsResizeStartX);
      const h = this.coordsResizeStartHeight + (e.clientY - this.coordsResizeStartY);
      const maxW = typeof window !== 'undefined' ? window.innerWidth - 40 : 4000;
      const maxH = typeof window !== 'undefined' ? window.innerHeight - 40 : 4000;
      this.coordsPanelWidth = Math.min(maxW, Math.max(this.COORDS_PANEL_MIN_W, w));
      this.coordsPanelHeight = Math.min(maxH, Math.max(this.COORDS_PANEL_MIN_H, h));
      return;
    }
    if (!this.coordsPanelDragging) return;
    this.coordsPanelLeft = Math.max(0, this.coordsDragStartLeft + (e.clientX - this.coordsDragStartX));
    this.coordsPanelTop = Math.max(0, this.coordsDragStartTop + (e.clientY - this.coordsDragStartY));
  };

  private onCoordsPanelMouseUp = (): void => {
    if (this.textPopupDragging || this.textPopupResizing) {
      this.textPopupDragging = false;
      this.textPopupResizing = false;
      return;
    }
    if (this.regionResizing && this.regionResizeBox && this.regionResizeAnchor && this.selectedNode) {
      const nodeId = this.selectedNode.node_id ?? this.selectedNode.full_title ?? '';
      const scale = this.pdfScale;
      const x1 = this.regionResizeAnchor.x0 + this.regionResizeBox.offsetWidth / scale;
      const y1 = this.regionResizeAnchor.y0 + this.regionResizeBox.offsetHeight / scale;
      this.editableBbox = {
        nodeId,
        page: this.regionResizeAnchor.page,
        x0: this.regionResizeAnchor.x0,
        y0: this.regionResizeAnchor.y0,
        x1,
        y1,
      };
      this.regionResizeHandle = {
        leftPx: this.regionResizeBox.offsetLeft + this.regionResizeBox.offsetWidth - 14,
        topPx: this.regionResizeBox.offsetTop + this.regionResizeBox.offsetHeight - 14,
      };
      this.regionResizing = false;
      this.regionResizeBox = null;
      return;
    }
    this.coordsPanelDragging = false;
    this.coordsPanelResizing = false;
  };

  ngOnDestroy(): void {
    document.removeEventListener('mousemove', this.onCoordsPanelMouseMove);
    document.removeEventListener('mouseup', this.onCoordsPanelMouseUp);
    if (this.isFullscreen) {
      this.exitFullscreen();
    }
    this.destroy$.next();
    this.destroy$.complete();
  }

  toggleFullscreen(): void {
    if (this.isFullscreen) {
      this.exitFullscreen();
    } else {
      this.enterFullscreen();
    }
  }

  enterFullscreen(): void {
    this.isFullscreen = true;
    
    // Hide other columns temporarily
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      (mainContent as HTMLElement).style.display = 'none';
    }
    
    // Re-render PDF và annotations với kích thước mới sau khi fullscreen
    setTimeout(async () => {
      if (this.rawPdfUrl && this.pdfDoc) {
        await this.renderAllPages();
        if (this.documentService.state.jsonStructure) {
          this.renderPdfAnnotations();
        }
      }
    }, 200);
  }

  exitFullscreen(): void {
    this.isFullscreen = false;
    
    // Show other columns again
    const mainContent = document.querySelector('.main-content');
    if (mainContent) {
      (mainContent as HTMLElement).style.display = 'grid';
    }
    
    // Re-render PDF và annotations với kích thước ban đầu
    setTimeout(async () => {
      if (this.rawPdfUrl && this.pdfDoc) {
        await this.renderAllPages();
        if (this.documentService.state.jsonStructure) {
          this.renderPdfAnnotations();
        }
      }
    }, 200);
  }

  renderPdfAnnotations(): void {
    if (!this.pdfAnnotationsOverlay || !this.pdfCanvasContainer || !this.pdfDoc) return;

    const state = this.documentService.state;
    if (!state.jsonStructure) {
      this.clearAnnotations();
      return;
    }

    const overlay = this.pdfAnnotationsOverlay.nativeElement;
    const container = overlay.parentElement;
    if (!container) return;

    // Lấy scale từ canvas đã render
    if (this.pdfScale === 0 || this.pdfPageWidth === 0) {
      setTimeout(() => this.renderPdfAnnotations(), 500);
      return;
    }

    // Find structure array
    let structure: any[] = [];
    if (state.jsonStructure.structure && Array.isArray(state.jsonStructure.structure)) {
      structure = state.jsonStructure.structure;
    } else if (Array.isArray(state.jsonStructure)) {
      structure = state.jsonStructure;
    } else {
      // Try to find structure in object keys
      for (const key of Object.keys(state.jsonStructure)) {
        const value = (state.jsonStructure as any)[key];
        if (Array.isArray(value) && value.length > 0) {
          const firstItem = value[0];
          if (firstItem && typeof firstItem === 'object' && (firstItem.anchors || firstItem.title)) {
            structure = value;
            break;
          }
        }
      }
    }

    if (structure.length === 0) {
      overlay.style.display = 'none';
      return;
    }

    overlay.innerHTML = '';
    overlay.style.display = 'block';
    overlay.classList.add('active');
    this.regionResizeHandle = null;
    this.regionResizeAnchor = null;

    // Kích thước container (canvas container) cho tính toán marker
    const canvasEl = this.pdfCanvasContainer.nativeElement;
    const containerWidth = canvasEl.clientWidth || canvasEl.offsetWidth || 800;
    const containerHeight = canvasEl.scrollHeight || canvasEl.offsetHeight;

    // Cập nhật chiều cao overlay để khớp với canvas container
    overlay.style.height = `${containerHeight}px`;

    structure.forEach((node, index) => {
      if (!node.anchors) return;

      const anchor = node.anchors.start_page || node.anchors.full_range;
      if (!anchor) return;

      const page = anchor.page || anchor.start_page;
      if (!page) return;

      // Create marker
      const marker = document.createElement('div');
      marker.className = 'pdf-annotation-marker';
      marker.textContent = '📍';
      marker.setAttribute('data-node-index', index.toString());
      marker.setAttribute('title', node.title || `Node ${index + 1}`);

      // Calculate position - dùng scale từ canvas đã render
      const x0 = anchor.x0 || 0;
      const y0 = anchor.y0 || 0;
      const x1 = anchor.x1 || anchor.page_width || this.pdfPageWidth;
      
      // Dùng scale và page height từ canvas
      const scaleX = this.pdfScale;
      const scaleY = this.pdfScale;
      const pageHeightPx = this.pdfPageHeight * this.pdfScale;
      const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);

      const markerX = x1 * scaleX;
      const markerY = pageOffsetY + (y0 * scaleY);

      const finalX = Math.min(containerWidth - 32, Math.max(0, markerX - 32));
      const finalY = Math.min(containerHeight - 32, Math.max(0, markerY));

      marker.style.position = 'absolute';
      marker.style.left = `${finalX}px`;
      marker.style.top = `${finalY}px`;
      marker.style.zIndex = '101';

      // Click handler
      marker.onclick = (e) => {
        e.stopPropagation();
        this.showPdfContentPopup(node);
      };

      overlay.appendChild(marker);
    });

    // Highlight mapped blocks for the active node if source_map is present
    if (this.activeSourceMap && this.activeSourceMap.mapped_blocks?.length) {
      // Lấy page_width/page_height từ JSON structure để tính scale chính xác
      let pdfWidth = 595.32; // Fallback A4
      let pdfHeight = 842.04; // Fallback A4
      
      const state = this.documentService.state;
      if (state.jsonStructure) {
        let structure: any[] = [];
        if (state.jsonStructure.structure && Array.isArray(state.jsonStructure.structure)) {
          structure = state.jsonStructure.structure;
        } else if (Array.isArray(state.jsonStructure)) {
          structure = state.jsonStructure;
        }
        
        // Tìm node đầu tiên có anchors để lấy page_width/page_height
        const findFirstAnchor = (items: any[]): any => {
          for (const item of items) {
            if (item.anchors) {
              const anchor = item.anchors.start_page || item.anchors.full_range;
              if (anchor && (anchor.page_width || anchor.page_height)) {
                return anchor;
              }
            }
            if (Array.isArray(item.nodes) && item.nodes.length) {
              const found = findFirstAnchor(item.nodes);
              if (found) return found;
            }
          }
          return null;
        };
        
        const firstAnchor = findFirstAnchor(structure);
        if (firstAnchor) {
          pdfWidth = firstAnchor.page_width || firstAnchor.width || pdfWidth;
          pdfHeight = firstAnchor.page_height || firstAnchor.height || pdfHeight;
        }
      }
      
      this.activeSourceMap.mapped_blocks.forEach((b) => {
        const page = b.page;
        const [x0, y0, x1, y1] = b.bbox;

        // Dùng scale từ canvas đã render
        const scaleX = this.pdfScale;
        const scaleY = this.pdfScale;
        const pageHeightPx = this.pdfPageHeight * this.pdfScale;
        const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);

        const blockX = x0 * scaleX;
        const blockY = pageOffsetY + y0 * scaleY;
        const blockW = (x1 - x0) * scaleX;
        const blockH = (y1 - y0) * scaleY;

        const rect = document.createElement('div');
        rect.className = 'pdf-annotation-block';
        rect.style.position = 'absolute';
        rect.style.left = `${blockX}px`;
        rect.style.top = `${blockY}px`;
        rect.style.width = `${blockW}px`;
        rect.style.height = `${blockH}px`;
        rect.style.zIndex = '100';

        overlay.appendChild(rect);
      });
    }

    // Vẽ icon điểm bắt đầu cho node được chọn
    if (this.selectedNode) {
      this.renderSelectedNodeStartMarker(overlay, containerWidth, containerHeight, structure);
      
      // Vẽ OCR bbox nếu bật
      if (this.showOcrBbox) {
        this.renderOcrBboxes(overlay, structure);
      }
    }
  }

  /** Vẽ icon đánh dấu điểm bắt đầu của node được chọn. */
  private renderSelectedNodeStartMarker(
    overlay: HTMLElement,
    containerWidth: number,
    containerHeight: number,
    structure: any[]
  ): void {
    if (!this.selectedNode) return;

    // Lấy page từ anchors_full_range của selectedNode trước
    const startPage = this.selectedNode.anchors_full_range?.start_page;
    if (!startPage) {
      console.warn('Selected node không có start_page:', this.selectedNode);
      return;
    }

    // Tìm node trong structure array để lấy anchor chi tiết (x0, y0)
    let foundNode: any = null;
    const findNode = (items: any[]): any => {
      for (const item of items) {
        // So khớp theo nhiều cách
        const matchById = this.selectedNode!.node_id && 
          (item.node_id === this.selectedNode!.node_id || item.id === this.selectedNode!.node_id);
        const matchByStructure = this.selectedNode!.structure && 
          item.structure === this.selectedNode!.structure;
        const matchByTitle = this.selectedNode!.full_title && 
          (item.full_title === this.selectedNode!.full_title || item.title === this.selectedNode!.full_title);
        
        if (matchById || matchByStructure || matchByTitle) {
          return item;
        }
        if (Array.isArray(item.nodes) && item.nodes.length) {
          const found = findNode(item.nodes);
          if (found) return found;
        }
      }
      return null;
    };

    foundNode = findNode(structure);
    
    // Lấy anchor từ foundNode hoặc dùng giá trị mặc định
    let anchor: any = null;
    let page = startPage;
    let x0 = 0;
    let y0 = 0;
    // Lấy page_width và page_height từ JSON (đã được adapter thêm vào)
    let pdfWidth = 595.32; // Fallback A4
    let pdfHeight = 842.04; // Fallback A4

    let x1 = this.pdfPageWidth;
    let y1 = this.pdfPageHeight;
    if (foundNode && foundNode.anchors) {
      anchor = foundNode.anchors.start_page || foundNode.anchors.full_range;
      if (anchor) {
        page = anchor.page || anchor.start_page || startPage;
        x0 = anchor.x0 ?? 0;
        y0 = anchor.y0 ?? 0;
        x1 = anchor.x1 ?? this.pdfPageWidth;
        y1 = anchor.y1 ?? this.pdfPageHeight;
      }
    }
    
    // Dùng kích thước từ canvas đã render
    pdfWidth = this.pdfPageWidth;
    pdfHeight = this.pdfPageHeight;

    // Nếu không tìm thấy anchor chi tiết, dùng giá trị mặc định ở góc trên trái của trang
    if (!anchor || (x0 === 0 && y0 === 0)) {
      // Đặt icon ở góc trên trái của trang (margin nhỏ)
      x0 = 50; // Margin trái
      y0 = 50; // Margin trên
      x1 = x0 + 200;
      y1 = y0 + 24;
      console.log(`Không tìm thấy anchor chi tiết cho node "${this.selectedNode.full_title}", dùng vị trí mặc định tại trang ${page}`);
    }

    // Ưu tiên bbox đã chỉnh (kéo góc) nếu đang chỉnh cho đúng node này
    const nodeId = this.selectedNode.node_id ?? this.selectedNode.full_title ?? '';
    if (this.editableBbox && this.editableBbox.nodeId === nodeId) {
      page = this.editableBbox.page;
      x0 = this.editableBbox.x0;
      y0 = this.editableBbox.y0;
      x1 = this.editableBbox.x1;
      y1 = this.editableBbox.y1;
    }

    // Lưu anchor để khi resize tính lại x1, y1
    this.regionResizeAnchor = { page, x0, y0 };

    // Tính vị trí icon và vùng (x0,y0)->(x1,y1) từ JSON (dùng scale từ canvas)
    const scaleX = this.pdfScale;
    const scaleY = this.pdfScale;
    const pageHeightPx = this.pdfPageHeight * this.pdfScale;
    const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);
    
    const markerX = x0 * scaleX;
    const markerY = pageOffsetY + (y0 * scaleY);

    // Vẽ vùng khoanh từ (x0,y0) đến (x1,y1) trên PDF
    const boxLeft = x0 * scaleX;
    const boxTop = pageOffsetY + (y0 * scaleY);
    const boxW = Math.max(2, (x1 - x0) * scaleX);
    const boxH = Math.max(2, (y1 - y0) * scaleY);
    const regionBox = document.createElement('div');
    regionBox.className = 'pdf-node-region';
    regionBox.setAttribute('title', `Vùng node (trang ${page}): ${this.selectedNode.full_title || this.selectedNode.title}`);
    regionBox.style.position = 'absolute';
    regionBox.style.left = `${boxLeft}px`;
    regionBox.style.top = `${boxTop}px`;
    regionBox.style.width = `${boxW}px`;
    regionBox.style.height = `${boxH}px`;
    regionBox.style.border = '2px solid rgba(56, 189, 248, 0.9)';
    regionBox.style.backgroundColor = 'rgba(56, 189, 248, 0.12)';
    regionBox.style.pointerEvents = 'none';
    regionBox.style.zIndex = '100';
    regionBox.style.borderRadius = '2px';
    overlay.appendChild(regionBox);
    this.regionResizeHandle = {
      leftPx: boxLeft + boxW - 14,
      topPx: boxTop + boxH - 14,
    };

    // Tạo icon đánh dấu điểm bắt đầu (khác với markers thông thường)
    const startMarker = document.createElement('div');
    startMarker.className = 'pdf-start-marker';
    startMarker.innerHTML = '🎯'; // Icon target để phân biệt với markers thông thường
    startMarker.setAttribute('title', `Điểm bắt đầu (trang ${page}): ${this.selectedNode.full_title || this.selectedNode.title}`);

    const finalX = Math.min(containerWidth - 40, Math.max(-20, markerX - 20));
    const finalY = Math.min(containerHeight - 40, Math.max(-20, markerY - 20));

    startMarker.style.position = 'absolute';
    startMarker.style.left = `${finalX}px`;
    startMarker.style.top = `${finalY}px`;
    startMarker.style.zIndex = '102'; // Cao hơn các markers thông thường
    startMarker.style.fontSize = '24px';
    startMarker.style.cursor = 'pointer';
    startMarker.style.filter = 'drop-shadow(0 2px 4px rgba(0,0,0,0.3))';
    startMarker.style.animation = 'pulse 2s ease-in-out infinite';

    overlay.appendChild(startMarker);
    
    console.log(`Vẽ icon điểm bắt đầu cho node "${this.selectedNode.full_title}" tại trang ${page}, vị trí (${x0}, ${y0}), PDF size: ${pdfWidth}x${pdfHeight}`);
    
    // Scroll đến vị trí icon sau khi vẽ
    // Delay để đảm bảo PDF đã load và icon đã được render
    setTimeout(() => {
      // Thử scroll container đến vị trí y0, truyền thêm pdfWidth/pdfHeight để tính đúng scale
      this.scrollToPosition(page, y0, pdfWidth, pdfHeight);
      
      // Thêm: Sử dụng scrollIntoView trên icon element để đảm bảo icon visible
      // Điều này sẽ scroll container chứa icon đến vị trí của icon
      try {
        startMarker.scrollIntoView({
          behavior: 'smooth',
          block: 'center', // Đưa icon vào giữa viewport
          inline: 'nearest'
        });
        console.log(`Đã scroll icon vào view bằng scrollIntoView`);
      } catch (e) {
        console.warn('Không thể scroll icon vào view:', e);
      }
    }, 1200); // Tăng delay để đảm bảo PDF đã scroll đến trang trước
  }

  /** Vẽ các OCR bbox từ selectedNode lên PDF viewer. */
  private renderOcrBboxes(overlay: HTMLElement, structure: any[]): void {
    if (!this.selectedNode) return;

    // Tìm node trong structure tương ứng với selectedNode
    const findNode = (items: any[]): any => {
      for (const item of items) {
        const matchById = this.selectedNode!.node_id && 
          (item.node_id === this.selectedNode!.node_id || item.id === this.selectedNode!.node_id);
        const matchByStructure = this.selectedNode!.structure && 
          item.structure === this.selectedNode!.structure;
        const matchByTitle = this.selectedNode!.full_title && 
          (item.full_title === this.selectedNode!.full_title || item.title === this.selectedNode!.full_title);
        
        if (matchById || matchByStructure || matchByTitle) {
          return item;
        }
        if (Array.isArray(item.nodes) && item.nodes.length) {
          const found = findNode(item.nodes);
          if (found) return found;
        }
      }
      return null;
    };

    const foundNode = findNode(structure);
    if (!foundNode || !foundNode.content?.ocr?.pages) return;

    const ocrPages = foundNode.content.ocr.pages;
    const scaleX = this.pdfScale;
    const scaleY = this.pdfScale;
    const pageHeightPx = this.pdfPageHeight * this.pdfScale;

    // Duyệt qua các trang OCR
    ocrPages.forEach((ocrPage: any) => {
      const page = ocrPage.page;
      if (!ocrPage.blocks || !Array.isArray(ocrPage.blocks)) return;

      const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);

      // Vẽ từng block
      ocrPage.blocks.forEach((block: any, index: number) => {
        if (!block.bbox || !Array.isArray(block.bbox) || block.bbox.length < 4) return;

        const [x0, y0, x1, y1] = block.bbox;
        const blockX = x0 * scaleX;
        const blockY = pageOffsetY + y0 * scaleY;
        const blockW = (x1 - x0) * scaleX;
        const blockH = (y1 - y0) * scaleY;

        const rect = document.createElement('div');
        rect.className = 'pdf-ocr-bbox';
        rect.setAttribute('data-page', page.toString());
        rect.setAttribute('data-index', index.toString());
        rect.setAttribute('title', `OCR Block ${index + 1} (trang ${page}): ${(block.text || '').substring(0, 50)}...`);
        rect.style.position = 'absolute';
        rect.style.left = `${blockX}px`;
        rect.style.top = `${blockY}px`;
        rect.style.width = `${blockW}px`;
        rect.style.height = `${blockH}px`;
        rect.style.border = '1px solid rgba(34, 197, 94, 0.6)';
        rect.style.backgroundColor = 'rgba(34, 197, 94, 0.1)';
        rect.style.zIndex = '101';
        rect.style.pointerEvents = 'none';
        rect.style.boxSizing = 'border-box';

        overlay.appendChild(rect);
      });
    });

    console.log(`Đã vẽ ${ocrPages.reduce((sum: number, p: any) => sum + (p.blocks?.length || 0), 0)} OCR bbox cho node "${this.selectedNode.full_title}"`);
  }

  clearAnnotations(): void {
    if (this.pdfAnnotationsOverlay) {
      const overlay = this.pdfAnnotationsOverlay.nativeElement;
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.classList.remove('active');
    }
  }

  /** Called from JsonEditor when user selects a structure node. */
  setActiveSourceMap(map: SourceMap | null): void {
    this.activeSourceMap = map;
    // Re-render to show block highlights for the new node
    setTimeout(() => this.renderPdfAnnotations(), 200);
  }

  /** Signals (văn bản liên quan): đọc từ raw node trong jsonStructure (content.signals hoặc node.signals), fallback sang selectedNode.signals. */
  get selectedNodeSignals(): ContentSignals | null {
    if (!this.selectedNode) return null;
    const raw = this.findRawNodeInStructure(this.selectedNode);
    const fromRaw = (raw?.content?.signals ?? raw?.signals) as ContentSignals | undefined;
    if (fromRaw && typeof fromRaw === 'object') return fromRaw;
    return this.selectedNode.signals ?? null;
  }

  /** Set selected node để vẽ icon điểm bắt đầu. */
  setSelectedNode(node: StructureNode | null): void {
    this.selectedNode = node;

    // Khi chọn node mới trong cây JSON, cố gắng map sang node gốc trong jsonStructure
    // để panel "Thông tin tọa độ" luôn hiển thị đúng Node từ JSON.
    this.matchedNode = null;
    if (node) {
      const state = this.documentService.state;
      const json = state.jsonStructure;

      let structure: any[] = [];
      if (json?.structure && Array.isArray(json.structure)) {
        structure = json.structure;
      } else if (Array.isArray(json)) {
        structure = json;
      } else if (json && typeof json === 'object') {
        for (const key of Object.keys(json)) {
          const value = (json as any)[key];
          if (Array.isArray(value) && value.length > 0) {
            const firstItem = value[0];
            if (firstItem && typeof firstItem === 'object' && (firstItem.anchors || firstItem.title)) {
              structure = value;
              break;
            }
          }
        }
      }

      if (structure.length) {
        const findNode = (items: any[]): any => {
          for (const item of items) {
            const matchById =
              node.node_id &&
              (item.node_id === node.node_id || item.id === node.node_id);
            const matchByStructure =
              node.structure && item.structure === node.structure;
            const matchByTitle =
              node.full_title &&
              (item.full_title === node.full_title || item.title === node.full_title);

            if (matchById || matchByStructure || matchByTitle) {
              return item;
            }
            if (Array.isArray(item.nodes) && item.nodes.length) {
              const found = findNode(item.nodes);
              if (found) return found;
            }
          }
          return null;
        };

        const jsonNode = findNode(structure);
        if (jsonNode && jsonNode.anchors) {
          const anchor = jsonNode.anchors.start_page || jsonNode.anchors.full_range;
          const jsonPage = anchor?.page || anchor?.start_page || null;
          const jsonX0 = anchor?.x0 ?? null;
          const jsonY0 = anchor?.y0 ?? null;

          this.matchedNode = {
            node: jsonNode,
            jsonPage: jsonPage ?? undefined,
            jsonX0: jsonX0 ?? undefined,
            jsonY0: jsonY0 ?? undefined,
            distance: undefined,
            accuracy: 'not_found',
          };
        }
      }
    }

    // Scroll đến trang start_page trước, sau đó mới vẽ icon
    if (node && node.anchors_full_range?.start_page) {
      this.scrollToPage(node.anchors_full_range.start_page);
      // Re-render để vẽ icon điểm bắt đầu sau khi scroll
      // scrollToPosition sẽ được gọi trong renderSelectedNodeStartMarker
      setTimeout(() => this.renderPdfAnnotations(), 800);
    } else {
      // Nếu không có start_page, chỉ vẽ icon
      setTimeout(() => this.renderPdfAnnotations(), 200);
    }
  }

  /** Tìm item gốc trong jsonStructure tương ứng selectedNode (để ghi lại chỉnh sửa). */
  private findRawNodeInStructure(node: StructureNode): any {
    const json = this.documentService.state.jsonStructure;
    if (!json) return null;
    let structure: any[] = [];
    if (json.structure && Array.isArray(json.structure)) structure = json.structure;
    else if (Array.isArray(json)) structure = json;
    else {
      for (const key of Object.keys(json)) {
        const value = (json as any)[key];
        if (Array.isArray(value) && value.length > 0) {
          const first = value[0];
          if (first && typeof first === 'object' && (first.anchors || first.title)) {
            structure = value;
            break;
          }
        }
      }
    }
    const find = (items: any[]): any => {
      for (const item of items) {
        const match =
          (node.node_id && (item.node_id === node.node_id || item.id === node.node_id)) ||
          (node.structure && item.structure === node.structure) ||
          (node.full_title && (item.full_title === node.full_title || item.title === node.full_title));
        if (match) return item;
        if (Array.isArray(item.nodes) && item.nodes.length) {
          const found = find(item.nodes);
          if (found) return found;
        }
      }
      return null;
    };
    return find(structure);
  }

  /** Bbox hiển thị trên panel: ưu tiên editableBbox đã chỉnh, không thì lấy từ anchor JSON. */
  get currentDisplayBbox(): { page: number; x0: number; y0: number; x1: number; y1: number } | null {
    if (!this.selectedNode) return null;
    const nodeId = this.selectedNode.node_id ?? this.selectedNode.full_title ?? '';
    if (this.editableBbox && this.editableBbox.nodeId === nodeId) {
      return this.editableBbox;
    }
    const raw = this.findRawNodeInStructure(this.selectedNode);
    if (!raw?.anchors) return null;
    const anchor = raw.anchors.start_page || raw.anchors.full_range;
    if (!anchor) return null;
    const page = anchor.page ?? anchor.start_page ?? 1;
    const x0 = anchor.x0 ?? 0;
    const y0 = anchor.y0 ?? 0;
    const x1 = anchor.x1 ?? this.pdfPageWidth;
    const y1 = anchor.y1 ?? this.pdfPageHeight;
    return { page, x0, y0, x1, y1 };
  }

  /** Ghi bbox hiện tại (x0,y0,x1,y1) vào jsonStructure và re-render. */
  saveBboxToJson(): void {
    const bbox = this.currentDisplayBbox;
    if (!bbox || !this.selectedNode) return;
    const raw = this.findRawNodeInStructure(this.selectedNode);
    if (!raw) return;
    if (!raw.anchors) raw.anchors = {};
    const target = raw.anchors.start_page || raw.anchors.full_range;
    if (target) {
      target.page = bbox.page;
      target.x0 = bbox.x0;
      target.y0 = bbox.y0;
      target.x1 = bbox.x1;
      target.y1 = bbox.y1;
    } else {
      raw.anchors.start_page = { page: bbox.page, x0: bbox.x0, y0: bbox.y0, x1: bbox.x1, y1: bbox.y1 };
    }
    const nodeId = this.selectedNode.node_id ?? this.selectedNode.full_title ?? '';
    this.editableBbox = { nodeId, ...bbox };
    setTimeout(() => this.renderPdfAnnotations(), 100);
  }

  /** Đồng bộ chỉnh sửa từ selectedNode vào jsonStructure. */
  onNodeDetailChange(): void {
    const node = this.selectedNode;
    if (!node) return;
    const raw = this.findRawNodeInStructure(node);
    if (!raw) return;
    raw.full_title = node.full_title ?? raw.full_title;
    raw.title = raw.full_title;
    raw.summary = node.summary ?? raw.summary;
    if (node.ocr_text !== undefined) {
      raw.content = raw.content || {};
      raw.content.ocr = raw.content.ocr || {};
      raw.content.ocr.text = node.ocr_text;
    }
  }

  /** Lưu jsonStructure thành file mới với tên xxx_ver_N.json. */
  async saveAsNewVersion(): Promise<void> {
    const state = this.documentService.state;
    if (!state.selectedDocId || !state.selectedOutputName || !state.jsonStructure) {
      this.saveNewVersionStatus = 'Chọn doc và file JSON trước.';
      return;
    }
    this.saveNewVersionStatus = 'Đang lưu...';
    try {
      // Bỏ .json và bỏ _ver_N nếu có để tên gốc ví dụ: 02kh_vllm_structure
      const base = state.selectedOutputName.replace(/\.json$/i, '').replace(/_ver_\d+$/i, '');
      let outputs: { name: string }[] = [];
      try {
        outputs = await firstValueFrom(this.ragApi.getOutputs(state.selectedDocId));
      } catch {
        // ignore
      }
      const verPattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_ver_(\\d+)\\.json$`, 'i');
      let maxVer = 0;
      for (const o of outputs) {
        const m = o.name.match(verPattern);
        if (m) maxVer = Math.max(maxVer, parseInt(m[1], 10));
      }
      const newFilename = `${base}_ver_${maxVer + 1}.json`;
      const jsonText = JSON.stringify(state.jsonStructure, null, 2);
      await firstValueFrom(this.ragApi.saveEditor(state.selectedDocId, newFilename, jsonText, false));
      this.saveNewVersionStatus = `Đã lưu: ${newFilename}`;
      // Refresh danh sách outputs và chọn file mới để JSON Editor load đúng
      try {
        const outputs = await firstValueFrom(this.ragApi.getOutputs(state.selectedDocId));
        this.documentService.setOutputs(outputs);
        const newOutput = outputs.find(o => o.name === newFilename);
        if (newOutput) {
          this.documentService.setSelectedOutputName(newFilename);
        }
      } catch {
        // ignore
      }
    } catch (e: any) {
      this.saveNewVersionStatus = 'Lỗi: ' + (e?.message || e);
    }
  }

  /** Scroll PDF viewer to a specific page number. */
  scrollToPage(page: number): void {
    if (!this.pdfCanvasContainer || page < 1 || page > this.totalPages) return;

    const container = this.pdfCanvasContainer.nativeElement;
    const canvases = container.querySelectorAll('.pdf-page-canvas');
    
    if (canvases.length === 0) return;

    // Tìm canvas của trang cần scroll
    const targetCanvas = canvases[page - 1] as HTMLCanvasElement;
    if (!targetCanvas) return;

    // Scroll đến canvas đó
    targetCanvas.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });

    this.currentPage = page;
    
    // Re-render annotations sau khi scroll
    setTimeout(() => this.renderPdfAnnotations(), 300);
  }

  /** Scroll PDF viewer container đến vị trí cụ thể (page, y0) trong PDF. */
  scrollToPosition(page: number, y0: number, pdfWidth?: number, pdfHeight?: number): void {
    if (!this.pdfCanvasContainer || page < 1 || page > this.totalPages) return;

    const container = this.pdfCanvasContainer.nativeElement;
    const canvases = container.querySelectorAll('.pdf-page-canvas');
    
    if (canvases.length === 0) return;

    // Tìm canvas của trang cần scroll
    const targetCanvas = canvases[page - 1] as HTMLCanvasElement;
    if (!targetCanvas) return;

    // Tính vị trí y0 trong canvas (pixel)
    const y0Px = y0 * this.pdfScale;
    
    // Tính offset của trang này
    const pageHeightPx = this.pdfPageHeight * this.pdfScale;
    const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);
    
    // Vị trí scroll: offset của trang + vị trí y0 trong trang - margin top
    const scrollTop = pageOffsetY + y0Px - 150; // Trừ 150px để icon không ở sát top

    // Scroll container hoặc window đến vị trí này
    const parentContainer = container.parentElement; // .pdf-container
    if (parentContainer) {
      // Tìm scrollable parent
      let scrollContainer: HTMLElement | null = parentContainer;
      while (scrollContainer && scrollContainer !== document.body) {
        const style = window.getComputedStyle(scrollContainer);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll' || 
            scrollContainer.scrollHeight > scrollContainer.clientHeight) {
          scrollContainer.scrollTo({
            top: Math.max(0, scrollTop),
            behavior: 'smooth'
          });
          console.log(`Scroll container đến trang ${page}, y0=${y0}, scrollTop=${scrollTop}`);
          return;
        }
        scrollContainer = scrollContainer.parentElement;
      }
    }

    // Fallback: scroll window
    const rect = container.getBoundingClientRect();
    const windowScrollTop = window.scrollY + rect.top + scrollTop - 100;
    window.scrollTo({
      top: Math.max(0, windowScrollTop),
      behavior: 'smooth'
    });
    console.log(`Scroll window đến trang ${page}, y0=${y0}, windowScrollTop=${windowScrollTop}`);
  }

  /** Xử lý click trên coordinates capture layer để so sánh với JSON. */
  onOverlayClick(event: MouseEvent): void {
    // Chỉ xử lý nếu click vào background, không phải marker/icon
    const target = event.target as HTMLElement;
    if (target.classList.contains('pdf-annotation-marker') || 
        target.classList.contains('pdf-start-marker')) {
      return; // Để marker xử lý click của nó
    }

    // Tính toán tọa độ từ click (nếu chưa có từ mousemove)
    this.updateCoordinates(event);
    
    // Tìm node gần nhất trong JSON structure khi click
    this.findNearestNode();
    
    // Log ra console
    console.log('=== Tọa độ PDF (click) ===');
    console.log(`Page: ${this.pdfCoordinates.page}`);
    console.log(`x: ${this.pdfCoordinates.x?.toFixed(2)}`);
    console.log(`y: ${this.pdfCoordinates.y?.toFixed(2)}`);
    if (this.matchedNode?.node) {
      console.log('=== Node gần nhất từ JSON ===');
      console.log(`Title: ${this.matchedNode.node.title || this.matchedNode.node.full_title}`);
      console.log(`JSON x0: ${this.matchedNode.jsonX0?.toFixed(2)}`);
      console.log(`JSON y0: ${this.matchedNode.jsonY0?.toFixed(2)}`);
      console.log(`JSON Page: ${this.matchedNode.jsonPage}`);
      console.log(`Khoảng cách: ${this.matchedNode.distance?.toFixed(2)} points`);
      console.log(`Đánh giá: ${this.matchedNode.accuracy}`);
    }
  }

  /** Calibrate khoảng trắng giữa các trang từ click hiện tại. */
  /** Helper: Tính pageOffsetY từ canvas container (không cần calibration vì kiểm soát layout). */
  private getPageOffsetY(page: number, pageHeightPx: number): number {
    if (!this.pdfCanvasContainer) return 0;
    
    const container = this.pdfCanvasContainer.nativeElement;
    const canvases = container.querySelectorAll('.pdf-page-canvas');
    
    let offsetY = 0;
    const gapBetweenPages = 10; // px, khoảng cách giữa các trang (từ CSS margin-bottom)
    
    // Tính tổng chiều cao của các trang trước đó + gap
    for (let i = 0; i < page - 1 && i < canvases.length; i++) {
      const canvas = canvases[i] as HTMLCanvasElement;
      if (canvas) {
        offsetY += canvas.height + gapBetweenPages;
      }
    }
    
    return offsetY;
  }

  /** Tính toán và cập nhật tọa độ từ mouse event (dùng với canvas). */
  private updateCoordinates(event: MouseEvent): void {
    if (!this.pdfAnnotationsOverlay || !this.pdfCanvasContainer) return;

    const overlay = this.pdfAnnotationsOverlay.nativeElement;
    const container = overlay.parentElement; // .pdf-container
    if (!container) return;

    // Tọa độ màn hình (relative to container)
    const rect = container.getBoundingClientRect();
    const screenX = event.clientX - rect.left;
    const screenY = event.clientY - rect.top;

    this.screenCoordinates = { x: screenX, y: screenY };

    // Tính toán tọa độ PDF từ canvas
    const canvases = this.pdfCanvasContainer.nativeElement.querySelectorAll('.pdf-page-canvas');
    if (canvases.length === 0) return;

    // Tìm canvas nào chứa điểm click
    let currentY = 0;
    let foundPage = 1;
    let yInPage = 0;
    const gapBetweenPages = 10; // px, khớp với CSS margin-bottom

    for (let i = 0; i < canvases.length; i++) {
      const canvas = canvases[i] as HTMLCanvasElement;
      const canvasHeight = canvas.height;
      const nextY = currentY + canvasHeight + gapBetweenPages;

      if (screenY >= currentY && screenY < nextY) {
        foundPage = i + 1;
        yInPage = screenY - currentY;
        break;
      }

      currentY = nextY;
    }

    // Chuyển đổi từ pixel sang PDF points (dùng scale đã render)
    const pdfX = screenX / this.pdfScale;
    const pdfY = yInPage / this.pdfScale;

    this.pdfCoordinates = {
      page: foundPage,
      x: Math.max(0, pdfX),
      y: Math.max(0, pdfY)
    };
  }

  /** Tìm node gần nhất trong JSON structure dựa vào tọa độ click. */
  private findNearestNode(): void {
    if (!this.pdfCoordinates.page || !this.pdfCoordinates.x || !this.pdfCoordinates.y) {
      this.matchedNode = null;
      return;
    }

    const state = this.documentService.state;
    if (!state.jsonStructure) {
      this.matchedNode = null;
      return;
    }

    // Tìm structure array
    let structure: any[] = [];
    if (state.jsonStructure.structure && Array.isArray(state.jsonStructure.structure)) {
      structure = state.jsonStructure.structure;
    } else if (Array.isArray(state.jsonStructure)) {
      structure = state.jsonStructure;
    } else {
      for (const key of Object.keys(state.jsonStructure)) {
        const value = (state.jsonStructure as any)[key];
        if (Array.isArray(value) && value.length > 0) {
          const firstItem = value[0];
          if (firstItem && typeof firstItem === 'object' && (firstItem.anchors || firstItem.title)) {
            structure = value;
            break;
          }
        }
      }
    }

    if (structure.length === 0) {
      this.matchedNode = null;
      return;
    }

    const clickPage = this.pdfCoordinates.page;
    const clickX = this.pdfCoordinates.x;
    const clickY = this.pdfCoordinates.y;

    let nearestNode: any = null;
    let minDistance = Infinity;
    let nearestJsonX0 = 0;
    let nearestJsonY0 = 0;
    let nearestJsonPage = 0;

    // Duyệt qua tất cả nodes để tìm node gần nhất
    const walk = (items: any[]): void => {
      for (const item of items) {
        if (!item.anchors) {
          if (Array.isArray(item.nodes) && item.nodes.length) {
            walk(item.nodes);
          }
          continue;
        }

        // Lấy anchor từ start_page hoặc full_range
        const anchor = item.anchors.start_page || item.anchors.full_range;
        if (!anchor) {
          if (Array.isArray(item.nodes) && item.nodes.length) {
            walk(item.nodes);
          }
          continue;
        }

        const nodePage = anchor.page || anchor.start_page;
        if (!nodePage) {
          if (Array.isArray(item.nodes) && item.nodes.length) {
            walk(item.nodes);
          }
          continue;
        }

        // Chỉ xét các node trên cùng trang
        if (nodePage === clickPage) {
          const jsonX0 = anchor.x0 || 0;
          const jsonY0 = anchor.y0 || 0;

          // Tính khoảng cách Euclidean
          const dx = clickX - jsonX0;
          const dy = clickY - jsonY0;
          const distance = Math.sqrt(dx * dx + dy * dy);

          if (distance < minDistance) {
            minDistance = distance;
            nearestNode = item;
            nearestJsonX0 = jsonX0;
            nearestJsonY0 = jsonY0;
            nearestJsonPage = nodePage;
          }
        }

        // Đệ quy qua children
        if (Array.isArray(item.nodes) && item.nodes.length) {
          walk(item.nodes);
        }
      }
    };

    walk(structure);

    // Đánh giá độ chính xác
    let accuracy: 'exact' | 'close' | 'far' | 'not_found' = 'not_found';
    if (nearestNode) {
      if (minDistance < 5) {
        accuracy = 'exact'; // Lệch < 5 points
      } else if (minDistance < 20) {
        accuracy = 'close'; // Lệch < 20 points
      } else {
        accuracy = 'far'; // Lệch >= 20 points
      }
    }

    this.matchedNode = {
      node: nearestNode,
      distance: minDistance === Infinity ? undefined : minDistance,
      jsonX0: nearestJsonX0,
      jsonY0: nearestJsonY0,
      jsonPage: nearestJsonPage,
      accuracy
    };
  }

  showPdfContentPopup(node: any): void {
    if (!node) return;
    // Remove old popup
    const oldPopup = document.getElementById('pdf-content-popup');
    if (oldPopup) {
      oldPopup.remove();
    }

    const popup = document.createElement('div');
    popup.id = 'pdf-content-popup';
    popup.className = 'pdf-content-popup';

    const title = node.title || 'Nội dung';
    const ocrText = node.content?.ocr?.text || node.content?.ocr?.pages?.[0]?.text || '';
    const summaryText = node.summary || '';

    const summaryTabClass = !ocrText ? 'active' : '';
    const summaryPanelClass = !ocrText && summaryText ? 'active' : '';

    popup.innerHTML = `
      <div class="pdf-content-popup-header">
        <h3>${title}</h3>
        <button class="pdf-content-popup-close">×</button>
      </div>
      <div class="pdf-content-popup-tabs">
        ${ocrText ? '<button class="pdf-content-popup-tab active" data-tab="ocr">OCR</button>' : ''}
        ${summaryText ? `<button class="pdf-content-popup-tab ${summaryTabClass}" data-tab="summary">Summary</button>` : ''}
      </div>
      <div class="pdf-content-popup-content">
        ${ocrText ? `<div class="pdf-content-popup-panel active" data-panel="ocr">${ocrText.replace(/\n/g, '<br>')}</div>` : ''}
        ${summaryText ? `<div class="pdf-content-popup-panel ${summaryPanelClass}" data-panel="summary">${summaryText.replace(/\n/g, '<br>')}</div>` : ''}
      </div>
    `;

    document.body.appendChild(popup);

    // Close button
    popup.querySelector('.pdf-content-popup-close')?.addEventListener('click', () => {
      popup.remove();
    });

    // Tab switching
    popup.querySelectorAll('.pdf-content-popup-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        popup.querySelectorAll('.pdf-content-popup-tab').forEach(t => t.classList.remove('active'));
        popup.querySelectorAll('.pdf-content-popup-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        popup.querySelector(`[data-panel="${tabName}"]`)?.classList.add('active');
      });
    });

    // Click outside to close
    popup.addEventListener('click', (e) => {
      if (e.target === popup) {
        popup.remove();
      }
    });
  }
}
