# Google Services Setup for YouTube Audio Fallback

This guide explains how to set up Google Cloud Services for YouTube content extraction when transcripts are not available.

## 🎯 Overview

Your system now uses Google Cloud Speech-to-Text API as a fallback when YouTube videos don't have transcripts available. This provides:

- **High-quality Vietnamese speech recognition**
- **Word-level timestamps and confidence scores**
- **Integration with YouTube Data API for video verification**
- **Automatic fallback when transcript extraction fails**

## 🚀 Setup Steps

### 1. Google Cloud Project Setup

```bash
# Install Google Cloud CLI (if not already installed)
curl https://sdk.cloud.google.com | bash
exec -l $SHELL

# Initialize gcloud (this will open a browser for authentication)
gcloud init

# Create a new project
gcloud projects create yitam-youtube-processor --name="YouTube Content Processor"

# Set the project as active
gcloud config set project yitam-youtube-processor
```

### 2. Enable Required APIs

```bash
# Enable YouTube Data API v3
gcloud services enable youtube.googleapis.com

# Enable Speech-to-Text API
gcloud services enable speech.googleapis.com

# Enable Cloud Storage API (for large files)
gcloud services enable storage.googleapis.com

# Verify APIs are enabled
gcloud services list --enabled
```

### 3. Create Service Account and Credentials

```bash
# Create service account
gcloud iam service-accounts create youtube-processor \
    --description="Service account for YouTube content processing" \
    --display-name="YouTube Processor"

# Grant necessary permissions
gcloud projects add-iam-policy-binding yitam-youtube-processor \
    --member="serviceAccount:youtube-processor@yitam-youtube-processor.iam.gserviceaccount.com" \
    --role="roles/speech.editor"

gcloud projects add-iam-policy-binding yitam-youtube-processor \
    --member="serviceAccount:youtube-processor@yitam-youtube-processor.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

# Create and download service account key
gcloud iam service-accounts keys create ./google-credentials.json \
    --iam-account=youtube-processor@yitam-youtube-processor.iam.gserviceaccount.com

# Move the key to a secure location
mkdir -p ~/.config/gcloud/
mv ./google-credentials.json ~/.config/gcloud/youtube-processor-key.json
```

### 4. Get YouTube Data API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to "APIs & Services" > "Credentials"
3. Click "Create Credentials" > "API Key"
4. Copy the API key
5. (Optional) Restrict the key to YouTube Data API v3 for security

### 5. Install Dependencies

```bash
cd server
npm install @google-cloud/speech @google-cloud/storage
```

### 6. Install yt-dlp

```bash
# Ubuntu/Debian
sudo apt install yt-dlp

# macOS
brew install yt-dlp

# Windows/Others
pip install yt-dlp

# Verify installation
yt-dlp --version
```

### 7. Configure Environment Variables

Create or update your `.env` file in the `server` directory:

```bash
# Google Cloud Services Configuration
GOOGLE_APPLICATION_CREDENTIALS=/home/your-username/.config/gcloud/youtube-processor-key.json
GOOGLE_CLOUD_PROJECT_ID=yitam-youtube-processor
YOUTUBE_API_KEY=your_youtube_data_api_key_here
GOOGLE_API_KEY=your_youtube_data_api_key_here

# Other existing variables...
GEMINI_API_KEY=your_gemini_api_key_here
QDRANT_URL=http://localhost:6333
# ... etc
```

## 🧪 Testing

### Quick Test

```bash
cd server
npm run build

# Test with your Vietnamese video
curl -X POST http://localhost:3001/api/youtube/process \
  -H "Content-Type: application/json" \
  -d '{"youtubeUrl": "https://www.youtube.com/watch?v=Mhnqzu8lY9k"}'
```

### How It Works

1. **System tries existing transcript methods** (YouTube auto-captions, manual captions, etc.)
2. **If all transcript methods fail** → Google Services audio fallback triggers
3. **YouTube Data API** verifies video exists and is accessible
4. **yt-dlp downloads audio** from the video
5. **Google Speech API transcribes** the audio with Vietnamese language support
6. **Text is chunked and embedded** for search
7. **Results stored** in your Qdrant vector database

## 💰 Cost Estimation

### Google Cloud Speech API Pricing:
- **Standard Model**: $0.006 per 15 seconds
- **Enhanced Model**: $0.009 per 15 seconds

### Examples:
- **10-minute video**: ~$0.24 (standard) to $0.36 (enhanced)
- **1-hour video**: ~$1.44 (standard) to $2.16 (enhanced)

### YouTube Data API:
- **Free quota**: 10,000 units/day
- **Video metadata**: 1 unit per request

## 🔧 Advanced Configuration

### Custom Vietnamese Phrases

The system includes domain-specific phrases for better recognition:

```typescript
speechContexts: [
  {
    phrases: [
      'võ thuật', 'martial arts', 'bát đoạn cẩm', 'qigong',
      'thái cực quyền', 'tai chi', 'kung fu'
    ],
    boost: 10.0
  }
]
```

You can customize these in `server/src/services/youtube-audio-fallback.ts`.

### Language Configuration

The system uses `vi-VN` (Vietnamese) as the primary language with `en-US` as fallback. You can modify this in the service configuration.

## 🚨 Troubleshooting

### Common Issues:

1. **"Permission denied" errors**
   - Check service account permissions
   - Verify GOOGLE_APPLICATION_CREDENTIALS path

2. **"yt-dlp not found"**
   - Install yt-dlp: `pip install yt-dlp`
   - Update yt-dlp: `pip install -U yt-dlp`

3. **"Video not accessible"**
   - Video might be private or region-blocked
   - Check YouTube Data API quotas

4. **"Speech API quota exceeded"**
   - Check Google Cloud billing is enabled
   - Monitor usage in Google Cloud Console

### Debug Mode

Enable detailed logging by setting:

```bash
export DEBUG=youtube-audio-fallback
```

## 📊 Monitoring

Monitor your usage at:
- **Google Cloud Console**: https://console.cloud.google.com/apis/dashboard
- **Speech API usage**: https://console.cloud.google.com/speech
- **YouTube API quotas**: https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas

## 🎯 Benefits

✅ **High Accuracy**: Google's Speech API provides excellent Vietnamese recognition  
✅ **Word-Level Timestamps**: Precise timing information for each word  
✅ **Confidence Scores**: Quality metrics for transcription accuracy  
✅ **Automatic Fallback**: Only used when transcripts aren't available  
✅ **Domain-Specific**: Optimized for martial arts terminology  
✅ **Enterprise Grade**: Reliable and scalable  

## 🔒 Security

- Store credentials securely outside the repository
- Use service accounts with minimal required permissions
- Regularly rotate API keys and service account keys
- Monitor API usage for unexpected activity

Your system now has robust Google Services integration for extracting content from YouTube videos without transcripts, specifically optimized for Vietnamese martial arts content!
