import { getTranscript } from 'youtube-transcript-api';
import { createEmbedding } from './embedding';
import { GoogleGenerativeAI } from '@google/generative-ai';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { enhanceContent, EnhancementType } from './content-enhancement';
import { DocumentChunk } from './chunking';
import { google } from 'googleapis';
import { getAuthenticatedClient } from './youtube-auth';

// Configuration for scraping behavior
const SCRAPING_CONFIG = {
  maxRetries: parseInt(process.env.YOUTUBE_SCRAPING_MAX_RETRIES || '5'),
  baseRetryDelay: parseInt(process.env.YOUTUBE_SCRAPING_RETRY_DELAY || '2000'),
  enableWarmup: process.env.YOUTUBE_SCRAPING_ENABLE_WARMUP !== 'false',
  requestTimeout: parseInt(process.env.YOUTUBE_SCRAPING_TIMEOUT || '30000')
};

// Simple metrics tracking with circuit breaker
const scrapingMetrics = {
  totalAttempts: 0,
  successfulAttempts: 0,
  failedAttempts: 0,
  retryAttempts: 0,
  antiBotDetections: 0,
  lastResetTime: Date.now(),
  lastAntiBotTime: 0,
  circuitBreakerOpen: false,

  recordAttempt() {
    this.totalAttempts++;
  },

  recordSuccess() {
    this.successfulAttempts++;
    // Reset circuit breaker on success
    this.circuitBreakerOpen = false;
  },

  recordFailure() {
    this.failedAttempts++;
  },

  recordRetry() {
    this.retryAttempts++;
  },

  recordAntiBotDetection() {
    this.antiBotDetections++;
    this.lastAntiBotTime = Date.now();

    // Open circuit breaker only if we've had many confirmed anti-bot detections recently
    // Made this more conservative to avoid false positives
    if (this.antiBotDetections >= 5) { // Increased threshold from 3 to 5
      // Check if we've had multiple detections in the last 2 minutes (increased from 1 minute)
      const twoMinutesAgo = Date.now() - 120000;
      if (this.lastAntiBotTime > twoMinutesAgo) {
        this.circuitBreakerOpen = true;
        console.log('🚨 Circuit breaker opened due to repeated confirmed anti-bot detections');
      }
    }
  },

  isCircuitBreakerOpen() {
    // Auto-reset circuit breaker after 5 minutes
    if (this.circuitBreakerOpen && (Date.now() - this.lastAntiBotTime) > 300000) {
      this.circuitBreakerOpen = false;
      console.log('🔄 Circuit breaker reset after cooldown period');
    }
    return this.circuitBreakerOpen;
  },

  getStats() {
    const now = Date.now();
    const timeSinceReset = now - this.lastResetTime;
    const hours = timeSinceReset / (1000 * 60 * 60);

    return {
      totalAttempts: this.totalAttempts,
      successfulAttempts: this.successfulAttempts,
      failedAttempts: this.failedAttempts,
      retryAttempts: this.retryAttempts,
      antiBotDetections: this.antiBotDetections,
      circuitBreakerOpen: this.circuitBreakerOpen,
      successRate: this.totalAttempts > 0 ? (this.successfulAttempts / this.totalAttempts * 100).toFixed(2) + '%' : '0%',
      timePeriodHours: hours.toFixed(2)
    };
  },

  reset() {
    this.totalAttempts = 0;
    this.successfulAttempts = 0;
    this.failedAttempts = 0;
    this.retryAttempts = 0;
    this.antiBotDetections = 0;
    this.lastResetTime = Date.now();
    this.lastAntiBotTime = 0;
    this.circuitBreakerOpen = false;
  }
};

// Export function to get scraping metrics
export const getScrapingMetrics = () => scrapingMetrics.getStats();
export const resetScrapingMetrics = () => scrapingMetrics.reset();

// Import the TranscriptItem interface from our declaration file
interface TranscriptItem {
  text: string;
  offset: number;
  duration: number;
}

// Define video details interface
interface VideoDetails {
  title: string;
  description?: string;
}

// Extract YouTube ID from various YouTube URL formats
export const extractYouTubeId = (url: string): string | null => {
  const regExp = /^.*((youtu.be\/)|(v\/)|(\/u\/\w\/)|(embed\/)|(watch\?))\??v?=?([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[7].length === 11) ? match[7] : null;
};

// Get video details including title and description
export const getVideoDetails = async (videoId: string): Promise<VideoDetails> => {
  try {
    // Fetch the YouTube video page
    const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
    const $ = cheerio.load(response.data);
    
    // Extract title and description using meta tags
    const title = $('meta[property="og:title"]').attr('content') || `YouTube Video: ${videoId}`;
    const description = $('meta[property="og:description"]').attr('content') || '';
    
    return {
      title,
      description
    };
  } catch (error) {
    console.error('Error fetching video details:', error);
    // Fallback to a default title if we can't fetch it
    return {
      title: `YouTube Video: ${videoId}`
    };
  }
};

// Get YouTube transcript using OAuth2 authentication
export const getYouTubeTranscriptWithOAuth = async (
  videoId: string, 
  userId: string,
  languageCode: string = 'vi'
): Promise<string> => {
  try {
    console.log(`Fetching transcript via YouTube Data API with OAuth for video ID: ${videoId}`);
    
    // Get authenticated client for the user
    const oauth2Client = await getAuthenticatedClient(userId);
    if (!oauth2Client) {
      throw new Error('Not authenticated. Please authenticate with Google first.');
    }
    
    // Initialize the YouTube API client with authenticated credentials
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });
    
    // First, get the caption tracks available for the video
    const captionResponse = await youtube.captions.list({
      part: ['snippet'],
      videoId: videoId,
    });
    
    if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
      throw new Error('No captions found for this video');
    }
    
    // Find the caption track matching the requested language, or fall back to the first available
    let captionId = '';
    const captionItems = captionResponse.data.items;
    
    // Try to find a caption in the requested language
    const targetCaption = captionItems.find(item => 
      item.snippet?.language === languageCode ||
      item.snippet?.language?.startsWith(languageCode.split('-')[0])
    );
    
    // If found, use it; otherwise try to find any caption
    if (targetCaption && targetCaption.id) {
      captionId = targetCaption.id;
      console.log(`Found caption in requested language: ${targetCaption.snippet?.language}`);
    } else {
      // Look for auto-generated caption first
      const autoCaption = captionItems.find(item => 
        item.snippet?.trackKind === 'ASR'  // ASR = Auto Speech Recognition
      );
      
      if (autoCaption && autoCaption.id) {
        captionId = autoCaption.id;
        console.log(`Using auto-generated caption in language: ${autoCaption.snippet?.language}`);
      } else {
        // Fall back to any available caption
        const defaultCaption = captionItems.find(item => item.id);
        if (defaultCaption && defaultCaption.id) {
          captionId = defaultCaption.id;
          console.log(`Using fallback caption in language: ${defaultCaption.snippet?.language}`);
        } else {
          throw new Error('No usable captions found for this video');
        }
      }
    }
    
    // Download the caption track
    const transcriptResponse = await youtube.captions.download({
      id: captionId,
      tfmt: 'srt',  // SRT format which includes timestamps
    });
    
    if (!transcriptResponse.data) {
      throw new Error('Failed to download transcript data');
    }
    
    // Process the SRT formatted transcript into a clean text
    const srtData = transcriptResponse.data.toString();
    
    // Parse SRT format and extract text with timestamps
    const formattedTranscript = parseSrtToText(srtData);
    
    return formattedTranscript;
  } catch (error: any) {
    console.error('Error fetching YouTube transcript via API with OAuth:', error);
    throw new Error(`Failed to get transcript: ${error.message}`);
  }
};

