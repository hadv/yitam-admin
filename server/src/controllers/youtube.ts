import { Request, Response } from 'express';
import { extractYouTubeId, processYoutubeTranscript, getVideoDetails } from '../services/youtube-transcript';
import { DatabaseService } from '../core/database-service';
import { isAuthenticated, tokenStore } from '../services/youtube-auth';
import { progressTracker } from '../services/progress-tracker';

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
    
    // Initialize progress tracking
    progressTracker.initializeProgressTracking(videoId, socketId);
    
    // First, check if this video has already been transcribed
    progressTracker.updateTranscriptFetch(videoId, 'Checking if transcript already exists', 10);
    const transcriptExists = await dbService.doesTranscriptExist(videoId);
    
    if (transcriptExists) {
      progressTracker.completeProcessing(videoId, 0);
      return res.status(200).json({
        message: 'This video has already been transcribed',
        videoId,
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        alreadyProcessed: true
      });
    }
    
    // Get video details first
    progressTracker.updateTranscriptFetch(videoId, 'Fetching video details', 20);
    const videoDetails = await getVideoDetails(videoId);
    
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
    
    console.log(`Processing YouTube video: "${videoDetails.title}" (${videoId}) in domains: ${domains.join(', ')}`);
    progressTracker.updateTranscriptFetch(videoId, `Processing YouTube video: "${videoDetails.title}"`, 30);
    
    // Authentication data from multiple sources
    // 1. Check for user authentication in session
    const userId = req.session?.userId;
    const isSessionAuth = userId && isAuthenticated(userId);
    
    // 2. Check for direct access token in Authorization header
    const authHeader = req.headers.authorization;
    let accessToken: string | undefined;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7); // Remove "Bearer " prefix
      console.log('Using access token from Authorization header');
      
      // Validate token format
      if (!accessToken || accessToken.length < 20) {
        console.warn('Invalid access token format, but proceeding with alternative methods');
        accessToken = undefined;
      }
    }
    
    // Determine if we have valid authentication
    const useOAuth = isSessionAuth || !!accessToken;
    
    // Note: Authentication is preferred but no longer strictly required
    // due to our web scraping fallback approach
    console.log(`User authentication status: ${useOAuth ? 'Authenticated' : 'Not authenticated (using fallback methods)'}`);
    progressTracker.updateTranscriptFetch(
      videoId, 
      `Auth status: ${useOAuth ? 'Authenticated' : 'Not authenticated (will use fallback methods)'}`,
      40
    );
    
    // Process transcript and create chunks with embeddings
    progressTracker.updateTranscriptFetch(videoId, 'Starting transcript extraction', 50);
    
    // Initialize an estimated total chunks value for progress tracking
    // This will be updated with actual value once chunks are created
    let totalChunks = 100; // Default estimate
    
    const chunks = await processYoutubeTranscript(
      videoId,
      domains,
      chunkSize,
      chunkOverlap,
      userId, // Pass the userId for OAuth if authenticated via session
      accessToken, // Pass the access token if provided in the header
      (stage, message, progress) => {
        // Progress callback function
        switch (stage) {
          case 'transcript_fetch':
            progressTracker.updateTranscriptFetch(videoId, message, progress);
            break;
          case 'transcript_process':
            progressTracker.updateTranscriptProcess(videoId, message, progress);
            // Check if this is the special message containing total chunks info
            if (message.startsWith('Total chunks:')) {
              totalChunks = progress || totalChunks;
            }
            break;
          case 'chunk_creation':
            if (typeof progress === 'number') {
              progressTracker.updateChunkCreation(videoId, progress, totalChunks);
            }
            break;
          case 'embedding_generation':
            if (typeof progress === 'number') {
              progressTracker.updateEmbeddingGeneration(videoId, progress, totalChunks);
            }
            break;
        }
      }
    );
    
    console.log(`Created ${chunks.length} chunks for YouTube video ${videoId}`);
    progressTracker.updateChunkStorage(videoId, `Storing ${chunks.length} chunks`, 90);
    
    // Store all chunks in database
    await dbService.addDocumentChunks(chunks);
    
    progressTracker.completeProcessing(videoId, chunks.length);
    
    res.status(200).json({
      message: 'YouTube transcript extracted, chunked and embedded successfully',
      totalChunks: chunks.length,
      videoId,
      videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
      videoTitle: videoDetails.title,
      videoDescription: videoDetails.description || '',
      domains,
      usedOAuth: useOAuth
    });
  } catch (error) {
    console.error('Error processing YouTube transcript:', error);
    
    // Get videoId from request body if available for error reporting
    const videoId = extractYouTubeId(req.body.youtubeUrl);
    
    // Provide more specific error messages based on the type of error
    let errorMessage = 'Failed to process YouTube transcript';
    let statusCode = 500;
    
    if (error instanceof Error) {
      // Check for common YouTube transcript errors
      if (error.message.includes('Could not find any transcript')) {
        errorMessage = 'No transcript available for this video. The video may not have captions enabled.';
        statusCode = 404;
      } else if (error.message.includes('No transcript available')) {
        errorMessage = 'No transcript available for this video. The video may not have captions enabled.';
        statusCode = 404;
      } else if (error.message.includes('network')) {
        errorMessage = 'Network error while fetching the transcript. Please check your connection.';
        statusCode = 503;
      } else if (error.message.includes('timed out') || error.message.includes('timeout')) {
        errorMessage = 'The request timed out, but processing is continuing via WebSocket. Please check the progress indicator.';
        // Use a 200 status since the operation is still in progress via WebSocket
        statusCode = 200; 
      } else if (error.message.includes('Invalid YouTube ID')) {
        errorMessage = 'Invalid YouTube video ID.';
        statusCode = 400;
      } else if (error.message.includes('Not authenticated') || error.message.includes('auth')) {
        // This error is less critical now since we have fallback methods
        errorMessage = 'Authentication issues may limit transcript quality. The system will attempt alternative methods.';
        statusCode = 200; // Don't fail the request, just warn
      } else {
        // Include the actual error message for better debugging
        errorMessage = `${errorMessage}: ${error.message}`;
      }

      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      
      // Report error via progress tracker if we have a video ID
      if (videoId) {
        progressTracker.reportError(videoId, errorMessage, error.message);
      }
    }
    
    res.status(statusCode).json({ 
      message: errorMessage,
      error: error instanceof Error ? error.message : 'Unknown error',
      requiresAuth: statusCode === 401
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
      
      console.log(`Found ${count} chunks for YouTube video: ${videoId}`);
      
      return res.status(200).json({
        message: `Found ${count} chunks for the video`,
        videoId,
        count
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