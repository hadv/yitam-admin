import { Request, Response } from 'express';
import { extractYouTubeId, getVideoDetails } from '../services/youtube-transcript';
import { DatabaseService } from '../core/database-service';
import { isAuthenticated } from '../services/youtube-auth';
import { progressTracker } from '../services/progress-tracker';
import { addYoutubeProcessingJob, getJobStatus } from '../services/job-queue';
import {
  downloadVideo,
  getVideoInfo,
  getDownloadedVideos,
  deleteDownloadedVideo,
  getVideoFilePath,
  DownloadOptions
} from '../services/youtube-downloader';
import path from 'path';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

/**
 * Provides user-friendly suggestions based on error category
 */
const getSuggestionsForError = (category: string, isAuthenticated: boolean): string[] => {
  switch (category) {
    case 'MEMBERS_ONLY':
      return [
        'This video requires channel membership to access.',
        isAuthenticated
          ? 'The system attempted to use your authentication but YouTube blocked access to this members-only content.'
          : 'Sign in with your Google account if you are a member of this channel, then try again.',
        'Alternative options if download continues to fail:',
        '  • Watch the video directly on YouTube where you have membership access',
        '  • Use screen recording software while watching on YouTube',
        '  • Contact the channel owner about alternative access methods',
        'Note: YouTube has technical restrictions on automated downloads of premium content.'
      ];
    case 'PRIVATE':
      return [
        'This video is set to private by the creator.',
        'Only the video owner can access private videos.',
        'Contact the video owner if you believe you should have access.'
      ];
    case 'AGE_RESTRICTED':
      return [
        'This video is age-restricted.',
        isAuthenticated
          ? 'Your account may need age verification on YouTube.'
          : 'Sign in with a verified Google account to access age-restricted content.',
        'Verify your age on YouTube if you haven\'t already.'
      ];
    case 'GEO_BLOCKED':
      return [
        'This video is not available in your region.',
        'The content owner has restricted access in your country.',
        'Try using a VPN if legally permitted in your jurisdiction.'
      ];
    case 'NOT_FOUND':
      return [
        'The video may have been deleted or made unavailable.',
        'Check if the URL is correct.',
        'The video might be temporarily unavailable.'
      ];
    case 'RATE_LIMITED':
      return [
        'Too many requests have been made recently.',
        'Wait a few minutes before trying again.',
        'Consider spacing out your download requests.'
      ];
    case 'NETWORK':
      return [
        'Check your internet connection.',
        'Try again in a few moments.',
        'The YouTube servers might be temporarily unavailable.'
      ];
    default:
      return [
        'Try the request again in a few moments.',
        isAuthenticated
          ? 'If the problem persists, try refreshing your authentication.'
          : 'Consider signing in if this is restricted content.',
        'Contact support if the issue continues.'
      ];
  }
};