// Helper function to parse SRT format to text with timestamps
const parseSrtToText = (srtData: string): string => {
  // Split by double newline which typically separates entries in SRT
  const entries = srtData.split(/\n\n|\r\n\r\n/).filter(Boolean);
  
  // Process each entry
  const lines = entries.map(entry => {
    const parts = entry.split(/\n|\r\n/).filter(Boolean);
    if (parts.length < 3) return ''; // Skip invalid entries
    
    // Parse timestamp (second line)
    const timestamps = parts[1].split(' --> ')[0];
    const time = timestamps.split(':');
    const minutes = time[1];
    const seconds = time[2].split(',')[0];
    const formattedTime = `[${minutes}:${seconds}]`;
    
    // Get text (third line and beyond)
    const text = parts.slice(2).join(' ');
    
    return `${formattedTime} ${text}`;
  });
  
  return lines.join('\n');
};

// Get auto-generated transcript specifically from YouTube
export const getAutoGeneratedTranscript = async (videoId: string, languageCode: string = 'vi'): Promise<TranscriptItem[]> => {
  try {
    console.log(`Attempting to fetch auto-generated transcript for video ID: ${videoId} in language: ${languageCode}`);
    
    // First try with specific options for auto-generated captions
    const options = { 
      lang: languageCode,
      translationLanguage: languageCode, // Get translated auto captions if available
      mostReliable: true // This increases reliability for auto captions
    };
    
    try {
      const transcript = await getTranscript(videoId, options);
      console.log(`Successfully retrieved auto-generated transcript with ${transcript.length} entries`);
      return transcript;
    } catch (error: any) {
      console.log(`Failed to get auto-generated transcript with specific options: ${error.message}`);
      
      // Try with just language option
      const simpleOptions = { lang: languageCode };
      const transcript = await getTranscript(videoId, simpleOptions);
      console.log(`Successfully retrieved transcript with language option with ${transcript.length} entries`);
      return transcript;
    }
  } catch (error: any) {
    console.error(`Failed to get transcript in ${languageCode}: ${error.message}`);
    
    // Fall back to any available transcript
    try {
      console.log('Attempting to get any available transcript');
      const transcript = await getTranscript(videoId);
      console.log(`Successfully retrieved default transcript with ${transcript.length} entries`);
      return transcript;
    } catch (fallbackError: any) {
      console.error(`Failed to get any transcript: ${fallbackError.message}`);
      throw new Error('No transcript available for this video in any language');
    }
  }
};

// Get YouTube transcript using direct access token
export const getTranscriptWithDirectToken = async (
  videoId: string, 
  accessToken: string,
  languageCode: string = 'vi'
): Promise<string> => {
  try {
    console.log(`Fetching transcript via YouTube Data API with direct token for video ID: ${videoId}`);
    
    // Initialize the YouTube API client with the access token
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });
    
    // First, get the caption tracks available for the video
    const captionResponse = await youtube.captions.list({
      part: ['snippet'],
      videoId: videoId,
    });
    
    if (!captionResponse.data.items || captionResponse.data.items.length === 0) {
      throw new Error('No captions found for this video');
    }
    
    // Log all available captions for debugging
    console.log(`Found ${captionResponse.data.items.length} caption tracks for video ${videoId}:`);
    captionResponse.data.items.forEach((item, index) => {
      console.log(`Caption ${index + 1}: Language: ${item.snippet?.language}, Kind: ${item.snippet?.trackKind}, ID: ${item.id}`);
    });
    
    // Find the caption track matching the requested language, or fall back to the first available
    let captionId = '';
    const captionItems = captionResponse.data.items;
    
    // Try to find a caption in the requested language
    const targetCaption = captionItems.find(item => 
      item.snippet?.language === languageCode ||
      item.snippet?.language?.startsWith(languageCode.split('-')[0])
    );
    
    // If found, use it; otherwise try to find any caption
    if (targetCaption && targetCaption.id) {
      captionId = targetCaption.id;
      console.log(`Found caption in requested language: ${targetCaption.snippet?.language}`);
    } else {
      // Look for auto-generated caption first
      const autoCaption = captionItems.find(item => 
        item.snippet?.trackKind === 'ASR'  // ASR = Auto Speech Recognition
      );
      
      if (autoCaption && autoCaption.id) {
        captionId = autoCaption.id;
        console.log(`Using auto-generated caption in language: ${autoCaption.snippet?.language}`);
      } else {
        // Fall back to any available caption
        const defaultCaption = captionItems.find(item => item.id);
        if (defaultCaption && defaultCaption.id) {
          captionId = defaultCaption.id;
          console.log(`Using fallback caption in language: ${defaultCaption.snippet?.language}`);
        } else {
          throw new Error('No usable captions found for this video');
        }
      }
    }
    
    // Download the caption track
    const transcriptResponse = await youtube.captions.download({
      id: captionId,
      tfmt: 'srt',  // SRT format which includes timestamps
    });
    
    if (!transcriptResponse.data) {
      throw new Error('Failed to download transcript data');
    }
    
    // Process the SRT formatted transcript into a clean text
    const srtData = transcriptResponse.data.toString();
    
    // Parse SRT format and extract text with timestamps
    const formattedTranscript = parseSrtToText(srtData);
    
    return formattedTranscript;
  } catch (error: any) {
    console.error('Error fetching YouTube transcript via API with direct token:', error);
    throw new Error(`Failed to get transcript: ${error.message}`);
  }
};

