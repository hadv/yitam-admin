import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';
import path from 'path';

// Load .env file from the project root
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Qdrant configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10);

// Flag to prevent duplicate embedding error warnings
let embeddingErrorWarningLogged = false;

/**
 * Generate an embedding vector for the provided text
 * 
 * Uses Qdrant's built-in FastEmbed capability
 * 
 * @param text The text to generate an embedding for
 * @returns A vector representation of the text
 */
export const createEmbedding = async (text: string): Promise<number[]> => {
  try {
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
    
    // Reset error flag if successful
    embeddingErrorWarningLogged = false;
    
    return response.data.embedding;
  } catch (error) {
    return handleEmbeddingError(error, text.length);
  }
};

/**
 * Handle errors during embedding generation with proper categorization and logging
 */
function handleEmbeddingError(error: any, textLength: number): number[] {
  // Determine error type and handle accordingly
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    
    // Handle connection errors (e.g., Qdrant not running)
    if (axiosError.code === 'ECONNREFUSED' || !axiosError.response) {
      if (!embeddingErrorWarningLogged) {
        console.warn('Cannot connect to Qdrant for embedding generation.');
        console.warn(`Ensure Qdrant is running at ${QDRANT_URL} with FastEmbed support.`);
        console.warn('Using random vector fallback for embeddings.');
        embeddingErrorWarningLogged = true;
      } else {
        console.debug('Still unable to connect to Qdrant embedding service. Using fallback.');
      }
    } 
    // Handle API errors (e.g., bad request, authentication, etc.)
    else if (axiosError.response) {
      const status = axiosError.response.status;
      if (status === 401 || status === 403) {
        console.error('Authentication error connecting to Qdrant embedding service. Check your API key.');
      } else if (status === 404) {
        console.error('Embedding endpoint not found. Ensure your Qdrant version supports FastEmbed.');
      } else if (status >= 400 && status < 500) {
        console.error(`Client error (${status}) when requesting embeddings:`, axiosError.response.data);
      } else if (status >= 500) {
        console.error(`Server error (${status}) from embedding service.`);
      }
      
      if (!embeddingErrorWarningLogged) {
        console.warn('Using random vector fallback for embeddings due to API error.');
        embeddingErrorWarningLogged = true;
      }
    }
  } else {
    // Handle non-Axios errors
    console.error('Unexpected error during embedding generation:', error);
    
    if (!embeddingErrorWarningLogged) {
      console.warn('Using random vector fallback for embeddings due to unexpected error.');
      embeddingErrorWarningLogged = true;
    }
  }
  
  // Log information about text being embedded to help debugging
  console.debug(`Generated fallback embedding for text of length ${textLength}.`);
  
  // Fall back to mock implementation in case of errors
  return Array.from({ length: VECTOR_SIZE }, () => Math.random() - 0.5);
}

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