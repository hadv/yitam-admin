import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { createEmbedding } from '../services/embeddingService';

// Load environment variables
dotenv.config();

// Configuration constants
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'documents';
const VECTOR_SIZE = parseInt(process.env.VECTOR_SIZE || '384', 10); // Default fastembed vector size

// In-memory storage for fallback when Qdrant is not available
const inMemoryDocuments = new Map<string, { document: DocumentMetadata, vector: number[] }>();

// Document metadata interface
export interface DocumentMetadata {
  id: string;
  filename: string;
  path: string;
  contentType: string;
  uploadedAt: string;
  preview?: string;
}

// Database service class
export class DatabaseService {
  private qdrantClient: QdrantClient;
  private isUsingFallback = false;
  private connectionWarningLogged = false;
  
  constructor() {
    this.qdrantClient = new QdrantClient({ 
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY
    });
    console.log(`Initializing database service with Qdrant at ${QDRANT_URL}`);
  }
  
  // Initialize Qdrant and create collection if it doesn't exist
  public async initialize(): Promise<void> {
    try {
      // Check if collection exists
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections?.some(
        (collection) => collection.name === COLLECTION_NAME
      );

      if (!collectionExists) {
        console.log(`Creating Qdrant collection: ${COLLECTION_NAME}`);
        
        // Create collection
        await this.qdrantClient.createCollection(COLLECTION_NAME, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine'
          }
        });
        
        // Create payload index for filename
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'filename',
          field_schema: 'keyword'
        });
        
        // Create payload index for uploadedAt
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'uploadedAt',
          field_schema: 'keyword'
        });
      }
      
      this.isUsingFallback = false;
      this.connectionWarningLogged = false;
      console.log('Qdrant initialized successfully');
    } catch (error) {
      this.handleConnectionError('initialize', error);
    }
  }

  // Helper method to handle connection errors
  private handleConnectionError(operation: string, error: any): void {
    // Set fallback mode
    this.isUsingFallback = true;
    
    // Only log the connection warning once
    if (!this.connectionWarningLogged) {
      console.warn('Failed to connect to Qdrant server. Using in-memory fallback storage instead.');
      console.warn('To use Qdrant, make sure it is running at: ' + QDRANT_URL);
      console.warn('You can install Qdrant using Docker: docker run -p 6333:6333 qdrant/qdrant');
      this.connectionWarningLogged = true;
    } else {
      // For subsequent errors, just log a debug message
      console.debug(`Qdrant connection still unavailable during ${operation} operation. Using fallback.`);
    }
    
    // If it's not a connection refused error, log more details for debugging
    if (error?.cause?.code !== 'ECONNREFUSED') {
      console.error(`Unexpected error during ${operation} operation:`, error);
    }
  }
  
  // Helper method to check if we should use fallback and execute the appropriate function
  private withFallback<T>(
    operation: string, 
    fallbackFn: () => T, 
    qdrantFn: () => Promise<T>
  ): Promise<T> {
    // If already in fallback mode, use fallback immediately
    if (this.isUsingFallback) {
      return Promise.resolve(fallbackFn());
    }
    
    // Otherwise try Qdrant first, with fallback on error
    return qdrantFn().catch((error) => {
      this.handleConnectionError(operation, error);
      return fallbackFn();
    });
  }

  // Add a document with its vector embedding
  public async addDocument(document: DocumentMetadata, embedding: number[]): Promise<DocumentMetadata> {
    return this.withFallback(
      'addDocument',
      // Fallback function
      () => {
        inMemoryDocuments.set(document.id, { document, vector: embedding });
        return document;
      },
      // Qdrant function
      async () => {
        const payload = {
          id: document.id,
          filename: document.filename,
          path: document.path,
          contentType: document.contentType,
          uploadedAt: document.uploadedAt,
          preview: document.preview
        };

        await this.qdrantClient.upsert(COLLECTION_NAME, {
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
      }
    );
  }

  // Helper function to calculate cosine similarity for in-memory fallback
  private cosineSimilarity(a: number[], b: number[]): number {
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
  }

  // Search for documents using vector similarity
  public async searchByVector(queryVector: number[], limit = 5): Promise<Array<DocumentMetadata & { score: number }>> {
    return this.withFallback(
      'searchByVector',
      // Fallback function
      () => {
        // In-memory similarity search
        return Array.from(inMemoryDocuments.values())
          .map(item => ({
            ...item.document,
            score: this.cosineSimilarity(queryVector, item.vector)
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      // Qdrant function
      async () => {
        const searchResult = await this.qdrantClient.search(COLLECTION_NAME, {
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
      }
    );
  }

  // Get all documents
  public async getAllDocuments(): Promise<DocumentMetadata[]> {
    return this.withFallback(
      'getAllDocuments',
      // Fallback function
      () => Array.from(inMemoryDocuments.values()).map(item => item.document),
      // Qdrant function
      async () => {
        const result = await this.qdrantClient.scroll(COLLECTION_NAME, {
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
      }
    );
  }

  // Delete a document
  public async deleteDocument(id: string): Promise<boolean> {
    return this.withFallback(
      'deleteDocument',
      // Fallback function
      () => {
        inMemoryDocuments.delete(id);
        return true;
      },
      // Qdrant function
      async () => {
        await this.qdrantClient.delete(COLLECTION_NAME, {
          wait: true,
          points: [id]
        });
        
        return true;
      }
    );
  }
} 