// Get auto-generated transcript specifically from YouTube using alternative method
export const getTranscriptWithApiList = async (videoId: string, accessToken: string): Promise<string> => {
  try {
    console.log(`Attempting to get transcript with alternative API method for video ID: ${videoId}`);
    
    // Initialize the YouTube API client with the access token
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });
    
    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });
    
    // Step 1: List all available captions for the video
    const captionsListResponse = await youtube.captions.list({
      part: ['snippet'],
      videoId: videoId
    });
    
    if (!captionsListResponse.data.items || captionsListResponse.data.items.length === 0) {
      throw new Error('No captions found for this video');
    }
    
    // Log all available captions for debugging
    console.log(`Found ${captionsListResponse.data.items.length} caption tracks for video ${videoId}:`);
    captionsListResponse.data.items.forEach((item, index) => {
      console.log(`Caption ${index + 1}: Language: ${item.snippet?.language}, Kind: ${item.snippet?.trackKind}, ID: ${item.id}`);
    });
    
    // Step 2: Try to get transcript content using alternative method (not directly downloading)
    // Instead, we'll build a text transcript from the video's metadata and description
    const videoResponse = await youtube.videos.list({
      part: ['snippet'],
      id: [videoId]
    });
    
    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      throw new Error('Video not found');
    }
    
    const videoSnippet = videoResponse.data.items[0].snippet;
    let transcript = '';
    
    if (videoSnippet) {
      transcript = `Title: ${videoSnippet.title || ''}\n\n`;
      transcript += `Description: ${videoSnippet.description || ''}\n\n`;
      transcript += `Tags: ${(videoSnippet.tags || []).join(', ')}\n\n`;
      
      // Add publishing timestamp
      if (videoSnippet.publishedAt) {
        const publishDate = new Date(videoSnippet.publishedAt);
        transcript += `Published: ${publishDate.toLocaleDateString()}\n\n`;
      }
    }
    
    return transcript;
  } catch (error: any) {
    console.error('Error fetching transcript with alternative API method:', error);
    throw new Error(`Failed to get transcript with alternative method: ${error.message}`);
  }
};

/**
 * Progress callback function type
 */
export type ProgressCallback = (
  stage: 'transcript_fetch' | 'transcript_process' | 'chunk_creation' | 'embedding_generation',
  message: string,
  progress?: number
) => void;

/**
 * Process YouTube video to extract transcript, chunk it, and create embeddings
 */
