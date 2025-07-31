import ytdl from 'ytdl-core';
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
 * Get video information from YouTube URL
 */
export const getVideoInfo = async (youtubeUrl: string): Promise<VideoInfo> => {
  try {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    const info = await ytdl.getInfo(youtubeUrl);
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
    throw new Error(`Failed to get video information: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Download YouTube video
 */
export const downloadVideo = async (
  youtubeUrl: string,
  options: DownloadOptions = {},
  progressCallback?: (progress: DownloadProgress) => void
): Promise<{ filePath: string; videoInfo: VideoInfo }> => {
  try {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      throw new Error('Invalid YouTube URL');
    }

    // Get video info first
    const videoInfo = await getVideoInfo(youtubeUrl);
    
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

    // Set download options
    const downloadOptions: ytdl.downloadOptions = {
      quality: options.audioOnly ? 'highestaudio' : (options.quality || 'highest'),
      filter: options.audioOnly ? 'audioonly' : 'videoandaudio'
    };

    return new Promise((resolve, reject) => {
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
        reject(new Error(`Download failed: ${error.message}`));
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
    throw new Error(`Failed to download video: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
