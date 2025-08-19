import { createEmbedding } from './embedding';
import { DocumentChunk } from './chunking';
import { DatabaseService } from '../core/database-service';
import { enhanceContent, EnhancementType } from './content-enhancement';

export interface AudioTranscriptProcessingOptions {
  chunkSize?: number;
  chunkOverlap?: number;
  domains?: string[];
  videoId: string;
  videoTitle: string;
  videoUrl: string;
}

export interface AudioTranscriptProcessingResult {
  totalChunks: number;
  videoId: string;
  videoUrl: string;
  videoTitle: string;
  processingTime: number;
}

/**
 * Process audio transcript to create embeddings and store in vector database
 */
export const processAudioTranscript = async (
  audioTranscript: string,
  enhancedTranscript: string | undefined,
  options: AudioTranscriptProcessingOptions
): Promise<AudioTranscriptProcessingResult> => {
  const startTime = Date.now();
  const {
    chunkSize = 4000,
    chunkOverlap = 500,
    domains = ['youtube', 'audio'],
    videoId,
    videoTitle,
    videoUrl
  } = options;

  console.log(`🎵 Processing audio transcript for embedding: ${videoId}`);
  console.log(`📝 Audio transcript length: ${audioTranscript.length} characters`);
  console.log(`✨ Enhanced transcript length: ${enhancedTranscript?.length || 0} characters`);

  // Use enhanced transcript if available, otherwise use raw audio transcript
  const transcriptToProcess = enhancedTranscript || audioTranscript;
  
  if (!transcriptToProcess || transcriptToProcess.trim().length === 0) {
    throw new Error('No transcript content available for processing');
  }

  // Initialize database service
  const dbService = new DatabaseService();
  await dbService.initialize();

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
        title: `Audio Transcript Part ${i + 1} - ${videoTitle}`,
        summary: `Part ${i + 1} of audio transcript for video: ${videoTitle}`,
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
            domain: domains.join(', ')
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
 * Split audio transcript into chunks
 */
function splitAudioTranscriptIntoChunks(
  transcript: string,
  chunkSize: number,
  chunkOverlap: number
): string[] {
  if (!transcript || transcript.trim().length === 0) {
    return [];
  }

  const chunks: string[] = [];
  const sentences = transcript.split(/[.!?]+/).filter(s => s.trim().length > 0);
  
  if (sentences.length === 0) {
    return [transcript];
  }

  let currentChunk = '';
  
  for (const sentence of sentences) {
    const trimmedSentence = sentence.trim();
    if (!trimmedSentence) continue;

    const potentialChunk = currentChunk + (currentChunk ? '. ' : '') + trimmedSentence;
    
    if (potentialChunk.length <= chunkSize) {
      currentChunk = potentialChunk;
    } else {
      // Current chunk is full, save it and start new one
      if (currentChunk) {
        chunks.push(currentChunk + '.');
      }
      
      // Handle overlap by including last part of previous chunk
      if (chunkOverlap > 0 && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        const overlapText = lastChunk.slice(-chunkOverlap);
        currentChunk = overlapText + ' ' + trimmedSentence;
      } else {
        currentChunk = trimmedSentence;
      }
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk.trim()) {
    chunks.push(currentChunk + '.');
  }
  
  return chunks.filter(chunk => chunk.trim().length > 0);
}
