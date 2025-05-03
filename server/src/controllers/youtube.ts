import { Request, Response } from 'express';
import { extractYouTubeId, processYoutubeTranscript, getVideoDetails } from '../services/youtube-transcript';
import { DatabaseService } from '../core/database-service';
import { isAuthenticated, tokenStore } from '../services/youtube-auth';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

// Process YouTube video URL, extract transcript, and store in vector DB
export const processYoutubeVideo = async (req: Request, res: Response) => {
  try {
    const { youtubeUrl } = req.body;
    
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
    
    // Get video details first
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
    
    // Process transcript and create chunks with embeddings
    const chunks = await processYoutubeTranscript(
      videoId,
      domains,
      chunkSize,
      chunkOverlap,
      userId, // Pass the userId for OAuth if authenticated via session
      accessToken // Pass the access token if provided in the header
    );
    
    console.log(`Created ${chunks.length} chunks for YouTube video ${videoId}`);
    
    // Store all chunks in database
    await dbService.addDocumentChunks(chunks);
    
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