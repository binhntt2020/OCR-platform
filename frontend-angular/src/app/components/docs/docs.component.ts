import { Component, OnInit, OnDestroy, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DocumentService } from '../../services/document.service';
import { RagApiService, Document, Output as OutputFile, PipelineConfig } from '../../services/rag-api.service';
import { Subject, takeUntil, firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-docs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './docs.component.html',
  styleUrl: './docs.component.scss'
})
export class DocsComponent implements OnInit, OnDestroy {
  @Input() collapsed = false;
  @Output() toggleCollapse = new EventEmitter<void>();
  docs: Document[] = [];
  selectedDoc: Document | null = null;
  outputs: OutputFile[] = [];
  selectedOutput: OutputFile | null = null;
  
  // Pipeline config
  pipelineDocId = '';
  cfgProvider = 'vllm';
  cfgModel = '/model_vllm';
  cfgTemp = 0.0;
  cfgMaxTokens = '';
  cfgChunkSize = '';
  cfgVllmBaseUrl = '';
  cfgVllmApiKey = '';
  cfgOpenaiApiKey = '';

  /** Giá trị mặc định khi chọn provider (chatgpt / vllm / ...) */
  private static readonly CHATGPT_DEFAULTS = {
    model: 'gpt-4o-mini',
    temperature: 0,
    maxTokens: '',
    chunkSize: '',
    vllmBaseUrl: '',
    vllmApiKey: '',
    openaiApiKey: '', // User nhập hoặc dùng env OPENAI_API_KEY ở backend
  };
  private static readonly VLLM_DEFAULTS = {
    model: '/model_vllm',
    temperature: 0,
    maxTokens: '',
    chunkSize: '',
    vllmBaseUrl: 'http://10.192.4.50:8000/v1',
    vllmApiKey: 'dev-token',
    openaiApiKey: '',
  };
  
  // Pipeline steps
  steps = [
    { value: 'extract', checked: true },
    { value: 'parse', checked: true },
    { value: 'export', checked: true },
    { value: 'validate', checked: true }
  ];
  
  pipelineStatus = '';
  pipelineLogs = '';
  isRunningPipeline = false;
  
  private destroy$ = new Subject<void>();
  selectedFile: File | null = null;

  constructor(
    public documentService: DocumentService,
    private ragApi: RagApiService
  ) {}

  ngOnInit(): void {
    // Subscribe to state changes
    this.documentService.state$.pipe(takeUntil(this.destroy$)).subscribe(state => {
      this.docs = state.docs;
      this.outputs = state.outputs;
      
      // Update selected doc
      this.selectedDoc = state.docs.find(d => d.id === state.selectedDocId) || null;
      // Always sync pipelineDocId with selectedDocId
      this.pipelineDocId = state.selectedDocId || '';
      
      // Update selected output
      this.selectedOutput = state.outputs.find(o => o.name === state.selectedOutputName) || null;
    });
    
    // Load docs on init
    this.loadDocs();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  onToggleCollapse(): void {
    this.toggleCollapse.emit();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.selectedFile = input.files[0];
    }
  }

  async uploadDocument(): Promise<void> {
    if (!this.selectedFile) {
      alert('Chọn 1 file PDF trước.');
      return;
    }

    try {
      const doc = await firstValueFrom(this.ragApi.uploadDocument(this.selectedFile));
      const currentDocs = this.documentService.state.docs;
      this.documentService.setDocs([...currentDocs, doc]);
      this.documentService.setSelectedDocId(doc.id);
      this.selectedFile = null;
      
      // Reset file input
      const fileInput = document.getElementById('upload-file') as HTMLInputElement;
      if (fileInput) {
        fileInput.value = '';
      }
    } catch (e: any) {
      alert('Upload thất bại: ' + e.message);
    }
  }

  async loadDocs(): Promise<void> {
    try {
      const docs = await firstValueFrom(this.ragApi.getDocuments());
      this.documentService.setDocs(docs);
    } catch (e: any) {
      alert('Failed to load docs: ' + e.message);
    }
  }

