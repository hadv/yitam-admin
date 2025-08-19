import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { YtDlpVideoInfo } from './yt-dlp-downloader';
import { getTranscriptFromPublicApi, getVideoDetails } from './youtube-transcript';
import {
  transcribeVideoFile,
  isAudioTranscriptionAvailable,
  AudioTranscriptionOptions
} from './audio-transcription';
import { processAudioTranscript } from './audio-transcript-processor';

// Load environment variables
dotenv.config();

// Gemini API key for generating enhanced content
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Please add it to your .env file.');
}

/**
 * Enhanced video metadata interface
 */
export interface EnhancedVideoMetadata {
  // Original metadata from yt-dlp
  originalMetadata: YtDlpVideoInfo;
  
  // AI-enhanced metadata
  enhancedTitle: string;
  enhancedSummary: string;
  contentBasedTitle?: string;
  contentBasedSummary?: string;
  keyTopics: string[];
  contentTags: string[];
  chapters?: VideoChapter[];
  keyQuotes?: string[];

  // Enhancement metadata
  enhancementSource: 'transcript' | 'metadata' | 'combined';
  language: string;
  confidence: number;
  processingTime: number;

  // Audio transcript data
  audioTranscript?: string; // Raw audio transcript text
  enhancedTranscript?: string; // LLM-enhanced transcript (grammar fixed, cleaned up)
  transcriptWordCount?: number; // Word count for quality assessment
}

/**
 * Video chapter interface for automatic chapter detection
 */
export interface VideoChapter {
  title: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  summary: string;
}

/**
 * Options for video metadata enhancement
 */
export interface EnhancementOptions {
  includeChapters?: boolean;
  includeKeyQuotes?: boolean;
  maxKeyTopics?: number;
  maxContentTags?: number;
  temperature?: number;
  maxOutputTokens?: number;
  languagePreference?: string; // 'auto', 'en', 'vi', etc.
  useAudioTranscription?: boolean; // Enable audio-to-text transcription
  forceAudioTranscription?: boolean; // Force audio transcription even if transcript is available
  audioTranscriptionOptions?: Partial<AudioTranscriptionOptions>;
  transcriptCleaningLevel?: 'basic' | 'aggressive'; // Level of transcript cleaning
  embedAudioTranscript?: boolean; // Enable embedding audio transcript into vector database
  domains?: string[]; // Knowledge domains for categorizing the content
}

// Default enhancement options
const DEFAULT_ENHANCEMENT_OPTIONS: EnhancementOptions = {
  includeChapters: true,
  includeKeyQuotes: true,
  maxKeyTopics: 8,
  maxContentTags: 12,
  temperature: 0.3,
  maxOutputTokens: 4000,
  languagePreference: 'auto',
  useAudioTranscription: true, // Enable by default if available
  forceAudioTranscription: false, // Don't force by default
  transcriptCleaningLevel: 'aggressive', // Aggressive cleaning by default
  audioTranscriptionOptions: {
    languageCode: 'vi-VN',
    enableAutomaticPunctuation: true,
    useEnhancedModel: true
  }
};

/**
 * Main function to enhance video metadata using combined approach
 * Priority: Transcript-based enhancement -> Metadata-based enhancement
 */
