import { Injectable } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError, filter, map } from 'rxjs/operators';

export interface Document {
  id: string;
  name: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface Output {
  name: string;
}

export interface PipelineConfig {
  llmProvider: string;
  model: string;
  temperature: number;
  maxTokens?: number;
  chunkSize?: number;
  vllmBaseUrl?: string;
  vllmApiKey?: string;
  openaiApiKey?: string;
}

export interface PipelineRequest {
  docId: string;
  config: PipelineConfig;
  steps: string[];
}

export interface PipelineResponse {
  ok: boolean;
  logs?: string[];
}

export interface EditorLoadResponse {
  jsonText: string;
}

export interface EditorValidateResponse {
  ok: boolean;
  errors?: Array<{ path?: string; message: string }>;
  warnings?: Array<{ path?: string; message: string }>;
}

const OCR_PREFIX = '/v1/ocr';
const DEFAULT_TENANT = 'demo';

export interface CreateJobResponse {
  job_id: string;
  status: string;
}

export interface UploadJobResponse {
  job_id: string;
  status: string;
  input_object_key: string;
  original_filename?: string;
  content_type?: string;
  size_bytes?: number;
  checksum?: string;
  page_count?: number;
  worker_queued?: boolean;
}

export interface OcrJobStatus {
  job_id: string;
  status: string;
  input_object_key?: string | null;
  result_object_key?: string | null;
  original_filename?: string | null;
  content_type?: string | null;
  size_bytes?: number | null;
  checksum?: string | null;
  page_count?: number | null;
  processed_pages?: number | null;
  progress?: number | null;
  error?: string | null;
  detect_result?: string | null;
  /** JSON kết quả OCR (pages, blocks, text) — đọc từ DB, hiển thị/chỉnh sửa trong JSON Editor. */
  result?: string | null;
}

export interface OcrJobListItem extends OcrJobStatus {
  created_at?: string;
  updated_at?: string;
}

export interface UploadProgressEvent {
  phase: 'creating' | 'uploading' | 'done' | 'error';
  message: string;
  percent?: number;
  error?: string;
}

/** Kết quả Detect (CRAFT) từng trang — dùng vẽ vùng lên PDF. */
export interface DetectResult {
  job_id: string;
  pages: Array<{
    page_index: number;
    width: number;
    height: number;
    boxes: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  }>;
}

@Injectable({
  providedIn: 'root'
})
export class RagApiService {
  /** Backend OCR API (port 8000). */
  private readonly API_BASE = 'http://localhost:8000';

  constructor(private http: HttpClient) {}

  // ---- OCR Job API (POST /jobs, POST /jobs/{job_id}/upload) ----
  createOcrJob(xTenantId: string = DEFAULT_TENANT): Observable<CreateJobResponse> {
    return this.http.post<CreateJobResponse>(`${this.API_BASE}${OCR_PREFIX}/jobs`, {}, {
      headers: { 'X-Tenant-Id': xTenantId }
    });
  }

  uploadToOcrJob(jobId: string, file: File, xTenantId: string = DEFAULT_TENANT): Observable<UploadJobResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<UploadJobResponse>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/upload`,
      formData,
      { headers: { 'X-Tenant-Id': xTenantId } }
    );
  }

  /** Upload với báo cáo tiến trình (progress). Emit progress 0..100 rồi response hoặc error. */
  uploadToOcrJobWithProgress(
    jobId: string,
    file: File,
    xTenantId: string = DEFAULT_TENANT
  ): Observable<{ progress?: number; response?: UploadJobResponse; error?: string }> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    type Emit = { progress: number } | { response: UploadJobResponse } | { error: string };
    return this.http.post<UploadJobResponse>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/upload`,
      formData,
      {
        headers: { 'X-Tenant-Id': xTenantId },
        reportProgress: true,
        observe: 'events'
      }
    ).pipe(
      map((event): Emit | null => {
        if (event.type === HttpEventType.UploadProgress && event.loaded != null && event.total != null && event.total > 0) {
          return { progress: Math.round((100 * event.loaded) / event.total) };
        }
        if (event.type === HttpEventType.Response && event.body) {
          return { response: event.body as UploadJobResponse };
        }
        return null;
      }),
      filter((v): v is Emit => v != null),
      catchError(err => {
        const msg = err?.error?.detail || err?.message || 'Upload failed';
        return of<{ error: string }>({ error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
      })
    );
  }

  listOcrJobs(xTenantId: string | null = DEFAULT_TENANT, limit = 50): Observable<{ jobs: OcrJobListItem[]; count: number }> {
    const headers: Record<string, string> = {};
    if (xTenantId) headers['X-Tenant-Id'] = xTenantId;
    return this.http.get<{ jobs: OcrJobListItem[]; count: number }>(
      `${this.API_BASE}${OCR_PREFIX}/jobs`,
      { params: { limit }, headers }
    );
  }

  getOcrJobStatus(jobId: string, xTenantId: string = DEFAULT_TENANT): Observable<OcrJobStatus> {
    return this.http.get<OcrJobStatus>(`${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}`, {
      headers: { 'X-Tenant-Id': xTenantId }
    });
  }

  /** Kết quả Detect (CRAFT boxes) cho job — vẽ vùng lên PDF. 404 khi worker chưa ghi xong. */
  getDetectResult(jobId: string, xTenantId: string = DEFAULT_TENANT): Observable<DetectResult> {
    return this.http.get<DetectResult>(`${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/detect`, {
      headers: { 'X-Tenant-Id': xTenantId }
    });
  }

  rerunOcrJob(jobId: string, xTenantId: string = DEFAULT_TENANT): Observable<{ job_id: string; status: string; worker_queued: boolean }> {
    return this.http.post<{ job_id: string; status: string; worker_queued: boolean }>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/rerun`,
      {},
      { headers: { 'X-Tenant-Id': xTenantId } }
    );
  }

  /** Chạy bước OCR (recognize) dùng detect_result trong DB — gọi sau khi đã chỉnh sửa boxes (nếu cần). */
  runOcrJob(jobId: string, xTenantId: string = DEFAULT_TENANT): Observable<{ job_id: string; worker_queued: boolean }> {
    return this.http.post<{ job_id: string; worker_queued: boolean }>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/run-ocr`,
      {},
      { headers: { 'X-Tenant-Id': xTenantId } }
    );
  }

