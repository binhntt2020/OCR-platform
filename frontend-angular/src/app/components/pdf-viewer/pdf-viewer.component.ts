import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, Input, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { DocumentService } from '../../services/document.service';
import { RagApiService } from '../../services/rag-api.service';
import { DetectResult } from '../../services/rag-api.service';
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

  /** Raw PDF URL để load bằng PDF.js */
  private rawPdfUrl: string | null = null;
  showPlaceholder = true;
  showPdf = false;
  isFullscreen = false;
  isLoadingPdf = false;
  /** Lỗi khi tải PDF (vẫn giữ trạng thái đã chọn doc, không quay về "Chọn file..."). */
  pdfLoadError: string | null = null;
  
  /** Hiển thị tọa độ cố định khi di chuột */
  showCoordinates = false;
  /** Hiển thị OCR bbox trên PDF (đồng bộ với documentService.state.showOcrBboxOnPdf) */
  get showOcrBbox(): boolean {
    return this.documentService.state.showOcrBboxOnPdf;
  }
  /** Hiển thị vùng Detect (CRAFT) trên PDF */
  get showDetectBbox(): boolean {
    return this.documentService.state.showDetectBboxOnPdf;
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
  pdfCoordinates: { page?: number; x?: number; y?: number } = {};
  screenCoordinates: { x?: number; y?: number } = {};

  /** Scale để render PDF (tự động tính từ container width) */
  private pdfScale: number = 1.0;
  /** Đang load doc này (tránh gọi load 2 lần cho cùng doc). */
  private loadingDocId: string | null = null;
  /** Đang render canvas (tránh render trùng/đồng thời). */
  private isRenderingPages = false;

  /** Bản copy kết quả Detect để chỉnh sửa (kéo, đổi kích thước, xóa vùng). */
  editableDetectResult: DetectResult | null = null;
  /** DocId đã đồng bộ editableDetectResult — tránh ghi đè khi user đang chỉnh */
  private lastEditableDetectDocId: string | null = null;
  /** Đang kéo di chuyển vùng Detect */
  private detectDrag: { pageIndex: number; boxIndex: number; startLeft: number; startTop: number; startClientX: number; startClientY: number; el: HTMLElement } | null = null;
  /** Đang kéo đổi kích thước vùng Detect */
  private detectResize: { pageIndex: number; boxIndex: number; startLeft: number; startTop: number; startW: number; startH: number; startClientX: number; startClientY: number; el: HTMLElement } | null = null;
  /** Đang lưu thay đổi Detect lên server */
  savingDetect = false;
  /** Thông báo sau khi lưu Detect */
  saveDetectMessage = '';

  /** Stack để hoàn tác (undo) khi xóa/thêm/chỉnh ô detect — tối đa 30 bước */
  private detectUndoStack: DetectResult[] = [];
  private static readonly DETECT_UNDO_MAX = 30;

  private destroy$ = new Subject<void>();
  private static readonly PDF_TO_IMAGE = 150 / 72;

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
              this.renderPdfAnnotations();
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
      
      // Re-render khi có kết quả Detect (poll sau upload) hoặc khi đổi block OCR được chọn (highlight)
      if (state.selectedDocId && state.detectResult[state.selectedDocId] && this.showPdf && this.pdfDoc) {
        setTimeout(() => this.renderPdfAnnotations(), 200);
      }
      if (state.selectedOcrBlock != null && this.showPdf && this.pdfDoc) {
        setTimeout(() => {
          this.renderPdfAnnotations();
          this.scrollToPage(state.selectedOcrBlock!.pageIndex + 1);
        }, 50);
      }
      // Đồng bộ bản copy chỉnh sửa Detect chỉ khi đổi doc hoặc mới có detect (không ghi đè khi user đang chỉnh)
      if (!state.selectedDocId || !state.detectResult[state.selectedDocId]) {
        this.editableDetectResult = null;
        this.lastEditableDetectDocId = null;
        this.detectUndoStack = [];
      } else if (this.lastEditableDetectDocId !== state.selectedDocId) {
        this.editableDetectResult = this.deepCopyDetectResult(state.detectResult[state.selectedDocId]);
        this.lastEditableDetectDocId = state.selectedDocId;
        this.detectUndoStack = [];
      }
    });
  }

  private deepCopyDetectResult(d: DetectResult): DetectResult {
    return {
      job_id: d.job_id,
      pages: (d.pages || []).map(p => ({
        page_index: p.page_index,
        width: p.width,
        height: p.height,
        boxes: (p.boxes || []).map(b => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })),
      })),
    };
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
    setTimeout(() => {
      const state = this.documentService.state;
      if (state.selectedDocId && this.showPdf && this.pdfDoc) {
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
    if (this.detectDrag) {
      const dx = e.clientX - this.detectDrag.startClientX;
      const dy = e.clientY - this.detectDrag.startClientY;
      this.detectDrag.el.style.left = `${Math.max(0, this.detectDrag.startLeft + dx)}px`;
      this.detectDrag.el.style.top = `${Math.max(0, this.detectDrag.startTop + dy)}px`;
      return;
    }
    if (this.detectResize) {
      const dw = e.clientX - this.detectResize.startClientX;
      const dh = e.clientY - this.detectResize.startClientY;
      const w = Math.max(8, this.detectResize.startW + dw);
      const h = Math.max(8, this.detectResize.startH + dh);
      this.detectResize.el.style.width = `${w}px`;
      this.detectResize.el.style.height = `${h}px`;
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
    if (this.detectDrag || this.detectResize) {
      this.commitDetectDragOrResize();
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
        this.renderPdfAnnotations();
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
        this.renderPdfAnnotations();
      }
    }, 200);
  }

  /** Chỉ vẽ vùng Detect (CRAFT); không dùng structure/mục lục. */
  renderPdfAnnotations(): void {
    if (!this.pdfAnnotationsOverlay || !this.pdfCanvasContainer || !this.pdfDoc) return;

    const state = this.documentService.state;
    const hasDetect = state.selectedDocId && state.detectResult[state.selectedDocId]?.pages?.length;
    if (!hasDetect) {
      this.clearAnnotations();
      return;
    }

    const overlay = this.pdfAnnotationsOverlay.nativeElement;
    if (this.pdfScale === 0 || this.pdfPageWidth === 0) {
      setTimeout(() => this.renderPdfAnnotations(), 500);
      return;
    }

    const canvasEl = this.pdfCanvasContainer.nativeElement;
    const containerHeight = canvasEl.scrollHeight || canvasEl.offsetHeight;

    overlay.innerHTML = '';
    overlay.style.display = 'block';
    overlay.style.height = `${containerHeight}px`;

    if (this.showDetectBbox && state.selectedDocId) {
      const detectData = state.detectResult[state.selectedDocId];
      if (detectData?.pages?.length) {
        this.renderDetectBoxes(overlay, detectData);
      }
    }
  }

  /** Tọa độ Detect từ ảnh 150 DPI -> PDF points: nhân 72/150 */
  private static readonly IMAGE_TO_PDF_SCALE = 72 / 150;

  /** Chuyển (left, top, width, height) trên overlay (px) sang tọa độ ảnh 150 DPI cho trang pageIndex (0-based). */
  private screenToImageBox(left: number, top: number, w: number, h: number, pageIndex: number): { x1: number; y1: number; x2: number; y2: number } {
    const pageHeightPx = this.pdfPageHeight * this.pdfScale;
    const pageOffsetY = this.getPageOffsetY(pageIndex + 1, pageHeightPx);
    const topInPage = top - pageOffsetY;
    const k = PdfViewerComponent.PDF_TO_IMAGE / this.pdfScale;
    return {
      x1: Math.round((left) * k),
      y1: Math.round((topInPage) * k),
      x2: Math.round((left + w) * k),
      y2: Math.round((topInPage + h) * k),
    };
  }

  /** Vẽ các vùng Detect (CRAFT) lên overlay. Khi có selectedOcrBlock thì chỉ vẽ đúng 1 vùng được chọn (ẩn hết vùng khác). */
  private renderDetectBoxes(overlay: HTMLElement, detectData: { job_id: string; pages: Array<{ page_index: number; width: number; height: number; boxes: Array<{ x1: number; y1: number; x2: number; y2: number }> }> }): void {
    const scale = PdfViewerComponent.IMAGE_TO_PDF_SCALE;
    const scaleX = this.pdfScale;
    const scaleY = this.pdfScale;
    const pageHeightPx = this.pdfPageHeight * this.pdfScale;
    const data = this.editableDetectResult ?? detectData;
    const sel = this.documentService.state.selectedOcrBlock;

    const drawOneBox = (pageData: { page_index: number; boxes: Array<{ x1: number; y1: number; x2: number; y2: number }> }, box: { x1: number; y1: number; x2: number; y2: number }, idx: number, pageIndex: number, isOnlyOne: boolean) => {
      const page = pageData.page_index + 1;
      const pageOffsetY = this.getPageOffsetY(page, pageHeightPx);
      const isHighlight = isOnlyOne || (sel?.pageIndex === pageIndex && sel?.blockIndex === idx);

        const x1Pdf = box.x1 * scale;
        const y1Pdf = box.y1 * scale;
        const x2Pdf = box.x2 * scale;
        const y2Pdf = box.y2 * scale;

        const left = x1Pdf * scaleX;
        const top = pageOffsetY + y1Pdf * scaleY;
        const w = Math.max(4, (x2Pdf - x1Pdf) * scaleX);
        const h = Math.max(4, (y2Pdf - y1Pdf) * scaleY);

        const wrapper = document.createElement('div');
        wrapper.className = 'pdf-detect-bbox-wrapper' + (isHighlight ? ' pdf-detect-bbox-wrapper--highlight' : '');
        wrapper.style.position = 'absolute';
        wrapper.style.left = `${left}px`;
        wrapper.style.top = `${top}px`;
        wrapper.style.width = `${w}px`;
        wrapper.style.height = `${h}px`;
        wrapper.style.pointerEvents = 'auto';

        const rect = document.createElement('div');
        rect.className = isHighlight ? 'pdf-detect-bbox pdf-detect-bbox--highlight' : 'pdf-detect-bbox';
        rect.style.position = 'absolute';
        rect.style.inset = '0';
        rect.style.boxSizing = 'border-box';
        rect.style.pointerEvents = 'auto';
        rect.style.cursor = 'move';
        rect.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.pushDetectUndo();
          this.detectDrag = { pageIndex, boxIndex: idx, startLeft: wrapper.offsetLeft, startTop: wrapper.offsetTop, startClientX: e.clientX, startClientY: e.clientY, el: wrapper };
        });

        const resizeHandle = document.createElement('div');
        resizeHandle.className = 'pdf-detect-resize-handle';
        resizeHandle.title = 'Kéo để đổi kích thước';
        resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.pushDetectUndo();
          this.detectResize = { pageIndex, boxIndex: idx, startLeft: wrapper.offsetLeft, startTop: wrapper.offsetTop, startW: wrapper.offsetWidth, startH: wrapper.offsetHeight, startClientX: e.clientX, startClientY: e.clientY, el: wrapper };
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'pdf-detect-delete';
        deleteBtn.textContent = '×';
        deleteBtn.title = 'Xóa vùng này';
        deleteBtn.addEventListener('click', (e: MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          this.removeDetectBox(pageIndex, idx);
        });

        wrapper.appendChild(rect);
        wrapper.appendChild(resizeHandle);
        wrapper.appendChild(deleteBtn);
        overlay.appendChild(wrapper);
    };

    if (sel != null) {
      const pageData = data.pages?.[sel.pageIndex];
      const box = pageData?.boxes?.[sel.blockIndex];
      if (pageData && box) {
        drawOneBox(pageData, box, sel.blockIndex, sel.pageIndex, true);
      }
      return;
    }

    data.pages.forEach((pageData) => {
      const pageIndex = pageData.page_index;
      (pageData.boxes || []).forEach((box, idx) => {
        drawOneBox(pageData, box, idx, pageIndex, false);
      });
    });
  }

  private removeDetectBox(pageIndex: number, boxIndex: number): void {
    if (!this.editableDetectResult?.pages?.[pageIndex]?.boxes) return;
    this.pushDetectUndo();
    this.editableDetectResult.pages[pageIndex].boxes.splice(boxIndex, 1);
    this.cdr.markForCheck();
    setTimeout(() => this.renderPdfAnnotations(), 0);
  }

  /** Lưu trạng thái hiện tại vào stack undo trước khi sửa (xóa/thêm/di chuyển/đổi cỡ). */
  private pushDetectUndo(): void {
    if (!this.editableDetectResult) return;
    const copy = this.deepCopyDetectResult(this.editableDetectResult);
    this.detectUndoStack.push(copy);
    if (this.detectUndoStack.length > PdfViewerComponent.DETECT_UNDO_MAX) {
      this.detectUndoStack.shift();
    }
  }

  /** Hoàn tác một bước (khôi phục trạng thái trước khi xóa/thêm/chỉnh). */
  undoDetect(): void {
    if (this.detectUndoStack.length === 0 || !this.editableDetectResult) return;
    const prev = this.detectUndoStack.pop()!;
    this.editableDetectResult.job_id = prev.job_id;
    this.editableDetectResult.pages = prev.pages.map(p => ({
      page_index: p.page_index,
      width: p.width,
      height: p.height,
      boxes: (p.boxes || []).map(b => ({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })),
    }));
    this.cdr.markForCheck();
    setTimeout(() => this.renderPdfAnnotations(), 0);
  }

  /** Có thể undo (stack không rỗng). */
  get canUndoDetect(): boolean {
    return this.detectUndoStack.length > 0 && !!this.editableDetectResult;
  }

  /** Thêm một ô detect mới vào trang đầu (trang 0). User có thể kéo/đổi cỡ sau. */
  addNewDetectBox(): void {
    if (!this.editableDetectResult?.pages?.length) return;
    this.pushDetectUndo();
    const page0 = this.editableDetectResult.pages[0];
    const w = page0.width || 2480;
    const h = page0.height || 3508;
    const margin = 80;
    const boxW = 200;
    const boxH = 36;
    const newBox = {
      x1: margin,
      y1: margin,
      x2: margin + boxW,
      y2: margin + boxH,
    };
    if (!page0.boxes) page0.boxes = [];
    page0.boxes.push(newBox);
    this.cdr.markForCheck();
    setTimeout(() => this.renderPdfAnnotations(), 0);
  }

  private commitDetectDragOrResize(): void {
    if (this.detectDrag) {
      const { pageIndex, boxIndex, el } = this.detectDrag;
      const box = this.screenToImageBox(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight, pageIndex);
      if (this.editableDetectResult?.pages?.[pageIndex]?.boxes?.[boxIndex]) {
        this.editableDetectResult.pages[pageIndex].boxes[boxIndex] = box;
      }
      this.detectDrag = null;
    }
    if (this.detectResize) {
      const { pageIndex, boxIndex, el } = this.detectResize;
      const box = this.screenToImageBox(el.offsetLeft, el.offsetTop, el.offsetWidth, el.offsetHeight, pageIndex);
      if (this.editableDetectResult?.pages?.[pageIndex]?.boxes?.[boxIndex]) {
        this.editableDetectResult.pages[pageIndex].boxes[boxIndex] = box;
      }
      this.detectResize = null;
    }
    this.cdr.markForCheck();
    setTimeout(() => this.renderPdfAnnotations(), 0);
  }

  /** Lưu thay đổi vùng Detect lên server (PATCH). */
  saveDetectToServer(): void {
    const docId = this.documentService.state.selectedDocId;
    if (!docId || !this.editableDetectResult) return;
    this.savingDetect = true;
    this.saveDetectMessage = '';
    this.cdr.markForCheck();
    this.ragApi.updateDetectResult(docId, this.editableDetectResult, 'demo').subscribe({
      next: () => {
        this.documentService.setDetectResult(docId, this.editableDetectResult!);
        this.savingDetect = false;
        this.saveDetectMessage = 'Đã lưu.';
        this.cdr.markForCheck();
        setTimeout(() => { this.saveDetectMessage = ''; this.cdr.markForCheck(); }, 3000);
      },
      error: (err) => {
        this.savingDetect = false;
        this.saveDetectMessage = 'Lỗi: ' + (err?.error?.detail || err?.message || 'Lưu thất bại');
        this.cdr.markForCheck();
      },
    });
  }

  clearAnnotations(): void {
    if (this.pdfAnnotationsOverlay) {
      const overlay = this.pdfAnnotationsOverlay.nativeElement;
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      overlay.classList.remove('active');
    }
  }

  /** No-op: giữ để component khác (json-editor, structure-tree) gọi không lỗi. */
  setActiveSourceMap(_map: any): void {}

  /** No-op: giữ để component khác gọi không lỗi. */
  setSelectedNode(_node: any): void {}

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

  /** Cập nhật tọa độ khi click trên vùng PDF. */
  onOverlayClick(event: MouseEvent): void {
    this.updateCoordinates(event);
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

}