export async function enhanceVideoMetadata(
  videoInfo: YtDlpVideoInfo,
  youtubeUrl: string,
  videoFilePath?: string,
  options: Partial<EnhancementOptions> = {}
): Promise<EnhancedVideoMetadata> {
  const startTime = Date.now();
  const fullOptions: EnhancementOptions = {
    ...DEFAULT_ENHANCEMENT_OPTIONS,
    ...options
  };

  console.log(`🚀 Starting video metadata enhancement for: ${videoInfo.title}`);
  console.log(`🔧 Enhancement options:`, {
    useAudioTranscription: fullOptions.useAudioTranscription,
    forceAudioTranscription: fullOptions.forceAudioTranscription,
    hasVideoFile: !!videoFilePath,
    audioTranscriptionAvailable: isAudioTranscriptionAvailable()
  });

  try {
    // Step 1: Try audio transcription if enabled and video file is available
    if (fullOptions.useAudioTranscription && videoFilePath && isAudioTranscriptionAvailable()) {
      console.log('🎵 Attempting audio transcription-based enhancement...');
      const audioResult = await tryAudioTranscriptionBasedEnhancement(
        videoInfo,
        videoFilePath,
        fullOptions,
        youtubeUrl
      );

      if (audioResult) {
        console.log('✅ Successfully enhanced using audio transcription');
        return {
          ...audioResult,
          processingTime: Date.now() - startTime
        } as EnhancedVideoMetadata;
      } else {
        console.log('❌ Audio transcription failed, will try other methods');
      }
    } else {
      console.log('⏭️ Skipping audio transcription:', {
        useAudioTranscription: fullOptions.useAudioTranscription,
        hasVideoFile: !!videoFilePath,
        audioTranscriptionAvailable: isAudioTranscriptionAvailable()
      });
    }

    // Step 2: Try transcript-based enhancement (skip if forcing audio transcription)
    if (!fullOptions.forceAudioTranscription) {
      const transcriptResult = await tryTranscriptBasedEnhancement(
        videoInfo,
        youtubeUrl,
        fullOptions
      );

      if (transcriptResult) {
        console.log('✅ Successfully enhanced using transcript-based approach');
        return {
          ...transcriptResult,
          processingTime: Date.now() - startTime
        } as EnhancedVideoMetadata;
      }
    } else {
      console.log('⏭️ Skipping transcript-based enhancement (force audio transcription enabled)');
    }

    // Step 3: Fallback to metadata-based enhancement
    console.log('📋 Falling back to metadata-based enhancement');
    const metadataResult = await metadataBasedEnhancement(videoInfo, fullOptions);

    return {
      ...metadataResult,
      processingTime: Date.now() - startTime
    };

  } catch (error) {
    console.error('❌ Error in video metadata enhancement:', error);

    // Return basic enhanced metadata as final fallback
    return createFallbackMetadata(videoInfo, Date.now() - startTime);
  }
}

/**
 * Try to enhance metadata using audio transcription
 */
async function tryAudioTranscriptionBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  videoFilePath: string,
  options: EnhancementOptions,
  youtubeUrl?: string
): Promise<Partial<EnhancedVideoMetadata> | null> {
  try {
    console.log('🎤 Attempting audio transcription-based enhancement...');
    console.log(`📁 Video file path: ${videoFilePath}`);
    console.log(`🔧 Audio transcription options:`, options.audioTranscriptionOptions);

    // Transcribe the video file
    const transcriptionResult = await transcribeVideoFile(
      videoFilePath,
      options.audioTranscriptionOptions
    );

    if (!transcriptionResult.transcript || transcriptionResult.transcript.trim().length < 100) {
      console.log('⚠️ Audio transcription too short or failed, skipping audio-based enhancement');
      return null;
    }

    console.log(`🎵 Audio transcription successful: ${transcriptionResult.wordCount} words, confidence: ${(transcriptionResult.confidence * 100).toFixed(1)}%`);

    // Detect language from transcription result
    const language = transcriptionResult.languageCode.includes('vi') ? 'Vietnamese' : 'English';
    console.log(`🌐 Detected language from audio: ${language}`);

    // Enhance the raw transcript with LLM
    console.log(`🔧 Enhancing raw transcript with LLM (${options.transcriptCleaningLevel || 'aggressive'} mode)...`);
    const enhancedTranscript = await enhanceTranscriptWithLLM(
      transcriptionResult.transcript,
      language,
      videoInfo,
      options.transcriptCleaningLevel || 'aggressive'
    );

    // Generate enhanced metadata using the enhanced transcript (better quality)
    const enhanced = await generateTranscriptBasedMetadata(
      videoInfo,
      enhancedTranscript, // Use enhanced transcript for metadata generation
      language,
      options
    );

    // Higher confidence for audio transcription as it's from actual content
    const confidence = Math.min(0.95, transcriptionResult.confidence + 0.1);

    // Process audio transcript for embedding if enabled
    if (options.embedAudioTranscript) {
      try {
        console.log('🔗 Processing audio transcript for embedding...');
        const videoId = youtubeUrl ? extractVideoIdFromUrl(youtubeUrl) : videoInfo.videoId;
        if (videoId) {
          const embeddingResult = await processAudioTranscript(
            transcriptionResult.transcript,
            enhancedTranscript,
            {
              videoId,
              videoTitle: videoInfo.title,
              videoUrl: youtubeUrl || `https://www.youtube.com/watch?v=${videoInfo.videoId}`,
              domains: options.domains || ['youtube', 'audio']
            }
          );
          console.log(`✅ Audio transcript embedded: ${embeddingResult.totalChunks} chunks created`);
        } else {
          console.warn('⚠️ Could not extract video ID for embedding');
        }
      } catch (embeddingError) {
        console.error('❌ Failed to embed audio transcript:', embeddingError);
        // Don't fail the entire process if embedding fails
      }
    }

    return {
      originalMetadata: videoInfo,
      enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
      enhancedSummary: enhanced.enhancedSummary || videoInfo.description || `Video by ${videoInfo.uploader}`,
      contentBasedTitle: enhanced.contentBasedTitle,
      contentBasedSummary: enhanced.contentBasedSummary,
      keyTopics: enhanced.keyTopics || [],
      contentTags: enhanced.contentTags || [],
      keyQuotes: enhanced.keyQuotes,
      enhancementSource: 'transcript' as const, // Audio transcription is still transcript-based
      language,
      confidence,
      audioTranscript: transcriptionResult.transcript, // Raw transcript
      enhancedTranscript: enhancedTranscript, // LLM-enhanced transcript
      transcriptWordCount: transcriptionResult.wordCount // Include word count
    };

  } catch (error: any) {
    console.log('⚠️ Audio transcription-based enhancement failed:', error.message);
    console.log('🔍 Full error details:', error);
    console.log('📊 Error stack:', error.stack);
    return null;
  }
}

