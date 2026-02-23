# PageIndex Angular Frontend

Angular frontend cho PageIndex application với ngx-markdown để render Markdown với Table of Contents tự động.

## Cài đặt

```bash
cd apps/pageindex/frontend-angular
npm install
```

## Chạy development server

```bash
npm start
```

Ứng dụng sẽ chạy tại `http://localhost:4200`

## Build production

```bash
npm run build
```

## Cấu trúc

- `src/app/components/` - Các Angular components
  - `docs/` - Component quản lý documents, pipeline và outputs
  - `pdf-viewer/` - Component hiển thị PDF với annotations
  - `json-editor/` - Component editor JSON/Markdown với TOC
- `src/app/services/` - Services
  - `rag-api.service.ts` - API calls đến backend
  - `document.service.ts` - State management cho documents với RxJS

## Tính năng

- ✅ **DocsComponent**: Upload PDF, list documents, pipeline configuration, outputs list
- ✅ **PdfViewerComponent**: Hiển thị PDF với annotations markers và popup
- ✅ **JsonEditorComponent**: JSON/Markdown editor với:
  - Markdown rendering với ngx-markdown
  - Table of Contents tự động từ headings
  - Smooth scroll navigation
  - Active section highlighting trong TOC
  - JSON validation và save

## State Management

Tất cả components share state thông qua `DocumentService`:
- `docs`: Danh sách documents
- `selectedDocId`: Document được chọn
- `outputs`: Danh sách outputs
- `selectedOutputName`: Output được chọn
- `jsonStructure`: JSON structure để render PDF annotations

## Dependencies chính

- Angular 17
- ngx-markdown@17 - Markdown rendering với TOC support
- marked - Markdown parser
- RxJS - Reactive state management

## Workflow

1. **Upload PDF**: Chọn file và upload trong DocsComponent
2. **Select Document**: Click vào document trong list để chọn
3. **Run Pipeline**: Cấu hình và chạy pipeline để generate outputs
4. **View Output**: Click "View" trên output để xem trong editor
5. **Edit JSON**: Switch sang tab JSON để edit
6. **View Markdown**: Switch sang tab Markdown để xem với TOC
7. **PDF Annotations**: Khi có structure.json, markers sẽ xuất hiện trên PDF viewer

## API Endpoints

Backend API phải chạy tại `http://localhost:8100/api`:
- `GET /docs` - List documents
- `POST /docs/upload` - Upload PDF
- `GET /docs/{docId}/file` - Get PDF file
- `GET /outputs/{docId}` - List outputs
- `GET /outputs/{docId}/{filename}` - Get output content
- `POST /pipeline/run` - Run pipeline
- `POST /editor/load` - Load editor content
- `POST /editor/validate` - Validate JSON
- `POST /editor/save` - Save JSON
