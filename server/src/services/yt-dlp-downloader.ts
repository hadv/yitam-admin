import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { extractYouTubeId } from './youtube-transcript';

export interface YtDlpDownloadProgress {
  videoId: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  speed: string;
  eta: string;
  status: 'downloading' | 'processing' | 'complete' | 'error';
}

export interface YtDlpVideoInfo {
  videoId: string;
  title: string;
  description: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  viewCount: number;
  uploadDate: string;
  isLive: boolean;
  isMemberOnly: boolean;
  availability: string;
}

export interface YtDlpDownloadOptions {
  quality?: string; // e.g., 'best', 'worst', 'best[height<=720]'
  format?: string; // e.g., 'mp4', 'webm', 'best[ext=mp4]'
  audioOnly?: boolean;
  cookiesFile?: string; // Path to browser cookies file
  cookiesFromBrowser?: string; // Browser to extract cookies from: 'chrome', 'firefox', 'safari', 'edge'
  outputTemplate?: string;
  extractAudio?: boolean;
  audioFormat?: 'mp3' | 'aac' | 'flac' | 'wav';
}

// Ensure downloads directory exists
const DOWNLOADS_DIR = path.join(process.cwd(), 'downloads');
const COOKIES_DIR = path.join(process.cwd(), 'cookies');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

if (!fs.existsSync(COOKIES_DIR)) {
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
}

/**
 * Check if yt-dlp is installed
 */
export const checkYtDlpInstallation = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    const ytdlpPath = '/usr/local/bin/yt-dlp';
    const spawnOptions = {
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
      }
    };

    const ytdlp = spawn(ytdlpPath, ['--version'], spawnOptions);

    ytdlp.on('close', (code) => {
      resolve(code === 0);
    });

    ytdlp.on('error', () => {
      resolve(false);
    });
  });
};

/**
 * Get video information using yt-dlp
 */
export const getYtDlpVideoInfo = async (
  youtubeUrl: string,
  cookiesFile?: string,
  cookiesFromBrowser?: string
): Promise<YtDlpVideoInfo> => {
  return new Promise((resolve, reject) => {
    console.log('🔍 getYtDlpVideoInfo called with:', { youtubeUrl, cookiesFile, cookiesFromBrowser });

    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      reject(new Error('Invalid YouTube URL'));
      return;
    }

    const args = [
      '--dump-json',
      '--no-download',
      '--no-playlist',
      '-k', // Use -k flag like your working command
      youtubeUrl
    ];

    // Add cookies from browser if specified
    if (cookiesFromBrowser) {
      args.push('--cookies-from-browser', `${cookiesFromBrowser}:Profile 5`);
    }
    // Otherwise, add cookies file if provided
    else if (cookiesFile && fs.existsSync(cookiesFile)) {
      console.log('✅ Cookies file exists, adding to args:', cookiesFile);
      args.push('--cookies', cookiesFile);
    } else {
      console.log('❌ No cookies provided (file or browser)');
    }

    console.log('🚀 Spawning yt-dlp with args:', args);

    // Use full path and proper environment
    const ytdlpPath = '/usr/local/bin/yt-dlp';
    const spawnOptions = {
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
      },
      cwd: process.cwd()
    };

    console.log('🔧 Spawn options:', spawnOptions);
    const ytdlp = spawn(ytdlpPath, args, spawnOptions);
    let output = '';
    let errorOutput = '';

    // Set a timeout for the process
    const timeout = setTimeout(() => {
      console.log('⏰ yt-dlp process timeout, killing...');
      ytdlp.kill('SIGTERM');
      reject(new Error('yt-dlp process timed out after 60 seconds'));
    }, 60000); // 60 second timeout

    ytdlp.stdout.on('data', (data) => {
      const chunk = data.toString();
      console.log('📤 yt-dlp stdout:', chunk.substring(0, 200) + '...');
      output += chunk;
    });

    ytdlp.stderr.on('data', (data) => {
      const chunk = data.toString();
      console.log('📤 yt-dlp stderr:', chunk.substring(0, 200) + '...');
      errorOutput += chunk;
    });

    ytdlp.on('close', (code) => {
      clearTimeout(timeout);
      console.log(`🏁 yt-dlp process closed with code: ${code}`);

      if (code !== 0) {
        console.log('❌ yt-dlp failed with error output:', errorOutput);
        reject(new Error(`yt-dlp failed: ${errorOutput}`));
        return;
      }

      try {
        console.log('📋 Parsing yt-dlp output...');
        const info = JSON.parse(output);
        console.log('✅ Successfully parsed video info:', {
          id: info.id,
          title: info.title?.substring(0, 50) + '...',
          availability: info.availability
        });

        const videoInfo: YtDlpVideoInfo = {
          videoId,
          title: info.title || 'Unknown Title',
          description: info.description || '',
          duration: info.duration || 0,
          thumbnail: info.thumbnail || '',
          uploader: info.uploader || info.channel || 'Unknown',
          viewCount: info.view_count || 0,
          uploadDate: info.upload_date || '',
          isLive: info.is_live || false,
          isMemberOnly: info.availability === 'subscriber_only' ||
                       info.availability === 'premium_only' ||
                       (info.live_status === 'is_upcoming' && info.availability !== 'public'),
          availability: info.availability || 'unknown'
        };

        resolve(videoInfo);
      } catch (error) {
        console.log('❌ Failed to parse JSON output:', error);
        reject(new Error(`Failed to parse video info: ${error}`));
      }
    });

    ytdlp.on('error', (error) => {
      clearTimeout(timeout);
      console.log('❌ yt-dlp spawn error:', error);
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });
  });
};

