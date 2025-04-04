import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';

dotenv.config();

// Qdrant configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const COLLECTION_NAME = process.env.QDRANT_COLLECTION_NAME || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10); // Default fastembed vector size

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
    
    console.log('Qdrant initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Qdrant:', error);
    throw error;
  }
};

// Add a document with its vector embedding to Qdrant
export const addDocumentToQdrant = async (document: DocumentMetadata, embedding: number[]) => {
  try {
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
    console.error('Failed to add document to Qdrant:', error);
    throw error;
  }
};

// Search for documents using vector similarity
export const searchDocumentsByVector = async (queryVector: number[], limit = 5) => {
  try {
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
    console.error('Failed to search documents in Qdrant:', error);
    throw error;
  }
};

// Get all documents
export const getAllDocuments = async () => {
  try {
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
    console.error('Failed to get documents from Qdrant:', error);
    throw error;
  }
};

// Delete a document from Qdrant
export const deleteDocumentFromQdrant = async (id: string) => {
  try {
    await qdrantClient.delete(COLLECTION_NAME, {
      wait: true,
      points: [id]
    });
    
    return true;
  } catch (error) {
    console.error('Failed to delete document from Qdrant:', error);
    throw error;
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