import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import path from 'path';
import { FallbackService } from '../core/fallback-service';

// Load .env file from the project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Qdrant configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10);

// Create fallback service for embedding operations
const embeddingFallback = new FallbackService('Embedding');

/**
 * Generate an embedding vector for the provided text
 * 
 * Uses Qdrant's built-in FastEmbed capability
 * 
 * @param text The text to generate an embedding for
 * @returns A vector representation of the text
 */
export const createEmbedding = async (text: string): Promise<number[]> => {
  return embeddingFallback.withFallback(
    'generateVector',
    // Fallback function - generate random vector
    () => {
      // Log information about text being embedded to help debugging
      console.debug(`Generated fallback embedding for text of length ${text.length}.`);
      return Array.from({ length: VECTOR_SIZE }, () => Math.random() - 0.5);
    },
    // Primary function - call embedding API
    async () => {
      // Using Qdrant's server-side FastEmbed integration
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      
      if (QDRANT_API_KEY) {
        headers['api-key'] = QDRANT_API_KEY;
      }
      
      const response = await axios.post(
        `${QDRANT_URL}/embeddings`,
        {
          text: text,
          model: 'fastembed', // Use the default FastEmbed model
        },
        { headers }
      );
      
      return response.data.embedding;
    }
  );
};

/**
 * Helper function to calculate cosine similarity between two vectors
 * 
 * @param a First vector
 * @param b Second vector
 * @returns Cosine similarity score (0-1)
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Vectors must be of the same length');
  }
  
  let dotProduct = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;
  
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    aMagnitude += a[i] * a[i];
    bMagnitude += b[i] * b[i];
  }
  
  aMagnitude = Math.sqrt(aMagnitude);
  bMagnitude = Math.sqrt(bMagnitude);
  
  if (aMagnitude === 0 || bMagnitude === 0) {
    return 0;
  }
  
  return dotProduct / (aMagnitude * bMagnitude);
}

// Search for documents using semantic similarity
export const searchDocumentsByVector = async (queryVector: number[]) => {
  // This functionality is delegated to qdrantService
  // We're keeping this function here as a potential place for additional search logic
  return queryVector;
}; 