export const processYoutubeTranscript = async (
  videoId: string,
  domains: string[],
  chunkSize: number = 4000,
  chunkOverlap: number = 500,
  userId?: string,
  accessToken?: string,
  progressCallback?: ProgressCallback
): Promise<any[]> => {
  try {
    // Get video details
    const videoDetails = await getVideoDetails(videoId);
    let transcript = '';
    let errors: string[] = [];
    
    // Update progress if callback is provided
    const updateProgress = (
      stage: 'transcript_fetch' | 'transcript_process' | 'chunk_creation' | 'embedding_generation',
      message: string,
      progress?: number
    ) => {
      if (progressCallback) {
        progressCallback(stage, message, progress);
      }
    };
    
    // Try direct web scraping first as the most reliable method
    try {
      console.log('Attempting to get transcript using web scraping (primary method)');
      updateProgress('transcript_fetch', 'Attempting to get transcript using web scraping', 55);

      // Add a small delay before scraping to avoid immediate rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));

      transcript = await scrapeTranscriptFromYouTube(videoId);
      console.log(`Successfully retrieved transcript via web scraping with length: ${transcript.length} characters`);
      updateProgress('transcript_fetch', 'Successfully retrieved transcript via web scraping', 60);
    } catch (error: any) {
      const errorMsg = `Web scraping (primary method) failed: ${error.message}`;
      console.log(errorMsg + '. Falling back to API methods');
      errors.push(errorMsg);
      updateProgress('transcript_fetch', 'Web scraping failed, trying API methods', 55);
      
      // If web scraping fails, proceed with API methods
      // Attempt to get the transcript using API methods
      if (userId) {
        // Try OAuth if a userId is provided
        try {
          console.log('Attempting to get transcript using OAuth authentication');
          updateProgress('transcript_fetch', 'Attempting to get transcript using OAuth authentication', 57);
          transcript = await getYouTubeTranscriptWithOAuth(videoId, userId);
          console.log('Successfully retrieved transcript via OAuth');
          updateProgress('transcript_fetch', 'Successfully retrieved transcript via OAuth', 60);
        } catch (error: any) {
          const errorMsg = `OAuth method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
          updateProgress('transcript_fetch', 'OAuth method failed, trying next method', 57);
        }
      }
      
      // Try direct access token if provided and previous methods failed
      if (!transcript && accessToken) {
        try {
          console.log('Attempting to get transcript using direct access token');
          updateProgress('transcript_fetch', 'Attempting to get transcript using direct access token', 58);
          transcript = await getTranscriptWithDirectToken(videoId, accessToken);
          console.log('Successfully retrieved transcript via direct token');
          updateProgress('transcript_fetch', 'Successfully retrieved transcript via direct token', 60);
        } catch (error: any) {
          const errorMsg = `Direct token method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
          updateProgress('transcript_fetch', 'Direct token method failed, trying next method', 58);
        }
      }
      
      // If we still don't have a transcript, try API list method
      if (!transcript && accessToken) {
        try {
          console.log('Attempting to get transcript using API list method');
          updateProgress('transcript_fetch', 'Attempting to get transcript using API list method', 59);
          transcript = await getTranscriptWithApiList(videoId, accessToken);
          console.log('Successfully retrieved transcript via API list method');
          updateProgress('transcript_fetch', 'Successfully retrieved transcript via API list method', 60);
        } catch (error: any) {
          const errorMsg = `API list method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
          updateProgress('transcript_fetch', 'API list method failed, trying next method', 59);
        }
      }
      
      // Try public API approach with youtube-transcript-api
      if (!transcript) {
        try {
          console.log('Attempting to get transcript using YouTube transcript API');
          updateProgress('transcript_fetch', 'Attempting to get transcript using YouTube transcript API', 60);
          const transcriptItems = await getAutoGeneratedTranscript(videoId);
          transcript = transcriptItems.map(item => `[${Math.floor(item.offset / 60000)}:${Math.floor((item.offset % 60000) / 1000)}] ${item.text}`).join('\n');
          console.log(`Successfully retrieved transcript with ${transcriptItems.length} items using YouTube transcript API`);
          updateProgress('transcript_fetch', `Successfully retrieved transcript with ${transcriptItems.length} items`, 65);
        } catch (error: any) {
          const errorMsg = `YouTube transcript API failed: ${error.message}`;
          console.log(errorMsg);
          errors.push(errorMsg);
          updateProgress('transcript_fetch', 'YouTube transcript API failed', 60);
        }
      }

      // If all methods have failed, provide detailed error information
      if (!transcript) {
        const detailedError = `All transcript retrieval methods failed for video ${videoId}.\n\nAttempted methods and their errors:\n${errors.map((err, i) => `${i + 1}. ${err}`).join('\n')}\n\nThis could be due to:\n- Video has no captions/transcripts available\n- YouTube anti-bot detection\n- Network connectivity issues\n- Rate limiting\n\nPlease try again later or verify the video has captions enabled.`;
        console.error(detailedError);
        throw new Error(detailedError);
      }
    }
    
    if (!transcript || transcript.trim().length === 0) {
      throw new Error('Failed to retrieve transcript: All methods returned empty results');
    }
    
    console.log(`Successfully retrieved transcript with length: ${transcript.length} characters`);
    updateProgress('transcript_process', 'Transcript retrieved successfully, starting processing', 70);
    
    // Include video title in documentName for better readability
    // But keep a consistent id format for duplicate checking
    const documentName = videoDetails.title;
    const idPrefix = `youtube_${videoId}`;
    
    // Split the text into chunks
    updateProgress('transcript_process', 'Splitting transcript into chunks', 75);
    const chunks = splitTextIntoChunks(transcript, chunkSize, chunkOverlap);
    
    if (chunks.length === 0) {
      throw new Error('Failed to create text chunks from transcript');
    }
    
    console.log(`Split transcript into ${chunks.length} chunks`);
    updateProgress('transcript_process', `Split transcript into ${chunks.length} chunks`, 80);
    
    // Verify that no chunk exceeds the embedding size limit
    const EMBEDDING_MAX_SIZE = 7500; // Safe limit for embedding API
    const oversizedChunks = chunks.filter(chunk => chunk.length > EMBEDDING_MAX_SIZE);
    
    if (oversizedChunks.length > 0) {
      console.log(`Found ${oversizedChunks.length} chunks that exceed the safe embedding size limit.`);
      updateProgress('transcript_process', `Resizing ${oversizedChunks.length} large chunks for better embedding`, 82);
      
      // Replace oversized chunks with smaller ones
      const finalChunks: string[] = [];
      for (const chunk of chunks) {
        if (chunk.length > EMBEDDING_MAX_SIZE) {
          console.log(`Resizing chunk of size ${chunk.length} characters`);
          const smallerChunks = resizeChunk(chunk, EMBEDDING_MAX_SIZE, chunkOverlap);
          console.log(`Resized large chunk into ${smallerChunks.length} smaller chunks`);
          finalChunks.push(...smallerChunks);
        } else {
          finalChunks.push(chunk);
        }
      }
      
      console.log(`After resizing, we have ${finalChunks.length} chunks (was ${chunks.length} before)`);
      updateProgress('transcript_process', `Final chunk count after resizing: ${finalChunks.length}`, 85);
      
      // Use the resized chunks from now on
      const resizedChunks = finalChunks;
      
      // Immediately send the actual total chunks count to update progress tracking
      if (progressCallback) {
        progressCallback('transcript_process', `Total chunks: ${resizedChunks.length}`, resizedChunks.length);
      }
      
      // Process each chunk
      const documentChunks: DocumentChunk[] = [];
      
      // Try to detect the language of the transcript for AI generation
      const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(transcript);
      const detectedLanguage = hasVietnameseChars ? 'Vietnamese' : 'English';
      
      // Now that we know the actual number of chunks, update the progress functions to use this information
      const totalChunks = resizedChunks.length;
      const chunkProgressUpdate = (stage: 'chunk_creation' | 'embedding_generation', message: string, index: number) => {
        if (progressCallback) {
          progressCallback(stage, message, index);
        }
      };
      
      for (let i = 0; i < resizedChunks.length; i++) {
        const content = resizedChunks[i];
        console.log(`Processing chunk ${i+1}/${totalChunks}, length: ${content.length} characters`);
        chunkProgressUpdate('chunk_creation', `Processing chunk ${i+1}/${totalChunks}`, i+1);
        
        // Create embedding for the chunk
        chunkProgressUpdate('embedding_generation', `Generating embedding for chunk ${i+1}/${totalChunks}`, i+1);
        const embedding = await createEmbedding(content);
        
        // Create clean content for AI processing
        const cleanContent = content.replace(/\[\d{1,2}:\d{1,2}(:\d{1,2})?\]/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        
        // Create base document chunk with id format for duplicate checking
        const tempChunk: DocumentChunk = {
          id: `${idPrefix}_chunk_${i}`, // Use consistent id format with videoId for duplicate checking
          documentName: documentName, // Include video title in documentName for readability
          content: content, // Keep original content with timestamps
          embedding: embedding,
          title: `Part ${i+1} of ${videoDetails.title}`, // Default title in case AI generation fails
          summary: `Part ${i+1} of transcript for video: ${videoDetails.title}`, // Default summary
          sourceFile: `https://www.youtube.com/watch?v=${videoId}`,
          domains: domains || ['youtube']
        };
        
        // Enhance the chunk and generate AI title and summary
        try {
          // First generate AI title and summary for this chunk in the original language
          const aiEnhancedMetadata = await generateTitleAndSummary(cleanContent, videoDetails.title, i+1, totalChunks, detectedLanguage);
          
          // Create a clean temp chunk with AI-generated metadata for enhancement
          const cleanTempChunk = {
            ...tempChunk,
            content: cleanContent,
            title: aiEnhancedMetadata.title,
            summary: aiEnhancedMetadata.summary
          };
          
          // Now enhance the content itself
          const enhancedChunk = await enhanceContent(cleanTempChunk, {
            types: [EnhancementType.FORMATTING, EnhancementType.READABILITY]
          });
          
          // Keep the original content with timestamps, but use the enhanced content without timestamps
          // and the AI-generated title and summary
          documentChunks.push({
            ...enhancedChunk,
            content: tempChunk.content, // Keep original content with timestamps
            title: aiEnhancedMetadata.title,
            summary: aiEnhancedMetadata.summary
          });
        } catch (error) {
          console.error(`Error enhancing chunk ${i+1}:`, error);
          // If enhancement fails, use the original chunk
          documentChunks.push(tempChunk);
        }
      }
      
      return documentChunks;
    } else {
      // Proceed with original chunks if no resizing is needed
      
      // Immediately send the actual total chunks count to update progress tracking
      if (progressCallback) {
        progressCallback('transcript_process', `Total chunks: ${chunks.length}`, chunks.length);
      }
      
      // Process each chunk
      const documentChunks: DocumentChunk[] = [];
      
      // Try to detect the language of the transcript for AI generation
      const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(transcript);
      const detectedLanguage = hasVietnameseChars ? 'Vietnamese' : 'English';
      
      // Now that we know the actual number of chunks, update the progress functions to use this information
      const totalChunks = chunks.length;
      const chunkProgressUpdate = (stage: 'chunk_creation' | 'embedding_generation', message: string, index: number) => {
        if (progressCallback) {
          progressCallback(stage, message, index);
        }
      };
      
      for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i];
        console.log(`Processing chunk ${i+1}/${totalChunks}, length: ${content.length} characters`);
        chunkProgressUpdate('chunk_creation', `Processing chunk ${i+1}/${totalChunks}`, i+1);
        
        // Create embedding for the chunk
        chunkProgressUpdate('embedding_generation', `Generating embedding for chunk ${i+1}/${totalChunks}`, i+1);
        const embedding = await createEmbedding(content);
        
        // Create clean content for AI processing
        const cleanContent = content.replace(/\[\d{1,2}:\d{1,2}(:\d{1,2})?\]/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        
        // Create base document chunk with id format for duplicate checking
        const tempChunk: DocumentChunk = {
          id: `${idPrefix}_chunk_${i}`, // Use consistent id format with videoId for duplicate checking
          documentName: documentName, // Include video title in documentName for readability
          content: content, // Keep original content with timestamps
          embedding: embedding,
          title: `Part ${i+1} of ${videoDetails.title}`, // Default title in case AI generation fails
          summary: `Part ${i+1} of transcript for video: ${videoDetails.title}`, // Default summary
          sourceFile: `https://www.youtube.com/watch?v=${videoId}`,
          domains: domains || ['youtube']
        };
        
        // Enhance the chunk and generate AI title and summary
        try {
          // First generate AI title and summary for this chunk in the original language
          const aiEnhancedMetadata = await generateTitleAndSummary(cleanContent, videoDetails.title, i+1, totalChunks, detectedLanguage);
          
          // Create a clean temp chunk with AI-generated metadata for enhancement
          const cleanTempChunk = {
            ...tempChunk,
            content: cleanContent,
            title: aiEnhancedMetadata.title,
            summary: aiEnhancedMetadata.summary
          };
          
          // Now enhance the content itself
          const enhancedChunk = await enhanceContent(cleanTempChunk, {
            types: [EnhancementType.FORMATTING, EnhancementType.READABILITY]
          });
          
          // Keep the original content with timestamps, but use the enhanced content without timestamps
          // and the AI-generated title and summary
          documentChunks.push({
            ...enhancedChunk,
            content: tempChunk.content, // Keep original content with timestamps
            title: aiEnhancedMetadata.title,
            summary: aiEnhancedMetadata.summary
          });
        } catch (error) {
          console.error(`Error enhancing chunk ${i+1}:`, error);
          // If enhancement fails, use the original chunk
          documentChunks.push(tempChunk);
        }
      }
      
      return documentChunks;
    }
  } catch (error) {
    console.error('Error processing YouTube transcript:', error);
    throw error;
  }
};

