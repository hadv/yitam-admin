import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { FallbackService } from '../core/fallback-service';

dotenv.config();

// Qdrant configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10); // Default fastembed vector size

// In-memory storage for fallback when Qdrant is not available
const inMemoryDocuments = new Map<string, { document: DocumentMetadata, vector: number[] }>();

// Create Qdrant client
const qdrantClient = new QdrantClient({ url: QDRANT_URL });

// Create fallback service
const fallbackService = new FallbackService('Qdrant');

// Initialize Qdrant and create collection if it doesn't exist
export const initializeQdrant = async () => {
  try {
    // Check if collection exists
    const collections = await qdrantClient.getCollections();
    const collectionExists = collections.collections?.some(
      (collection) => collection.name === COLLECTION_NAME
    );

    if (!collectionExists) {
      console.log(`Creating Qdrant collection: ${COLLECTION_NAME}`);
      
      // Create collection
      await qdrantClient.createCollection(COLLECTION_NAME, {
        vectors: {
          size: VECTOR_SIZE,
          distance: 'Cosine'
        }
      });
      
      // Create payload index for filename
      await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'filename',
        field_schema: 'keyword'
      });
      
      // Create payload index for uploadedAt
      await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
        field_name: 'uploadedAt',
        field_schema: 'keyword'
      });
    }
    
    fallbackService.resetWarningFlag('initialize');
    console.log('Qdrant initialized successfully');
  } catch (error) {
    fallbackService.handleError('initialize', error);
  }
};

// Add a document with its vector embedding to Qdrant
export const addDocumentToQdrant = async (document: DocumentMetadata, embedding: number[]) => {
  return fallbackService.withFallback(
    'addDocument',
    // Fallback function
    () => {
      inMemoryDocuments.set(document.id, { document, vector: embedding });
      return document;
    },
    // Primary function
    async () => {
      const payload = {
        id: document.id,
        filename: document.filename,
        path: document.path,
        contentType: document.contentType,
        uploadedAt: document.uploadedAt,
        preview: document.preview
      };

      await qdrantClient.upsert(COLLECTION_NAME, {
        wait: true,
        points: [
          {
            id: document.id,
            vector: embedding,
            payload
          }
        ]
      });
      
      return document;
    },
    fallbackService.isFallbackActive()
  );
};

// Helper function to calculate cosine similarity for in-memory fallback
const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;
  
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
  
  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dotProduct / (aMagnitude * bMagnitude);
};

// Search for documents using vector similarity
export const searchDocumentsByVector = async (queryVector: number[], limit = 5) => {
  return fallbackService.withFallback(
    'searchDocuments',
    // Fallback function
    () => {
      // In-memory similarity search
      const results = Array.from(inMemoryDocuments.values())
        .map(item => ({
          ...item.document,
          score: cosineSimilarity(queryVector, item.vector)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      
      return results;
    },
    // Primary function
    async () => {
      const searchResult = await qdrantClient.search(COLLECTION_NAME, {
        vector: queryVector,
        limit,
        with_payload: true
      });
      
      return searchResult.map(hit => {
        const payload = hit.payload as unknown as DocumentMetadata;
        return {
          ...payload,
          score: hit.score
        };
      });
    },
    fallbackService.isFallbackActive()
  );
};

// Get all documents
export const getAllDocuments = async () => {
  return fallbackService.withFallback(
    'getAllDocuments',
    // Fallback function
    () => {
      return Array.from(inMemoryDocuments.values()).map(item => item.document);
    },
    // Primary function
    async () => {
      const result = await qdrantClient.scroll(COLLECTION_NAME, {
        with_payload: true,
        limit: 100
      });
      
      if (!result.points) {
        return [];
      }
      
      return result.points.map(point => {
        const payload = point.payload as unknown as DocumentMetadata;
        return payload;
      });
    },
    fallbackService.isFallbackActive()
  );
};

// Delete a document
export const deleteDocumentFromQdrant = async (id: string) => {
  return fallbackService.withFallback(
    'deleteDocument',
    // Fallback function
    () => {
      inMemoryDocuments.delete(id);
      return true;
    },
    // Primary function
    async () => {
      await qdrantClient.delete(COLLECTION_NAME, {
        wait: true,
        points: [id]
      });
      
      return true;
    },
    fallbackService.isFallbackActive()
  );
};

/**
 * Force a retry of the primary database connection
 * Useful for manual recovery after fixing connection issues
 */
export const forceRetryPrimary = (): void => {
  fallbackService.forceRetryPrimary();
  console.log('Forcing retry of primary Qdrant connection on next operation');
};

// Document metadata interface
export interface DocumentMetadata {
  id: string;
  filename: string;
  path: string;
  contentType: string;
  uploadedAt: string;
  preview?: string;
} 