  selectDoc(doc: Document): void {
    console.log('Selecting doc:', doc.id);
    this.documentService.setSelectedDocId(doc.id);
    // pipelineDocId will be automatically updated via state subscription in ngOnInit
  }

  useInPipeline(): void {
    const selectedDocId = this.documentService.state.selectedDocId;
    if (!selectedDocId) {
      alert('Chọn 1 doc trước.');
      return;
    }
    console.log('Use in pipeline clicked, docId:', selectedDocId);
    // pipelineDocId is already synced via state subscription
    // This button confirms the doc is ready for pipeline (same as original behavior)
    // Editor component will automatically update via DocumentService state subscription
  }

  /** Khi đổi LLM Provider → điền mặc định (chatgpt: gpt-4o-mini, ...) */
  onProviderChange(provider: string): void {
    const p = (provider || '').toLowerCase();
    if (p === 'chatgpt') {
      this.cfgModel = DocsComponent.CHATGPT_DEFAULTS.model;
      this.cfgTemp = DocsComponent.CHATGPT_DEFAULTS.temperature;
      this.cfgMaxTokens = DocsComponent.CHATGPT_DEFAULTS.maxTokens;
      this.cfgChunkSize = DocsComponent.CHATGPT_DEFAULTS.chunkSize;
      this.cfgVllmBaseUrl = DocsComponent.CHATGPT_DEFAULTS.vllmBaseUrl;
      this.cfgVllmApiKey = DocsComponent.CHATGPT_DEFAULTS.vllmApiKey;
      this.cfgOpenaiApiKey = DocsComponent.CHATGPT_DEFAULTS.openaiApiKey;
    } else if (p === 'vllm') {
      this.cfgModel = DocsComponent.VLLM_DEFAULTS.model;
      this.cfgTemp = DocsComponent.VLLM_DEFAULTS.temperature;
      this.cfgMaxTokens = DocsComponent.VLLM_DEFAULTS.maxTokens;
      this.cfgChunkSize = DocsComponent.VLLM_DEFAULTS.chunkSize;
      this.cfgVllmBaseUrl = DocsComponent.VLLM_DEFAULTS.vllmBaseUrl;
      this.cfgVllmApiKey = DocsComponent.VLLM_DEFAULTS.vllmApiKey;
      this.cfgOpenaiApiKey = DocsComponent.VLLM_DEFAULTS.openaiApiKey;
    }
  }

  async runPipeline(): Promise<void> {
    const selectedDocId = this.documentService.state.selectedDocId;
    if (!selectedDocId) {
      alert('Chọn 1 doc trước.');
      return;
    }

    const selectedSteps = this.steps.filter(s => s.checked).map(s => s.value);
    if (selectedSteps.length === 0) {
      alert('Chọn ít nhất 1 step.');
      return;
    }

    const config: PipelineConfig = {
      llmProvider: this.cfgProvider,
      model: this.cfgModel,
      temperature: this.cfgTemp
    };

    if (this.cfgMaxTokens) {
      config.maxTokens = parseInt(this.cfgMaxTokens, 10);
    }
    if (this.cfgChunkSize) {
      config.chunkSize = parseInt(this.cfgChunkSize, 10);
    }
    if (this.cfgVllmBaseUrl) {
      config.vllmBaseUrl = this.cfgVllmBaseUrl;
    }
    if (this.cfgVllmApiKey) {
      config.vllmApiKey = this.cfgVllmApiKey;
    }
    if (this.cfgOpenaiApiKey && (this.cfgProvider === 'chatgpt' || this.cfgProvider === 'openai')) {
      config.openaiApiKey = this.cfgOpenaiApiKey;
    }

    this.isRunningPipeline = true;
    this.pipelineStatus = 'Running...';
    this.pipelineLogs = '';

    try {
      console.log('Running pipeline with:', {
        docId: selectedDocId,
        config,
        steps: selectedSteps
      });

      const res = await firstValueFrom(this.ragApi.runPipeline({
        docId: selectedDocId,
        config,
        steps: selectedSteps
      }));

      console.log('Pipeline response:', res);

      this.pipelineStatus = res.ok
        ? '<span class="badge-ok">OK</span>'
        : '<span class="badge-fail">FAIL</span>';
      this.pipelineLogs = (res.logs || []).join('\n');
      
      // Reload outputs after pipeline completes
      if (res.ok) {
        console.log('Pipeline succeeded, reloading outputs...');
        await this.loadOutputs();
      }
    } catch (e: any) {
      console.error('Pipeline error:', e);
      this.pipelineStatus = '<span class="badge-fail">ERROR</span>';
      this.pipelineLogs = e.message || e.toString();
    } finally {
      this.isRunningPipeline = false;
    }
  }