/**
 * Try to enhance metadata using transcript content
 */
async function tryTranscriptBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  youtubeUrl: string,
  options: EnhancementOptions
): Promise<Partial<EnhancedVideoMetadata> | null> {
  try {
    console.log('🎬 Attempting transcript-based enhancement...');
    
    // Try to get transcript
    const transcript = await getTranscriptFromPublicApi(videoInfo.videoId);
    
    if (!transcript || transcript.trim().length < 100) {
      console.log('⚠️ Transcript too short or unavailable, skipping transcript-based enhancement');
      return null;
    }

    console.log(`📝 Transcript available (${transcript.length} characters), proceeding with transcript-based enhancement`);

    // Detect language
    const language = detectLanguage(transcript);
    console.log(`🌐 Detected language: ${language}`);

    // Generate enhanced metadata using transcript
    const enhanced = await generateTranscriptBasedMetadata(
      videoInfo,
      transcript,
      language,
      options
    );

    return {
      originalMetadata: videoInfo,
      enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
      enhancedSummary: enhanced.enhancedSummary || videoInfo.description || `Video by ${videoInfo.uploader}`,
      contentBasedTitle: enhanced.contentBasedTitle,
      contentBasedSummary: enhanced.contentBasedSummary,
      keyTopics: enhanced.keyTopics || [],
      contentTags: enhanced.contentTags || [],
      keyQuotes: enhanced.keyQuotes,
      enhancementSource: 'transcript' as const,
      language,
      confidence: 0.9
    };

  } catch (error: any) {
    console.log('⚠️ Transcript-based enhancement failed:', error.message);
    return null;
  }
}

/**
 * Enhance metadata using only yt-dlp metadata (fallback approach)
 */
async function metadataBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  options: EnhancementOptions
): Promise<EnhancedVideoMetadata> {
  console.log('📊 Performing metadata-based enhancement...');

  // Detect language from title and description
  const language = detectLanguage(videoInfo.title + ' ' + videoInfo.description);
  
  // Generate enhanced metadata using only available metadata
  const enhanced = await generateMetadataBasedEnhancement(
    videoInfo,
    language,
    options
  );

  // Lower confidence for metadata-only enhancement, especially if description is poor
  const hasGoodDescription = videoInfo.description && videoInfo.description.length > 50;
  const confidence = hasGoodDescription ? 0.4 : 0.2; // Reduced from 0.6

  return {
    originalMetadata: videoInfo,
    enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
    enhancedSummary: enhanced.enhancedSummary || `Video by ${videoInfo.uploader}. Limited information available from metadata only.`,
    keyTopics: enhanced.keyTopics || [],
    contentTags: enhanced.contentTags || [],
    enhancementSource: 'metadata' as const,
    language,
    confidence,
    processingTime: 0 // Will be set by the caller
  };
}

