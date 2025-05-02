import { getTranscript } from 'youtube-transcript-api';
import { createEmbedding } from './embedding';
import { TaskType } from '@google/generative-ai';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { enhanceContent, EnhancementType } from './content-enhancement';
import { DocumentChunk } from './chunking';
import { google } from 'googleapis';
import { getAuthenticatedClient } from './youtube-auth';

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

// Process YouTube transcript into vector chunks for embedding
export const processYoutubeTranscript = async (
  videoId: string,
  domains: string[],
  chunkSize: number = 1000,
  chunkOverlap: number = 200,
  userId?: string, // Optional user ID for OAuth authentication
  accessToken?: string // Optional direct access token
): Promise<any[]> => {
  try {
    // Get the transcript data once and format it
    console.log(`Fetching transcript for video ID: ${videoId}`);
    
    // Get video details (actual title from YouTube)
    const videoDetails = await getVideoDetails(videoId);
    
    let finalTranscript = '';
    let useOAuth = false;
    
    // Try direct web scraping first as the most reliable method
    try {
      console.log('Attempting to extract transcript directly from YouTube webpage');
      finalTranscript = await scrapeTranscriptFromYouTube(videoId);
      console.log(`Successfully extracted transcript by scraping, length: ${finalTranscript.length} characters`);
    } catch (scrapeError) {
      console.error('Web scraping method failed:', scrapeError);
      
      // If scraping fails, try the API methods
      // 1. First try with direct access token if provided
      if (accessToken) {
        try {
          console.log('Attempting to get transcript with direct access token');
          finalTranscript = await getTranscriptWithDirectToken(videoId, accessToken);
          useOAuth = true;
          console.log('Successfully retrieved transcript with direct access token');
        } catch (directTokenError) {
          console.error('Direct token method failed:', directTokenError);
        }
      }
      
      // 2. Then try with OAuth if user is authenticated but direct token failed
      if (!finalTranscript && userId) {
        try {
          console.log('Attempting to get transcript with OAuth authentication');
          finalTranscript = await getYouTubeTranscriptWithOAuth(videoId, userId);
          useOAuth = true;
          console.log('Successfully retrieved transcript with OAuth authentication');
        } catch (oauthError) {
          console.error('OAuth method failed:', oauthError);
        }
      }
      
      // 3. Then try with the public API methods if both authenticated methods failed
      if (!finalTranscript) {
        try {
          console.log('Trying public API transcript methods');
          finalTranscript = await getTranscriptFromPublicApi(videoId);
          console.log(`Successfully retrieved transcript using public API methods, length: ${finalTranscript.length} characters`);
        } catch (publicApiError) {
          console.error('Public API methods failed:', publicApiError);
          
          // 4. Last resort: use youtube-transcript-api library
          try {
            console.log('Trying youtube-transcript-api library as last resort');
            const transcript = await getAutoGeneratedTranscript(videoId);
            
            // Format with timestamps
            const formattedTranscript = transcript.map((item: TranscriptItem) => {
              const timeInSeconds = item.offset / 1000;
              const minutes = Math.floor(timeInSeconds / 60);
              const seconds = Math.floor(timeInSeconds % 60);
              const formattedTime = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
              
              return `[${formattedTime}] ${item.text}`;
            }).join('\n');
            
            finalTranscript = formattedTranscript;
            console.log(`Successfully got transcript from youtube-transcript-api, length: ${finalTranscript.length} characters`);
          } catch (directApiError) {
            console.error('All transcript methods failed');
            
            // Absolute last resort: just use the video metadata
            finalTranscript = `Title: ${videoDetails.title}\n\nDescription: ${videoDetails.description || ''}\n\n(No transcript available from any source. Using video metadata only.)`;
            console.log('Using video metadata as fallback');
          }
        }
      }
    }
    
    // If transcript is still empty after all attempts, throw an error
    if (!finalTranscript.trim()) {
      throw new Error('Could not retrieve any transcript or metadata from this video');
    }
    
    // If transcript is too short, include video title and description to augment it
    let textToChunk = finalTranscript;
    if (finalTranscript.length < 200 && videoDetails.description) {
      textToChunk = `${videoDetails.title}\n\n${videoDetails.description}\n\n${finalTranscript}`;
      console.log(`Augmented transcript with title and description, new length: ${textToChunk.length} characters`);
    }
    
    // Try to enhance the transcript with AI
    try {
      // Create a temporary document chunk for AI enhancement
      const chunk: DocumentChunk = {
        id: `youtube-transcript-${videoId}`,
        documentName: `YouTube Video ${videoId}`,
        content: textToChunk,
        embedding: [],
        title: videoDetails.title,
        summary: '',
        sourceFile: `https://www.youtube.com/watch?v=${videoId}`,
        domains: domains || ['youtube']
      };
      
      // Enhance content using the existing service
      const enhancedChunk = await enhanceContent(chunk, {
        types: [EnhancementType.FORMATTING, EnhancementType.READABILITY],
        temperature: 0.2
      });
      
      if (enhancedChunk.enhancedContent) {
        textToChunk = enhancedChunk.enhancedContent;
        console.log(`Enhanced transcript with AI, new length: ${textToChunk.length} characters`);
      }
    } catch (aiError) {
      console.warn('Failed to enhance transcript with AI:', aiError);
    }
    
    // Chunk the transcript
    const textChunks = splitTextIntoChunks(textToChunk, chunkSize, chunkOverlap);
    
    console.log(`Created ${textChunks.length} chunks from transcript`);
    
    if (textChunks.length === 0) {
      console.error(`Failed to create chunks from transcript. Final transcript length: ${textToChunk.length}`);
      
      // Fallback: Create a single chunk with whatever content we have
      textChunks.push(textToChunk);
      console.log('Fallback: Created a single chunk with the entire transcript');
    }
    
    // Create embeddings and format data for storage
    const chunks = [];
    
    for (let i = 0; i < textChunks.length; i++) {
      const chunkText = textChunks[i];
      
      console.log(`Processing chunk ${i+1}/${textChunks.length}, length: ${chunkText.length} characters`);
      
      // Generate embedding vector
      const embedding = await createEmbedding(chunkText, TaskType.RETRIEVAL_DOCUMENT);
      
      // Create metadata for the chunk
      const chunk = {
        id: `youtube-${videoId}-chunk-${i}`,
        videoId,
        content: chunkText,
        embedding,
        domains,
        metadata: {
          source: 'youtube',
          sourceId: videoId,
          sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
          documentTitle: videoDetails.title,
          documentDescription: videoDetails.description || '',
          chunkIndex: i,
          totalChunks: textChunks.length,
          timestamp: new Date().toISOString()
        }
      };
      
      chunks.push(chunk);
    }
    
    return chunks;
  } catch (error) {
    console.error('Error processing YouTube transcript:', error);
    // Enhanced error details
    if (error instanceof Error) {
      console.error('Error name:', error.name);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
    throw error;
  }
};

// Helper function to split text into chunks with overlap
const splitTextIntoChunks = (
  text: string,
  chunkSize: number,
  chunkOverlap: number
): string[] => {
  // If text is short enough, just return it as a single chunk
  if (text.length <= chunkSize) {
    console.log('Text is short enough to be a single chunk');
    return [text];
  }
  
  // Try to split by timestamps
  const timestampPattern = /\[\d{2}:\d{2}\]/g;
  const timestamps = text.match(timestampPattern);
  
  // If no timestamps found, use simple text chunking
  if (!timestamps || timestamps.length <= 1) {
    console.log('No timestamps found, using simple text chunking');
    return simpleTextChunking(text, chunkSize, chunkOverlap);
  }
  
  // Otherwise use timestamp-aware chunking
  console.log('Using timestamp-aware chunking');
  const segments = text.split(timestampPattern);
  
  // Reconstruct segments with their timestamps
  const lines: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    lines.push(`${timestamps[i-1]}${segments[i]}`);
  }
  
  // Now create chunks
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const line of lines) {
    if ((currentChunk + '\n' + line).length <= chunkSize) {
      currentChunk += (currentChunk ? '\n' : '') + line;
    } else {
      chunks.push(currentChunk);
      
      // Start new chunk with overlap by including the last few lines from previous chunk
      if (chunkOverlap > 0 && currentChunk.length > 0) {
        // Take the last few lines that fit within overlap size
        const lines = currentChunk.split('\n');
        let overlapText = '';
        let overlapSize = 0;
        
        for (let i = lines.length - 1; i >= 0; i--) {
          if (overlapSize + lines[i].length <= chunkOverlap) {
            overlapText = lines[i] + (overlapText ? '\n' + overlapText : '');
            overlapSize += lines[i].length;
          } else {
            break;
          }
        }
        
        currentChunk = overlapText + '\n' + line;
      } else {
        currentChunk = line;
      }
    }
  }
  
  // Add the last chunk if it's not empty
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks.length > 0 ? chunks : [text]; // Fallback to original text if no chunks created
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
  }
  
  // Add the last chunk if it exists
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
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
 * Scrape transcript directly from YouTube's webpage
 * This works around API limitations since YouTube displays transcripts on the web
 */
