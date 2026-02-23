import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

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