/**
 * Generate enhanced metadata using transcript content
 */
async function generateTranscriptBasedMetadata(
  videoInfo: YtDlpVideoInfo,
  transcript: string,
  language: string,
  options: EnhancementOptions
): Promise<Partial<EnhancedVideoMetadata>> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for transcript-based enhancement');
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  // Truncate transcript if too long (keep first 8000 chars for context)
  const transcriptSample = transcript.length > 8000 
    ? transcript.substring(0, 8000) + "..." 
    : transcript;

  const prompt = buildTranscriptEnhancementPrompt(
    videoInfo,
    transcriptSample,
    language,
    options
  );

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    }
  });

  const responseText = result.response.text().trim();
  return parseEnhancementResponse(responseText, 'transcript');
}

/**
 * Generate enhanced metadata using only video metadata
 */
async function generateMetadataBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  language: string,
  options: EnhancementOptions
): Promise<Partial<EnhancedVideoMetadata>> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for metadata-based enhancement');
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

  const prompt = buildMetadataEnhancementPrompt(videoInfo, language, options);

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens,
    }
  });

  const responseText = result.response.text().trim();
  return parseEnhancementResponse(responseText, 'metadata');
}

/**
 * Build prompt for transcript-based enhancement
 */
function buildTranscriptEnhancementPrompt(
  videoInfo: YtDlpVideoInfo,
  transcript: string,
  language: string,
  options: EnhancementOptions
): string {
  return `You are analyzing a YouTube video with both metadata and transcript content. Generate enhanced metadata in ${language}.

VIDEO METADATA:
- Original Title: ${videoInfo.title}
- Description: ${videoInfo.description}
- Duration: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}
- Uploader: ${videoInfo.uploader}
- Upload Date: ${videoInfo.uploadDate}

TRANSCRIPT CONTENT:
${transcript}

Please generate the following in ${language}:

1. ENHANCED_TITLE: A more descriptive and engaging title (max 80 characters)
2. ENHANCED_SUMMARY: A comprehensive summary of the video content (max 300 words)
3. CONTENT_TITLE: A title based purely on the actual content discussed (max 80 characters)
4. CONTENT_SUMMARY: A summary of the key points from the transcript (max 200 words)
5. KEY_TOPICS: ${options.maxKeyTopics} main topics/themes (comma-separated)
6. CONTENT_TAGS: ${options.maxContentTags} relevant tags for categorization (comma-separated)
${options.includeKeyQuotes ? '7. KEY_QUOTES: 3-5 important quotes or statements from the video (one per line)' : ''}

Format your response exactly as:
ENHANCED_TITLE: [title]
ENHANCED_SUMMARY: [summary]
CONTENT_TITLE: [content-based title]
CONTENT_SUMMARY: [content-based summary]
KEY_TOPICS: [topic1, topic2, topic3, ...]
CONTENT_TAGS: [tag1, tag2, tag3, ...]
${options.includeKeyQuotes ? 'KEY_QUOTES:\n- [quote1]\n- [quote2]\n- [quote3]' : ''}`;
}

/**
 * Build prompt for metadata-only enhancement
 */
