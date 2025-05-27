import { Request, Response } from 'express';
import { extractYouTubeId, getVideoDetails } from '../services/youtube-transcript';
import { DatabaseService } from '../core/database-service';
import { isAuthenticated } from '../services/youtube-auth';
import { progressTracker } from '../services/progress-tracker';
import { addYoutubeProcessingJob, getJobStatus } from '../services/job-queue';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

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