/**
 * Get progressive format fallback options for yt-dlp
 */
const getFormatFallbacks = (options: YtDlpDownloadOptions): string[] => {
  if (options.audioOnly || options.extractAudio) {
    return ['bestaudio']; // For audio extraction, format is handled by --extract-audio
  }

  // Build progressive fallback list starting with user preferences
  const fallbackFormats: string[] = [];

  // Start with user-specified format/quality if provided
  if (options.format) {
    fallbackFormats.push(options.format);
  } else if (options.quality) {
    fallbackFormats.push(options.quality);
  }

  // Add comprehensive fallback options (avoiding duplicates)
  const standardFallbacks = [
    'best[ext=mp4][height<=1080]',           // Prefer MP4, max 1080p
    'best[ext=mp4]',                         // Any MP4 quality
    'best[height<=1080]',                    // Max 1080p, any format
    'best[height<=720]',                     // Max 720p, any format
    'bestvideo[height<=1080]+bestaudio',     // Separate streams, max 1080p
    'bestvideo[height<=720]+bestaudio',      // Separate streams, max 720p
    'bestvideo+bestaudio/best',              // Best separate streams or combined
    'best[protocol!=m3u8]',                  // Best non-HLS format
    'best',                                  // Best available quality, any format
    'bestvideo+bestaudio',                   // Any separate video+audio streams
    'worst'                                  // Last resort - any available format
  ];

  // Add fallbacks that aren't already in the list
  for (const format of standardFallbacks) {
    if (!fallbackFormats.includes(format)) {
      fallbackFormats.push(format);
    }
  }

  return fallbackFormats;
};

/**
 * Download YouTube video using yt-dlp with format fallback
 */
const downloadWithFormatFallback = async (
  youtubeUrl: string,
  outputTemplate: string,
  options: YtDlpDownloadOptions,
  progressCallback?: (progress: YtDlpDownloadProgress) => void
): Promise<{ filePath: string; errorOutput: string }> => {
  const formatOptions = getFormatFallbacks(options);
  let lastError = '';

  console.log(`🎬 Starting download with ${formatOptions.length} format fallback options:`, formatOptions);

  for (let i = 0; i < formatOptions.length; i++) {
    const format = formatOptions[i];
    console.log(`🎯 Attempting download with format: ${format} (attempt ${i + 1}/${formatOptions.length})`);

    try {
      const result = await attemptDownloadWithFormat(
        youtubeUrl,
        outputTemplate,
        format,
        options,
        progressCallback
      );

      console.log(`✅ Download successful with format: ${format}`);
      return result;
    } catch (error: any) {
      lastError = error.message;
      console.log(`❌ Format ${format} failed: ${error.message}`);

      // If this is the last attempt, provide comprehensive error information
      if (i === formatOptions.length - 1) {
        console.log(`💥 All ${formatOptions.length} format options exhausted. Formats tried:`, formatOptions);
        throw new Error(`All format options failed. Last error: ${lastError}`);
      }

      // Continue to next format option
      console.log(`🔄 Trying next format option...`);
    }
  }

  throw new Error(`All format options failed. Last error: ${lastError}`);
};