function buildMetadataEnhancementPrompt(
  videoInfo: YtDlpVideoInfo,
  language: string,
  options: EnhancementOptions
): string {
  return `You are analyzing YouTube video metadata to generate enhanced descriptions. Generate all content in ${language}.

IMPORTANT: You only have access to basic metadata (title, description, uploader). DO NOT invent or assume specific content details that are not explicitly mentioned in the metadata. If information is unclear, acknowledge the limitation.

VIDEO METADATA:
- Title: ${videoInfo.title}
- Description: ${videoInfo.description}
- Duration: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}
- Uploader: ${videoInfo.uploader}
- Upload Date: ${videoInfo.uploadDate}
- View Count: ${videoInfo.viewCount.toLocaleString()}

Please generate the following in ${language}, based ONLY on the provided metadata:

1. ENHANCED_TITLE: A clearer version of the title without adding unverified details (max 80 characters)
2. ENHANCED_SUMMARY: A summary based strictly on available metadata, acknowledging limitations (max 200 words)
3. KEY_TOPICS: ${options.maxKeyTopics} topics that can be reasonably inferred from title and description only (comma-separated)
4. CONTENT_TAGS: ${options.maxContentTags} tags based on explicit metadata only (comma-separated)

If the metadata is insufficient to determine specific content, mention this limitation in your summary.

Format your response exactly as:
ENHANCED_TITLE: [title]
ENHANCED_SUMMARY: [summary]
KEY_TOPICS: [topic1, topic2, topic3, ...]
CONTENT_TAGS: [tag1, tag2, tag3, ...]`;
}

/**
 * Parse the AI response and extract structured data
 */
function parseEnhancementResponse(
  responseText: string,
  source: 'transcript' | 'metadata'
): Partial<EnhancedVideoMetadata> {
  const result: Partial<EnhancedVideoMetadata> = {
    keyTopics: [],
    contentTags: [],
    keyQuotes: []
  };

  // Extract enhanced title
  const enhancedTitleMatch = responseText.match(/ENHANCED_TITLE:\s*(.*?)(?=\n|$)/i);
  if (enhancedTitleMatch) {
    result.enhancedTitle = enhancedTitleMatch[1].trim();
  }

  // Extract enhanced summary
  const enhancedSummaryMatch = responseText.match(/ENHANCED_SUMMARY:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (enhancedSummaryMatch) {
    result.enhancedSummary = enhancedSummaryMatch[1].trim();
  }

  // Extract content-based title (only for transcript source)
  if (source === 'transcript') {
    const contentTitleMatch = responseText.match(/CONTENT_TITLE:\s*(.*?)(?=\n|$)/i);
    if (contentTitleMatch) {
      result.contentBasedTitle = contentTitleMatch[1].trim();
    }

    const contentSummaryMatch = responseText.match(/CONTENT_SUMMARY:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
    if (contentSummaryMatch) {
      result.contentBasedSummary = contentSummaryMatch[1].trim();
    }
  }

  // Extract key topics
  const keyTopicsMatch = responseText.match(/KEY_TOPICS:\s*(.*?)(?=\n|$)/i);
  if (keyTopicsMatch) {
    result.keyTopics = keyTopicsMatch[1]
      .split(',')
      .map(topic => topic.trim())
      .filter(topic => topic.length > 0);
  }

  // Extract content tags
  const contentTagsMatch = responseText.match(/CONTENT_TAGS:\s*(.*?)(?=\n|$)/i);
  if (contentTagsMatch) {
    result.contentTags = contentTagsMatch[1]
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
  }

  // Extract key quotes (only for transcript source)
  if (source === 'transcript') {
    const keyQuotesMatch = responseText.match(/KEY_QUOTES:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
    if (keyQuotesMatch) {
      result.keyQuotes = keyQuotesMatch[1]
        .split('\n')
        .map(quote => quote.replace(/^-\s*/, '').trim())
        .filter(quote => quote.length > 0);
    }
  }

  return result;
}

/**
 * Enhance raw transcript using LLM - fix grammar, slang, improve readability
 */
async function enhanceTranscriptWithLLM(
  rawTranscript: string,
  language: string,
  videoInfo: YtDlpVideoInfo,
  cleaningLevel: 'basic' | 'aggressive' = 'aggressive'
): Promise<string> {
  if (!GEMINI_API_KEY) {
    console.log('⚠️ No Gemini API key, returning raw transcript');
    return rawTranscript;
  }

  try {
    console.log('🔧 Enhancing transcript with LLM...');

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // Build prompt based on cleaning level
    const isAggressive = cleaningLevel === 'aggressive';

    const basePrompt = `You are a professional transcript editor. Clean and improve this raw audio transcript.

VIDEO CONTEXT:
- Title: ${videoInfo.title}
- Channel: ${videoInfo.uploader}
- Duration: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}

RAW TRANSCRIPT:
${rawTranscript}

Please provide the cleaned transcript in ${language}.`;

    const aggressiveInstructions = `
AGGRESSIVE CLEANING - Remove completely:
1. Filler words: "um", "uh", "er", "ah", Vietnamese equivalents
2. Profanity and inappropriate language
3. Unnecessary exclamations and interjections
4. Irrelevant small talk (greetings, weather, personal matters)
5. Channel promotion content (like, subscribe) unless it's main content
6. Off-topic conversations unrelated to main subject

IMPROVEMENTS:
- Fix grammar and spelling errors
- Replace slang with proper language
- Add proper punctuation and capitalization
- Improve sentence structure while preserving meaning
- Keep only core content directly related to main topic
- Make result concise and focused`;

    const basicInstructions = `
BASIC CLEANING:
- Fix grammar and spelling errors
- Replace slang with proper language
- Add proper punctuation and capitalization
- Remove basic filler words: "um", "uh", "er"
- Improve sentence structure while preserving meaning
- Keep most of the original content`;

    const prompt = basePrompt + (isAggressive ? aggressiveInstructions : basicInstructions);

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000,
      }
    });

    const enhancedTranscript = result.response.text().trim();
    console.log('✅ Transcript enhanced successfully');

    return enhancedTranscript;

  } catch (error: any) {
    console.error('❌ Transcript enhancement failed:', error.message);
    console.log('⚠️ Returning raw transcript as fallback');
    return rawTranscript;
  }
}

