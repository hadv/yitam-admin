import dotenv from 'dotenv';
import { FallbackService } from '../core/fallback-service';
import { GoogleGenerativeAI, TaskType } from '@google/generative-ai';

// Load .env file from the server directory
dotenv.config();

// Gemini configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Please add it to your .env file.');
}

const GEMINI_VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10);

// Create fallback service for embedding operations
const embeddingFallback = new FallbackService('Embedding');

/**
 * Generate an embedding vector for the provided text
 * 
 * Uses Google's Gemini for embeddings
 * 
 * @param text The text to generate an embedding for
 * @param taskType TaskType enum value for the embedding purpose
 * @returns A vector representation of the text
 */
export const createEmbedding = async (
  text: string, 
  taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT
): Promise<number[]> => {
  return embeddingFallback.withFallback(
    'generateVector',
    // Fallback function - generate random vector
    () => {
      // Log information about text being embedded to help debugging
      console.debug(`Generated fallback embedding for text of length ${text.length}.`);
      return Array.from({ length: GEMINI_VECTOR_SIZE }, () => Math.random() - 0.5);
    },
    // Primary function - call Gemini embedding API
    async () => {
      return generateGeminiEmbedding(text, taskType);
    },
    embeddingFallback.isFallbackActive()
  );
};

/**
 * Generate embedding using Google's Gemini API
 * 
 * @param text Text to generate embedding for
 * @param taskType Task type from TaskType enum
 * @returns Vector representation of the text
 */
async function generateGeminiEmbedding(
  text: string, 
  taskType: TaskType
): Promise<number[]> {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
  }

  // Gemini has a payload size limit of ~32KB
  // Chunk the text if it's too large (approximately 10K characters to be safe)
  const MAX_CHUNK_SIZE = 10000;
  
  if (text.length <= MAX_CHUNK_SIZE) {
    // Text is small enough to process as a single chunk
    return processTextChunk(text, taskType);
  } else {
    console.log(`Text is too large (${text.length} chars), chunking into smaller pieces...`);
    
    // Chunk by paragraphs or sentences to maintain context
    const chunks = chunkText(text, MAX_CHUNK_SIZE);
    console.log(`Created ${chunks.length} chunks`);
    
    if (chunks.length === 0) return []; // Shouldn't happen
    
    if (chunks.length === 1) {
      return processTextChunk(chunks[0], taskType);
    }
    
    // For multiple chunks, we'll use the average of all chunk embeddings
    // This is a simple approach - more sophisticated approaches could weight key sections
    const chunkEmbeddings = await Promise.all(
      chunks.map(chunk => processTextChunk(chunk, taskType))
    );
    
    // Average the embeddings
    const embeddingSize = chunkEmbeddings[0].length;
    const averageEmbedding = new Array(embeddingSize).fill(0);
    
    for (const embedding of chunkEmbeddings) {
      for (let i = 0; i < embeddingSize; i++) {
        averageEmbedding[i] += embedding[i] / chunks.length;
      }
    }
    
    return averageEmbedding;
  }
  
  // Helper function to process a single text chunk
  async function processTextChunk(chunk: string, chunkTaskType: TaskType): Promise<number[]> {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const embeddingModel = genAI.getGenerativeModel({ model: "embedding-001" });
    
    // Create properly formatted request object with TaskType enum
    // This format works with the Gemini API to properly specify the embedding use case
    const result = await embeddingModel.embedContent({
      content: {
        parts: [{ text: chunk }],
        role: "user"
      },
      taskType: chunkTaskType
    });
    
    return result.embedding.values;
  }
}

/**
 * Split text into chunks that don't exceed the maximum size
 * Tries to split on paragraph boundaries first, then sentences if needed
 */
export function chunkText(text: string, maxChunkSize: number): string[] {
  // Split by paragraphs first (double newlines)
  const paragraphs = text.split(/\n\s*\n/);
  
  const chunks: string[] = [];
  let currentChunk = '';
  
  for (const paragraph of paragraphs) {
    // If a single paragraph is too big, we'll need to split by sentences
    if (paragraph.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      
      // Split by sentences (period + space or newline)
      const sentences = paragraph.split(/\.\s+|\.\n/);
      
      for (const sentence of sentences) {
        // Skip empty sentences
        if (!sentence || sentence.trim() === '') continue;
        
        if (sentence.length > maxChunkSize) {
          // If even a sentence is too long, split by word boundaries
          const words = sentence.split(/\s+/).filter(word => word.trim() !== '');
          let sentenceChunk = '';
          
          for (const word of words) {
            if ((sentenceChunk + ' ' + word).length <= maxChunkSize) {
              sentenceChunk += (sentenceChunk ? ' ' : '') + word;
            } else {
              if (sentenceChunk) chunks.push(sentenceChunk);
              sentenceChunk = word;
            }
          }
          
          if (sentenceChunk) chunks.push(sentenceChunk);
        } else {
          // Sentence fits in a chunk
          if ((currentChunk + '. ' + sentence).length <= maxChunkSize) {
            currentChunk += (currentChunk ? '. ' : '') + sentence;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = sentence;
          }
        }
      }
    } else {
      // Paragraph fits in a chunk
      if ((currentChunk + '\n\n' + paragraph).length <= maxChunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = paragraph;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
} 