// Process YouTube video URL, extract transcript, and store in vector DB
export const processYoutubeVideo = async (req: Request, res: Response) => {
  try {
    const { youtubeUrl } = req.body;
    const socketId = req.body.socketId; // Optional socket ID for tracking
    
    if (!youtubeUrl) {
      return res.status(400).json({ message: 'YouTube URL is required' });
    }
    
    // Extract YouTube video ID from URL
    const videoId = extractYouTubeId(youtubeUrl);
    
    if (!videoId) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }
    
    // First, check if this video has already been transcribed
    const transcriptExists = await dbService.doesTranscriptExist(videoId);
    
    if (transcriptExists) {
      return res.status(200).json({
        message: 'This video has already been transcribed',
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        alreadyProcessed: true
      });
    }
    
    // Get domains from request body or use default
    let domains: string[] = ['default'];
    if (req.body.domains) {
      if (typeof req.body.domains === 'string') {
        try {
          domains = JSON.parse(req.body.domains);
          if (!Array.isArray(domains)) {
            domains = [req.body.domains];
          }
        } catch (error) {
          domains = [req.body.domains];
        }
      } else if (Array.isArray(req.body.domains)) {
        domains = req.body.domains;
      } else if (req.body.domain) {
        domains = [req.body.domain];
      }
    }
    
    // Extract chunking options from request if available
    const chunkSize = req.body.chunkSize ? parseInt(req.body.chunkSize, 10) : 4000;
    const chunkOverlap = req.body.chunkOverlap ? parseInt(req.body.chunkOverlap, 10) : 500;
    
    // Get basic video details first
    try {
      const videoDetails = await getVideoDetails(videoId);
      console.log(`Queueing YouTube video processing: "${videoDetails.title}" (${videoId})`);
    } catch (error) {
      console.log(`Queueing YouTube video processing for ID: ${videoId} (details fetch failed)`);
    }
    
    // Authentication data from multiple sources
    // 1. Check for user authentication in session
    const userId = req.session?.userId;
    
    // 2. Check for direct access token in Authorization header
    const authHeader = req.headers.authorization;
    let accessToken: string | undefined;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7); // Remove "Bearer " prefix
      
      // Validate token format
      if (!accessToken || accessToken.length < 20) {
        console.warn('Invalid access token format, but proceeding with alternative methods');
        accessToken = undefined;
      }
    }
    
    // Add the job to the queue
    const job = await addYoutubeProcessingJob({
      youtubeUrl,
      domains,
      videoId,
      socketId,
      userId,
      accessToken,
      chunkSize,
      chunkOverlap
    });

    // Immediately return success response with job ID
    res.status(202).json({
      message: 'YouTube video processing has been queued',
      jobId: job.id,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      status: 'processing'
    });
  } catch (error) {
    console.error('Error queueing YouTube processing job:', error);
    
    // Get videoId from request body if available for error reporting
    const videoId = extractYouTubeId(req.body.youtubeUrl);
    
    // Provide more specific error messages based on the type of error
    let errorMessage = 'Failed to queue YouTube processing job';
    let statusCode = 500;
    
    if (error instanceof Error) {
      errorMessage = `${errorMessage}: ${error.message}`;
      
      // Report error via progress tracker if we have a video ID
      if (videoId) {
        progressTracker.reportError(videoId, errorMessage, error.message);
      }
    }
    
    res.status(statusCode).json({ 
      message: errorMessage,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Check if authenticated access is available for YouTube transcripts
export const checkTranscriptAccess = (req: Request, res: Response) => {
  const userId = req.session?.userId;
  const isAuthorized = userId && isAuthenticated(userId);
  
  res.json({
    authenticated: isAuthorized,
    userId: isAuthorized ? userId : null
  });
};

// Check if a transcript already exists for a given videoId
export const checkTranscriptExists = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }
    
    // Check if the transcript exists in the database
    const exists = await dbService.doesTranscriptExist(videoId);
    
    res.status(200).json({
      exists,
      videoId
    });
  } catch (error) {
    console.error('Error checking transcript existence:', error);
    
    res.status(500).json({ 
      message: 'Failed to check if transcript exists',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

// Count chunks for a specific YouTube video ID without deleting them
export const countYoutubeVideoChunks = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }
    
    console.log(`Counting chunks for YouTube video: ${videoId}`);
    
    // Check if the transcript exists before counting
    const transcriptExists = await dbService.doesTranscriptExist(videoId);
    
    if (!transcriptExists) {
      console.log(`No transcript found for video ID: ${videoId}`);
      return res.status(404).json({
        message: 'No transcript found for this video ID',
        videoId,
        count: 0
      });
    }
    
    try {
      console.log(`Transcript found for ${videoId}. Counting chunks...`);
      const count = await dbService.countYoutubeTranscriptChunks(videoId);
      
      // Get domains for the video
      const domains = await dbService.getYoutubeVideoDomains(videoId);
      
      console.log(`Found ${count} chunks for YouTube video: ${videoId} with domains: ${domains.join(', ')}`);
      
      return res.status(200).json({
        message: `Found ${count} chunks for the video`,
        videoId,
        count,
        domains
      });
    } catch (countError: any) {
      console.error(`Error in Qdrant during countYoutubeTranscriptChunks:`, countError);
      
      // Provide a detailed error message
      return res.status(500).json({
        message: 'Failed to count YouTube transcript chunks',
        error: countError.message || 'Unknown error',
        videoId
      });
    }
  } catch (error: any) {
    console.error('Error in countYoutubeVideoChunks controller:', error);
    return res.status(500).json({
      message: 'An error occurred while processing your request',
      error: error.message || 'Unknown error'
    });
  }
};

// Delete all chunks for a specific YouTube video to allow re-extraction
export const deleteYoutubeVideoChunks = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;
    
    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }
    
    console.log(`Attempting to delete all chunks for YouTube video: ${videoId}`);
    
    // Check if the transcript exists before attempting deletion
    const transcriptExists = await dbService.doesTranscriptExist(videoId);
    
    if (!transcriptExists) {
      console.log(`No transcript found for video ID: ${videoId}`);
      return res.status(404).json({
        message: 'No transcript found for this video ID',
        videoId
      });
    }
    
    try {
      console.log(`Transcript found for ${videoId}. Proceeding with deletion...`);
      const deletedCount = await dbService.deleteYoutubeTranscriptChunks(videoId);
      
      console.log(`Successfully deleted ${deletedCount} chunks for YouTube video: ${videoId}`);
      
      return res.status(200).json({
        message: `Successfully deleted ${deletedCount} chunks for the video`,
        videoId,
        deletedCount
      });
    } catch (deleteError: any) {
      console.error(`Error in Qdrant during deleteYoutubeTranscriptChunks:`, deleteError);
      
      // Provide a detailed error message
      return res.status(500).json({
        message: 'Failed to delete YouTube transcript chunks',
        error: deleteError.message || 'Unknown error',
        videoId
      });
    }
  } catch (error: any) {
    console.error('Error in deleteYoutubeVideoChunks controller:', error);
    return res.status(500).json({
      message: 'An error occurred while processing your request',
      error: error.message || 'Unknown error'
    });
  }
};