// Helper function to split text into chunks with overlap
const splitTextIntoChunks = (
  text: string,
  chunkSize: number,
  chunkOverlap: number
): string[] => {
  // Maximum size for a single chunk to prevent embedding service from needing to re-chunk
  const EMBEDDING_MAX_SIZE = 9000; // Conservative limit below the 10000 limit in embedding.ts
  const effectiveChunkSize = Math.min(chunkSize, EMBEDDING_MAX_SIZE);
  
  // If text is short enough, just return it as a single chunk
  if (text.length <= effectiveChunkSize) {
    console.log('Text is short enough to be a single chunk');
    return [text];
  }
  
  // Try to split by timestamps - this is the YouTube specific format
  const timestampPattern = /\[\d{2}:\d{2}\]/g;
  const timestamps = text.match(timestampPattern);
  
  // If no timestamps found, use simple text chunking
  if (!timestamps || timestamps.length <= 1) {
    console.log('No timestamps found, using simple text chunking');
    return simpleTextChunking(text, effectiveChunkSize, chunkOverlap);
  }
  
  // Otherwise use timestamp-aware chunking
  console.log('Using timestamp-aware chunking for YouTube transcript');
  const segments = text.split(timestampPattern);
  
  // Reconstruct segments with their timestamps
  const lines: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    lines.push(`${timestamps[i-1]}${segments[i]}`);
  }
  
  // Now create chunks, ensuring we keep logical content together
  const chunks: string[] = [];
  let currentChunk = '';
  let timestampCount = 0;  // Track number of timestamps in current chunk
  
  for (const line of lines) {
    // If this line would exceed chunk size and we already have substantial content
    if ((currentChunk + '\n' + line).length > effectiveChunkSize && timestampCount >= 5) {
      // Only break if we have at least a few timestamps worth of content
      chunks.push(currentChunk);
      
      // Start new chunk with overlap by including the last few lines from previous chunk
      if (chunkOverlap > 0 && currentChunk.length > 0) {
        // Take the last few timestamp segments that fit within overlap size
        const chunkLines = currentChunk.split('\n');
        let overlapText = '';
        let overlapSize = 0;
        let overlapTimestamps = 0;
        
        // Start from the end and work backward to include enough context
        for (let i = chunkLines.length - 1; i >= 0; i--) {
          if (overlapSize + chunkLines[i].length <= chunkOverlap || overlapTimestamps < 3) {
            // Add to overlap if under size limit or we need more timestamp context
            overlapText = chunkLines[i] + (overlapText ? '\n' + overlapText : '');
            overlapSize += chunkLines[i].length + 1; // +1 for newline
            if (chunkLines[i].match(timestampPattern)) {
              overlapTimestamps++;
            }
          } else {
            break;
          }
        }
        
        currentChunk = overlapText;
        timestampCount = overlapTimestamps;
      } else {
        currentChunk = '';
        timestampCount = 0;
      }
    }
    
    // Add the current line to the chunk
    if (currentChunk) {
      currentChunk += '\n' + line;
    } else {
      currentChunk = line;
    }
    
    // Increment timestamp counter if this line has a timestamp
    if (line.match(timestampPattern)) {
      timestampCount++;
    }
    
    // Extra check for oversized chunks - if we're getting too big even without hitting
    // a logical break point, force a chunk break
    if (currentChunk.length > effectiveChunkSize * 0.9 && timestampCount >= 3) {
      chunks.push(currentChunk);
      currentChunk = '';
      timestampCount = 0;
    }
  }
  
  // Add the last chunk if it's not empty
  if (currentChunk) {
    // Check if the last chunk is too large
    if (currentChunk.length > effectiveChunkSize) {
      console.log(`Last chunk is too large (${currentChunk.length} chars), splitting further`);
      // Split the oversized last chunk
      const additionalChunks = splitLargeChunk(currentChunk, effectiveChunkSize, chunkOverlap, timestampPattern);
      chunks.push(...additionalChunks);
    } else {
      chunks.push(currentChunk);
    }
  }
  
  console.log(`Created ${chunks.length} chunks with timestamp-aware chunking`);
  return chunks.length > 0 ? chunks : [text]; // Fallback to original text if no chunks created
};

// Function to split an oversized chunk into smaller pieces
const splitLargeChunk = (
  text: string,
  chunkSize: number,
  chunkOverlap: number,
  timestampPattern: RegExp
): string[] => {
  // Split by lines to maintain structure
  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + (currentChunk ? '\n' : '') + line).length <= chunkSize) {
      currentChunk += (currentChunk ? '\n' : '') + line;
    } else {
      // If we have content, add it as a chunk
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      // Start a new chunk with this line
      // If the line itself is too long (unlikely), we'll add it as a chunk by itself
      currentChunk = line;
    }
  }
  
  // Add the last chunk if it's not empty
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
};