  async loadOutputs(): Promise<void> {
    const selectedDocId = this.documentService.state.selectedDocId;
    if (!selectedDocId) {
      alert('Chọn 1 doc trước.');
      return;
    }

    try {
      console.log('Loading outputs for docId:', selectedDocId);
      const outputs = await firstValueFrom(
        this.ragApi.getOutputs(selectedDocId)
      );
      console.log('Loaded outputs:', outputs);
      this.documentService.setOutputs(outputs);
    } catch (e: any) {
      console.error('Failed to load outputs:', e);
      alert('Failed to load outputs: ' + (e.message || e.toString()));
    }
  }

  /** Load nội dung file structure và set jsonStructure (dùng cho cả selectOutput và viewOutput). */
  private async loadStructureIfNeeded(output: OutputFile): Promise<void> {
    if (!this.documentService.state.selectedDocId) return;
    if (!output.name.includes('structure') || !output.name.endsWith('.json')) {
      this.documentService.setJsonStructure(null);
      return;
    }
    try {
      const text = await firstValueFrom(
        this.ragApi.getOutputContent(this.documentService.state.selectedDocId, output.name)
      );
      let parsed: any = null;
      try {
        parsed = JSON.parse(text);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      } catch (e1) {
        if (text.trim().startsWith('"') && text.trim().endsWith('"')) {
          const unescaped = JSON.parse(text);
          if (typeof unescaped === 'string') parsed = JSON.parse(unescaped);
        }
      }
      if (parsed && typeof parsed === 'object') {
        this.documentService.setJsonStructure(parsed);
      } else {
        this.documentService.setJsonStructure(null);
      }
    } catch (e) {
      console.warn('Could not load JSON structure:', e);
      this.documentService.setJsonStructure(null);
    }
  }

  async selectOutput(output: OutputFile): Promise<void> {
    this.documentService.setSelectedOutputName(output.name);
    // Khi chọn file structure thì load luôn nội dung để cây + panel "Văn bản liên quan" có dữ liệu
    await this.loadStructureIfNeeded(output);
  }

  async viewOutput(output: OutputFile): Promise<void> {
    if (!this.documentService.state.selectedDocId) return;
    try {
      await firstValueFrom(
        this.ragApi.getOutputContent(this.documentService.state.selectedDocId, output.name)
      );
      this.documentService.setSelectedOutputName(output.name);
      await this.loadStructureIfNeeded(output);
    } catch (e: any) {
      alert('Failed to view output: ' + e.message);
    }
  }

  async deleteOutput(output: OutputFile): Promise<void> {
    const docId = this.documentService.state.selectedDocId;
    if (!docId) return;
    if (!confirm(`Xóa file "${output.name}"?\nHành động không thể hoàn tác.`)) return;
    try {
      await firstValueFrom(this.ragApi.deleteOutput(docId, output.name));
      if (this.documentService.state.selectedOutputName === output.name) {
        this.documentService.setSelectedOutputName(null);
        this.documentService.setJsonStructure(null);
      }
      await this.loadOutputs();
    } catch (e: any) {
      alert('Xóa thất bại: ' + (e?.error?.detail || e?.message || e));
    }
  }
}
