import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import { extractYouTubeId } from './youtube-transcript';

export interface DownloadProgress {
  videoId: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: number;
  eta: number;
}

export interface VideoInfo {
  videoId: string;
  title: string;
  description: string;
  duration: string;
  thumbnail: string;
  author: string;
  viewCount: string;
  uploadDate: string;
}

export interface DownloadOptions {
  quality?: 'highest' | 'lowest' | 'highestaudio' | 'lowestaudio';
  format?: 'mp4' | 'webm' | 'flv';
  audioOnly?: boolean;
}

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(process.cwd(), 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

/**
 * Categorizes YouTube access errors for better user feedback
 */
const categorizeYouTubeError = (error: Error): { category: string; userMessage: string; originalError: string } => {
  const errorMessage = error.message.toLowerCase();
  const originalError = error.message;

  // Members-only content
  if (errorMessage.includes('join this channel to get access to members-only content') ||
      errorMessage.includes('members-only') ||
      errorMessage.includes('channel membership required')) {
    return {
      category: 'MEMBERS_ONLY',
      userMessage: 'This video is restricted to channel members only. You need to join the channel as a member to access this content.',
      originalError
    };
  }

  // Private videos
  if (errorMessage.includes('private video') ||
      errorMessage.includes('this video is private')) {
    return {
      category: 'PRIVATE',
      userMessage: 'This video is private and cannot be accessed.',
      originalError
    };
  }

  // Age-restricted content
  if (errorMessage.includes('age-restricted') ||
      errorMessage.includes('sign in to confirm your age')) {
    return {
      category: 'AGE_RESTRICTED',
      userMessage: 'This video is age-restricted. You may need to sign in to YouTube to access it.',
      originalError
    };
  }

  // Geo-blocked content
  if (errorMessage.includes('not available in your country') ||
      errorMessage.includes('geo-blocked') ||
      errorMessage.includes('region')) {
    return {
      category: 'GEO_BLOCKED',
      userMessage: 'This video is not available in your region due to geographic restrictions.',
      originalError
    };
  }

  // Video not found or deleted
  if (errorMessage.includes('video unavailable') ||
      errorMessage.includes('video not found') ||
      errorMessage.includes('does not exist')) {
    return {
      category: 'NOT_FOUND',
      userMessage: 'This video is unavailable, may have been deleted, or the URL is incorrect.',
      originalError
    };
  }

  // Rate limiting
  if (errorMessage.includes('rate limit') ||
      errorMessage.includes('too many requests')) {
    return {
      category: 'RATE_LIMITED',
      userMessage: 'Too many requests. Please wait a moment before trying again.',
      originalError
    };
  }

  // Network issues
  if (errorMessage.includes('network') ||
      errorMessage.includes('timeout') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('etimedout')) {
    return {
      category: 'NETWORK',
      userMessage: 'Network connection issue. Please check your internet connection and try again.',
      originalError
    };
  }

  // Generic error
  return {
    category: 'UNKNOWN',
    userMessage: `Failed to access video: ${originalError}`,
    originalError
  };
};

/**
 * Get video information from YouTube URL
 */
export const getVideoInfo = async (youtubeUrl: string, authToken?: string): Promise<VideoInfo> => {
  try {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // First validate the URL
    if (!ytdl.validateURL(youtubeUrl)) {
      throw new Error('Invalid YouTube URL format');
    }

    console.log(`Getting video info for: ${videoId}`);

    // Prepare request options with authentication if available
    const requestOptions: any = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    };

    // Add authentication if available
    if (authToken) {
      (requestOptions.headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
      console.log('Using authenticated request for video info');
    }

    const info = await ytdl.getInfo(youtubeUrl, {
      requestOptions
    });

    const videoDetails = info.videoDetails;

    return {
      videoId,
      title: videoDetails.title,
      description: videoDetails.description || '',
      duration: videoDetails.lengthSeconds,
      thumbnail: videoDetails.thumbnails[0]?.url || '',
      author: videoDetails.author.name,
      viewCount: videoDetails.viewCount,
      uploadDate: videoDetails.uploadDate || ''
    };
  } catch (error) {
    console.error('Error getting video info:', error);
    const categorizedError = categorizeYouTubeError(error as Error);

    // Create a more informative error
    const enhancedError = new Error(categorizedError.userMessage);
    (enhancedError as any).category = categorizedError.category;
    (enhancedError as any).originalError = categorizedError.originalError;

    throw enhancedError;
  }
};

/**
 * Download YouTube video
 */
export const downloadVideo = async (
  youtubeUrl: string,
  options: DownloadOptions = {},
  progressCallback?: (progress: DownloadProgress) => void,
  authToken?: string
): Promise<{ filePath: string; videoInfo: VideoInfo }> => {
  try {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // Get video info first with authentication if available
    const videoInfo = await getVideoInfo(youtubeUrl, authToken);

    // Sanitize filename
    const sanitizedTitle = videoInfo.title
      .replace(/[^\w\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '_') // Replace spaces with underscores
      .substring(0, 100); // Limit length

    // Determine file extension based on options
    const extension = options.audioOnly ? 'mp3' : (options.format || 'mp4');
    const fileName = `${videoId}_${sanitizedTitle}.${extension}`;
    const filePath = path.join(downloadsDir, fileName);

    // Check if file already exists
    if (fs.existsSync(filePath)) {
      console.log(`File already exists: ${fileName}`);
      return { filePath, videoInfo };
    }

    // Set download options with better configuration
    const downloadOptions: ytdl.downloadOptions = {
      quality: options.audioOnly ? 'highestaudio' : (options.quality || 'highest'),
      filter: options.audioOnly ? 'audioonly' : 'videoandaudio',
      requestOptions: {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      }
    };

    // Add authentication if available
    if (authToken) {
      (downloadOptions.requestOptions!.headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
      console.log('Using authenticated request for video download');
    }

    return new Promise((resolve, reject) => {
      console.log(`Starting download with options:`, downloadOptions);
      const stream = ytdl(youtubeUrl, downloadOptions);
      const writeStream = fs.createWriteStream(filePath);

      let downloadedBytes = 0;
      let totalBytes = 0;
      let startTime = Date.now();

      stream.on('info', (info) => {
        const format = ytdl.chooseFormat(info.formats, downloadOptions);
        totalBytes = parseInt(format.contentLength || '0');
        console.log(`Starting download: ${videoInfo.title} (${totalBytes} bytes)`);
      });

      stream.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        
        if (progressCallback && totalBytes > 0) {
          const progress = (downloadedBytes / totalBytes) * 100;
          const elapsedTime = (Date.now() - startTime) / 1000;
          const speed = downloadedBytes / elapsedTime; // bytes per second
          const eta = totalBytes > downloadedBytes ? (totalBytes - downloadedBytes) / speed : 0;

          progressCallback({
            videoId,
            progress: Math.round(progress * 100) / 100,
            downloadedBytes,
            totalBytes,
            speed: Math.round(speed),
            eta: Math.round(eta)
          });
        }
      });

      stream.on('error', (error) => {
        console.error('Download error:', error);
        // Clean up partial file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }

        // Categorize the error for better user feedback
        const categorizedError = categorizeYouTubeError(error);
        const enhancedError = new Error(categorizedError.userMessage);
        (enhancedError as any).category = categorizedError.category;
        (enhancedError as any).originalError = categorizedError.originalError;

        reject(enhancedError);
      });

      stream.on('end', () => {
        console.log(`Download completed: ${fileName}`);
        resolve({ filePath, videoInfo });
      });

      stream.pipe(writeStream);

      writeStream.on('error', (error) => {
        console.error('Write stream error:', error);
        // Clean up partial file
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        reject(new Error(`File write failed: ${error.message}`));
      });
    });

  } catch (error) {
    console.error('Error downloading video:', error);

    // If it's already a categorized error, re-throw it
    if (error instanceof Error && (error as any).category) {
      throw error;
    }

    // Otherwise, categorize the error
    const categorizedError = categorizeYouTubeError(error as Error);
    const enhancedError = new Error(categorizedError.userMessage);
    (enhancedError as any).category = categorizedError.category;
    (enhancedError as any).originalError = categorizedError.originalError;

    throw enhancedError;
  }
};

/**
 * Get list of downloaded videos
 */
export const getDownloadedVideos = (): Array<{ fileName: string; filePath: string; size: number; createdAt: Date }> => {
  try {
    if (!fs.existsSync(downloadsDir)) {
      return [];
    }

    const files = fs.readdirSync(downloadsDir);
    return files
      .filter(file => file.match(/\.(mp4|webm|flv|mp3)$/i))
      .map(file => {
        const filePath = path.join(downloadsDir, file);
        const stats = fs.statSync(filePath);
        return {
          fileName: file,
          filePath,
          size: stats.size,
          createdAt: stats.birthtime
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  } catch (error) {
    console.error('Error getting downloaded videos:', error);
    return [];
  }
};

/**
 * Delete downloaded video file
 */
export const deleteDownloadedVideo = (fileName: string): boolean => {
  try {
    const filePath = path.join(downloadsDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Deleted video file: ${fileName}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting video file:', error);
    return false;
  }
};

/**
 * Get file path for serving downloaded video
 */
export const getVideoFilePath = (fileName: string): string | null => {
  const filePath = path.join(downloadsDir, fileName);
  return fs.existsSync(filePath) ? filePath : null;
};
