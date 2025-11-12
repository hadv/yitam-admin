# Transcript Correction - Sửa lỗi chính tả trong Vector Database

## Tổng quan

Chức năng này cho phép sửa các lỗi chính tả trong transcript đã được lưu trong vector database. Đặc biệt hữu ích cho việc sửa các từ chuyên biệt của Phật giáo trong tiếng Việt bị nhận dạng sai khi transcript từ YouTube.

## Các lỗi chính tả mặc định được sửa

1. **"dính mắt"** → **"dính mắc"**
2. **"rộng lặng"** → **"rỗng lặng"**

## API Endpoints

### 1. Sửa tất cả transcripts

**Endpoint:** `POST /api/youtube/correct-transcripts`

**Body:**
```json
{
  "dryRun": false,
  "correctionRules": [
    {
      "incorrect": "dính mắt",
      "correct": "dính mắc",
      "caseSensitive": false
    },
    {
      "incorrect": "rộng lặng",
      "correct": "rỗng lặng",
      "caseSensitive": false
    }
  ]
}
```

**Parameters:**
- `dryRun` (boolean, optional): Nếu `true`, chỉ xem trước kết quả mà không thực sự cập nhật database. Mặc định: `false`
- `correctionRules` (array, optional): Danh sách các quy tắc sửa lỗi. Nếu không cung cấp, sẽ sử dụng quy tắc mặc định cho thuật ngữ Phật giáo

**Response:**
```json
{
  "success": true,
  "message": "Transcript correction completed",
  "dryRun": false,
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

### 2. Sửa chỉ YouTube transcripts

**Endpoint:** `POST /api/youtube/correct-youtube-transcripts`

**Body:**
```json
{
  "videoId": "abc123xyz",
  "dryRun": true,
  "correctionRules": [
    {
      "incorrect": "dính mắt",
      "correct": "dính mắc"
    }
  ]
}
```

**Parameters:**
- `videoId` (string, optional): ID của video YouTube cần sửa. Nếu không cung cấp, sẽ sửa tất cả YouTube transcripts
- `dryRun` (boolean, optional): Chế độ xem trước
- `correctionRules` (array, optional): Danh sách các quy tắc sửa lỗi

### 3. Lấy danh sách quy tắc mặc định

**Endpoint:** `GET /api/youtube/correction-rules`

**Response:**
```json
{
  "success": true,
  "rules": [
    {
      "incorrect": "dính mắt",
      "correct": "dính mắc",
      "caseSensitive": false
    },
    {
      "incorrect": "rộng lặng",
      "correct": "rỗng lặng",
      "caseSensitive": false
    }
  ],
  "description": "Default correction rules for Buddhist terminology in Vietnamese"
}
```

### 4. Xem trước kết quả sửa lỗi

**Endpoint:** `POST /api/youtube/preview-corrections`

**Body:**
```json
{
  "text": "Trong thiền định, chúng ta cần rộng lặng tâm và không dính mắt vào bất cứ điều gì.",
  "correctionRules": [
    {
      "incorrect": "dính mắt",
      "correct": "dính mắc"
    },
    {
      "incorrect": "rộng lặng",
      "correct": "rỗng lặng"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "originalText": "Trong thiền định, chúng ta cần rộng lặng tâm và không dính mắt vào bất cứ điều gì.",
  "correctedText": "Trong thiền định, chúng ta cần rỗng lặng tâm và không dính mắc vào bất cứ điều gì.",
  "hasChanges": true,
  "replacements": [
    {
      "rule": "rộng lặng → rỗng lặng",
      "count": 1
    },
    {
      "rule": "dính mắt → dính mắc",
      "count": 1
    }
  ]
}
```

## Quy trình sử dụng

### Bước 1: Xem trước (Dry Run)

Trước khi thực sự sửa lỗi, nên chạy dry run để xem kết quả:

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": true
  }'
```

### Bước 2: Thực hiện sửa lỗi

Sau khi xác nhận kết quả dry run, thực hiện sửa lỗi thực sự:

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{
    "dryRun": false
  }'
```

### Bước 3: Sửa lỗi cho một video cụ thể

Nếu chỉ muốn sửa lỗi cho một video:

```bash
curl -X POST http://localhost:3001/api/youtube/correct-youtube-transcripts \
  -H "Content-Type: application/json" \
  -d '{
    "videoId": "abc123xyz",
    "dryRun": false
  }'
```

## Thêm quy tắc sửa lỗi mới

Bạn có thể thêm các quy tắc sửa lỗi tùy chỉnh:

```json
{
  "correctionRules": [
    {
      "incorrect": "từ sai",
      "correct": "từ đúng",
      "caseSensitive": false
    },
    {
      "incorrect": "Từ Sai Khác",
      "correct": "Từ Đúng Khác",
      "caseSensitive": true
    }
  ]
}
```

## Lưu ý quan trọng

1. **Backup dữ liệu**: Nên backup database trước khi chạy correction
2. **Dry run trước**: Luôn chạy dry run trước để kiểm tra kết quả
3. **Embedding mới**: Hệ thống sẽ tự động tạo embedding mới cho content đã sửa
4. **Thời gian xử lý**: Quá trình có thể mất thời gian tùy thuộc vào số lượng chunks cần sửa
5. **API rate limit**: Có delay 100ms giữa các lần tạo embedding để tránh quá tải API

## Ví dụ sử dụng với JavaScript

```javascript
// Xem trước kết quả
const dryRunResponse = await fetch('http://localhost:3001/api/youtube/correct-youtube-transcripts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ dryRun: true })
});

const dryRunResult = await dryRunResponse.json();
console.log('Dry run result:', dryRunResult);

// Nếu kết quả OK, thực hiện sửa lỗi thực sự
if (dryRunResult.success) {
  const actualResponse = await fetch('http://localhost:3001/api/youtube/correct-youtube-transcripts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: false })
  });
  
  const actualResult = await actualResponse.json();
  console.log('Correction result:', actualResult);
}
```

