import { getTranscript } from 'youtube-transcript-api';
import { createEmbedding } from './embedding';
import { GoogleGenerativeAI } from '@google/generative-ai';
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
  chunkSize: number = 4000,
  chunkOverlap: number = 500,
  userId?: string,
  accessToken?: string
): Promise<any[]> => {
  try {
    // Get video details
    const videoDetails = await getVideoDetails(videoId);
    let transcript = '';
    let errors: string[] = [];
    
    // Try direct web scraping first as the most reliable method
    try {
      console.log('Attempting to get transcript using web scraping (primary method)');
      transcript = await scrapeTranscriptFromYouTube(videoId);
      console.log(`Successfully retrieved transcript via web scraping with length: ${transcript.length} characters`);
    } catch (error: any) {
      const errorMsg = `Web scraping (primary method) failed: ${error.message}`;
      console.log(errorMsg + '. Falling back to API methods');
      errors.push(errorMsg);
      
      // If web scraping fails, proceed with API methods
      // Attempt to get the transcript using API methods
      if (userId) {
        // Try OAuth if a userId is provided
        try {
          console.log('Attempting to get transcript using OAuth authentication');
          transcript = await getYouTubeTranscriptWithOAuth(videoId, userId);
          console.log('Successfully retrieved transcript via OAuth');
        } catch (error: any) {
          const errorMsg = `OAuth method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
        }
      }
      
      // Try direct access token if provided and previous methods failed
      if (!transcript && accessToken) {
        try {
          console.log('Attempting to get transcript using direct access token');
          transcript = await getTranscriptWithDirectToken(videoId, accessToken);
          console.log('Successfully retrieved transcript via direct token');
        } catch (error: any) {
          const errorMsg = `Direct token method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
        }
      }
      
      // If we still don't have a transcript, try API list method
      if (!transcript && accessToken) {
        try {
          console.log('Attempting to get transcript using API list method');
          transcript = await getTranscriptWithApiList(videoId, accessToken);
          console.log('Successfully retrieved transcript via API list method');
        } catch (error: any) {
          const errorMsg = `API list method failed: ${error.message}`;
          console.log(errorMsg + '. Trying next method');
          errors.push(errorMsg);
        }
      }
      
      // Try public API approach with youtube-transcript-api
      if (!transcript) {
        try {
          console.log('Attempting to get transcript using YouTube transcript API');
          const transcriptItems = await getAutoGeneratedTranscript(videoId);
          transcript = transcriptItems.map(item => `[${Math.floor(item.offset / 60000)}:${Math.floor((item.offset % 60000) / 1000)}] ${item.text}`).join('\n');
          console.log(`Successfully retrieved transcript with ${transcriptItems.length} items using YouTube transcript API`);
        } catch (error: any) {
          const errorMsg = `YouTube transcript API failed: ${error.message}`;
          console.log(errorMsg);
          errors.push(errorMsg);
          
          // If all methods have failed, throw a detailed error
          if (!transcript) {
            throw new Error(`All transcript retrieval methods failed for video ${videoId}. Errors: ${errors.join(' | ')}`);
          }
        }
      }
    }
    
    if (!transcript || transcript.trim().length === 0) {
      throw new Error('Failed to retrieve transcript: All methods returned empty results');
    }
    
    console.log(`Successfully retrieved transcript with length: ${transcript.length} characters`);
    
    // Include video title in documentName for better readability
    // But keep a consistent id format for duplicate checking
    const documentName = videoDetails.title;
    const idPrefix = `youtube_${videoId}`;
    
    // Split the text into chunks
    const chunks = splitTextIntoChunks(transcript, chunkSize, chunkOverlap);
    
    if (chunks.length === 0) {
      throw new Error('Failed to create text chunks from transcript');
    }
    
    console.log(`Split transcript into ${chunks.length} chunks`);
    
    // Process each chunk
    const documentChunks: DocumentChunk[] = [];
    
    // Try to detect the language of the transcript for AI generation
    const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(transcript);
    const detectedLanguage = hasVietnameseChars ? 'Vietnamese' : 'English';
    
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      console.log(`Processing chunk ${i+1}/${chunks.length}, length: ${content.length} characters`);
      
      // Create embedding for the chunk
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
        const aiEnhancedMetadata = await generateTitleAndSummary(cleanContent, videoDetails.title, i+1, chunks.length, detectedLanguage);
        
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
  // If text is short enough, just return it as a single chunk
  if (text.length <= chunkSize) {
    console.log('Text is short enough to be a single chunk');
    return [text];
  }
  
  // Try to split by timestamps - this is the YouTube specific format
  const timestampPattern = /\[\d{2}:\d{2}\]/g;
  const timestamps = text.match(timestampPattern);
  
  // If no timestamps found, use simple text chunking
  if (!timestamps || timestamps.length <= 1) {
    console.log('No timestamps found, using simple text chunking');
    return simpleTextChunking(text, chunkSize, chunkOverlap);
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
    if ((currentChunk + '\n' + line).length > chunkSize && timestampCount >= 5) {
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
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
    
    const html = response.data;
    
    // Try different regex patterns to locate caption data
    let captionData;
    let captionUrl;
    
    // Pattern 1: Try to find the newer format of caption data
    const newPatternMatch = html.match(/\{"captionTracks":(\[.*?\])/);
    if (newPatternMatch && newPatternMatch[1]) {
      try {
        const captionTracksJson = JSON.parse(newPatternMatch[1]);
        if (captionTracksJson && captionTracksJson.length > 0) {
          captionUrl = captionTracksJson[0].baseUrl;
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
      }
    }
    
    if (!captionUrl) {
      throw new Error('Could not find caption URL in video page. The video may not have captions enabled.');
    }
    
    console.log(`Found caption URL: ${captionUrl}`);
    
    // Fetch the caption content (XML format)
    const captionResponse = await axios.get(captionUrl);
    const captionXml = captionResponse.data;
    
    if (!captionXml || captionXml.length < 10) {
      throw new Error('Received empty caption data from YouTube');
    }
    
    // Parse XML to extract text with timestamps
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
      throw new Error('No transcript lines found after parsing caption data');
    }
    
    return transcriptLines.join('\n');
  } catch (error) {
    console.error('Error scraping transcript from YouTube:', error);
    throw new Error(`Failed to scrape transcript: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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