export const scrapeTranscriptFromYouTube = async (videoId: string): Promise<string> => {
  try {
    // First get the timedtext URL from the video page
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const response = await axios.get(videoUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    
    const html = response.data;
    
    // Extract serializedShareEntity which contains caption info
    const serializedShareEntityMatch = html.match(/"captions":\s*(\{.*?\}\s*\})/);
    if (!serializedShareEntityMatch || !serializedShareEntityMatch[1]) {
      throw new Error('No caption data found in video page');
    }
    
    try {
      // Try to extract the caption track URL
      const captionData = JSON.parse('{' + serializedShareEntityMatch[1] + '}');
      
      if (captionData && captionData.playerCaptionsTracklistRenderer && 
          captionData.playerCaptionsTracklistRenderer.captionTracks && 
          captionData.playerCaptionsTracklistRenderer.captionTracks.length > 0) {
        
        // Get the first available caption track URL
        const captionTrack = captionData.playerCaptionsTracklistRenderer.captionTracks[0];
        const captionUrl = captionTrack.baseUrl;
        
        if (captionUrl) {
          // Fetch the caption content (XML format)
          const captionResponse = await axios.get(captionUrl);
          const captionXml = captionResponse.data;
          
          // Parse XML to extract text with timestamps
          const $ = cheerio.load(captionXml, { xmlMode: true });
          const transcriptLines: string[] = [];
          
          $('text').each((i, elem) => {
            const start = parseFloat($(elem).attr('start') || '0');
            const minutes = Math.floor(start / 60);
            const seconds = Math.floor(start % 60);
            const timeCode = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
            
            const text = $(elem).text().trim();
            if (text) {
              transcriptLines.push(`${timeCode} ${text}`);
            }
          });
          
          return transcriptLines.join('\n');
        }
      }
      
      throw new Error('No caption tracks found in video data');
    } catch (parseError) {
      console.error('Error parsing caption data:', parseError);
      
      // Alternative method using regex to find caption URL directly
      const captionUrlMatch = html.match(/captionTracks.*?(https:\/\/www.youtube.com\/api\/timedtext[^"]*)/);
      if (!captionUrlMatch || !captionUrlMatch[1]) {
        throw new Error('Could not find caption URL in video page');
      }
      
      const captionUrl = captionUrlMatch[1].replace(/\\u0026/g, '&');
      
      // Fetch the caption content
      const captionResponse = await axios.get(captionUrl);
      const captionXml = captionResponse.data;
      
      // Parse XML to extract text with timestamps
      const $ = cheerio.load(captionXml, { xmlMode: true });
      const transcriptLines: string[] = [];
      
      $('text').each((i, elem) => {
        const start = parseFloat($(elem).attr('start') || '0');
        const minutes = Math.floor(start / 60);
        const seconds = Math.floor(start % 60);
        const timeCode = `[${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}]`;
        
        const text = $(elem).text().trim();
        if (text) {
          transcriptLines.push(`${timeCode} ${text}`);
        }
      });
      
      return transcriptLines.join('\n');
    }
  } catch (error) {
    console.error('Error scraping transcript from YouTube:', error);
    throw new Error(`Failed to scrape transcript: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}; 