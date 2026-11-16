import { createEmbedding } from './embedding';
import { DocumentChunk } from './chunking';
import { dbService } from '../core/database-service';
import { enhanceContent, EnhancementType } from './content-enhancement';
import { cjkRatio, getLanguageName, getVietnameseLanguageName, joinTextFragments, splitTextIntoSegments } from './language-utils';

export interface AudioTranscriptProcessingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  domains?: string[];
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  /** Detected language of the audio, e.g. 'cmn-Hans-CN' (recorded in chunk title/summary). */
  originalLanguageCode?: string;
  /** True when the text being embedded is a (Vietnamese) translation of the original audio. */
  isTranslation?: boolean;
}

/** Chunk sizes (characters). CJK text carries ~2x the tokens per character, so its chunks are smaller. */
const CHUNK_SIZES = {
  cjk: { size: 1500, overlap: 200 },
  other: { size: 4000, overlap: 500 }
};

export interface AudioTranscriptProcessingResult {
  totalChunks: number;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
  processingTime: number;
}

/**
 * Process audio transcript to create embeddings and store in vector database.
 *
 * @param audioTranscript raw transcript (original language), used only as fallback
 * @param enhancedTranscript text to embed: the Vietnamese translation when the audio was in
 *   another language, otherwise the cleaned original-language transcript
 */
