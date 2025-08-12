# yt-dlp Member-Only Video Download Feature

This document describes the newly implemented yt-dlp integration for downloading member-only YouTube videos.

## 🎯 Overview

The application now supports downloading member-only YouTube videos using yt-dlp and browser cookies. This feature extends the existing YouTube functionality to handle premium content that requires authentication.

## ✨ Features

### Core Functionality
- **Member-Only Video Support**: Download videos that require YouTube membership
- **Browser Cookie Authentication**: Upload and manage browser cookies for authentication
- **Multiple Download Options**: Various quality settings and audio extraction options
- **Real-Time Progress Tracking**: Live progress updates with speed and ETA
- **Smart Video Detection**: Automatically detects if a video is member-only
- **Cookie Management**: Upload, list, and delete cookie files

### User Interface
- **Integrated UI**: Seamlessly integrated into the existing YouTube upload interface
- **Three Download Modes**: 
  1. Extract Transcript (existing)
  2. Download Video (existing) 
  3. yt-dlp Download (Member-Only) (new)
- **Cookie Upload Interface**: Drag-and-drop cookie file upload
- **Video Information Display**: Shows video details and membership requirements
- **Progress Visualization**: Real-time progress bars and status updates

## 🛠 Technical Implementation

### Backend Components

#### New Services
- `yt-dlp-downloader.ts`: Core yt-dlp integration service
- Enhanced YouTube controller with yt-dlp endpoints
- Cookie file management with multer integration

#### API Endpoints
```
GET    /api/youtube/yt-dlp/status           - Check yt-dlp installation
POST   /api/youtube/yt-dlp/download         - Download video with yt-dlp
POST   /api/youtube/yt-dlp/info             - Get video information
POST   /api/youtube/cookies/upload          - Upload browser cookies
GET    /api/youtube/cookies                 - List available cookies
DELETE /api/youtube/cookies/:fileName       - Delete cookies file
```

### Frontend Components

#### New Components
- `YtDlpDownloader.tsx`: Main yt-dlp download interface
- Enhanced `YoutubeUpload.tsx` with mode selection

#### Key Features
- Cookie file upload with validation
- Download options configuration
- Progress tracking integration
- Error handling and user feedback

## 📋 Prerequisites

### System Requirements
- **yt-dlp**: Must be installed on the system
  ```bash
  # macOS
  brew install yt-dlp
  
  # Python
  pip install yt-dlp
  ```

### Browser Cookies
- Exported cookies from a browser logged into YouTube with membership
- Cookies must be in Netscape format (.txt file)

## 🚀 Usage Instructions

### 1. Export Browser Cookies

#### Method 1: Browser Extensions (Recommended)
- **Chrome/Edge**: Install "Get cookies.txt LOCALLY" extension
- **Firefox**: Install "cookies.txt" extension
- Visit YouTube.com while logged in
- Export cookies as .txt file

#### Method 2: Using yt-dlp
```bash
yt-dlp --cookies-from-browser chrome --cookies youtube_cookies.txt "https://www.youtube.com"
```

### 2. Using the Feature

1. **Access the Interface**:
   - Go to YouTube Upload section
   - Select "yt-dlp Download (Member-Only)" radio button

2. **Upload Cookies**:
   - Click "Choose File" in Browser Cookies section
   - Select your exported .txt cookies file
   - File will be uploaded and available for selection

3. **Configure Download**:
   - Choose video quality (Best, 720p, 480p, etc.)
   - Select audio options if needed
   - Choose audio format for audio downloads

4. **Download Video**:
   - Enter YouTube URL
   - Click "Get Info" to verify video details
   - Click "Download with yt-dlp" to start download
   - Monitor real-time progress

## 🔧 Configuration Options

### Video Quality
- `best[ext=mp4]/best` - Best quality MP4
- `worst[ext=mp4]/worst` - Lowest quality MP4
- `best[height<=720]` - 720p or lower
- `best[height<=480]` - 480p or lower
- `best[height<=360]` - 360p or lower

### Audio Options
- **Audio Only**: Download only audio stream
- **Extract Audio**: Download video and extract audio separately
- **Audio Formats**: MP3, AAC, FLAC, WAV

## 🛡 Security Considerations

- **Cookie Security**: Cookies contain sensitive authentication data
- **Local Storage**: Cookies are stored locally and not transmitted elsewhere
- **Automatic Cleanup**: Temporary files are cleaned up automatically
- **File Permissions**: Proper file permissions for cookie storage

## 🧪 Testing

Run the included test script to verify installation:

```bash
node server/src/test-yt-dlp.js
```

This will test:
- yt-dlp installation
- Directory permissions
- Video information retrieval
- Cookie file handling

## 📁 File Structure

```
server/src/
├── services/
│   └── yt-dlp-downloader.ts     # Core yt-dlp service
├── controllers/
│   └── youtube.ts               # Enhanced with yt-dlp endpoints
└── routes/
    └── youtube.ts               # New yt-dlp routes

client/src/
├── components/
│   ├── YtDlpDownloader.tsx      # New yt-dlp interface
│   └── YoutubeUpload.tsx        # Enhanced with mode selection

downloads/                       # Downloaded videos
cookies/                         # Uploaded cookie files
temp/                           # Temporary files
```

## 🐛 Troubleshooting

### Common Issues

1. **yt-dlp not found**:
   - Install yt-dlp: `brew install yt-dlp` or `pip install yt-dlp`
   - Verify installation: `yt-dlp --version`

2. **Cookies not working**:
   - Re-export cookies from browser
   - Ensure you're logged into correct YouTube account
   - Check that membership is still active

3. **Download failures**:
   - Verify video URL is correct
   - Check internet connection
   - Try different quality settings

4. **Permission errors**:
   - Check file system permissions
   - Ensure downloads directory is writable

## 🔄 Updates and Maintenance

- **Cookie Refresh**: Re-export cookies periodically as they expire
- **yt-dlp Updates**: Keep yt-dlp updated for best compatibility
- **Cleanup**: Regularly clean up old cookie files and downloads

## 📞 Support

For issues related to:
- **yt-dlp functionality**: Check yt-dlp documentation
- **Cookie export**: Refer to browser extension documentation
- **Application integration**: Check application logs and error messages

---

This feature significantly extends the application's YouTube capabilities, enabling access to premium content while maintaining security and user-friendly operation.
