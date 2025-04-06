import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

// Qdrant configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10); // Default fastembed vector size

// In-memory storage for fallback when Qdrant is not available
const inMemoryDocuments = new Map<string, { document: DocumentMetadata, vector: number[] }>();
let isUsingFallback = false;

// Create Qdrant client
const qdrantClient = new QdrantClient({ url: QDRANT_URL });

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
    
    isUsingFallback = false;
    console.log('Qdrant initialized successfully');
  } catch (error) {
    isUsingFallback = true;
    console.warn('Failed to connect to Qdrant server. Using in-memory fallback storage instead.');
    console.warn('To use Qdrant, make sure it is running at: ' + QDRANT_URL);
    console.warn('You can install Qdrant using Docker: docker run -p 6333:6333 qdrant/qdrant');
  }
};

// Add a document with its vector embedding to Qdrant
export const addDocumentToQdrant = async (document: DocumentMetadata, embedding: number[]) => {
  try {
    if (isUsingFallback) {
      inMemoryDocuments.set(document.id, { document, vector: embedding });
      return document;
    }

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
  } catch (error) {
    console.error('Failed to add document to storage:', error);
    
    // Fallback to in-memory storage on error
    inMemoryDocuments.set(document.id, { document, vector: embedding });
    isUsingFallback = true;
    return document;
  }
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
  try {
    if (isUsingFallback) {
      // In-memory similarity search
      const results = Array.from(inMemoryDocuments.values())
        .map(item => ({
          ...item.document,
          score: cosineSimilarity(queryVector, item.vector)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      
      return results;
    }

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
  } catch (error) {
    console.error('Failed to search documents in storage:', error);
    
    // Fallback to in-memory search
    isUsingFallback = true;
    
    // In-memory similarity search
    const results = Array.from(inMemoryDocuments.values())
      .map(item => ({
        ...item.document,
        score: cosineSimilarity(queryVector, item.vector)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    
    return results;
  }
};

// Get all documents
export const getAllDocuments = async () => {
  try {
    if (isUsingFallback) {
      return Array.from(inMemoryDocuments.values()).map(item => item.document);
    }

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
  } catch (error) {
    console.error('Failed to get documents from storage:', error);
    
    // Fallback to in-memory
    isUsingFallback = true;
    return Array.from(inMemoryDocuments.values()).map(item => item.document);
  }
};

// Delete a document
export const deleteDocumentFromQdrant = async (id: string) => {
  try {
    if (isUsingFallback) {
      inMemoryDocuments.delete(id);
      return true;
    }

    await qdrantClient.delete(COLLECTION_NAME, {
      wait: true,
      points: [id]
    });
    
    return true;
  } catch (error) {
    console.error('Failed to delete document from storage:', error);
    
    // Fallback to in-memory
    isUsingFallback = true;
    inMemoryDocuments.delete(id);
    return true;
  }
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