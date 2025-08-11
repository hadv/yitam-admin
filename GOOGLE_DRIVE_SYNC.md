# Google Drive Sync Feature

## Tổng quan

Tính năng Google Drive Sync cho phép đồng bộ hóa các file từ server (thư mục uploads hoặc downloads) lên Google Drive một cách tự động.

## Cài đặt và Cấu hình

### 1. Cấu hình Google OAuth

Đảm bảo các biến môi trường sau đã được thiết lập trong file `.env`:

```env
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3001/api/auth/google/callback
```

### 2. Google Cloud Console Setup

**Nếu đã có YouTube API setup (như project hiện tại):**
1. Truy cập [Google Cloud Console](https://console.cloud.google.com/)
2. Chọn project hiện tại (cùng project với YouTube API)
3. Vào **APIs & Services** → **Library**
4. Tìm "Google Drive API" và click **Enable**

**Nếu setup từ đầu:**
1. Truy cập [Google Cloud Console](https://console.cloud.google.com/)
2. Tạo hoặc chọn một project
3. Bật Google Drive API và YouTube Data API v3
4. Tạo OAuth 2.0 credentials
5. Thêm redirect URI: `http://localhost:3001/api/auth/google/callback`

### 3. Scopes được sử dụng

- `https://www.googleapis.com/auth/youtube.force-ssl`
- `https://www.googleapis.com/auth/youtube.readonly`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/drive.metadata.readonly`

## Cách sử dụng

### 1. Xác thực với Google

- Truy cập trang Server Files
- Click button "Sync to Google Drive"
- Nếu chưa xác thực, bạn sẽ được chuyển hướng đến Google OAuth
- Đăng nhập và cấp quyền cho ứng dụng

### 2. Đồng bộ file

1. Click button "Sync to Google Drive"
2. Chọn thư mục muốn đồng bộ (Uploads hoặc Downloads)
3. Nhập tên folder trên Google Drive
4. Chọn có ghi đè file đã tồn tại hay không
5. Click "Start Sync"

### 3. Xem kết quả

Sau khi đồng bộ hoàn tất, bạn sẽ thấy:
- Số file đã upload thành công
- Số file bị bỏ qua (đã tồn tại)
- Số file lỗi
- Danh sách chi tiết các file

## API Endpoints

### POST /api/google-drive/sync
Đồng bộ file từ server lên Google Drive

**Request Body:**
```json
{
  "directoryType": "uploads" | "downloads",
  "folderName": "string",
  "overwriteExisting": boolean
}
```

**Headers:**
```
Authorization: Bearer <google_access_token>
```

### POST /api/google-drive/folder
Tạo hoặc tìm folder trên Google Drive

**Request Body:**
```json
{
  "folderName": "string",
  "parentFolderId": "string" // optional
}
```

### POST /api/google-drive/upload
Upload một file cụ thể lên Google Drive

**Request Body:**
```json
{
  "fileName": "string",
  "directoryType": "uploads" | "downloads",
  "folderId": "string" // optional
}
```

### GET /api/google-drive/check
Kiểm tra file có tồn tại trên Google Drive không

**Query Parameters:**
- `fileName`: Tên file cần kiểm tra
- `folderId`: ID folder (optional)

## Cấu trúc Code

### Backend

- `server/src/services/google-drive.ts`: Service chính cho Google Drive API
- `server/src/controllers/google-drive.ts`: Controllers xử lý HTTP requests
- `server/src/routes/google-drive.ts`: Route definitions
- `server/src/services/youtube-auth.ts`: OAuth authentication (đã cập nhật scopes)

### Frontend

- `client/src/services/googleDriveService.ts`: Service gọi API từ frontend
- `client/src/types/google-drive.ts`: Type definitions
- `client/src/components/FileBrowser.tsx`: UI component (đã thêm sync button và modal)

## Tính năng chính

1. **Xác thực OAuth2**: Sử dụng Google OAuth để xác thực người dùng
2. **Tạo folder tự động**: Tự động tạo folder trên Google Drive nếu chưa tồn tại
3. **Kiểm tra file trùng lặp**: Tránh upload file đã tồn tại (có thể tùy chọn ghi đè)
4. **Báo cáo chi tiết**: Hiển thị kết quả đồng bộ chi tiết
5. **Xử lý lỗi**: Xử lý và báo cáo lỗi một cách rõ ràng
6. **UI thân thiện**: Modal đẹp với progress indicator

## Lưu ý

- Access token được lưu trong localStorage của browser
- Token sẽ tự động refresh khi hết hạn
- Chỉ sync được file từ thư mục uploads và downloads
- Hỗ trợ nhiều loại file: PDF, DOC, DOCX, images, videos, etc.
- File size không giới hạn (tuân theo giới hạn của Google Drive API)

## Troubleshooting

### Lỗi xác thực
- Kiểm tra Google OAuth credentials
- Đảm bảo redirect URI đúng
- Kiểm tra scopes đã được cấp quyền

### Lỗi upload
- Kiểm tra file có tồn tại trên server không
- Kiểm tra quyền truy cập Google Drive
- Kiểm tra kết nối internet

### Lỗi UI
- Kiểm tra access token trong localStorage
- Refresh trang và thử lại
- Kiểm tra console log để xem lỗi chi tiết
