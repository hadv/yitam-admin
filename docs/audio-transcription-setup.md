# Audio Transcription Setup Guide

This guide explains how to set up Google Cloud Speech-to-Text API for audio transcription functionality in the enhanced video metadata system.

## Overview

The audio transcription feature allows the system to:
- Extract audio from downloaded videos
- Convert speech to text using Google Cloud Speech-to-Text
- Generate enhanced metadata based on actual video content
- Support Vietnamese and English languages
- Provide higher accuracy than subtitle-based transcription

## Prerequisites

### 1. Google Cloud Account
- Create a Google Cloud account at https://cloud.google.com
- Enable billing for your project
- Create a new project or use an existing one

### 2. Enable Speech-to-Text API
1. Go to Google Cloud Console
2. Navigate to "APIs & Services" > "Library"
3. Search for "Cloud Speech-to-Text API"
4. Click "Enable"

### 3. Create Service Account
1. Go to "IAM & Admin" > "Service Accounts"
2. Click "Create Service Account"
3. Name: `speech-to-text-service`
4. Role: `Cloud Speech Client` or `Editor`
5. Create and download the JSON key file

### 4. Install ffmpeg
Audio processing requires ffmpeg:

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

**Windows:**
Download from https://ffmpeg.org/download.html

## Configuration

### 1. Environment Variables

Add to your `.env` file:

```env
# Google Cloud Speech-to-Text Configuration
GOOGLE_CLOUD_PROJECT_ID=your-project-id
GOOGLE_CLOUD_KEY_FILE=path/to/service-account-key.json

# Alternative method (recommended for production)
# GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account-key.json
```

### 2. Service Account Key

**Option A: Key File Path**
```env
GOOGLE_CLOUD_KEY_FILE=/path/to/your/service-account-key.json
```

**Option B: Application Credentials (Recommended)**
```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account-key.json"
```

### 3. Verify Setup

Check if audio transcription is available:
```bash
curl http://localhost:3001/api/youtube/yt-dlp/status
```

Response should include audio transcription status.

## Usage

### 1. Enhanced Download with Audio Transcription

```bash
curl -X POST http://localhost:3001/api/youtube/yt-dlp/download-enhanced \
  -H "Content-Type: application/json" \
  -d '{
    "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
    "enhancementOptions": {
      "useAudioTranscription": true,
      "audioTranscriptionOptions": {
        "languageCode": "vi-VN",
        "enableAutomaticPunctuation": true,
        "useEnhancedModel": true
      }
    }
  }'
```

### 2. Frontend Usage

In the yt-dlp downloader interface:
1. Check "Generate enhanced metadata with AI"
2. Check "🎵 Use audio transcription (higher accuracy)"
3. Download the video

## Language Support

### Supported Language Codes

- **Vietnamese**: `vi-VN`
- **English (US)**: `en-US`
- **English (UK)**: `en-GB`
- **Auto-detect**: System will attempt to detect language

### Configuration Example

```javascript
audioTranscriptionOptions: {
  languageCode: 'vi-VN',
  enableAutomaticPunctuation: true,
  enableWordTimeOffsets: false,
  useEnhancedModel: true,
  profanityFilter: false
}
```

## Pricing

Google Cloud Speech-to-Text pricing (as of 2024):
- **Standard model**: $0.006 per 15 seconds
- **Enhanced model**: $0.009 per 15 seconds
- **First 60 minutes per month**: Free

**Example costs:**
- 10-minute video: ~$0.24 (standard) or ~$0.36 (enhanced)
- 1-hour video: ~$1.44 (standard) or ~$2.16 (enhanced)

## Troubleshooting

### Common Issues

**1. "Google Speech-to-Text client is not initialized"**
- Check if service account key file exists
- Verify GOOGLE_CLOUD_PROJECT_ID is set
- Ensure Speech-to-Text API is enabled

**2. "Audio extraction failed"**
- Install ffmpeg: `brew install ffmpeg`
- Check if video file exists and is accessible
- Verify ffmpeg is in PATH: `which ffmpeg`

**3. "Audio transcription failed"**
- Check Google Cloud quotas and billing
- Verify service account has correct permissions
- Check audio file size (max 10MB for sync recognition)

**4. "No transcription results returned"**
- Audio might be silent or very quiet
- Try different language code
- Check if audio contains speech

### Debug Mode

Enable detailed logging:
```env
NODE_ENV=development
```

Check server logs for detailed error messages.

### File Size Limits

- **Synchronous recognition**: 10MB max
- **Large files**: Automatically split into chunks
- **Recommended**: Videos under 1 hour for best performance

## Performance Optimization

### 1. Audio Quality
- 16kHz sample rate (automatically set)
- Mono channel (automatically converted)
- WAV format for best compatibility

### 2. Processing Time
- **Small videos** (<10MB audio): 10-30 seconds
- **Large videos** (>10MB audio): 1-5 minutes
- **Chunked processing**: Parallel processing for faster results

### 3. Cost Optimization
- Use standard model for cost savings
- Enable enhanced model only for critical content
- Consider caching transcription results

## Security

### Best Practices
1. **Never commit service account keys** to version control
2. **Use environment variables** for sensitive data
3. **Rotate service account keys** regularly
4. **Limit service account permissions** to minimum required
5. **Use Google Application Credentials** in production

### Production Deployment
```bash
# Set environment variable instead of file path
export GOOGLE_APPLICATION_CREDENTIALS="/secure/path/to/key.json"

# Or use Google Cloud IAM for compute instances
# No key file needed when running on Google Cloud
```

## Integration with Enhanced Metadata

The audio transcription integrates seamlessly with the enhanced metadata system:

1. **Priority**: Audio transcription → YouTube transcript → Metadata only
2. **Confidence**: Audio transcription provides highest confidence scores
3. **Language**: Automatically detected from audio
4. **Content**: More accurate than subtitle-based analysis

## Monitoring

### Success Metrics
- Transcription success rate
- Average confidence scores
- Processing time per video
- Cost per transcription

### Logs to Monitor
```
✅ Audio transcription successful: 150 words, confidence: 92.5%
🎵 Audio transcription-based enhancement...
⚠️ Audio transcription failed: [error details]
```

## Support

For issues with:
- **Google Cloud setup**: Check Google Cloud documentation
- **ffmpeg installation**: Check ffmpeg documentation  
- **Integration issues**: Check server logs and this documentation
- **API limits**: Check Google Cloud quotas and billing
