# Debugging Guide - Use in pipeline & Reload outputs

## Vấn đề đã sửa:

### 1. "Use in pipeline" button
- **Vấn đề**: Button không hoạt động hoặc không update UI đúng cách
- **Giải pháp**: 
  - `pipelineDocId` được tự động sync với `selectedDocId` qua state subscription
  - Button chỉ để confirm doc đã sẵn sàng cho pipeline (giống code gốc)
  - Editor component tự động update khi `selectedDocId` thay đổi

### 2. "Reload outputs" button
- **Vấn đề**: Không load outputs từ backend
- **Giải pháp**:
  - Thêm console.log để debug
  - Đảm bảo `selectedDocId` có giá trị trước khi gọi API
  - Xử lý error tốt hơn với error message chi tiết

## Cách test:

1. **Test "Use in pipeline"**:
   - Chọn một document từ list
   - Click "Use in pipeline"
   - Kiểm tra console log: `Use in pipeline clicked, docId: <id>`
   - Kiểm tra `pipelineDocId` trong UI có được update không

2. **Test "Reload outputs"**:
   - Chọn một document
   - Click "Reload outputs"
   - Kiểm tra console log: `Loading outputs for docId: <id>`
   - Kiểm tra `Loaded outputs: [...]` trong console
   - Kiểm tra outputs list có được update không

## Console logs để debug:

- `Selecting doc: <id>` - Khi click vào document
- `Use in pipeline clicked, docId: <id>` - Khi click "Use in pipeline"
- `Loading outputs for docId: <id>` - Khi click "Reload outputs"
- `Loaded outputs: [...]` - Khi outputs được load thành công
- `Failed to load outputs: <error>` - Khi có lỗi

## API Endpoints cần kiểm tra:

- `GET /api/outputs/{docId}` - Phải trả về array of Output objects
- `POST /api/pipeline/run` - Phải nhận PipelineRequest và trả về PipelineResponse

## Common Issues:

1. **Backend không chạy**: Kiểm tra `http://localhost:8100/api` có accessible không
2. **CORS error**: Backend phải cho phép CORS từ `http://localhost:4200`
3. **selectedDocId null**: Đảm bảo đã chọn document trước khi click buttons
4. **API response format**: Kiểm tra response format có đúng với interface không
