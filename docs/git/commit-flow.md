# Thứ tự thực thi từng bước khi bạn git commit
## 1. Bạn chạy git add và git commit trên máy host (VD tại thư mục E:\Web\finops-core).

## 2. Git trên host đọc cấu hình Husky (core.hooksPath trỏ tới .husky) và thực thi file .husky/pre-commit ngay trên máy host.

## 3. File .husky/pre-commit gọi Docker Compose trên host:docker compose exec -T api npx lint-staged
Lúc này, Docker CLI trên host gửi yêu cầu sang container đang chạy tên là api (nest_api).

## 4. Bên trong container api (working_dir: /app):

* npx lint-staged chạy và hỏi Git xem file nào đang được staged (nhờ . được bind mount vào /app nên container thấy cả .git và trạng thái staged của repo).

* lint-staged lọc đúng các file staged khớp pattern (ví dụ *.ts, *.json, *.md) rồi chạy oxlint --fix và prettier --write lên các file đó (nằm trên thư mục bind mount . nên sửa trực tiếp trên file ở máy host).

* Nếu oxlint hoặc prettier báo lỗi, lint-staged thoát với mã lỗi khác 0 → docker compose exec trả mã lỗi về cho .husky/pre-commit → Git hủy commit.

## 5. Nếu lint-staged thành công (mã thoát 0):

* lint-staged tự stage lại các file đã được fix/format (nếu cần), trả quyền kiểm soát về cho Git trên host.

* Git trên host hoàn tất tạo commit.

# Tóm tắt ai làm việc gì?
* **Máy host:** Chạy git add, git commit, kích hoạt .husky/pre-commit, gọi docker compose exec, và ghi nhận commit cuối cùng.

* **Container api:** Cung cấp môi trường Node 26 + node_modules (oxlint, prettier, lint-staged) để kiểm tra và format file staged qua bind mount /app.

# Attention
* Container `api` phải đang bật (docker compose up -d) trước khi bạn git commit.

* Trên máy `host`, Git phải đã trỏ hook về .husky (thường do npx husky / npx husky init thiết lập khi có .git).
