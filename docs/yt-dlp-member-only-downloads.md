# yt-dlp Member-Only YouTube Video Downloads

This feature allows you to download member-only YouTube videos using yt-dlp and browser cookies.

## Prerequisites

1. **Install yt-dlp**: You need to have yt-dlp installed on your system.
   ```bash
   pip install yt-dlp
   ```

2. **Browser Cookies**: For member-only videos, you need to export your browser cookies from a browser where you're logged into YouTube with an active membership.

## How to Export Browser Cookies

### Method 1: Using Browser Extensions

1. **Chrome/Edge**: Install "Get cookies.txt LOCALLY" extension
2. **Firefox**: Install "cookies.txt" extension
3. Navigate to YouTube while logged in
4. Click the extension icon and export cookies as a .txt file

### Method 2: Using yt-dlp directly

```bash
# This will save cookies to a file
yt-dlp --cookies-from-browser chrome --cookies cookies.txt "https://www.youtube.com/watch?v=VIDEO_ID"
```

### Method 3: Manual Export (Advanced)

1. Open Developer Tools (F12)
2. Go to Application/Storage tab
3. Find YouTube cookies
4. Export in Netscape format

## Using the Feature

1. **Access the yt-dlp Download Mode**:
   - Go to the YouTube Upload section
   - Select "yt-dlp Download (Member-Only)" radio button

2. **Upload Cookies File**:
   - Click "Choose File" in the Browser Cookies section
   - Select your exported .txt cookies file
   - The file will be uploaded and available for selection

3. **Configure Download Options**:
   - **Quality**: Choose video quality (Best, 720p, 480p, etc.)
   - **Audio Options**: 
     - Audio Only: Download only audio
     - Extract Audio: Download video and extract audio separately
   - **Audio Format**: Choose format when downloading audio (MP3, AAC, FLAC, WAV)

4. **Download Video**:
   - Enter the YouTube URL
   - Click "Get Info" to check video details and membership requirements
   - Click "Download with yt-dlp" to start the download

## Features

### Video Information Display
- Shows video title, uploader, duration, views
- Indicates if the video is member-only
- Warns if cookies are required but not provided

### Progress Tracking
- Real-time download progress
- Speed and ETA information
- Status updates during processing

### Cookies Management
- Upload multiple cookies files
- Select which cookies file to use
- Delete unused cookies files
- View list of available cookies files

### Download Options
- Multiple quality options
- Audio-only downloads
- Audio extraction from video
- Various audio formats

## Supported Video Types

- **Public Videos**: Works without cookies
- **Member-Only Videos**: Requires valid cookies from a member account
- **Premium Videos**: Requires cookies from a Premium subscriber
- **Live Streams**: Supported (if accessible)
- **Private Videos**: Requires appropriate access permissions

## Troubleshooting

### yt-dlp Not Found
- Ensure yt-dlp is installed: `pip install yt-dlp`
- Check if it's in your PATH: `yt-dlp --version`
- On some systems, you might need to use `python -m yt_dlp` instead

### Cookies Not Working
- Ensure cookies are from the same browser session where you have access
- Cookies expire - re-export if downloads start failing
- Make sure you're logged into YouTube with the correct account
- Check that your membership is still active

### Download Failures
- Verify the video URL is correct
- Check if the video is still available
- Ensure you have sufficient disk space
- Try different quality settings

### Permission Errors
- Check file system permissions for the downloads directory
- Ensure the cookies directory is writable

## File Locations

- **Downloaded Videos**: `./downloads/` directory
- **Cookies Files**: `./cookies/` directory
- **Temporary Files**: `./temp/` directory (cleaned automatically)

## Security Notes

- Cookies files contain sensitive authentication information
- Store cookies files securely and don't share them
- Delete old cookies files when no longer needed
- The application stores cookies locally and doesn't transmit them elsewhere

## API Endpoints

The feature adds several new API endpoints:

- `GET /api/youtube/yt-dlp/status` - Check yt-dlp installation
- `POST /api/youtube/yt-dlp/download` - Download video with yt-dlp
- `POST /api/youtube/yt-dlp/info` - Get video info with yt-dlp
- `POST /api/youtube/cookies/upload` - Upload cookies file
- `GET /api/youtube/cookies` - List cookies files
- `DELETE /api/youtube/cookies/:fileName` - Delete cookies file

## Example Usage

1. Export cookies from Chrome while logged into YouTube
2. Upload the cookies.txt file through the interface
3. Enter a member-only video URL
4. Click "Get Info" to verify access
5. Configure quality settings
6. Click "Download with yt-dlp"
7. Monitor progress and wait for completion

The downloaded video will appear in the Downloads section and can be played directly in the browser or downloaded to your device.