// Simple text chunking without timestamp awareness
const simpleTextChunking = (
  text: string,
  chunkSize: number,
  chunkOverlap: number
): string[] => {
  const chunks: string[] = [];
  
  // Split by sentence endings or newlines
  const sentences = text.split(/(?<=[.!?])\s+|\n/).filter(s => s.trim().length > 0);
  
  if (sentences.length === 0) {
    return [text]; // Return original text if no sentences found
  }
  
  let currentChunk = '';
  
  for (const sentence of sentences) {
    // If adding this sentence would exceed chunkSize, start a new chunk
    if (currentChunk && (currentChunk + ' ' + sentence).length > chunkSize) {
      chunks.push(currentChunk);
      
      // Apply overlap
      if (chunkOverlap > 0) {
        // For simplicity, take the last sentence as overlap
        const lastSentences = currentChunk.split(/(?<=[.!?])\s+|\n/).filter(s => s.trim().length > 0);
        let overlapText = '';
        let overlapSize = 0;
        
        for (let i = lastSentences.length - 1; i >= 0; i--) {
          if (overlapSize + lastSentences[i].length <= chunkOverlap) {
            if (overlapText) {
              overlapText = lastSentences[i] + ' ' + overlapText;
            } else {
              overlapText = lastSentences[i];
            }
            overlapSize += lastSentences[i].length + 1; // +1 for space
          } else {
            break;
          }
        }
        
        currentChunk = overlapText.trim();
      } else {
        currentChunk = '';
      }
    }
    
    // Add the current sentence to the chunk
    if (currentChunk) {
      currentChunk += ' ' + sentence;
    } else {
      currentChunk = sentence;
    }
    
    // Extra check for oversized chunks - some sentences might be very long
    if (currentChunk.length > chunkSize) {
      // If a single sentence is too long, we need to split it by words
      if (currentChunk === sentence) {
        const words = sentence.split(/\s+/);
        let wordChunk = '';
        
        for (const word of words) {
          if ((wordChunk + ' ' + word).length <= chunkSize) {
            wordChunk += (wordChunk ? ' ' : '') + word;
          } else {
            if (wordChunk) {
              chunks.push(wordChunk);
            }
            wordChunk = word;
          }
        }
        
        if (wordChunk) {
          currentChunk = wordChunk;
        } else {
          currentChunk = '';
        }
      } else {
        chunks.push(currentChunk);
        currentChunk = '';
      }
    }
  }
  
  // Add the last chunk if it exists
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  console.log(`Created ${chunks.length} chunks with simple text chunking`);
  return chunks.length > 0 ? chunks : [text]; // Fallback to original text if no chunks created
};

