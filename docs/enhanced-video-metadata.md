# Enhanced Video Metadata with LLM Integration

This document describes the enhanced video metadata functionality that uses LLM APIs to generate improved titles, summaries, and content analysis for YouTube videos downloaded with yt-dlp.

## Overview

The enhanced metadata system implements a **Combined Approach** that prioritizes transcript-based enhancement when available, with intelligent fallback to metadata-based enhancement. This ensures the highest quality content analysis regardless of video accessibility.

### Enhancement Strategy

1. **Primary**: Audio transcription-based enhancement (when Google Speech-to-Text is configured)
2. **Secondary**: Transcript-based enhancement (when YouTube transcript is available)
3. **Fallback**: Metadata-based enhancement (using yt-dlp extracted metadata)
4. **Final Fallback**: Basic metadata preservation

## Features

### 🎯 Core Enhancements

- **Enhanced Titles**: More descriptive, SEO-friendly titles
- **Comprehensive Summaries**: Detailed content summaries
- **Content-Based Analysis**: Analysis based on actual video content (when transcript available)
- **Key Topics Extraction**: Automatic identification of main themes
- **Content Tags**: Relevant categorization tags
- **Language Detection**: Automatic language detection and localized output

### 🔍 Advanced Features (Transcript-Based)

- **Key Quotes Extraction**: Important statements and quotes from the video
- **Chapter Detection**: Automatic chapter identification (future feature)
- **Content Confidence Scoring**: Quality assessment of the enhancement

## API Endpoints

### 1. Enhanced Download

Downloads a YouTube video with enhanced metadata generation.

```http
POST /api/youtube/yt-dlp/download-enhanced
```

**Request Body:**
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "options": {
    "quality": "best[ext=mp4]/best",
    "audioOnly": false,
    "extractAudio": false,
    "audioFormat": "mp3"
  },
  "cookiesFileName": "cookies.txt",
  "enhancementOptions": {
    "includeChapters": true,
    "includeKeyQuotes": true,
    "maxKeyTopics": 8,
    "maxContentTags": 12,
    "temperature": 0.3,
    "maxOutputTokens": 4000,
    "languagePreference": "auto"
  },
  "socketId": "socket-id-for-progress"
}
```

**Response:**
```json
{
  "message": "Video downloaded successfully with enhanced metadata",
  "videoId": "VIDEO_ID",
  "filePath": "/path/to/downloaded/video.mp4",
  "fileName": "video.mp4",
  "videoInfo": {
    "videoId": "VIDEO_ID",
    "title": "Original Title",
    "description": "Original description...",
    "duration": 180,
    "uploader": "Channel Name",
    "viewCount": 1000000
  },
  "enhancedMetadata": {
    "originalMetadata": { /* yt-dlp metadata */ },
    "enhancedTitle": "Enhanced descriptive title",
    "enhancedSummary": "Comprehensive summary...",
    "contentBasedTitle": "Content-based title",
    "contentBasedSummary": "Content-based summary...",
    "keyTopics": ["topic1", "topic2", "topic3"],
    "contentTags": ["tag1", "tag2", "tag3"],
    "keyQuotes": ["Quote 1", "Quote 2"],
    "enhancementSource": "transcript",
    "language": "English",
    "confidence": 0.9,
    "processingTime": 5000
  }
}
```

### 2. Generate Enhanced Metadata Only

Generates enhanced metadata without downloading the video.

```http
POST /api/youtube/yt-dlp/enhance-metadata
```

**Request Body:**
```json
{
  "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "enhancementOptions": {
    "includeKeyQuotes": true,
    "maxKeyTopics": 6,
    "maxContentTags": 10,
    "temperature": 0.2,
    "languagePreference": "auto"
  }
}
```

**Alternative (with existing video info):**
```json
{
  "videoInfo": {
    "videoId": "VIDEO_ID",
    "title": "Video Title",
    "description": "Video description...",
    "duration": 180,
    "uploader": "Channel Name"
  },
  "youtubeUrl": "https://www.youtube.com/watch?v=VIDEO_ID",
  "enhancementOptions": { /* ... */ }
}
```

## Enhancement Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `includeChapters` | boolean | `true` | Generate automatic chapters (future feature) |
| `includeKeyQuotes` | boolean | `true` | Extract key quotes from transcript |
| `maxKeyTopics` | number | `8` | Maximum number of key topics to extract |
| `maxContentTags` | number | `12` | Maximum number of content tags to generate |
| `temperature` | number | `0.3` | LLM creativity level (0.0-1.0) |
| `maxOutputTokens` | number | `4000` | Maximum tokens for LLM response |
| `languagePreference` | string | `"auto"` | Language preference (`"auto"`, `"en"`, `"vi"`, etc.) |

## Enhancement Sources

### 1. Transcript-Based Enhancement (`"transcript"`)

**Confidence**: 0.9  
**Requirements**: Video must have accessible transcript  
**Features**:
- Content-based title and summary
- Key quotes extraction
- Detailed topic analysis
- High accuracy content understanding

### 2. Metadata-Based Enhancement (`"metadata"`)

**Confidence**: 0.6  
**Requirements**: yt-dlp metadata only  
**Features**:
- Enhanced title based on original title/description
- Inferred topic analysis
- SEO-friendly improvements
- Basic content categorization

### 3. Combined Enhancement (`"combined"`)

**Confidence**: 0.8  
**Requirements**: Both transcript and metadata available  
**Features**: Best of both approaches

## Language Support

The system automatically detects content language and generates enhanced metadata in the same language:

- **Vietnamese**: Detected by Vietnamese-specific characters
- **English**: Default for non-Vietnamese content
- **Custom**: Override with `languagePreference` option

## Error Handling

The system implements graceful degradation:

1. **Transcript Enhancement Fails**: Falls back to metadata-based enhancement
2. **Metadata Enhancement Fails**: Returns basic enhanced metadata
3. **Complete Failure**: Returns original metadata with minimal enhancement

## Usage Examples

### Basic Enhanced Download

```javascript
const response = await fetch('/api/youtube/yt-dlp/download-enhanced', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    options: { quality: 'best[height<=720]' }
  })
});

