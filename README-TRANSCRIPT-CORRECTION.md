# Transcript Correction - Sửa lỗi chính tả trong Vector Database

## Tổng quan

Chức năng này cho phép sửa các lỗi chính tả trong transcript đã được lưu trong vector database. Đặc biệt hữu ích cho việc sửa các từ chuyên biệt của Phật giáo trong tiếng Việt bị nhận dạng sai khi transcript từ YouTube.

## Các lỗi chính tả mặc định

1. **"dính mắt"** → **"dính mắc"**
2. **"rộng lặng"** → **"rỗng lặng"**

## Cách sử dụng nhanh

### 1. Xem trước kết quả (Dry Run)

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

### 2. Thực hiện sửa lỗi

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{"dryRun": false}'
```

### 3. Sửa lỗi cho một video cụ thể

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{"videoId": "abc123xyz", "dryRun": false}'
```

## API Endpoints

| Endpoint | Method | Mô tả |
|----------|--------|-------|
| `/api/youtube/correct-transcripts` | POST | Sửa tất cả transcripts |
| `/api/youtube/correct-youtube-transcripts` | POST | Sửa chỉ YouTube transcripts |
| `/api/youtube/correction-rules` | GET | Lấy danh sách quy tắc mặc định |
| `/api/youtube/preview-corrections` | POST | Xem trước kết quả sửa lỗi |

## Tính năng

- ✅ Sửa lỗi chính tả trong content và enhancedContent
- ✅ Tự động tạo embedding mới cho content đã sửa
- ✅ Hỗ trợ dry run để xem trước kết quả
- ✅ Hỗ trợ quy tắc sửa lỗi tùy chỉnh
- ✅ Thống kê chi tiết về số lượng thay đổi
- ✅ Xử lý theo batch để tránh quá tải

## Cấu trúc code

```
server/src/
├── core/
│   └── database-service.ts          # Thêm updateChunks() và getAllChunksWithPointIds()
├── services/
│   └── transcript-correction.ts     # Service chính cho việc sửa lỗi
├── controllers/
│   └── transcript-correction.ts     # Controllers cho API endpoints
└── routes/
    └── youtube.ts                   # Routes cho transcript correction
```

## Lưu ý quan trọng

⚠️ **Backup dữ liệu**: Nên backup database trước khi chạy correction

⚠️ **Dry run trước**: Luôn chạy dry run trước để kiểm tra kết quả

⚠️ **Thời gian xử lý**: Quá trình có thể mất thời gian tùy thuộc vào số lượng chunks

## Tài liệu chi tiết

Xem [docs/transcript-correction.md](docs/transcript-correction.md) để biết thêm chi tiết về:
- Cách thêm quy tắc sửa lỗi mới
- Ví dụ sử dụng với JavaScript
- Cấu trúc request/response chi tiết
- Best practices

## Ví dụ Response

```json
{
  "success": true,
  "message": "YouTube transcript correction completed",
  "dryRun": false,
  "videoId": "all",
  "stats": {
    "totalChunksProcessed": 150,
    "chunksModified": 45,
    "totalReplacements": 67,
    "processingTimeMs": 12500,
    "replacementDetails": [
      {
        "rule": "dính mắt → dính mắc",
        "count": 34
      },
      {
        "rule": "rộng lặng → rỗng lặng",
        "count": 33
      }
    ]
  }
}
```

