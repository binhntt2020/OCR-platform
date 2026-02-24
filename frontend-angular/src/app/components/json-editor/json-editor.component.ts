import { Component, OnInit, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MarkdownComponent, MarkdownPipe } from 'ngx-markdown';
import { Editor, NgxEditorModule } from 'ngx-editor';
import { StructureNode } from '../../models/structure-node.model';
import { SourceMap } from '../../models/source-map.model';
import { StructureTreeComponent } from '../structure-tree/structure-tree.component';
import { DocumentService } from '../../services/document.service';
import { RagApiService } from '../../services/rag-api.service';

/** Một trang trong kết quả OCR — dùng cho tree tab JSON */
export interface OcrPageNode {
  page_index: number;
  width?: number;
  height?: number;
  blocks: OcrBlockNode[];
}

/** Một vùng OCR (block) — bấm vào sẽ highlight box trên PDF */
export interface OcrBlockNode {
  block_id: string;
  box: number[];
  text: string;
  conf: number;
  blockIndex: number;
}
import { Subject, takeUntil, firstValueFrom } from 'rxjs';
import hljs from 'highlight.js';
import { marked } from 'marked';

@Component({
  selector: 'app-json-editor',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MarkdownComponent,
    MarkdownPipe,
    NgxEditorModule,
    StructureTreeComponent
  ],
  templateUrl: './json-editor.component.html',
  styleUrl: './json-editor.component.scss'
})
export class JsonEditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('markdownPreview', { static: false }) markdownPreview!: ElementRef<HTMLDivElement>;
  /** Removed from template; kept for type compatibility where code checks before use */
  private markdownToc?: ElementRef<HTMLDivElement>;
  private markdownTocList?: ElementRef<HTMLUListElement>;

  activeTab: 'json' | 'markdown' = 'json';
  editorText = '';
  markdownContent = ''; // Raw markdown content from .md file (for preview/TOC)
  /** HTML for ngx-editor: chỉ set khi đọc từ file .md (marked.parse), không sync ngược từ editor */
  markdownEditorHtml = '';
  markdownTocContent = ''; // Extracted TOC content from markdown file
  /** ngx-editor instance; created when component loads, destroyed on destroy */
  editor: Editor = null!;
  /** Flattened structure nodes built from jsonStructure for tree + editor. */
  structureNodes: StructureNode[] = [];
  selectedStructureNode: StructureNode | null = null;
  editorDocId = '';
  editorFilename = '';
  editorStatus = '';
  validateResult = '';
  /** true khi nội dung JSON tab là kết quả OCR đọc từ DB (job.result), Save sẽ gọi PATCH /jobs/{id}/result */
  isOcrResultMode = false;
  /** Cây kết quả OCR (Page → Block → Text) để hiển thị tree và bấm highlight PDF */
  ocrResultTree: OcrPageNode[] | null = null;
  /** Bản gốc parsed (job.result) để sửa/xóa block rồi sync ra editorText khi Save */
  ocrResultRaw: any = null;
  /** Block đang chọn trong tree (pageIndex-blockIndex) để tô active */
  selectedOcrBlockId: string | null = null;
  jsonStructure: any = null; // Store JSON structure for TOC mapping
  jsonlData: Array<{ id: string; text: string; metadata: any }> = []; // Store JSONL data for anchor mapping

  /** Khớp với tenant khi tạo job (rag-api: 'demo') — tránh 403 tenant mismatch */
  private readonly DEFAULT_TENANT = 'demo';
  private destroy$ = new Subject<void>();
  private tocScrollListener?: () => void;

  constructor(
    public documentService: DocumentService,
    private ragApi: RagApiService
  ) {
    // highlight.js is configured in app.config.ts via ngx-markdown markedOptions
  }

  ngOnInit(): void {
    this.editor = new Editor();
    this.documentService.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      // Update editor docId and filename from state
      this.editorDocId = state.selectedDocId || '';
      const previousFilename = this.editorFilename;
      this.editorFilename = state.selectedOutputName || '';
      this.jsonStructure = state.jsonStructure;
      if (this.jsonStructure) {
        this.structureNodes = this.buildStructureNodes(this.jsonStructure);
      } else {
        this.structureNodes = [];
        this.selectedStructureNode = null;
      }
      // Auto-load content when output changes
      if (state.selectedDocId && state.selectedOutputName && previousFilename !== state.selectedOutputName) {
        if (this.activeTab === 'json') {
          // Auto-load JSON content
          this.loadEditor();
        } else if (this.activeTab === 'markdown') {
          // Auto-load markdown content
          this.renderMarkdownTab();
        }
      }
    });
  }

  ngAfterViewInit(): void {
    // Setup TOC scroll listener after view init
    setTimeout(() => this.setupTocScrollListener(), 100);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    this.editor?.destroy();
    if (this.tocScrollListener) {
      this.markdownPreview?.nativeElement?.removeEventListener('scroll', this.tocScrollListener);
    }
  }

  switchTab(tab: 'json' | 'markdown'): void {
    this.activeTab = tab;
    if (tab === 'markdown') {
      this.renderMarkdownTab();
    }
  }

  ocrResultPlaceholder(): string {
    if (!this.editorDocId) return 'Chọn document (job) trong danh sách, sau đó bấm Load để đọc kết quả OCR từ DB.';
    return 'Bấm Load để đọc kết quả OCR từ DB (hoặc chọn file Output và Load cho RAG).';
  }

  /** Parse JSON kết quả OCR thành cây Page → Block (sắp xếp theo tọa độ y, x). */
  buildOcrResultTree(jsonStr: string): OcrPageNode[] | null {
    try {
      const raw = JSON.parse(jsonStr);
      const pages = raw?.pages;
      if (!Array.isArray(pages)) return null;
      return pages.map((p: any) => {
        const blocks: OcrBlockNode[] = (p.blocks || []).map((b: any, idx: number) => ({
          block_id: b.block_id ?? `block-${idx}`,
          box: Array.isArray(b.box) ? b.box : [0, 0, 0, 0],
          text: typeof b.text === 'string' ? b.text : '',
          conf: typeof b.conf === 'number' ? b.conf : 0,
          blockIndex: idx,
        }));
        blocks.sort((a, b) => {
          const y1 = a.box[1] ?? 0, y2 = b.box[1] ?? 0;
          if (y1 !== y2) return y1 - y2;
          return (a.box[0] ?? 0) - (b.box[0] ?? 0);
        });
        return {
          page_index: p.page_index ?? 0,
          width: p.width,
          height: p.height,
          blocks,
        };
      });
    } catch {
      return null;
    }
  }

  /** Bấm vào block trong tree → highlight box trên PDF và scroll tới trang (chỉ hiện 1 vùng). */
  selectOcrBlock(pageIndex: number, blockIndex: number): void {
    this.documentService.setSelectedOcrBlock({ pageIndex, blockIndex });
    this.selectedOcrBlockId = `${pageIndex}-${blockIndex}`;
  }

  /** Cập nhật editorText từ ocrResultRaw (gọi sau khi sửa/xóa trong tree). */
  private syncOcrResultToEditor(): void {
    if (this.ocrResultRaw == null) return;
    this.editorText = JSON.stringify(this.ocrResultRaw, null, 2);
  }

  /** Sửa text của block trong tree và sync ra editorText. */
  updateOcrBlockText(pageIndex: number, blockIndex: number, newText: string): void {
    const raw = this.ocrResultRaw;
    if (!raw?.pages?.[pageIndex]?.blocks?.[blockIndex]) return;
    raw.pages[pageIndex].blocks[blockIndex].text = newText;
    const node = this.ocrResultTree?.[pageIndex]?.blocks?.find(b => b.blockIndex === blockIndex);
    if (node) node.text = newText;
    this.syncOcrResultToEditor();
  }

  /** Xóa block trong tree và sync ra editorText + DB (cần bấm Save để ghi DB). */
  deleteOcrBlock(pageIndex: number, blockIndex: number): void {
    const raw = this.ocrResultRaw;
    if (!raw?.pages?.[pageIndex]?.blocks) return;
    raw.pages[pageIndex].blocks.splice(blockIndex, 1);
    this.ocrResultTree = this.buildOcrResultTree(JSON.stringify(raw));
    this.syncOcrResultToEditor();
    if (this.selectedOcrBlockId === `${pageIndex}-${blockIndex}`) {
      this.documentService.setSelectedOcrBlock(null);
      this.selectedOcrBlockId = null;
    }
  }

  async loadEditor(): Promise<void> {
    const state = this.documentService.state;
    if (!state.selectedDocId) {
      this.editorStatus = 'Chọn document (job) trước.';
      return;
    }

    this.editorStatus = 'Loading...';
    this.isOcrResultMode = false;

    try {
      // Ưu tiên: đọc kết quả OCR từ DB (job.result) khi đang xem job
      const jobRes = await firstValueFrom(
        this.ragApi.getOcrJobStatus(state.selectedDocId, this.DEFAULT_TENANT)
      ).catch(() => null);

      if (jobRes?.result != null && jobRes.result !== '') {
        let formatted = jobRes.result;
        try {
          const parsed = JSON.parse(formatted);
          formatted = JSON.stringify(parsed, null, 2);
        } catch {
          // Giữ nguyên nếu không parse được
        }
        this.editorText = formatted;
        this.isOcrResultMode = true;
        try {
          this.ocrResultRaw = JSON.parse(formatted);
        } catch {
          this.ocrResultRaw = null;
        }
        this.ocrResultTree = this.buildOcrResultTree(formatted);
        this.editorStatus = 'Loaded (kết quả OCR từ DB)';
        this.documentService.setJsonStructure(null);
        this.jsonStructure = null;
        this.structureNodes = [];
        this.documentService.setSelectedOcrBlock(null);
        this.selectedOcrBlockId = null;
        return;
      }

      this.ocrResultTree = null;
      this.ocrResultRaw = null;
      this.selectedOcrBlockId = null;
      this.documentService.setSelectedOcrBlock(null);

      // Fallback: RAG output (cần chọn file)
      if (!state.selectedOutputName) {
        this.editorStatus = jobRes ? 'Job chưa có kết quả OCR. Chạy Run OCR hoặc chọn file Output và Load.' : 'Chọn file Output hoặc chờ job có result.';
        return;
      }

      const text = await firstValueFrom(
        this.ragApi.getOutputContent(state.selectedDocId, state.selectedOutputName)
      );

      let finalText = text;
      if (state.selectedOutputName.endsWith('.json')) {
        try {
          const parsed = JSON.parse(text);
          if (typeof parsed === 'string') {
            finalText = parsed;
          } else {
            finalText = JSON.stringify(parsed, null, 2);
          }
        } catch (e) {
          // Keep original text if parsing fails
        }
      }

      this.editorText = finalText;

      if (state.selectedOutputName.includes('structure') && state.selectedOutputName.endsWith('.json')) {
        try {
          let parsed: any = null;
          let textToParse = text;
          try {
            parsed = JSON.parse(textToParse);
            if (typeof parsed === 'string') parsed = JSON.parse(parsed);
          } catch (e1) {
            if (textToParse.trim().startsWith('"') && textToParse.trim().endsWith('"')) {
              const unescaped = JSON.parse(textToParse);
              if (typeof unescaped === 'string') parsed = JSON.parse(unescaped);
            }
          }
          if (parsed && typeof parsed === 'object') {
            this.documentService.setJsonStructure(parsed);
            this.jsonStructure = parsed;
            this.structureNodes = this.buildStructureNodes(parsed);
          } else {
            this.documentService.setJsonStructure(null);
            this.jsonStructure = null;
            this.structureNodes = [];
          }
        } catch (e) {
          console.warn('Could not parse JSON structure:', e);
          this.documentService.setJsonStructure(null);
        }
      } else {
        this.documentService.setJsonStructure(null);
      }

      this.editorStatus = 'Loaded';
    } catch (e: any) {
      this.editorStatus = 'Load error';
      console.error('Load failed:', e);
    }
  }

  async validateEditor(): Promise<void> {
    const text = this.editorText || '';
    this.editorStatus = 'Validating...';
    this.validateResult = '';
    
    try {
      const res = await firstValueFrom(this.ragApi.validateEditor(text));
      if (res) {
        let html = '';
        html += res.ok
          ? '<div class="badge-ok">OK ✅</div>'
          : '<div class="badge-fail">Invalid ❌</div>';
        
        if (res.errors && res.errors.length) {
          html += '<div><strong>Errors</strong><ul>';
          for (const e of res.errors) {
            html += `<li>${e.path ? e.path + ': ' : ''}${e.message}</li>`;
          }
          html += '</ul></div>';
        }
        
        if (res.warnings && res.warnings.length) {
          html += '<div><strong>Warnings</strong><ul>';
          for (const w of res.warnings) {
            html += `<li>${w.path ? w.path + ': ' : ''}${w.message}</li>`;
          }
          html += '</ul></div>';
        }
        
        this.validateResult = html;
        this.editorStatus = 'Validated';
      }
    } catch (e: any) {
      this.editorStatus = 'Validate error';
      alert('Validate failed: ' + e.message);
    }
  }

  async saveEditor(): Promise<void> {
    const state = this.documentService.state;
    if (!state.selectedDocId) {
      alert('Chọn document (job) trước.');
      return;
    }

    const text = this.editorText ?? '';
    this.editorStatus = 'Saving...';

    try {
      if (this.isOcrResultMode) {
        await firstValueFrom(this.ragApi.updateOcrResult(state.selectedDocId, text, this.DEFAULT_TENANT));
        this.editorStatus = 'Saved (kết quả OCR đã ghi vào DB)';
        return;
      }

      if (!state.selectedOutputName) {
        alert('Chọn file output trước hoặc Load kết quả OCR từ DB rồi chỉnh sửa.');
        this.editorStatus = '';
        return;
      }

      await firstValueFrom(this.ragApi.saveEditor(state.selectedDocId, state.selectedOutputName, text, true));
      this.editorStatus = 'Saved';
    } catch (e: any) {
      this.editorStatus = 'Save error';
      alert('Save failed: ' + (e?.message ?? e));
    }
  }

  /** Build simplified structure tree model from the loaded JSON structure. */
  private buildStructureNodes(structureRoot: any): StructureNode[] {
    const result: StructureNode[] = [];

    if (!structureRoot) {
      return result;
    }

    let topLevel: any[] = [];
    if (Array.isArray(structureRoot)) {
      topLevel = structureRoot;
    } else if (Array.isArray(structureRoot.structure)) {
      topLevel = structureRoot.structure;
    } else {
      // Không đúng schema mong đợi
      return result;
    }

    const walk = (items: any[], parentLevel: number | null = null) => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        const structureValue = item.structure || '';
        const levelFromPrefix = item.parsed_prefix?.level;
        const level =
          typeof levelFromPrefix === 'number'
            ? levelFromPrefix
            : parentLevel !== null
              ? parentLevel + 1
              : 0;

        const anchorsFull = item.anchors?.full_range;
        // Lấy OCR text từ content.ocr.text hoặc content.ocr.pages[].text
        let ocrText = '';
        if (item.content?.ocr?.text) {
          ocrText = item.content.ocr.text;
        } else if (Array.isArray(item.content?.ocr?.pages)) {
          ocrText = item.content.ocr.pages
            .map((p: any) => p.text || '')
            .filter(Boolean)
            .join('\n\n');
        }

        const node: StructureNode = {
          node_id: item.node_id || item.id || '',
          structure: structureValue,
          level,
          display_number: item.display_number || item.parsed_prefix?.raw,
          title: item.title || item.full_title || '',
          full_title: item.full_title || item.title || '',
          summary: item.summary || '',
          ocr_text: ocrText || undefined,
          signals: item.content?.signals,
          anchors_full_range: anchorsFull
            ? {
                start_page: anchorsFull.start_page,
                end_page: anchorsFull.end_page
              }
            : undefined,
          qc: {
            text_length: (ocrText || '').length
          },
          status: 'draft'
        };

        const sourceMap: SourceMap | undefined = item.source_map;
        if (sourceMap && Array.isArray(sourceMap.mapped_blocks)) {
          node.source_map = sourceMap;
        }

        result.push(node);

        // Đệ quy qua children nếu có
        if (Array.isArray(item.nodes) && item.nodes.length) {
          walk(item.nodes, level);
        }
      }
    };

    walk(topLevel, null);
    return result;
  }

  onStructureNodeSelected(node: StructureNode): void {
    this.selectedStructureNode = node;
    const ref = this.documentService.state.pdfViewerComponentRef as any;
    if (ref) {
      // Set selected node để vẽ icon điểm bắt đầu (sẽ tự động scroll và vẽ icon)
      if (typeof ref.setSelectedNode === 'function') {
        ref.setSelectedNode(node);
      }
      // Set active source map để highlight blocks
      if (typeof ref.setActiveSourceMap === 'function') {
        ref.setActiveSourceMap(node.source_map || null);
      }
      // Note: scrollToPage đã được gọi trong setSelectedNode, không cần gọi lại
    }
  }

  /** Very simple MVP: map all OCR blocks in the node's page range to source_map. */
  autoMapBlocksForSelectedNode(): void {
    const node = this.selectedStructureNode;
    if (!node || !this.jsonStructure) return;

    const ocr = this.jsonStructure.content?.ocr;
    if (!ocr || !Array.isArray(ocr.pages)) return;

    const anchorsFull = (node as any).anchors?.full_range || node.anchors_full_range;
    const pageStart = anchorsFull?.start_page || 1;
    const pageEnd = anchorsFull?.end_page || pageStart;

    const mappedBlocks: SourceMap['mapped_blocks'] = [];

    for (let page = pageStart; page <= pageEnd; page++) {
      const pageEntry = ocr.pages.find((p: any) => p.page === page);
      if (!pageEntry || !Array.isArray(pageEntry.blocks)) continue;

      pageEntry.blocks.forEach((b: any, idx: number) => {
        if (!b || typeof b !== 'object') return;
        const bbox = b.bbox || [0, 0, 0, 0];
        mappedBlocks.push({
          page,
          block_idx: idx,
          bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
          text: b.text || '',
          match: 1
        });
      });
    }

    if (!mappedBlocks.length) return;

    const sourceMap: SourceMap = {
      page_start: pageStart,
      page_end: pageEnd,
      mapped_blocks: mappedBlocks
    };

    node.source_map = sourceMap;

    const ref = this.documentService.state.pdfViewerComponentRef as any;
    if (ref && typeof ref.setActiveSourceMap === 'function') {
      ref.setActiveSourceMap(sourceMap);
    }
  }

  async renderMarkdownTab(): Promise<void> {
    const state = this.documentService.state;
    if (!state.selectedDocId || !state.selectedOutputName) {
      this.markdownContent = 'Chọn doc và file (trong Outputs) trước, sau đó bấm Load nếu cần.';
      this.markdownEditorHtml = '';
      return;
    }

    const mdPath = this.getMdPathForCurrentFile();
    if (!mdPath) {
      this.markdownContent = 'Không xác định được file .md.';
      this.markdownEditorHtml = '';
      return;
    }

    try {
      const raw = await firstValueFrom(this.ragApi.getOutputContent(state.selectedDocId, mdPath));
      if (raw) {
        // Preprocess markdown: ensure line breaks are preserved
        // Replace literal \n with actual newlines if they exist as escaped strings
        let processedContent = raw;
        
        // Handle escaped newlines (\n) that might be in the string
        // This ensures single line breaks are preserved for breaks: true to work
        processedContent = processedContent.replace(/\\n/g, '\n');
        
        // Extract TOC section from markdown content for TOC panel
        // Match: ## Mục lục followed by newline, then list items until --- or chunk_id
        const tocMatch = processedContent.match(/^##\s+Mục lục\s*\n([\s\S]*?)(?=\n---|\nchunk_id|$)/m);
        if (tocMatch && tocMatch[1]) {
          // Store TOC content for rendering in TOC panel
          this.markdownTocContent = tocMatch[1].trim();
        } else {
          this.markdownTocContent = '';
        }
        
        // Keep full markdown content including TOC section - don't remove anything
        // marked.js with breaks: true will convert single \n to <br>
        this.markdownContent = processedContent;
        let editorHtml = marked.parse(processedContent) as string;
        // // Bỏ thẻ <a id="xxx"></a> khỏi HTML trước khi đưa vào ngx-editor, để editor không hiển thị dạng chữ và không bị mất thẻ đóng
        // editorHtml = editorHtml.replace(/<a\s+id="[^"]*"\s*>\s*<\/a>\s*/gi, '');
        this.markdownEditorHtml = editorHtml;

        // Load JSON structure for TOC mapping
        await this.loadJsonStructureForMapping(state.selectedDocId);
        await this.loadJsonlDataForAnchorMapping(state.selectedDocId);
        
        // Generate TOC from the extracted TOC content in markdown file
        // Use multiple timeouts to ensure markdown is fully rendered
        setTimeout(() => {
          // First pass: ensure anchor tags from markdown HTML are preserved/created
          // ngx-markdown may escape HTML, so we need to restore anchor tags
          this.restoreAnchorTagsFromMarkdown();
          
          // Second pass: ensure anchor tags exist (using JSONL mapping for accuracy)
          this.ensureAnchorTagsExist();

          // Third pass: setup everything else after anchors are created
          setTimeout(() => {
            this.addAnchorMarkersToTOC(); // Add (#...) markers to TOC links
            this.enhanceMarkdownHeadingsWithMetadata(); // Add page badges, tooltips, etc.
            this.generateTableOfContentsFromMarkdownTOC();
            this.setupTocScrollListener();
            this.setupAnchorLinks();
            // Ensure code blocks are highlighted (ngx-markdown should handle this via markedOptions, but double-check)
            this.highlightCodeBlocksInDOM();
          }, 200);
        }, 800); // Increased timeout to ensure markdown is fully rendered
      }
    } catch (e: any) {
      this.markdownContent = 'Lỗi: ' + e.message;
      this.markdownEditorHtml = '';
      this.markdownTocContent = '';
    }
  }

  getMdPathForCurrentFile(): string | null {
    const name = this.documentService.state.selectedOutputName || '';
    if (!name) return null;
    if (name.endsWith('.md')) return name;
    const i = name.lastIndexOf('.');
    if (i === -1) return name + '.md';
    return name.slice(0, i) + '.md';
  }
  
  async loadJsonStructureForMapping(docId: string): Promise<void> {
    try {
      const jsonPath = this.getJsonPathForCurrentFile();
      if (!jsonPath) return;
      
      const jsonText = await firstValueFrom(this.ragApi.getOutputContent(docId, jsonPath));
      if (!jsonText) return;
      
      // Parse JSON (handle double-escaped JSON)
      let parsed = null;
      let textToParse = jsonText;
      
      try {
        parsed = JSON.parse(textToParse);
        if (typeof parsed === 'string') {
          parsed = JSON.parse(parsed);
        }
      } catch (e1) {
        if (textToParse.trim().startsWith('"') && textToParse.trim().endsWith('"')) {
          const unescaped = JSON.parse(textToParse);
          if (typeof unescaped === 'string') {
            parsed = JSON.parse(unescaped);
          }
        }
      }
      
      if (parsed && typeof parsed === 'object') {
        this.jsonStructure = parsed;
        this.documentService.setJsonStructure(parsed);
        this.structureNodes = this.buildStructureNodes(parsed);
      }
    } catch (e: any) {
      console.warn('Could not load JSON structure for mapping:', e);
      this.jsonStructure = null;
      this.documentService.setJsonStructure(null);
      this.structureNodes = [];
    }
  }
  
  async loadJsonlDataForAnchorMapping(docId: string): Promise<void> {
    try {
      const jsonlPath = this.getJsonlPathForCurrentFile();
      if (!jsonlPath) return;
      
      const jsonlText = await firstValueFrom(this.ragApi.getOutputContent(docId, jsonlPath));
      if (!jsonlText) return;
      
      // Parse JSONL (each line is a JSON object)
      const lines = jsonlText.trim().split('\n').filter(line => line.trim());
      this.jsonlData = lines.map(line => {
        try {
          return JSON.parse(line);
        } catch (e) {
          console.warn('Failed to parse JSONL line:', line.substring(0, 100));
          return null;
        }
      }).filter(item => item !== null);
      
      console.log(`Loaded ${this.jsonlData.length} entries from JSONL for anchor mapping`);
    } catch (e: any) {
      console.warn('Could not load JSONL data for anchor mapping:', e);
      this.jsonlData = [];
    }
  }
  
  getJsonlPathForCurrentFile(): string | null {
    const name = this.documentService.state.selectedOutputName || '';
    if (!name) return null;
    if (name.endsWith('.jsonl')) return name;
    const i = name.lastIndexOf('.');
    if (i === -1) return name + '.jsonl';
    return name.slice(0, i) + '.jsonl';
  }
  
  getJsonPathForCurrentFile(): string | null {
    const name = this.documentService.state.selectedOutputName || '';
    if (!name) return null;
    if (name.endsWith('.json')) return name;
    const i = name.lastIndexOf('.');
    if (i === -1) return name + '.json';
    return name.slice(0, i) + '.json';
  }
  
  findStructureByAnchorId(anchorId: string): any | null {
    if (!this.jsonStructure) return null;
    
    // Find structure array
    let structure: any[] = [];
    if (this.jsonStructure.structure && Array.isArray(this.jsonStructure.structure)) {
      structure = this.jsonStructure.structure;
    } else if (Array.isArray(this.jsonStructure)) {
      structure = this.jsonStructure;
    }
    
    // Find structure item by structure field (e.g., "I", "II", "II1")
    const found = structure.find((node: any) => {
      const nodeStructure = node.structure || '';
      return nodeStructure === anchorId || 
             nodeStructure === anchorId.toUpperCase() ||
             node.node_id === anchorId ||
             node.path === anchorId ||
             node.path?.endsWith(anchorId);
    });
    
    return found || null;
  }
  
  scrollToPdfAndShowPopup(anchorId: string): void {
    const structure = this.findStructureByAnchorId(anchorId);
    if (!structure) {
      console.warn('Structure not found for anchor:', anchorId);
      return;
    }
    
    // Highlight the heading in markdown
    this.highlightMarkdownHeading(anchorId);
    
    // Get PDF viewer component reference
    const pdfViewerComponent = this.getPdfViewerComponent();
    if (!pdfViewerComponent) {
      console.warn('PDF viewer component not found');
      return;
    }
    
    // Scroll PDF to the anchor position
    if (structure.anchors) {
      const anchor = structure.anchors.start_page || structure.anchors.full_range;
      if (anchor && anchor.page) {
        // Scroll PDF to page using URL fragment
        const pdfEmbed = document.querySelector('embed[type="application/pdf"]') as HTMLEmbedElement;
        if (pdfEmbed) {
          const currentSrc = pdfEmbed.getAttribute('src') || '';
          const baseUrl = currentSrc.split('#')[0];
          const newSrc = `${baseUrl}#page=${anchor.page}`;
          pdfEmbed.setAttribute('src', newSrc);
          
          // Force reload if same URL
          if (currentSrc === newSrc) {
            pdfEmbed.setAttribute('src', baseUrl);
            setTimeout(() => {
              pdfEmbed.setAttribute('src', newSrc);
            }, 100);
          }
        }
      }
    }
    
    // Show popup with OCR and summary after a short delay to allow PDF to scroll
    setTimeout(() => {
      if (pdfViewerComponent.showPdfContentPopup) {
        pdfViewerComponent.showPdfContentPopup(structure);
      }
    }, 500);
  }
  
  highlightMarkdownHeading(anchorId: string): void {
    // Remove previous highlights
    if (!this.markdownPreview) return;
    const preview = this.markdownPreview.nativeElement;
    preview.querySelectorAll('.markdown-heading-highlighted').forEach((el: Element) => {
      el.classList.remove('markdown-heading-highlighted');
    });
    
    // Find heading associated with anchor tag <a id="xx">
    let heading: Element | null = null;
    
    // First priority: find anchor tag <a id="xx"> and then its next heading
    const anchor = preview.querySelector(`a[id="${anchorId}"]`);
    if (anchor) {
      // Find next heading after anchor
      let nextElement = anchor.nextElementSibling;
      while (nextElement && !nextElement.matches('h1, h2, h3, h4, h5, h6')) {
        nextElement = nextElement.nextElementSibling;
      }
      if (nextElement) {
        heading = nextElement;
      }
    }
    
    // Fallback: try heading with id directly
    if (!heading) {
      heading = preview.querySelector(`h1[id="${anchorId}"], h2[id="${anchorId}"], h3[id="${anchorId}"], h4[id="${anchorId}"], h5[id="${anchorId}"], h6[id="${anchorId}"]`);
    }
    
    if (heading) {
      heading.classList.add('markdown-heading-highlighted');
      
      // Remove highlight after 3 seconds
      setTimeout(() => {
        heading?.classList.remove('markdown-heading-highlighted');
      }, 3000);
    } else {
      console.warn(`Could not find heading for anchor: ${anchorId}`);
    }
  }
  
  getPdfViewerComponent(): any {
    // Get PDF viewer component reference from document service
    return this.documentService.state.pdfViewerComponentRef;
  }

  restoreAnchorTagsFromMarkdown(): void {
    // ngx-markdown may escape HTML tags like <a id="xxx"></a> into text
    // This function restores them as actual anchor tags in the DOM
    if (!this.markdownPreview || !this.markdownContent) {
      return;
    }
    
    const preview = this.markdownPreview.nativeElement;
    let restoredCount = 0;
    
    // Strategy: Find all elements and text nodes that contain anchor tag text
    // and replace them with actual anchor elements
    
    // First, process all text nodes
    const walker = document.createTreeWalker(
      preview,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    const textNodes: Text[] = [];
    let node: Node | null;
    while (node = walker.nextNode()) {
      const text = node.textContent || '';
      if (text.includes('<a id=') || text.includes('&lt;a id=')) {
        textNodes.push(node as Text);
      }
    }
    
    // Process text nodes
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || '';
      const parent = textNode.parentElement;
      if (!parent) return;
      
      // Match patterns: <a id="XXX"></a> or &lt;a id="XXX"&gt;&lt;/a&gt;
      const anchorPattern = /(&lt;|<)a\s+id=["']([^"']+)["']\s*(&gt;|>)\s*(&lt;|<\/)a\s*(&gt;|>)/g;
      const matches = Array.from(text.matchAll(anchorPattern));
      
      if (matches.length === 0) return;
      
      // Create fragment to replace text node
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      
      matches.forEach((match) => {
        const matchIndex = match.index!;
        const anchorId = match[2];
        
        // Add text before match
        if (matchIndex > lastIndex) {
          const beforeText = text.substring(lastIndex, matchIndex);
          if (beforeText.trim() || beforeText.includes('\n')) {
            fragment.appendChild(document.createTextNode(beforeText));
          }
        }
        
        // Create anchor element
        const anchor = document.createElement('a');
        anchor.id = anchorId;
        anchor.setAttribute('name', anchorId);
        anchor.setAttribute('data-anchor-id', anchorId);
        anchor.style.cssText = `
          display: block;
          position: relative;
          top: -20px;
          visibility: hidden;
          height: 0;
          margin: 0;
          padding: 0;
          pointer-events: none;
          scroll-margin-top: 20px;
        `;
        fragment.appendChild(anchor);
        
        lastIndex = matchIndex + match[0].length;
        restoredCount++;
      });
      
      // Add remaining text
      if (lastIndex < text.length) {
        const remainingText = text.substring(lastIndex);
        if (remainingText.trim() || remainingText.includes('\n')) {
          fragment.appendChild(document.createTextNode(remainingText));
        }
      }
      
      // Replace text node
      if (fragment.childNodes.length > 0) {
        parent.replaceChild(fragment, textNode);
      }
    });
    
    // Second strategy: Find elements containing anchor text in their content
    // and insert anchor before them
    const allElements = Array.from(preview.querySelectorAll('p, pre, code, div, span, li'));
    allElements.forEach((el) => {
      const textContent = el.textContent || '';
      const innerHTML = el.innerHTML || '';
      
      // Check if element contains anchor tag text
      if ((textContent.includes('<a id=') || innerHTML.includes('&lt;a id=')) && 
          !el.querySelector('a[id]')) {
        
        // Match anchor patterns
        const patterns = [
          /<a\s+id=["']([^"']+)["']\s*><\/a>/g,
          /&lt;a\s+id=["']([^"']+)["']\s*&gt;&lt;\/a&gt;/g
        ];
        
        patterns.forEach((pattern) => {
          const matches = Array.from(innerHTML.matchAll(pattern));
          matches.forEach((match) => {
            const anchorId = match[1];
            const fullMatch = match[0];
            
            // Check if anchor already exists
            if (preview.querySelector(`a[id="${anchorId}"]`)) {
              return;
            }
            
            // Create anchor element
            const anchor = document.createElement('a');
            anchor.id = anchorId;
            anchor.setAttribute('name', anchorId);
            anchor.setAttribute('data-anchor-id', anchorId);
            anchor.style.cssText = `
              display: block;
              position: relative;
              top: -20px;
              visibility: hidden;
              height: 0;
              margin: 0;
              padding: 0;
              pointer-events: none;
              scroll-margin-top: 20px;
            `;
            
            // Remove anchor text from element's innerHTML
            el.innerHTML = el.innerHTML.replace(fullMatch, '').trim();
            
            // Insert anchor before the element
            if (el.parentElement) {
              el.parentElement.insertBefore(anchor, el);
              restoredCount++;
            }
          });
        });
      }
    });
    
    console.log(`Restored ${restoredCount} anchor tags from markdown`);
  }

  ensureAnchorTagsExist(): void {
    // File .md uses format: <a id="XXX"></a> followed by markdown heading
    // ngx-markdown may strip the anchor tags, so we need to re-create them
    // Use JSONL data for accurate mapping if available
    if (!this.markdownPreview || !this.markdownContent) {
      console.warn('ensureAnchorTagsExist: markdownPreview or markdownContent is missing');
      return;
    }
    
    const preview = this.markdownPreview.nativeElement;
    
    // Build anchor map from JSONL data (more accurate than parsing markdown)
    const anchorMap = new Map<string, { headingText: string; headingLevel: number; structure: string }>();
    
    if (this.jsonlData.length > 0) {
      // Use JSONL data for accurate mapping
      this.jsonlData.forEach((item: any) => {
        if (!item.text || !item.metadata) return;
        
        // Extract anchor ID from text: <a id="XXX"></a>
        const anchorMatch = item.text.match(/<a id="([^"]+)"><\/a>/);
        if (!anchorMatch) return;
        
        const anchorId = anchorMatch[1];
        
        // Extract heading from text: # Heading or ## Heading, etc.
        const headingMatch = item.text.match(/<a id="[^"]+"><\/a>\s*\n(#+\s+[^\n]+)/);
        if (!headingMatch) return;
        
        const headingLine = headingMatch[1];
        const headingLevel = (headingLine.match(/^#+/)?.[0] || '').length;
        const headingText = headingLine.replace(/^#+\s+/, '').trim();
        const structure = item.metadata.structure || '';
        
        anchorMap.set(anchorId, { headingText, headingLevel, structure });
        console.log(`[JSONL] Mapped anchor ${anchorId} (structure: ${structure}) to heading level ${headingLevel}: "${headingText.substring(0, 60)}..."`);
      });
    } else {
      // Fallback: Extract from markdown content
      const anchorMatches = Array.from(this.markdownContent.matchAll(/<a id="([^"]+)"><\/a>\s*\n(#+\s+[^\n]+)/gm));
      console.log('Found anchor matches in markdown:', anchorMatches.length);
      
      for (const match of anchorMatches) {
        const anchorId = match[1];
        const headingLine = match[2];
        const headingLevel = (headingLine.match(/^#+/)?.[0] || '').length;
        const headingText = headingLine.replace(/^#+\s+/, '').trim();
        anchorMap.set(anchorId, { headingText, headingLevel, structure: '' });
        console.log(`[Markdown] Mapped anchor ${anchorId} to heading level ${headingLevel}: "${headingText.substring(0, 60)}..."`);
      }
    }
    
    console.log(`Total anchor mappings: ${anchorMap.size}`);
    
    // Find all headings in rendered HTML
    const headings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    console.log('Found headings in rendered HTML:', headings.length);
    
    let anchorsCreated = 0;
    
    // Process headings in order and match with anchors from JSONL/markdown
    headings.forEach((heading: Element, index: number) => {
      const headingLevel = parseInt(heading.tagName.charAt(1));
      let headingText = heading.textContent?.trim() || '';
      
      // Remove page badge if exists (we'll add it back later)
      const existingBadge = heading.querySelector('.markdown-heading-page-badge');
      if (existingBadge) {
        const badgeText = existingBadge.textContent || '';
        // Remove badge text from heading text for matching
        headingText = headingText.replace(badgeText, '').trim();
      }
      
      // Check if there's already an anchor tag before this heading
      let prevElement = heading.previousElementSibling;
      let hasAnchor = false;
      let existingAnchorId: string | null = null;
      
      while (prevElement) {
        if (prevElement.tagName === 'A' && prevElement.getAttribute('id')) {
          hasAnchor = true;
          existingAnchorId = prevElement.getAttribute('id');
          break;
        }
        if (prevElement.matches('h1, h2, h3, h4, h5, h6')) {
          break; // Stop if we hit another heading
        }
        prevElement = prevElement.previousElementSibling;
      }
      
      // If no anchor exists, find matching anchor ID from JSONL/markdown
      if (!hasAnchor) {
        let bestMatch: { anchorId: string; score: number } | null = null;
        
        // Find anchor ID that matches this heading
        for (const [anchorId, mapped] of anchorMap.entries()) {
          // Match by heading level first
          if (mapped.headingLevel === headingLevel) {
            let score = 0;
            
            // Exact text match gets highest score
            if (headingText.toLowerCase() === mapped.headingText.toLowerCase()) {
              score = 100;
            } else {
              // Partial match scoring
              const headingStart = headingText.substring(0, Math.min(100, headingText.length)).toLowerCase();
              const mappedStart = mapped.headingText.substring(0, Math.min(100, mapped.headingText.length)).toLowerCase();
              
              // Check if heading starts with mapped text or vice versa
              if (headingStart.startsWith(mappedStart) || mappedStart.startsWith(headingStart)) {
                score = 80;
              } else if (headingStart.includes(mappedStart) || mappedStart.includes(headingStart)) {
                score = 60;
              } else {
                // Check word-by-word similarity
                const headingWords = headingStart.split(/\s+/).slice(0, 10);
                const mappedWords = mappedStart.split(/\s+/).slice(0, 10);
                const commonWords = headingWords.filter(w => mappedWords.includes(w)).length;
                score = Math.min(50, commonWords * 10);
              }
            }
            
            // Prefer matches with higher score
            if (score > 0 && (!bestMatch || score > bestMatch.score)) {
              bestMatch = { anchorId, score };
            }
          }
        }
        
        // Create anchor tag if we found a match (lower threshold to ensure all anchors are created)
        if (bestMatch && bestMatch.score >= 30) {
          // Create anchor tag <a id="xx"> that will be the scroll target
          const anchor = document.createElement('a');
          anchor.id = bestMatch.anchorId;
          anchor.setAttribute('name', bestMatch.anchorId);
          anchor.setAttribute('data-anchor-id', bestMatch.anchorId); // Additional data attribute for easier querying
          // Style anchor tag to be invisible but still take up space for scrolling
          anchor.style.display = 'block';
          anchor.style.position = 'relative';
          anchor.style.top = '-20px'; // Negative offset to position above heading
          anchor.style.visibility = 'hidden';
          anchor.style.height = '0';
          anchor.style.margin = '0';
          anchor.style.padding = '0';
          anchor.style.pointerEvents = 'none';
          anchor.style.scrollMarginTop = '20px'; // Ensure smooth scroll positioning
          heading.parentNode?.insertBefore(anchor, heading);
          anchorsCreated++;
          const mapped = anchorMap.get(bestMatch.anchorId);
          console.log(`Created anchor tag <a id="${bestMatch.anchorId}"> (score: ${bestMatch.score}) before heading level ${headingLevel}: "${headingText.substring(0, 60)}..."`);
          anchorMap.delete(bestMatch.anchorId); // Remove from map to avoid duplicates
        } else if (bestMatch) {
          console.warn(`Skipped low-score match for "${headingText.substring(0, 40)}..." (score: ${bestMatch.score}, threshold: 30). Heading: "${headingText.substring(0, 80)}", Expected: "${anchorMap.get(bestMatch.anchorId)?.headingText.substring(0, 80)}"`);
        }
      } else {
        console.log(`Heading already has anchor: ${existingAnchorId}`);
      }
    });
    
    console.log(`Created ${anchorsCreated} anchor tags`);
    
    // For any remaining unmapped anchors, try to create them anyway by finding headings by text
    if (anchorMap.size > 0) {
      console.warn(`Attempting to create ${anchorMap.size} remaining unmapped anchors...`);
      const remainingAnchors = Array.from(anchorMap.entries());
      
      remainingAnchors.forEach(([anchorId, mapped]) => {
        // Try to find heading by text match
        const allHeadings = Array.from(preview.querySelectorAll('h1, h2, h3, h4, h5, h6'));
        for (const heading of allHeadings) {
          const headingLevel = parseInt(heading.tagName.charAt(1));
          if (headingLevel !== mapped.headingLevel) continue;
          
          let headingText = heading.textContent?.trim() || '';
          // Remove page badge if exists
          const badge = heading.querySelector('.markdown-heading-page-badge');
          if (badge) {
            headingText = headingText.replace(badge.textContent || '', '').trim();
          }
          
          // Check if heading text matches (more lenient matching)
          const headingLower = headingText.toLowerCase();
          const mappedLower = mapped.headingText.toLowerCase();
          
          // Check if either contains the other or they share significant words
          if (headingLower.includes(mappedLower) || mappedLower.includes(headingLower) ||
              headingLower.substring(0, 50) === mappedLower.substring(0, 50)) {
            // Check if anchor already exists
            let prevElement = heading.previousElementSibling;
            let hasAnchor = false;
            while (prevElement) {
              if (prevElement.tagName === 'A' && prevElement.getAttribute('id') === anchorId) {
                hasAnchor = true;
                break;
              }
              if (prevElement.matches('h1, h2, h3, h4, h5, h6')) {
                break;
              }
              prevElement = prevElement.previousElementSibling;
            }
            
            if (!hasAnchor) {
              // Create anchor tag
              const anchor = document.createElement('a');
              anchor.id = anchorId;
              anchor.setAttribute('name', anchorId);
              anchor.setAttribute('data-anchor-id', anchorId);
              anchor.style.display = 'block';
              anchor.style.position = 'relative';
              anchor.style.top = '-20px';
              anchor.style.visibility = 'hidden';
              anchor.style.height = '0';
              anchor.style.margin = '0';
              anchor.style.padding = '0';
              anchor.style.pointerEvents = 'none';
              anchor.style.scrollMarginTop = '20px';
              heading.parentNode?.insertBefore(anchor, heading);
              anchorsCreated++;
              console.log(`Created fallback anchor tag <a id="${anchorId}"> for heading: "${headingText.substring(0, 60)}..."`);
              anchorMap.delete(anchorId);
              break;
            }
          }
        }
      });
      
      if (anchorMap.size > 0) {
        console.warn('Still unmapped anchors after fallback:', Array.from(anchorMap.keys()));
      }
    }
    
    // Verify anchors exist
    const allAnchors = preview.querySelectorAll('a[id]');
    const anchorIds = Array.from(allAnchors).map(a => a.getAttribute('id')).filter(Boolean);
    console.log(`Available anchor IDs after creation: ${anchorIds.length} anchors`, anchorIds);
  }

  enhanceMarkdownHeadingsWithMetadata(): void {
    // Enhance markdown headings with page badges, tooltips, and interactive features
    if (!this.markdownPreview || !this.jsonStructure) return;
    
    const preview = this.markdownPreview.nativeElement;
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    
    headings.forEach((heading: Element) => {
      // Find anchor ID associated with this heading
      let anchorId: string | null = null;
      
      // Check if there's an anchor tag before this heading
      let prevElement = heading.previousElementSibling;
      while (prevElement) {
        if (prevElement.tagName === 'A' && prevElement.getAttribute('id')) {
          anchorId = prevElement.getAttribute('id');
          break;
        }
        if (prevElement.matches('h1, h2, h3, h4, h5, h6')) {
          break;
        }
        prevElement = prevElement.previousElementSibling;
      }
      
      // Also check if heading has id directly
      if (!anchorId && heading.id) {
        anchorId = heading.id;
      }
      
      if (!anchorId) return;
      
      // Find structure data for this anchor
      const structure = this.findStructureByAnchorId(anchorId);
      if (!structure) return;
      
      // Add page badge if anchors exist
      if (structure.anchors) {
        const anchor = structure.anchors.start_page || structure.anchors.full_range;
        if (anchor && anchor.page) {
          // Create page badge
          const badge = document.createElement('span');
          badge.className = 'markdown-heading-page-badge';
          badge.textContent = `📄 ${anchor.page}`;
          badge.title = `Trang ${anchor.page}`;
          badge.style.cssText = `
            display: inline-block;
            margin-left: 8px;
            padding: 2px 6px;
            font-size: 0.75em;
            background: rgba(59, 130, 246, 0.2);
            border: 1px solid rgba(59, 130, 246, 0.4);
            border-radius: 4px;
            color: #60a5fa;
            cursor: pointer;
            vertical-align: middle;
          `;
          
          // Click badge to scroll PDF
          badge.addEventListener('click', (e) => {
            e.stopPropagation();
            this.scrollToPdfAndShowPopup(anchorId!);
          });
          
          heading.appendChild(badge);
        }
      }
      
      // Add hover tooltip with summary
      const headingElement = heading as HTMLElement;
      if (structure.summary || structure.title) {
        heading.setAttribute('data-tooltip', structure.summary || structure.title);
        headingElement.style.cursor = 'pointer';
        headingElement.style.position = 'relative';
        
        // Add hover event for tooltip
        headingElement.addEventListener('mouseenter', (e) => {
          this.showHeadingTooltip(e.target as HTMLElement, structure);
        });
        
        headingElement.addEventListener('mouseleave', () => {
          this.hideHeadingTooltip();
        });
        
        // Click heading to scroll PDF and show popup
        headingElement.addEventListener('click', () => {
          this.scrollToPdfAndShowPopup(anchorId!);
        });
      }
    });
    
    console.log(`Enhanced ${headings.length} headings with metadata`);
  }
  
  showHeadingTooltip(heading: HTMLElement, structure: any): void {
    // Remove existing tooltip
    const existingTooltip = document.getElementById('markdown-heading-tooltip');
    if (existingTooltip) {
      existingTooltip.remove();
    }
    
    const tooltip = document.createElement('div');
    tooltip.id = 'markdown-heading-tooltip';
    tooltip.className = 'markdown-heading-tooltip';
    
    const title = structure.title || heading.textContent?.trim() || '';
    const summary = structure.summary || '';
    const pageInfo = structure.anchors?.start_page?.page || structure.anchors?.full_range?.start_page;
    
    tooltip.innerHTML = `
      <div class="tooltip-title">${title}</div>
      ${pageInfo ? `<div class="tooltip-page">📄 Trang ${pageInfo}</div>` : ''}
      ${summary ? `<div class="tooltip-summary">${summary.substring(0, 200)}${summary.length > 200 ? '...' : ''}</div>` : ''}
      <div class="tooltip-hint">Click để xem trong PDF</div>
    `;
    
    document.body.appendChild(tooltip);
    
    // Position tooltip
    const rect = heading.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    
    let top = rect.bottom + 8;
    let left = rect.left;
    
    // Adjust if tooltip goes off screen
    if (left + tooltipRect.width > window.innerWidth) {
      left = window.innerWidth - tooltipRect.width - 10;
    }
    if (top + tooltipRect.height > window.innerHeight) {
      top = rect.top - tooltipRect.height - 8;
    }
    
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
  }
  
  hideHeadingTooltip(): void {
    const tooltip = document.getElementById('markdown-heading-tooltip');
    if (tooltip) {
      tooltip.remove();
    }
  }

  addAnchorMarkersToTOC(): void {
    // Add (#...) markers to TOC links in rendered markdown
    // This makes the anchor IDs visible in the table of contents
    // Also ensure href attributes are correct based on JSONL data
    if (!this.markdownPreview) return;
    
    const preview = this.markdownPreview.nativeElement;
    
    // Build mapping from heading text to anchor ID from JSONL
    const headingToAnchorMap = new Map<string, string>();
    if (this.jsonlData.length > 0) {
      this.jsonlData.forEach((item: any) => {
        if (!item.text || !item.metadata) return;
        const anchorMatch = item.text.match(/<a id="([^"]+)"><\/a>/);
        if (!anchorMatch) return;
        const anchorId = anchorMatch[1];
        const headingMatch = item.text.match(/<a id="[^"]+"><\/a>\s*\n(#+\s+[^\n]+)/);
        if (headingMatch) {
          const headingText = headingMatch[1].replace(/^#+\s+/, '').trim();
          headingToAnchorMap.set(headingText.toLowerCase(), anchorId);
        }
      });
    }
    
    // Find the "Mục lục" heading (h2)
    const tocHeading = Array.from(preview.querySelectorAll('h2')).find((h2: Element) => {
      const text = h2.textContent?.trim().toLowerCase() || '';
      return text.includes('mục lục') || text.includes('muc luc');
    });
    
    if (!tocHeading) {
      console.warn('TOC heading "Mục lục" not found');
      return;
    }
    
    // Find the list (ul or ol) that comes after the TOC heading
    // This should be the TOC list
    let currentElement: Element | null = tocHeading.nextElementSibling;
    let tocList: Element | null = null;
    
    // Look for ul or ol in the next few siblings
    while (currentElement && currentElement !== preview) {
      if (currentElement.matches('ul, ol')) {
        tocList = currentElement;
        break;
      }
      // Also check if current element contains a list
      const nestedList = currentElement.querySelector('ul, ol');
      if (nestedList) {
        tocList = nestedList;
        break;
      }
      // Stop if we hit another heading
      if (currentElement.matches('h1, h2, h3, h4, h5, h6')) {
        break;
      }
      currentElement = currentElement.nextElementSibling;
    }
    
    if (!tocList) {
      console.warn('TOC list not found after "Mục lục" heading');
      return;
    }
    
    // Find all links with href starting with # in the TOC list
    const tocLinks = tocList.querySelectorAll('a[href^="#"]');
    
    // Process each TOC link
    tocLinks.forEach((link: Element) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        let anchorId = href.substring(1);
        const linkText = link.textContent?.trim() || '';
        
        // If we have JSONL mapping, try to correct the href if needed
        if (headingToAnchorMap.size > 0) {
          // Extract the actual heading text from link (remove marker if exists)
          const cleanLinkText = linkText.replace(/\s*\(#[^)]+\)\s*$/, '').trim();
          const mappedAnchorId = headingToAnchorMap.get(cleanLinkText.toLowerCase());
          
          if (mappedAnchorId && mappedAnchorId !== anchorId) {
            // Update href to match JSONL anchor ID
            (link as HTMLElement).setAttribute('href', `#${mappedAnchorId}`);
            anchorId = mappedAnchorId;
            console.log(`Updated TOC link href from #${href.substring(1)} to #${mappedAnchorId} for "${cleanLinkText}"`);
          }
        }
        
        // Add (#...) marker if it doesn't exist
        const currentText = link.textContent?.trim() || '';
        if (!currentText.includes(`(#${anchorId})`)) {
          // Remove existing marker if any
          const existingMarker = link.querySelector('text');
          if (existingMarker && existingMarker.textContent?.includes('(#')) {
            existingMarker.remove();
          }
          
          // Add marker at the end of the link text
          const marker = document.createTextNode(` (#${anchorId})`);
          link.appendChild(marker);
        }
      }
    });
    
    console.log(`Processed ${tocLinks.length} TOC links with anchor markers`);
  }

  generateTableOfContentsFromMarkdownTOC(): void {
    if (!this.markdownToc || !this.markdownTocList) return;

    // If we have extracted TOC content from markdown, use it
    if (this.markdownTocContent) {
      // Parse the markdown TOC list items
      // Format: - [Text](#anchor) or   - [Text](#anchor) for nested items
      const lines = this.markdownTocContent.split('\n');
      
      const tocEl = this.markdownToc?.nativeElement;
      if (tocEl) tocEl.style.display = 'none';
      
      if (lines.length === 0 || lines.every(line => !line.trim())) {
        return;
      }
      const tocListEl = this.markdownTocList?.nativeElement;
      if (tocListEl) tocListEl.innerHTML = '';

      lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('-')) return;

        // Parse markdown link: - [Text](#anchor) or   - [Text](#anchor)
        const match = trimmed.match(/^[\s-]*\[([^\]]+)\]\(#([^)]+)\)/);
        if (!match) return;

        const text = match[1];
        const anchorId = match[2];
        
        // Determine level based on indentation (2 spaces = 1 level)
        const indentMatch = trimmed.match(/^(\s*)/);
        const indent = indentMatch ? indentMatch[1].length : 0;
        const level = Math.floor(indent / 2) + 1; // Level 1 for no indent, level 2 for 2 spaces, etc.

        const li = document.createElement('li');
        li.className = `toc-level-${level}`;

        const a = document.createElement('a');
        a.href = `#${anchorId}`;
        a.textContent = text;
        a.onclick = (e) => {
          e.preventDefault();
          
          // Try to find the target element in the preview
          const preview = this.markdownPreview?.nativeElement;
          if (preview) {
            const target = preview.querySelector(`#${anchorId}, a[id="${anchorId}"]`);
            if (target) {
              target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
          
          const listEl = this.markdownTocList?.nativeElement;
          if (listEl) listEl.querySelectorAll('a').forEach((link: any) => link.classList.remove('toc-active'));
          a.classList.add('toc-active');
          
          if (this.jsonStructure) {
            this.scrollToPdfAndShowPopup(anchorId);
          }
        };

        li.appendChild(a);
        if (tocListEl) tocListEl.appendChild(li);
      });
    } else {
      // Fallback to auto-generate from headings if no TOC found in markdown
      this.generateTableOfContents();
    }
  }

  generateTableOfContents(): void {
    if (!this.markdownToc || !this.markdownTocList || !this.markdownPreview) return;

    const preview = this.markdownPreview.nativeElement;
    // Find headings and anchor elements (for HTML anchors like <a id="I"></a>)
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const anchors = preview.querySelectorAll('a[id]');

    // Create a map of IDs to elements (both from headings and anchors)
    const idMap = new Map<string, Element>();
    
    // Map anchor IDs to their following headings
    anchors.forEach((anchor) => {
      const id = anchor.getAttribute('id');
      if (id) {
        // Find the next heading after this anchor
        let nextElement = anchor.nextElementSibling;
        while (nextElement && !nextElement.matches('h1, h2, h3, h4, h5, h6')) {
          nextElement = nextElement.nextElementSibling;
        }
        if (nextElement) {
          idMap.set(id, nextElement);
        } else {
          idMap.set(id, anchor);
        }
      }
    });

    // Also map heading IDs
    headings.forEach((heading) => {
      if (heading.id) {
        idMap.set(heading.id, heading);
      }
    });

    const tocEl2 = this.markdownToc?.nativeElement;
    if (tocEl2) tocEl2.style.display = 'none';
    
    if (headings.length === 0 && anchors.length === 0) {
      return;
    }
    const tocListEl2 = this.markdownTocList?.nativeElement;
    if (tocListEl2) tocListEl2.innerHTML = '';

    // Generate TOC from headings, but use anchor IDs if available
    headings.forEach((heading) => {
      // Check if there's an anchor before this heading
      let targetId = heading.id;
      let targetElement: Element = heading;
      
      // Look for anchor with ID before this heading
      let prevElement = heading.previousElementSibling;
      while (prevElement) {
        if (prevElement.tagName === 'A' && prevElement.getAttribute('id')) {
          targetId = prevElement.getAttribute('id') || heading.id;
          targetElement = prevElement;
          break;
        }
        prevElement = prevElement.previousElementSibling;
      }
      
      // If no ID, generate one
      if (!targetId) {
        const text = heading.textContent?.trim() || '';
        targetId = text
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .substring(0, 50);
        heading.id = targetId || `heading-${Math.random().toString(36).substr(2, 9)}`;
        targetId = heading.id;
        targetElement = heading;
      }

      const level = parseInt(heading.tagName.charAt(1));
      const text = heading.textContent?.trim() || '';
      const li = document.createElement('li');
      li.className = `toc-level-${level}`;

      const a = document.createElement('a');
      a.href = `#${targetId}`;
      a.textContent = text;
      a.onclick = (e) => {
        e.preventDefault();
        const scrollTarget = idMap.get(targetId) || targetElement;
        scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const listEl2 = this.markdownTocList?.nativeElement;
        if (listEl2) listEl2.querySelectorAll('a').forEach((link: any) => link.classList.remove('toc-active'));
        a.classList.add('toc-active');
        
        if (this.jsonStructure) {
          this.scrollToPdfAndShowPopup(targetId);
        }
      };

      li.appendChild(a);
      if (tocListEl2) tocListEl2.appendChild(li);
    });
  }
  
  setupAnchorLinks(): void {
    if (!this.markdownPreview) return;
    
    const preview = this.markdownPreview.nativeElement;
    
    // Build anchor ID to heading text mapping from JSONL for better matching
    const anchorToHeadingMap = new Map<string, string>();
    if (this.jsonlData.length > 0) {
      this.jsonlData.forEach((item: any) => {
        if (!item.text || !item.metadata) return;
        const anchorMatch = item.text.match(/<a id="([^"]+)"><\/a>/);
        if (!anchorMatch) return;
        const anchorId = anchorMatch[1];
        const headingMatch = item.text.match(/<a id="[^"]+"><\/a>\s*\n(#+\s+[^\n]+)/);
        if (headingMatch) {
          const headingText = headingMatch[1].replace(/^#+\s+/, '').trim();
          anchorToHeadingMap.set(anchorId, headingText);
        }
      });
    }
    
    // Make all anchor links in the content scroll smoothly
    const links = preview.querySelectorAll('a[href^="#"]');
    console.log(`Setting up ${links.length} anchor links`);
    
    links.forEach((link: Element) => {
      const href = link.getAttribute('href');
      if (href && href.startsWith('#')) {
        const targetId = href.substring(1);
        
        // Remove existing listeners to avoid duplicates
        const newLink = link.cloneNode(true);
        link.parentNode?.replaceChild(newLink, link);
        
        newLink.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          
          // Try multiple selectors to find the target
          let target: Element | null = null;
          
          // First try: find anchor tag with id (created by ensureAnchorTagsExist)
          target = preview.querySelector(`a[id="${targetId}"]`);
          
          // Second try: find heading with id
          if (!target) {
            target = preview.querySelector(`h1[id="${targetId}"], h2[id="${targetId}"], h3[id="${targetId}"], h4[id="${targetId}"], h5[id="${targetId}"], h6[id="${targetId}"]`);
          }
          
          // Third try: find any element with id
          if (!target) {
            target = preview.querySelector(`#${targetId}`);
          }
          
          // Fourth try: use JSONL mapping to find heading by text
          if (!target && anchorToHeadingMap.has(targetId)) {
            const expectedHeadingText = anchorToHeadingMap.get(targetId)!;
            const allHeadings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
            for (const heading of Array.from(allHeadings)) {
              const headingText = heading.textContent?.trim() || '';
              // Remove page badge if exists
              const badge = heading.querySelector('.markdown-heading-page-badge');
              const cleanHeadingText = badge 
                ? headingText.replace(badge.textContent || '', '').trim()
                : headingText;
              
              // Match heading text (case-insensitive, partial match)
              if (cleanHeadingText.toLowerCase().includes(expectedHeadingText.toLowerCase()) ||
                  expectedHeadingText.toLowerCase().includes(cleanHeadingText.toLowerCase())) {
                // Check if there's an anchor before this heading
                let prevElement = heading.previousElementSibling;
                while (prevElement) {
                  if (prevElement.tagName === 'A' && prevElement.getAttribute('id') === targetId) {
                    target = prevElement;
                    break;
                  }
                  if (prevElement.matches('h1, h2, h3, h4, h5, h6')) {
                    break;
                  }
                  prevElement = prevElement.previousElementSibling;
                }
                // If no anchor found, use the heading itself
                if (!target) {
                  target = heading;
                }
                break;
              }
            }
          }
          
          if (target) {
            // Determine scroll target: prioritize anchor tag <a id="xx"> itself
            let scrollTarget: Element = target;
            let anchorTag: Element | null = null;
            let headingAfterAnchor: Element | null = null;
            
            // If target is an anchor tag <a id="xx">, use it as scroll target
            if (target.tagName === 'A' && target.getAttribute('id') === targetId) {
              anchorTag = target;
              // Find the next heading after the anchor for highlighting and better scroll position
              let nextElement = target.nextElementSibling;
              while (nextElement && !nextElement.matches('h1, h2, h3, h4, h5, h6')) {
                nextElement = nextElement.nextElementSibling;
              }
              if (nextElement) {
                headingAfterAnchor = nextElement;
                this.highlightMarkdownHeading(targetId);
              }
            } else {
              // If target is a heading, check if there's an anchor tag before it
              let prevElement = target.previousElementSibling;
              while (prevElement) {
                if (prevElement.tagName === 'A' && prevElement.getAttribute('id') === targetId) {
                  anchorTag = prevElement;
                  headingAfterAnchor = target;
                  break;
                }
                if (prevElement.matches('h1, h2, h3, h4, h5, h6')) {
                  break;
                }
                prevElement = prevElement.previousElementSibling;
              }
              // If anchor tag found, use it; otherwise use heading
              if (anchorTag) {
                scrollTarget = anchorTag;
                this.highlightMarkdownHeading(targetId);
              } else {
                scrollTarget = target;
                this.highlightMarkdownHeading(targetId);
              }
            }
            
            // Scroll to the anchor tag position
            // Since anchor tags have top: -20px and are hidden, we scroll to the heading after it
            // but account for the anchor tag's position
            const finalScrollTarget = headingAfterAnchor || scrollTarget;
            
            // Use scrollIntoView for more reliable scrolling
            (finalScrollTarget as HTMLElement).scrollIntoView({ 
              behavior: 'smooth', 
              block: 'start',
              inline: 'nearest'
            });
            
            // Also manually scroll the preview container to ensure proper positioning
            setTimeout(() => {
              const previewRect = preview.getBoundingClientRect();
              const targetRect = (finalScrollTarget as HTMLElement).getBoundingClientRect();
              const relativeTop = targetRect.top - previewRect.top + preview.scrollTop;
              
              // Account for anchor tag's negative top position (-20px)
              const scrollOffset = anchorTag ? 20 : 0;
              preview.scrollTo({ 
                top: Math.max(0, relativeTop - scrollOffset - 10), 
                behavior: 'smooth' 
              });
            }, 100);
            
            // Try to scroll PDF and show popup if JSON structure is available
            setTimeout(() => {
              if (this.jsonStructure) {
                this.scrollToPdfAndShowPopup(targetId);
              }
            }, 300);
            
            console.log(`Successfully navigated to anchor: ${targetId} (anchor tag: ${anchorTag ? 'found' : 'not found'}, scroll target: ${finalScrollTarget.tagName}${finalScrollTarget.id ? `#${finalScrollTarget.id}` : ''})`);
          } else {
            console.warn('Target not found for anchor:', targetId);
            // Debug: log all available IDs (headings and anchors)
            const allHeadings = preview.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
            const allAnchors = preview.querySelectorAll('a[id]');
            const headingIds = Array.from(allHeadings).map(h => h.getAttribute('id')).filter(Boolean);
            const anchorIds = Array.from(allAnchors).map(a => a.getAttribute('id')).filter(Boolean);
            console.log('Available heading IDs:', headingIds);
            console.log('Available anchor IDs:', anchorIds);
            console.log('Expected anchor ID from link:', targetId);
            if (anchorToHeadingMap.has(targetId)) {
              console.log('Expected heading text from JSONL:', anchorToHeadingMap.get(targetId));
            }
          }
        });
      }
    });
    
    console.log(`Completed setting up ${links.length} anchor links`);
  }

  setupTocScrollListener(): void {
    if (!this.markdownPreview || !this.markdownTocList) return;

    const preview = this.markdownPreview.nativeElement;
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    if (headings.length === 0) return;

    let ticking = false;

    const updateActiveTocItem = () => {
      if (ticking) return;
      ticking = true;

      requestAnimationFrame(() => {
        let activeHeading: Element | null = null;

        headings.forEach((heading) => {
          const rect = heading.getBoundingClientRect();
          const previewRect = preview.getBoundingClientRect();
          const relativeTop = rect.top - previewRect.top;

          if (relativeTop <= 100 && relativeTop >= -50) {
            activeHeading = heading;
          }
        });

        if (!activeHeading) {
          for (let i = 0; i < headings.length; i++) {
            const rect = headings[i].getBoundingClientRect();
            const previewRect = preview.getBoundingClientRect();
            if (rect.top - previewRect.top > 0) {
              activeHeading = headings[Math.max(0, i - 1)] || headings[i];
              break;
            }
          }
        }

        const listEl3 = this.markdownTocList?.nativeElement;
        if (listEl3) {
          listEl3.querySelectorAll('a').forEach((link: any) => {
            link.classList.remove('toc-active');
            if (activeHeading && link.getAttribute('href') === `#${activeHeading.id}`) {
              link.classList.add('toc-active');
              link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          });
        }

        ticking = false;
      });
    };

    this.tocScrollListener = updateActiveTocItem;
    preview.addEventListener('scroll', updateActiveTocItem);
    updateActiveTocItem();
  }
  
  highlightCodeBlocksInDOM(): void {
    if (!this.markdownPreview) return;
    
    const preview = this.markdownPreview.nativeElement;
    const codeBlocks = preview.querySelectorAll('pre code:not(.hljs)');
    
    codeBlocks.forEach((codeBlock) => {
      const code = codeBlock.textContent || '';
      const language = codeBlock.className.replace('language-', '') || '';
      
      if (language && hljs.getLanguage(language)) {
        try {
          const highlighted = hljs.highlight(code, { language });
          codeBlock.innerHTML = highlighted.value;
          codeBlock.className = `hljs ${language}`;
        } catch (e) {
          // Auto-detect on error
          try {
            const highlighted = hljs.highlightAuto(code);
            codeBlock.innerHTML = highlighted.value;
            codeBlock.className = `hljs ${highlighted.language || ''}`;
          } catch (e2) {
            // Keep original
          }
        }
      } else {
        // Auto-detect
        try {
          const highlighted = hljs.highlightAuto(code);
          codeBlock.innerHTML = highlighted.value;
          codeBlock.className = `hljs ${highlighted.language || ''}`;
        } catch (e) {
          // Keep original
        }
      }
    });
  }
  
  addHeaderIdsToDOM(): void {
    if (!this.markdownPreview) return;
    
    const preview = this.markdownPreview.nativeElement;
    // Find all headings and add IDs if they don't have one
    const headings = preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((heading) => {
      if (!heading.id) {
        const text = heading.textContent?.trim() || '';
        // Generate ID from text (similar to GitHub's approach)
        const id = text
          .toLowerCase()
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-')
          .replace(/-+/g, '-')
          .substring(0, 50);
        if (id) {
          heading.id = id;
        } else {
          // Fallback: use random ID
          heading.id = `heading-${Math.random().toString(36).substr(2, 9)}`;
        }
      }
    });
  }
}