// Try to get transcript using a public API service
export const getTranscriptFromPublicApi = async (videoId: string): Promise<string> => {
  try {
    console.log(`Attempting to get transcript from public API for video ID: ${videoId}`);
    
    // First try web scraping approach as it's more reliable
    try {
      console.log('Attempting to extract transcript directly from YouTube webpage');
      const transcript = await scrapeTranscriptFromYouTube(videoId);
      if (transcript && transcript.length > 0) {
        console.log(`Successfully extracted transcript by scraping, length: ${transcript.length} characters`);
        return transcript;
      }
      throw new Error('Failed to extract transcript by scraping');
    } catch (scrapeError) {
      console.error('Error scraping transcript:', scrapeError);
      
      // Then try with youtube-transcript-api as fallback
      try {
        // This will use the non-OAuth method
        const transcript = await getAutoGeneratedTranscript(videoId);
        
        if (transcript && transcript.length > 0) {
          // If the transcript has real content (not just an error message)
          if (!transcript[0].text.includes("We're sorry, YouTube is currently blocking us")) {
            // Format transcript with timestamps
            const formattedTranscript = transcript.map((item: TranscriptItem) => {
              const timeInSeconds = item.offset / 1000;
              const minutes = Math.floor(timeInSeconds / 60);
              const seconds = Math.floor(timeInSeconds % 60);
              const formattedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
              
              return `[${formattedTime}] ${item.text}`;
            }).join('\n');
            
            return formattedTranscript;
          }
        }
        
        throw new Error('Transcript contains only error message');
      } catch (apiError) {
        console.error('Error with YouTube transcript API:', apiError);
        
        // Last resort: try with Cheerio web scraping to get metadata
        // Get the YouTube page and extract any transcript data available in the page
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`);
        const $ = cheerio.load(response.data);
        
        // Extract title and description
        const title = $('meta[property="og:title"]').attr('content') || '';
        const description = $('meta[property="og:description"]').attr('content') || '';
        
        // Simple metadata-based transcript
        return `Title: ${title}\n\nDescription: ${description}\n\n(No transcript available from YouTube API. Using video metadata only.)`;
      }
    }
  } catch (error: any) {
    console.error('All public API transcript methods failed:', error);
    throw new Error(`Could not retrieve transcript from any public API: ${error.message}`);
  }
};

/**
 * Perform a warm-up request to YouTube to establish session and avoid anti-bot detection
 */
const performWarmupRequest = async (userAgent: string): Promise<void> => {
  try {
    console.log('Performing warm-up request to YouTube...');
    await axios.get('https://www.youtube.com/', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1'
      },
      timeout: 10000
    });
    console.log('Warm-up request completed successfully');
    // Small delay after warm-up
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.log('Warm-up request failed, but continuing with scraping:', error instanceof Error ? error.message : 'Unknown error');
  }
};

/**
 * Scrape transcript directly from YouTube's webpage
 * This works around API limitations since YouTube displays transcripts on the web
 */
export const scrapeTranscriptFromYouTube = async (
  videoId: string,
  maxRetries = SCRAPING_CONFIG.maxRetries,
  retryDelay = SCRAPING_CONFIG.baseRetryDelay
): Promise<string> => {
  let retryCount = 0;

  // Array of different user agents to rotate through
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0'
  ];

  const performScrape = async (): Promise<string> => {
    try {
      // Check circuit breaker before attempting
      if (scrapingMetrics.isCircuitBreakerOpen()) {
        throw new Error('Circuit breaker is open due to repeated anti-bot detections. Please wait 5 minutes before trying again.');
      }

      // Record attempt in metrics
      scrapingMetrics.recordAttempt();

      // Rotate user agent on retries
      const userAgent = userAgents[retryCount % userAgents.length];

      // Perform warm-up request on first attempt or after multiple failures (if enabled)
      if (SCRAPING_CONFIG.enableWarmup && (retryCount === 0 || retryCount === 2)) {
        await performWarmupRequest(userAgent);
      }

      // Add random delay to avoid detection patterns
      if (retryCount > 0) {
        scrapingMetrics.recordRetry();
        const randomDelay = Math.random() * 1000 + 500; // 500-1500ms random delay
        console.log(`Adding random delay of ${Math.round(randomDelay)}ms before retry ${retryCount}`);
        await new Promise(resolve => setTimeout(resolve, randomDelay));
      }

      // First get the timedtext URL from the video page
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      console.log(`Attempting to scrape YouTube page for video ${videoId} (attempt ${retryCount + 1}/${maxRetries + 1})`);

      const response = await axios.get(videoUrl, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        timeout: SCRAPING_CONFIG.requestTimeout,
        maxRedirects: 5
      });

      // Check if we got a valid response
      if (!response.data || response.data.length < 1000) {
        throw new Error('Received incomplete or empty response from YouTube');
      }

      const html = response.data;

      // Check for anti-bot detection with more specific and precise patterns
      // Only trigger on very specific anti-bot messages, not generic terms
      const antiBotPatterns = [
        'Our systems have detected unusual traffic from your computer network',
        'Please complete the security check to access',
        'verify you are human',
        'automated requests from your computer network',
        'unusual traffic from your computer network',
        'This page appears when Google automatically detects',
        'Before we continue, we need to verify that you\'re human'
      ];

      // More precise detection - look for specific anti-bot page indicators
      const isAntiBotPage = antiBotPatterns.some(pattern =>
        html.toLowerCase().includes(pattern.toLowerCase())
      ) || (
        // Check for combination of indicators that suggest anti-bot page
        html.includes('captcha') &&
        (html.includes('verify') || html.includes('security')) &&
        html.length < 50000 // Anti-bot pages are typically much smaller
      );

      if (isAntiBotPage) {
        const foundPattern = antiBotPatterns.find(pattern =>
          html.toLowerCase().includes(pattern.toLowerCase())
        ) || 'captcha verification page';

        // Record anti-bot detection
        scrapingMetrics.recordAntiBotDetection();

        console.log(`🚨 Confirmed anti-bot detection: ${foundPattern}`);

        // For anti-bot detection, we should wait longer before retrying
        if (retryCount < maxRetries) {
          throw new Error(`YouTube anti-bot detection triggered (pattern: "${foundPattern}"). Will retry with longer delay.`);
        } else {
          throw new Error(`YouTube anti-bot detection triggered after ${maxRetries} attempts. This may indicate IP-based rate limiting. Please try again later or from a different network.`);
        }
      }

      // Validate that we got a proper YouTube page
      if (!html.includes('ytInitialData') && !html.includes('captionTracks')) {
        console.log(`⚠️  Page validation failed - missing ytInitialData and captionTracks. Page length: ${html.length}`);
        throw new Error('Invalid YouTube page response - may be blocked or rate limited');
      }

      console.log(`✅ Valid YouTube page received (${html.length} characters)`);
      console.log(`🔍 Searching for caption data...`);

      // Try different regex patterns to locate caption data
      let captionData;
      let captionUrl;

      console.log('Searching for caption data in YouTube page...');

      // Pattern 1: Try to find the newer format of caption data
      const newPatternMatch = html.match(/\{"captionTracks":(\[.*?\])/);
      if (newPatternMatch && newPatternMatch[1]) {
        try {
          const captionTracksJson = JSON.parse(newPatternMatch[1]);
          if (captionTracksJson && captionTracksJson.length > 0) {
            captionUrl = captionTracksJson[0].baseUrl;
            console.log('Found caption URL using new pattern format');
          }
        } catch (e) {
          console.log('Failed to parse new caption format:', e);
        }
      }

      // Pattern 2: Try the older format
      if (!captionUrl) {
        const oldPatternMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
        if (oldPatternMatch && oldPatternMatch[1]) {
          try {
            const captionTracksJson = JSON.parse(oldPatternMatch[1].replace(/\\"/g, '"').replace(/\\u0026/g, '&'));
            if (captionTracksJson && captionTracksJson.length > 0) {
              captionUrl = captionTracksJson[0].baseUrl;
              console.log('Found caption URL using old pattern format');
            }
          } catch (e) {
            console.log('Failed to parse old caption format:', e);
          }
        }
      }

      // Pattern 3: Try direct URL regex (most reliable fallback)
      if (!captionUrl) {
        const directUrlMatch = html.match(/https:\/\/www.youtube.com\/api\/timedtext[^"]*/) ||
                              html.match(/https:\/\/www.youtube.com\/api\/timedtext[^&]*/) ||
                              html.match(/"(https:\/\/www\.youtube\.com\/api\/timedtext[^"]*)"/);

        if (directUrlMatch && directUrlMatch[0]) {
          captionUrl = directUrlMatch[0].replace(/\\u0026/g, '&');
          console.log('Found caption URL using direct URL pattern');
        }
      }

      // Pattern 4: Try more aggressive search for timedtext URLs
      if (!captionUrl) {
        const aggressiveMatch = html.match(/timedtext[^"]*lang[^"]*/) ||
                               html.match(/api\/timedtext[^"]*/) ||
                               html.match(/subtitle[^"]*timedtext[^"]*/);

        if (aggressiveMatch && aggressiveMatch[0]) {
          // Reconstruct the full URL if we found a partial match
          if (!aggressiveMatch[0].startsWith('http')) {
            captionUrl = `https://www.youtube.com/api/${aggressiveMatch[0]}`;
          } else {
            captionUrl = aggressiveMatch[0];
          }
          captionUrl = captionUrl.replace(/\\u0026/g, '&');
          console.log('Found caption URL using aggressive pattern search');
        }
      }

      if (!captionUrl) {
        console.log(`❌ No caption URL found. This could mean:`);
        console.log(`   - Video has no captions/transcripts available`);
        console.log(`   - YouTube changed their page structure`);
        console.log(`   - Video is private or restricted`);
        throw new Error('Could not find caption URL in video page. The video may not have captions enabled or the page structure has changed.');
      }

      console.log(`Found caption URL: ${captionUrl}`);

      // Add a small delay before fetching caption content to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));

      // Fetch the caption content (XML format) with retry logic
      let captionResponse;
      let captionXml;

      try {
        console.log(`🔗 Fetching caption content from: ${captionUrl.substring(0, 100)}...`);
        captionResponse = await axios.get(captionUrl, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'application/xml, text/xml, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': videoUrl,
            'Origin': 'https://www.youtube.com'
          },
          timeout: 15000 // 15 second timeout for caption fetch
        });
        captionXml = captionResponse.data;
        console.log(`📥 Caption response status: ${captionResponse.status}, length: ${captionXml ? captionXml.length : 0}`);
      } catch (captionError) {
        console.error('❌ Error fetching caption content:', captionError instanceof Error ? captionError.message : captionError);
        throw new Error(`Failed to fetch caption content: ${captionError instanceof Error ? captionError.message : 'Unknown error'}`);
      }

      if (!captionXml || captionXml.length < 10) {
        console.log(`⚠️  Received empty caption data (length: ${captionXml ? captionXml.length : 0})`);
        throw new Error('Received empty caption data from YouTube');
      }

      // Validate that we got XML content
      if (!captionXml.includes('<text') && !captionXml.includes('<?xml')) {
        console.log(`⚠️  Caption response is not valid XML. Content preview: ${captionXml.substring(0, 200)}`);
        throw new Error('Caption response does not contain valid XML data');
      }

      console.log(`✅ Valid caption XML received (${captionXml.length} characters)`);

      // Parse XML to extract text with timestamps
      console.log('Parsing caption XML data...');
      const $ = cheerio.load(captionXml, { xmlMode: true });
      const transcriptLines: string[] = [];

      $('text').each((i, elem) => {
        const start = parseFloat($(elem).attr('start') || '0');

        // Format the timestamp with hours if needed
        let timeCode: string;
        if (start >= 3600) {
          // Format as [HH:MM:SS] for videos longer than 1 hour
          const hours = Math.floor(start / 3600);
          const minutes = Math.floor((start % 3600) / 60);
          const seconds = Math.floor(start % 60);
          timeCode = `[${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
        } else {
          // Format as [MM:SS] for shorter videos
          const minutes = Math.floor(start / 60);
          const seconds = Math.floor(start % 60);
          timeCode = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
        }

        const text = $(elem).text().trim();
        if (text) {
          transcriptLines.push(`${timeCode} ${text}`);
        }
      });

      if (transcriptLines.length === 0) {
        throw new Error('No transcript lines found after parsing caption data - XML may be malformed or empty');
      }

      console.log(`Successfully parsed ${transcriptLines.length} transcript lines`);

      // Record successful attempt
      scrapingMetrics.recordSuccess();

      return transcriptLines.join('\n');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Scraping attempt ${retryCount + 1} failed:`, errorMessage);

      // Determine if we should retry based on the error type
      const shouldRetry = retryCount < maxRetries && (
        errorMessage.includes('empty caption data') ||
        errorMessage.includes('incomplete or empty response') ||
        errorMessage.includes('anti-bot detection triggered') || // More specific pattern
        errorMessage.includes('rate limited') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('network') ||
        errorMessage.includes('Failed to fetch caption content') ||
        errorMessage.includes('Invalid YouTube page response') ||
        errorMessage.includes('Could not find caption URL') ||
        errorMessage.includes('Caption response does not contain valid XML')
      );

      // Special handling for confirmed anti-bot detection - use longer delays
      const isConfirmedAntiBotError = errorMessage.includes('anti-bot detection triggered');
      const baseDelay = isConfirmedAntiBotError ? retryDelay * 2 : retryDelay; // 2x longer for confirmed anti-bot (reduced from 3x)

      if (shouldRetry) {
        retryCount++;
        // Exponential backoff with jitter
        const backoffDelay = baseDelay * Math.pow(2, retryCount - 1);
        const jitter = Math.random() * 1000; // Add up to 1 second of random jitter
        const totalDelay = backoffDelay + jitter;

        console.log(`Retry ${retryCount}/${maxRetries}: ${errorMessage}. Retrying after ${Math.round(totalDelay)}ms...`);

        // For confirmed anti-bot errors, add additional random delay to break patterns
        if (isConfirmedAntiBotError) {
          const extraDelay = Math.random() * 3000 + 1000; // 1-4 seconds extra (reduced from 2-7)
          console.log(`🤖 Confirmed anti-bot detected, adding extra ${Math.round(extraDelay)}ms delay...`);
          await new Promise(resolve => setTimeout(resolve, extraDelay));
        }

        // Wait for the retry delay
        await new Promise(resolve => setTimeout(resolve, totalDelay));

        // Retry with exponential backoff
        return performScrape();
      }

      // If we've exhausted retries or hit a non-retryable error
      console.error('All scraping attempts failed or non-retryable error encountered:', error);

      // Record failure in metrics
      scrapingMetrics.recordFailure();

      // Log current metrics for debugging
      const stats = scrapingMetrics.getStats();
      console.log(`Scraping metrics - Success rate: ${stats.successRate}, Total attempts: ${stats.totalAttempts}, Retries: ${stats.retryAttempts}`);

      throw new Error(`Failed to scrape transcript after ${retryCount + 1} attempts: ${errorMessage}`);
    }
  };

  return performScrape();
};