const result = await response.json();
console.log('Enhanced Title:', result.enhancedMetadata.enhancedTitle);
console.log('Key Topics:', result.enhancedMetadata.keyTopics);
```

### Metadata Only Generation

```javascript
const response = await fetch('/api/youtube/yt-dlp/enhance-metadata', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    youtubeUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    enhancementOptions: {
      maxKeyTopics: 5,
      includeKeyQuotes: false,
      temperature: 0.2
    }
  })
});

const result = await response.json();
console.log('Enhancement Source:', result.enhancedMetadata.enhancementSource);
console.log('Confidence:', result.enhancedMetadata.confidence);
```

## Testing

Run the test script to verify functionality:

```bash
cd server
node test-enhanced-metadata.js
```

The test script will:
1. Check yt-dlp installation status
2. Test enhanced metadata generation
3. Optionally test enhanced download (commented out by default)

## Configuration

### Environment Variables

Ensure these environment variables are set:

```env
GEMINI_API_KEY=your_gemini_api_key_here
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your_qdrant_api_key
COLLECTION_NAME=knowledge_base
GEMINI_VECTOR_SIZE=768
```

### Prerequisites

- yt-dlp installed and accessible
- Google Gemini API key
- Node.js server running
- Qdrant vector database (for transcript storage)

## Performance Considerations

- **Transcript-based enhancement**: 3-8 seconds depending on transcript length
- **Metadata-based enhancement**: 1-3 seconds
- **Download + enhancement**: Adds 2-8 seconds to download time
- **Token usage**: ~500-2000 tokens per enhancement (depending on content length)

## Future Enhancements

- [ ] Automatic chapter detection and timestamps
- [ ] Video thumbnail analysis integration
- [ ] Multi-language transcript support
- [ ] Batch processing for multiple videos
- [ ] Custom enhancement templates
- [ ] Integration with video player for enhanced viewing experience