// Get all chunks for a specific YouTube video ID
export const getYoutubeVideoChunks = async (req: Request, res: Response) => {
  try {
    const { videoId } = req.params;

    if (!videoId) {
      return res.status(400).json({ message: 'Video ID is required' });
    }

    console.log(`Getting chunks for YouTube video: ${videoId}`);

    // Check if the transcript exists before getting chunks
    const transcriptExists = await dbService.doesTranscriptExist(videoId);

    if (!transcriptExists) {
      console.log(`No transcript found for video ID: ${videoId}`);
      return res.status(404).json({
        message: 'No transcript found for this video ID',
        videoId,
        chunks: []
      });
    }

    try {
      console.log(`Transcript found for ${videoId}. Getting chunks...`);
      const chunks = await dbService.getYoutubeVideoChunks(videoId);

      // Get video details and domains
      const domains = await dbService.getYoutubeVideoDomains(videoId);

      console.log(`Found ${chunks.length} chunks for YouTube video: ${videoId}`);

      return res.status(200).json({
        message: `Found ${chunks.length} chunks for the video`,
        videoId,
        chunks,
        totalChunks: chunks.length,
        domains
      });
    } catch (getError: any) {
      console.error(`Error getting YouTube video chunks:`, getError);

      // Provide a detailed error message
      return res.status(500).json({
        message: 'Failed to get YouTube video chunks',
        error: getError.message || 'Unknown error',
        videoId
      });
    }
  } catch (error: any) {
    console.error('Error in getYoutubeVideoChunks controller:', error);
    return res.status(500).json({
      message: 'An error occurred while processing your request',
      error: error.message || 'Unknown error'
    });
  }
};

// Download YouTube video to server
export const downloadYoutubeVideo = async (req: Request, res: Response) => {
  try {
    const { youtubeUrl, options = {} } = req.body;
    const socketId = req.body.socketId;

    if (!youtubeUrl) {
      return res.status(400).json({ message: 'YouTube URL is required' });
    }

    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      return res.status(400).json({ message: 'Invalid YouTube URL' });
    }

    console.log(`Starting video download for: ${youtubeUrl}`);

    // Check if user is authenticated and get access token
    const userId = req.session?.userId;
    let authToken: string | undefined;

    if (userId && isAuthenticated(userId)) {
      // Try to get authenticated client to extract access token
      const authClient = await import('../services/youtube-auth').then(auth => auth.getAuthenticatedClient(userId));
      if (authClient) {
        const credentials = authClient.credentials;
        authToken = credentials.access_token || undefined;
        console.log('Using authenticated download for user:', userId);
      }
    }

    // Initialize progress tracking if socket ID provided
    if (socketId) {
      progressTracker.initializeProgressTracking(videoId, socketId);
      progressTracker.updateTranscriptFetch(videoId, 'Starting video download...', 0);
    }

    // Download the video with progress callback and authentication
    const result = await downloadVideo(youtubeUrl, options as DownloadOptions, (progress) => {
      if (socketId) {
        progressTracker.updateTranscriptFetch(
          videoId,
          `Downloading: ${progress.progress.toFixed(1)}% (${(progress.downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(progress.totalBytes / 1024 / 1024).toFixed(1)}MB)`,
          progress.progress
        );
      }
    }, authToken);

    // Complete progress tracking
    if (socketId) {
      progressTracker.updateTranscriptFetch(videoId, 'Download completed successfully!', 100);
      // For downloads, we don't have chunks, so we pass 1 to indicate completion
      progressTracker.completeProcessing(videoId, 1);
    }

    console.log(`Video download completed: ${result.filePath}`);

    return res.status(200).json({
      message: 'Video downloaded successfully',
      videoId,
      filePath: result.filePath,
      fileName: path.basename(result.filePath),
      videoInfo: result.videoInfo
    });

  } catch (error: any) {
    console.error('Error downloading YouTube video:', error);

    const videoId = extractYouTubeId(req.body.youtubeUrl);
    if (videoId && req.body.socketId) {
      progressTracker.reportError(videoId, 'Download failed', error.message);
    }

    // Determine appropriate HTTP status code based on error category
    let statusCode = 500;
    let userMessage = error.message || 'Unknown error';

    if (error.category) {
      switch (error.category) {
        case 'MEMBERS_ONLY':
          statusCode = 403; // Forbidden
          userMessage = error.message;
          break;
        case 'PRIVATE':
          statusCode = 403; // Forbidden
          break;
        case 'AGE_RESTRICTED':
          statusCode = 403; // Forbidden
          break;
        case 'GEO_BLOCKED':
          statusCode = 451; // Unavailable For Legal Reasons
          break;
        case 'NOT_FOUND':
          statusCode = 404; // Not Found
          break;
        case 'RATE_LIMITED':
          statusCode = 429; // Too Many Requests
          break;
        case 'NETWORK':
          statusCode = 503; // Service Unavailable
          break;
        default:
          statusCode = 500; // Internal Server Error
      }
    }

    return res.status(statusCode).json({
      message: 'Failed to download video',
      error: userMessage,
      category: error.category || 'UNKNOWN',
      suggestions: getSuggestionsForError(error.category, !!req.session?.userId)
    });
  }
};