/**
 * Generate a specific title and summary for a chunk using generative AI
 */
async function generateTitleAndSummary(
  content: string,
  videoTitle: string,
  chunkNumber: number,
  totalChunks: number,
  language: string = 'English'
): Promise<{ title: string; summary: string }> {
  try {
    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // Extract a shorter sample of the content for the title/summary generation
    // to avoid token limits (first 1500 chars should be enough for context)
    const contentSample = content.length > 1500 ? content.substring(0, 1500) + "..." : content;
    
    // Create a prompt for generating title and summary
    const prompt = `You are analyzing a segment of a transcript from the YouTube video titled "${videoTitle}". 
This is part ${chunkNumber} of ${totalChunks} from the transcript.

The transcript is in ${language}. YOU MUST GENERATE THE TITLE AND SUMMARY IN ${language} as well.

Here's the transcript segment:
"""
${contentSample}
"""

Please generate:
1. A descriptive title (maximum 10 words) for just this specific segment that captures its main topic or theme
2. A concise summary (maximum 100 words) of the key points covered in this specific segment

Format your response exactly like this:
TITLE: [your generated title in ${language}]
SUMMARY: [your generated summary in ${language}]`;

    // Call Gemini API to generate title and summary
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1000,
      }
    });

    const responseText = result.response.text().trim();
    
    // Parse the response to extract title and summary
    let title = `Part ${chunkNumber} of ${videoTitle}`;
    let summary = `Part ${chunkNumber} of transcript for video: ${videoTitle}`;
    
    const titleMatch = responseText.match(/TITLE:\s*(.*?)(?=\n|$)/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim();
    }
    
    const summaryMatch = responseText.match(/SUMMARY:\s*([\s\S]*?)(?=\n\n|$)/i);
    if (summaryMatch && summaryMatch[1]) {
      summary = summaryMatch[1].trim();
    }
    
    console.log(`Generated AI title for chunk ${chunkNumber}: "${title}"`);
    return { title, summary };
  } catch (error) {
    console.error('Error generating title and summary:', error);
    // Return defaults if generation fails
    return { 
      title: `Part ${chunkNumber} of ${videoTitle}`,
      summary: `Part ${chunkNumber} of transcript for video: ${videoTitle}`
    };
  }
}

// Function to resize a chunk that exceeds embedding limits
function resizeChunk(chunk: string, maxSize: number, overlap: number): string[] {
  // Try to split by timestamps
  const timestampPattern = /\[\d{2}:\d{2}\]/g;
  const hasTimestamps = timestampPattern.test(chunk);
  
  if (hasTimestamps) {
    // Use timestamp-aware splitting
    return splitLargeChunk(chunk, maxSize, overlap, timestampPattern);
  } else {
    // Fall back to simple text chunking
    // Split by sentences or paragraphs
    const sentences = chunk.split(/(?<=[.!?])\s+|\n/).filter(s => s.trim().length > 0);
    
    const smallerChunks: string[] = [];
    let currentChunk = '';
    
    for (const sentence of sentences) {
      if ((currentChunk + ' ' + sentence).length <= maxSize) {
        currentChunk += (currentChunk ? ' ' : '') + sentence;
      } else {
        if (currentChunk) {
          smallerChunks.push(currentChunk);
        }
        currentChunk = sentence;
      }
    }
    
    if (currentChunk) {
      smallerChunks.push(currentChunk);
    }
    
    return smallerChunks.length > 0 ? smallerChunks : [chunk.substring(0, maxSize)]; // Last resort
  }
} 