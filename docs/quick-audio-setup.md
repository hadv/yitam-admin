# Quick Audio Transcription Setup

Nếu bạn đã có `GOOGLE_CREDENTIALS_BASE64` được cấu hình, việc setup audio transcription rất đơn giản!

## ✅ **Điều Kiện Tiên Quyết**

Bạn đã có:
- ✅ `GOOGLE_CLOUD_PROJECT_ID` trong .env
- ✅ `GOOGLE_CREDENTIALS_BASE64` trong .env  
- ✅ Google Cloud project đang hoạt động

## 🚀 **Setup Chỉ Cần 2 Bước**

### **Bước 1: Enable Speech-to-Text API**

1. Vào [Google Cloud Console](https://console.cloud.google.com)
2. Chọn project của bạn
3. Vào **APIs & Services** > **Library**
4. Tìm **"Cloud Speech-to-Text API"**
5. Click **"Enable"**

### **Bước 2: Cài đặt ffmpeg**

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt-get install ffmpeg
```

**Windows:**
- Download từ https://ffmpeg.org/download.html
- Thêm vào PATH

## ✅ **Xong! Không Cần Thêm Gì**

Hệ thống sẽ tự động:
- ✅ Sử dụng `GOOGLE_CREDENTIALS_BASE64` hiện có
- ✅ Kết nối với Speech-to-Text API
- ✅ Transcribe audio từ video
- ✅ Tạo enhanced metadata chính xác

## 🧪 **Test Ngay**

```bash
cd server
node test-audio-transcription.js
```

Hoặc sử dụng UI:
1. Mở http://localhost:5173
2. Vào yt-dlp section
3. Check ✅ "Generate enhanced metadata with AI"
4. Check ✅ "🎵 Use audio transcription (higher accuracy)"
5. Test với video Kinh Dịch: `https://www.youtube.com/watch?v=B1oRxj89gAw`

## 🎯 **Kết Quả Mong Đợi**

**Trước (chỉ metadata):**
```
Enhancement Source: metadata
Confidence: 40%
Enhanced Title: "Khí Công & Sức Khỏe..." (SAI)
```

**Sau (audio transcription):**
```
Enhancement Source: transcript  
Confidence: 90%+
Enhanced Title: "Giảng Kinh Dịch..." (ĐÚNG)
Key Topics: ["kinh dịch", "dịch học", "triết học"]
```

## 💰 **Chi Phí**

Google Speech-to-Text:
- **60 phút đầu/tháng**: MIỄN PHÍ
- **Sau đó**: ~$0.006/15 giây
- **Video 10 phút**: ~$0.24

## 🔧 **Troubleshooting**

**Lỗi: "Google Speech-to-Text client is not initialized"**
- ✅ Check `GOOGLE_CLOUD_PROJECT_ID` trong .env
- ✅ Check `GOOGLE_CREDENTIALS_BASE64` trong .env
- ✅ Đảm bảo Speech-to-Text API đã enabled

**Lỗi: "Audio extraction failed"**
- ✅ Cài đặt ffmpeg: `brew install ffmpeg`
- ✅ Check ffmpeg trong PATH: `which ffmpeg`

**Lỗi: "Audio transcription failed"**
- ✅ Check Google Cloud billing enabled
- ✅ Check API quotas
- ✅ Check service account permissions

## 🎵 **Workflow Hoàn Chỉnh**

```
1. User chọn video YouTube
2. yt-dlp download video
3. ffmpeg extract audio → WAV 16kHz mono
4. Google Speech-to-Text → Vietnamese text
5. Gemini AI analyze → Enhanced metadata
6. Display kết quả với confidence cao
```

## 📊 **So Sánh Các Phương Pháp**

| Phương Pháp | Confidence | Accuracy | Yêu Cầu |
|-------------|------------|----------|----------|
| **Audio Transcription** | 90%+ | Cao nhất | Google Cloud + ffmpeg |
| YouTube Transcript | 70% | Trung bình | Video có subtitle |
| Metadata Only | 40% | Thấp | Chỉ cần yt-dlp |

## 🎯 **Kết Luận**

Với setup hiện tại của bạn, chỉ cần:
1. **Enable Speech-to-Text API** (1 click)
2. **Install ffmpeg** (1 command)

→ **Có ngay audio transcription chính xác 90%+** 🚀

Không cần tạo service account mới hay cấu hình credentials phức tạp!
