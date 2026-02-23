# Hướng dẫn Git và đẩy code lên GitHub

## 1. Tạo file .gitignore

Repo đã có sẵn file **`.gitignore`** ở thư mục gốc, bỏ qua:

- Thư mục Python: `__pycache__/`, `.venv/`, `venv/`
- File môi trường: `.env`, `infra/.env`
- Log: `logs/`, `*.log`
- Node/Angular: `node_modules/`, `dist/`, `.angular/`
- IDE/OS: `.idea/`, `.vscode/`, `.DS_Store`

**Lưu ý:** Không commit file `infra/.env` (chứa mật khẩu). Tạo file mẫu `infra/.env.example` (không có giá trị nhạy cảm) để người khác biết biến cần thiết.

---

## 2. Khởi tạo Git và commit (nếu chưa có repo)

Chạy từ **thư mục gốc** project (`ocr-platform`):

```bash
cd /mnt/data/code/ocr-platform

# Khởi tạo repo (chỉ chạy nếu chưa có .git)
git init

# Thêm toàn bộ file (đã tuân theo .gitignore)
git add .

# Kiểm tra file sẽ được commit
git status

# Commit lần đầu
git commit -m "Initial commit: OCR platform API, worker, frontend"
```

---

## 3. Tạo repo trên GitHub và đẩy code

1. **Tạo repository mới trên GitHub**
   - Vào https://github.com/new
   - Đặt tên (vd: `ocr-platform`), chọn Public/Private, **không** tạo README/.gitignore (repo đã có)

2. **Kết nối remote và push**

   Trên máy (sau khi đã `git init` và `git commit`):

   ```bash
   # Thay YOUR_USERNAME và YOUR_REPO bằng tên user GitHub và tên repo của bạn
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git

   # Đặt nhánh mặc định (tùy chọn)
   git branch -M main

   # Đẩy lên GitHub
   git push -u origin main
   ```

   Nếu dùng SSH:

   ```bash
   git remote add origin git@github.com:YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

3. **Nhập tài khoản GitHub** khi được hỏi (HTTPS) hoặc dùng SSH key đã cấu hình.

---

## 4. Các lệnh thường dùng sau này

```bash
git status                  # Xem file thay đổi
git add .                    # Thêm tất cả (theo .gitignore)
git add path/to/file         # Chỉ thêm file cụ thể
git commit -m "Mô tả thay đổi"
git push                     # Đẩy lên GitHub (sau lần đầu có -u origin main)
git pull                     # Kéo code mới từ GitHub
```

---

## 5. Nếu đã có thư mục .git (repo đã tồn tại)

Chỉ cần thêm remote và push:

```bash
git remote -v
# Nếu chưa có origin:
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Nếu GitHub báo lỗi do repo mới đã có commit (vd: README), có thể đồng bộ bằng:

```bash
git pull origin main --allow-unrelated-histories
# Giải quyết conflict nếu có, rồi:
git push -u origin main
```