export const processAudioTranscript = async (
  audioTranscript: string,
  enhancedTranscript: string | undefined,
  options: AudioTranscriptProcessingOptions
): Promise<AudioTranscriptProcessingResult> => {
  const startTime = Date.now();
  const {
    domains = ['youtube', 'audio'],
    videoId,
    videoTitle,
    videoUrl,
    originalLanguageCode,
    isTranslation = false
  } = options;

  // e.g. " (dịch từ tiếng Trung)" so Vietnamese results show where the text came from
  const translationLabel = isTranslation && originalLanguageCode
    ? ` (dịch từ ${getVietnameseLanguageName(originalLanguageCode)})`
    : '';
  // Language of the text being embedded, so the per-chunk rewrite neither translates nor mislabels it
  const contentLanguage = isTranslation
    ? 'Vietnamese'
    : originalLanguageCode ? getLanguageName(originalLanguageCode) : undefined;
  const languageNote = originalLanguageCode
    ? isTranslation
      ? ` Bản dịch tiếng Việt từ ${getVietnameseLanguageName(originalLanguageCode)} (ngôn ngữ gốc: ${originalLanguageCode}).`
      : ` Ngôn ngữ gốc: ${originalLanguageCode}.`
    : '';

  console.log(`🎵 Processing audio transcript for embedding: ${videoId}`);
  console.log(`📝 Audio transcript length: ${audioTranscript.length} characters`);
  console.log(`✨ Enhanced transcript length: ${enhancedTranscript?.length || 0} characters`);

  // Use enhanced transcript if available, otherwise use raw audio transcript.
  // Chunk-level transcription failure markers are noise for search.
  const stripMarkers = (t?: string) => (t || '').replace(/\[TRANSCRIPTION_FAILED\]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
  const transcriptToProcess = stripMarkers(enhancedTranscript) || stripMarkers(audioTranscript);

  if (!transcriptToProcess || transcriptToProcess.trim().length === 0) {
    throw new Error('No transcript content available for processing');
  }

  const sizes = cjkRatio(transcriptToProcess) >= 0.3 ? CHUNK_SIZES.cjk : CHUNK_SIZES.other;
  const chunkSize = options.chunkSize ?? sizes.size;
  const chunkOverlap = options.chunkOverlap ?? sizes.overlap;

  // Use the singleton instance of the database service
  // dbService is now imported from core

  // Check if audio transcript already exists in database
  const existingTranscript = await dbService.doesTranscriptExist(videoId);

  if (existingTranscript) {
    console.log(`⚠️ Audio transcript already exists for video ${videoId}, skipping embedding`);
    return {
      totalChunks: 0,
      videoId,
      videoUrl,
      videoTitle,
      processingTime: Date.now() - startTime
    };
  }

  // Split transcript into chunks
  console.log(`📄 Splitting audio transcript into chunks (size: ${chunkSize}, overlap: ${chunkOverlap})`);
  const chunks = splitAudioTranscriptIntoChunks(transcriptToProcess, chunkSize, chunkOverlap);

  if (chunks.length === 0) {
    throw new Error('Failed to create chunks from audio transcript');
  }

  console.log(`📦 Created ${chunks.length} chunks from audio transcript`);

  // Process chunks and create embeddings
  const documentChunks: DocumentChunk[] = [];
  const idPrefix = `youtube_${videoId}`;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`🔄 Processing chunk ${i + 1}/${chunks.length} (${chunk.length} chars)`);

    try {
      // Create base document chunk
      const baseChunk: DocumentChunk = {
        id: `${idPrefix}_chunk_${i}`,
        documentName: `${videoTitle} (Audio Transcript)`,
        content: chunk,
        embedding: [], // Will be set after enhancement
        title: `Audio Transcript Part ${i + 1} - ${videoTitle}${translationLabel}`,
        summary: `Part ${i + 1} of audio transcript for video: ${videoTitle}.${languageNote}`,
        sourceFile: videoUrl,
        domains: domains
      };

      // Enhance the chunk content if enhanced transcript is available
      let finalChunk = baseChunk;
      if (enhancedTranscript) {
        try {
          console.log(`🎨 Enhancing chunk ${i + 1} content...`);
          const enhancedChunk = await enhanceContent(baseChunk, {
            types: [EnhancementType.FORMATTING, EnhancementType.READABILITY],
            domain: domains.join(', '),
            language: contentLanguage
          });

          // Keep original content but add enhanced content
          finalChunk = {
            ...enhancedChunk,
            content: chunk, // Keep original audio transcript
            enhancedContent: enhancedChunk.enhancedContent // Use enhanced version
          };
          console.log(`✅ Enhanced chunk ${i + 1} content`);
        } catch (enhanceError) {
          console.warn(`⚠️ Failed to enhance chunk ${i + 1}, using original:`, enhanceError);
          finalChunk = baseChunk;
        }
      }

      // Generate embedding for the content (use enhanced if available, otherwise original)
      const contentForEmbedding = finalChunk.enhancedContent || finalChunk.content;
      const embedding = await createEmbedding(contentForEmbedding);
      finalChunk.embedding = embedding;

      documentChunks.push(finalChunk);
      console.log(`✅ Created embedding for chunk ${i + 1}`);

    } catch (error) {
      console.error(`❌ Failed to process chunk ${i + 1}:`, error);
      throw new Error(`Failed to create embedding for chunk ${i + 1}: ${error}`);
    }
  }

  // Store chunks in database
  console.log(`💾 Storing ${documentChunks.length} audio transcript chunks in database`);
  await dbService.addDocumentChunks(documentChunks);

  const processingTime = Date.now() - startTime;
  console.log(`✅ Audio transcript processing completed in ${processingTime}ms`);

  return {
    totalChunks: documentChunks.length,
    videoId,
    videoUrl,
    videoTitle,
    processingTime
  };
};

/**
 * Split audio transcript into chunks on sentence boundaries (handles 。！？ / .!? / newlines),
 * each chunk prefixed with the tail of the previous one as overlap.
 */
export function splitAudioTranscriptIntoChunks(
  transcript: string,
  chunkSize: number,
  chunkOverlap: number
): string[] {
  if (!transcript || transcript.trim().length === 0) {
    return [];
  }

  const overlap = Math.max(0, Math.min(chunkOverlap, Math.floor(chunkSize / 2)));
  const segments = splitTextIntoSegments(transcript, chunkSize - overlap);
  if (segments.length === 0) {
    return [transcript.trim()];
  }

  return segments
    .map((segment, index) => {
      if (index === 0 || overlap === 0) return segment;
      let tail = segments[index - 1].slice(-overlap);
      // Start the overlap at a word boundary when there is one
      const firstSpace = tail.search(/\s/);
      if (firstSpace > 0 && firstSpace < tail.length / 2) tail = tail.slice(firstSpace + 1);
      return joinTextFragments(tail.trim(), segment);
    })
    .filter(chunk => chunk.trim().length > 0);
}