// Get video information without downloading
export const getYoutubeVideoInfo = async (req: Request, res: Response) => {
  try {
    const { youtubeUrl } = req.body;

    if (!youtubeUrl) {
      return res.status(400).json({ message: 'YouTube URL is required' });
    }

    // Check if user is authenticated and get access token
    const userId = req.session?.userId;
    let authToken: string | undefined;

    if (userId && isAuthenticated(userId)) {
      const authClient = await import('../services/youtube-auth').then(auth => auth.getAuthenticatedClient(userId));
      if (authClient) {
        const credentials = authClient.credentials;
        authToken = credentials.access_token || undefined;
      }
    }

    const videoInfo = await getVideoInfo(youtubeUrl, authToken);

    return res.status(200).json({
      message: 'Video information retrieved successfully',
      videoInfo
    });

  } catch (error: any) {
    console.error('Error getting video info:', error);

    // Use enhanced error handling
    let statusCode = 500;
    let userMessage = error.message || 'Unknown error';

    if (error.category) {
      switch (error.category) {
        case 'MEMBERS_ONLY':
        case 'PRIVATE':
        case 'AGE_RESTRICTED':
          statusCode = 403;
          break;
        case 'GEO_BLOCKED':
          statusCode = 451;
          break;
        case 'NOT_FOUND':
          statusCode = 404;
          break;
        case 'RATE_LIMITED':
          statusCode = 429;
          break;
        case 'NETWORK':
          statusCode = 503;
          break;
        default:
          statusCode = 500;
      }
    }

    return res.status(statusCode).json({
      message: 'Failed to get video information',
      error: userMessage,
      category: error.category || 'UNKNOWN',
      suggestions: getSuggestionsForError(error.category, !!req.session?.userId)
    });
  }
};

// Get list of downloaded videos
export const getDownloadedVideosList = async (req: Request, res: Response) => {
  try {
    const videos = getDownloadedVideos();

    return res.status(200).json({
      message: `Found ${videos.length} downloaded videos`,
      videos
    });

  } catch (error: any) {
    console.error('Error getting downloaded videos list:', error);
    return res.status(500).json({
      message: 'Failed to get downloaded videos list',
      error: error.message || 'Unknown error'
    });
  }
};

// Delete downloaded video
export const deleteDownloadedVideoFile = async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;

    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }

    const success = deleteDownloadedVideo(fileName);

    if (success) {
      return res.status(200).json({
        message: 'Video file deleted successfully',
        fileName
      });
    } else {
      return res.status(404).json({
        message: 'Video file not found',
        fileName
      });
    }

  } catch (error: any) {
    console.error('Error deleting video file:', error);
    return res.status(500).json({
      message: 'Failed to delete video file',
      error: error.message || 'Unknown error'
    });
  }
};

// Serve downloaded video file
export const serveDownloadedVideo = async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;

    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }

    const filePath = getVideoFilePath(fileName);

    if (!filePath) {
      return res.status(404).json({
        message: 'Video file not found',
        fileName
      });
    }

    // Set appropriate headers for video streaming
    const stat = require('fs').statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      // Support for video streaming with range requests
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = require('fs').createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      require('fs').createReadStream(filePath).pipe(res);
    }

  } catch (error: any) {
    console.error('Error serving video file:', error);
    return res.status(500).json({
      message: 'Failed to serve video file',
      error: error.message || 'Unknown error'
    });
  }
};