/**
 * Detect language from text content
 */
function detectLanguage(text: string): string {
  // Basic language detection (check for Vietnamese-specific characters)
  const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(text);
  return hasVietnameseChars ? 'Vietnamese' : 'English';
}

/**
 * Audio-only enhancement - ONLY uses audio transcription, no fallbacks
 */
export async function enhanceVideoMetadataAudioOnly(
  videoInfo: YtDlpVideoInfo,
  videoFilePath: string,
  options: Partial<EnhancementOptions> = {},
  youtubeUrl?: string
): Promise<EnhancedVideoMetadata> {
  const startTime = Date.now();
  const fullOptions: EnhancementOptions = {
    ...DEFAULT_ENHANCEMENT_OPTIONS,
    ...options,
    useAudioTranscription: true,
    forceAudioTranscription: true
  };

  console.log(`🎵 AUDIO-ONLY enhancement for: ${videoInfo.title}`);
  console.log(`📁 Video file: ${videoFilePath}`);

  if (!isAudioTranscriptionAvailable()) {
    throw new Error('Audio transcription is not available. Please configure Google Speech-to-Text API.');
  }

  try {
    console.log('🔥 FORCING audio transcription (no fallbacks)...');
    const audioResult = await tryAudioTranscriptionBasedEnhancement(
      videoInfo,
      videoFilePath,
      fullOptions,
      youtubeUrl
    );

    if (audioResult) {
      console.log('✅ Audio-only enhancement successful');
      return {
        ...audioResult,
        processingTime: Date.now() - startTime
      } as EnhancedVideoMetadata;
    } else {
      throw new Error('Audio transcription failed - no fallback in audio-only mode');
    }

  } catch (error: any) {
    console.error('❌ Audio-only enhancement failed:', error.message);
    throw new Error(`Audio-only enhancement failed: ${error.message}`);
  }
}

/**
 * Extract YouTube video ID from URL
 */
function extractVideoIdFromUrl(url: string): string | null {
  if (!url) return null;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Create fallback metadata when all enhancement attempts fail
 */
function createFallbackMetadata(
  videoInfo: YtDlpVideoInfo,
  processingTime: number
): EnhancedVideoMetadata {
  return {
    originalMetadata: videoInfo,
    enhancedTitle: videoInfo.title,
    enhancedSummary: videoInfo.description || `Video by ${videoInfo.uploader} uploaded on ${videoInfo.uploadDate}`,
    keyTopics: [],
    contentTags: [],
    enhancementSource: 'metadata' as const,
    language: detectLanguage(videoInfo.title + ' ' + videoInfo.description),
    confidence: 0.3,
    processingTime
  };
}