  /** Cập nhật kết quả Detect (chỉnh sửa boxes) trong DB. */
  updateDetectResult(jobId: string, body: DetectResult, xTenantId: string = DEFAULT_TENANT): Observable<{ job_id: string; updated: boolean }> {
    return this.http.patch<{ job_id: string; updated: boolean }>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/detect`,
      body,
      { headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': xTenantId } }
    );
  }

  /** Cập nhật kết quả OCR (JSON) trong DB — dùng khi chỉnh sửa trong JSON Editor. */
  updateOcrResult(jobId: string, result: string, xTenantId: string = DEFAULT_TENANT): Observable<{ job_id: string; updated: boolean }> {
    return this.http.patch<{ job_id: string; updated: boolean }>(
      `${this.API_BASE}${OCR_PREFIX}/jobs/${jobId}/result`,
      { result },
      { headers: { 'Content-Type': 'application/json', 'X-Tenant-Id': xTenantId } }
    );
  }

  // Documents (OCR backend có thể không có GET /docs → trả về [] khi lỗi)
  getDocuments(): Observable<Document[]> {
    return this.http.get<Document[]>(`${this.API_BASE}/docs`).pipe(
      catchError(() => of([]))
    );
  }

  /** Upload file: gọi POST /v1/ocr/jobs → POST /v1/ocr/jobs/{job_id}/upload. */
  uploadDocument(file: File, xTenantId: string = DEFAULT_TENANT): Observable<Document> {
    return new Observable<Document>(subscriber => {
      this.createOcrJob(xTenantId).subscribe({
        next: (createRes) => {
          this.uploadToOcrJob(createRes.job_id, file, xTenantId).subscribe({
            next: () => {
              subscriber.next({
                id: createRes.job_id,
                name: file.name,
                sizeBytes: file.size,
                uploadedAt: new Date().toISOString()
              });
              subscriber.complete();
            },
            error: (err) => subscriber.error(err)
          });
        },
        error: (err) => subscriber.error(err)
      });
    });
  }

  getDocumentFile(docId: string): string {
    return `${this.API_BASE}/docs/${docId}/file`;
  }

  /** Lấy file PDF dưới dạng ArrayBuffer (để load bằng PDF.js, tránh CORS). */
  getDocumentFileAsArrayBuffer(docId: string, xTenantId: string = DEFAULT_TENANT): Observable<ArrayBuffer> {
    return this.http.get(`${this.API_BASE}/docs/${docId}/file`, {
      responseType: 'arraybuffer',
      headers: { 'X-Tenant-Id': xTenantId }
    });
  }

  // Outputs
  getOutputs(docId: string): Observable<Output[]> {
    return this.http.get<Output[]>(`${this.API_BASE}/outputs/${docId}`);
  }

  getOutputContent(docId: string, filename: string): Observable<string> {
    return this.http.get(`${this.API_BASE}/outputs/${docId}/${encodeURIComponent(filename)}`, {
      responseType: 'text'
    });
  }

  deleteOutput(docId: string, name: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(
      `${this.API_BASE}/outputs/${docId}/${encodeURIComponent(name)}`
    );
  }

  // Pipeline
  runPipeline(request: PipelineRequest): Observable<PipelineResponse> {
    return this.http.post<PipelineResponse>(`${this.API_BASE}/pipeline/run`, request);
  }

  // Editor
  loadEditor(docId: string, filename: string): Observable<EditorLoadResponse> {
    return this.http.post<EditorLoadResponse>(`${this.API_BASE}/editor/load`, {
      docId,
      filename
    });
  }

  validateEditor(jsonText: string): Observable<EditorValidateResponse> {
    return this.http.post<EditorValidateResponse>(`${this.API_BASE}/editor/validate`, {
      jsonText
    });
  }

  saveEditor(docId: string, filename: string, jsonText: string, overwrite: boolean = true): Observable<void> {
    return this.http.post<void>(`${this.API_BASE}/editor/save`, {
      docId,
      filename,
      jsonText,
      overwrite
    });
  }
}