/**
 * Attempt download with a specific format
 */
const attemptDownloadWithFormat = async (
  youtubeUrl: string,
  outputTemplate: string,
  format: string,
  options: YtDlpDownloadOptions,
  progressCallback?: (progress: YtDlpDownloadProgress) => void
): Promise<{ filePath: string; errorOutput: string }> => {
  return new Promise((resolve, reject) => {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      reject(new Error('Invalid YouTube URL'));
      return;
    }

    const args = [
      '--newline',
      '--progress',
      '--no-playlist',
      '-k', // Use -k flag like your working command
      '-o', outputTemplate,
      youtubeUrl
    ];

    // Add quality/format options
    if (options.audioOnly || options.extractAudio) {
      args.push('--extract-audio');
      if (options.audioFormat) {
        args.push('--audio-format', options.audioFormat);
      }
    } else {
      args.push('-f', format);
    }

    // Add cookies from browser if specified
    if (options.cookiesFromBrowser) {
      // Use the exact format that works in command line (without extra quotes)
      args.push('--cookies-from-browser', `${options.cookiesFromBrowser}:Profile 5`);
    }
    // Otherwise, add cookies file if provided
    else if (options.cookiesFile && fs.existsSync(options.cookiesFile)) {
      args.push('--cookies', options.cookiesFile);
    }

    console.log('Starting yt-dlp download with args:', args);

    // Use full path and proper environment
    const ytdlpPath = '/usr/local/bin/yt-dlp';
    const spawnOptions = {
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
      },
      cwd: process.cwd()
    };

    const ytdlp = spawn(ytdlpPath, args, spawnOptions);
    let finalFilePath = '';
    let errorOutput = '';

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('yt-dlp output:', output);

        // Parse progress information with multiple regex patterns for robustness
        const progressPatterns = [
          // Full pattern: [download]  17.8% of   11.21MiB at    4.06MiB/s ETA 00:02
          /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*(\d+\.?\d*\w+)\s+at\s+(\S+)\s+ETA\s+(\S+)/,
          // Simpler pattern: [download]  17.8% of   11.21MiB at    4.06MiB/s
          /\[download\]\s+(\d+\.?\d*)%\s+of\s+(\S+)\s+at\s+(\S+)/,
          // Basic pattern: [download]  17.8%
          /\[download\]\s+(\d+\.?\d*)%/
        ];

        let progressMatch = null;
        let patternUsed = -1;

        for (let i = 0; i < progressPatterns.length; i++) {
          progressMatch = output.match(progressPatterns[i]);
          if (progressMatch) {
            patternUsed = i;
            break;
          }
        }

        if (progressMatch && progressCallback) {
          const progress = parseFloat(progressMatch[1]);
          const size = progressMatch[2] || 'Unknown';
          const speed = progressMatch[3] || 'Unknown';
          const eta = progressMatch[4] || 'Unknown';

          console.log(`📊 yt-dlp progress: ${progress}% (pattern ${patternUsed})`);

          progressCallback({
            videoId,
            progress,
            downloadedBytes: 0, // yt-dlp doesn't provide exact bytes easily
            totalBytes: 0,
            speed,
            eta,
            status: 'downloading'
          });
        }

        // Check for completion - handle both "100%" and "100.0%"
        if (output.includes('[download] 100%') || output.includes('[download] 100.0%')) {
          console.log('🎉 yt-dlp download completed (100%)');
          if (progressCallback) {
            progressCallback({
              videoId,
              progress: 100,
              downloadedBytes: 0,
              totalBytes: 0,
              speed: '0B/s',
              eta: '00:00',
              status: 'complete'
            });
          }
        }

        // Extract final file path
        const fileMatch = output.match(/\[download\] Destination: (.+)/);
        if (fileMatch) {
          finalFilePath = fileMatch[1].trim();
        }

        const mergeMatch = output.match(/\[Merger\] Merging formats into "(.+)"/);
        if (mergeMatch) {
          finalFilePath = mergeMatch[1].trim();
        }
      });

      ytdlp.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.error('yt-dlp error:', data.toString());
      });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp failed with code ${code}: ${errorOutput}`));
        return;
      }

      if (!finalFilePath) {
        // Try to find the downloaded file
        const files = fs.readdirSync(DOWNLOADS_DIR);
        const videoFiles = files.filter(file => file.startsWith(videoId!));
        if (videoFiles.length > 0) {
          finalFilePath = path.join(DOWNLOADS_DIR, videoFiles[0]);
        } else {
          reject(new Error('Could not determine downloaded file path'));
          return;
        }
      }

      resolve({ filePath: finalFilePath, errorOutput });
    });

    ytdlp.on('error', (error) => {
      reject(new Error(`Failed to spawn yt-dlp: ${error.message}`));
    });
  });
};

/**
 * Download YouTube video using yt-dlp
 */
export const downloadVideoWithYtDlp = async (
  youtubeUrl: string,
  options: YtDlpDownloadOptions = {},
  progressCallback?: (progress: YtDlpDownloadProgress) => void
): Promise<{ filePath: string; videoInfo: YtDlpVideoInfo }> => {
  return new Promise(async (resolve, reject) => {
    try {
      const videoId = extractYouTubeId(youtubeUrl);
      if (!videoId) {
        reject(new Error('Invalid YouTube URL'));
        return;
      }

      // Get video info first
      const videoInfo = await getYtDlpVideoInfo(youtubeUrl, options.cookiesFile, options.cookiesFromBrowser);

      // Sanitize filename
      const sanitizedTitle = videoInfo.title
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '_') // Replace spaces with underscores
        .substring(0, 100); // Limit length

      const outputTemplate = options.outputTemplate ||
        path.join(DOWNLOADS_DIR, `${videoId}_${sanitizedTitle}.%(ext)s`);

      // Use the new format fallback system
      const result = await downloadWithFormatFallback(
        youtubeUrl,
        outputTemplate,
        options,
        progressCallback
      );

      console.log(`yt-dlp download completed: ${result.filePath}`);
      resolve({ filePath: result.filePath, videoInfo });

    } catch (error) {
      reject(error);
    }
  });
};

/**
 * Save browser cookies file
 */
export const saveCookiesFile = async (
  cookiesContent: string,
  fileName: string = 'youtube_cookies.txt'
): Promise<string> => {
  const cookiesPath = path.join(COOKIES_DIR, fileName);
  
  try {
    await fs.promises.writeFile(cookiesPath, cookiesContent, 'utf8');
    console.log(`Cookies saved to: ${cookiesPath}`);
    return cookiesPath;
  } catch (error) {
    throw new Error(`Failed to save cookies file: ${error}`);
  }
};

/**
 * List available cookies files
 */
export const listCookiesFiles = (): string[] => {
  try {
    const files = fs.readdirSync(COOKIES_DIR);
    return files.filter(file => file.endsWith('.txt'));
  } catch (error) {
    console.error('Error listing cookies files:', error);
    return [];
  }
};

/**
 * Delete cookies file
 */
export const deleteCookiesFile = async (fileName: string): Promise<void> => {
  const cookiesPath = path.join(COOKIES_DIR, fileName);
  
  try {
    await fs.promises.unlink(cookiesPath);
    console.log(`Cookies file deleted: ${cookiesPath}`);
  } catch (error) {
    throw new Error(`Failed to delete cookies file: ${error}`);
  }
};
