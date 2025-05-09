import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { FallbackService } from './fallback-service';
import { DocumentChunk } from '../services/chunking';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables
dotenv.config();

// Configuration constants
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'knowledge_base';
const VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10); // Gemini embedding size

// In-memory storage for fallback when Qdrant is not available
const inMemoryDocuments = new Map<string, { document: DocumentChunk }>();

// Search result interface with scores
export interface SearchResult {
  id: string;
  documentName: string;
  content: string;
  enhancedContent?: string;
  title?: string;
  summary?: string;
  sourceFile?: string;
  domains?: string[];
  score: number;
}

// Database service class
export class DatabaseService {
  private qdrantClient: QdrantClient;
  private fallbackService: FallbackService;
  
  constructor() {
    this.qdrantClient = new QdrantClient({ 
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY
    });
    this.fallbackService = new FallbackService('Qdrant');
    console.log(`Initializing database service with Qdrant at ${QDRANT_URL}`);
  }
  
  // Initialize Qdrant and create collections if they don't exist
  public async initialize(): Promise<void> {
    try {
      // Check if collections exist
      const collections = await this.qdrantClient.getCollections();
      
      // Check if the knowledge base collection exists
      const collectionExists = collections.collections?.some(
        (collection) => collection.name === COLLECTION_NAME
      );
      
      if (!collectionExists) {
        console.log(`Creating Qdrant collection: ${COLLECTION_NAME} with vector size: ${VECTOR_SIZE}`);
        
        // Create knowledge base collection
        await this.qdrantClient.createCollection(COLLECTION_NAME, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine'
          }
        });
        
        // Create relevant payload indices for knowledge base
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'documentName',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'title',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'domains',
          field_schema: 'keyword'
        });
      }
      
      this.fallbackService.resetWarningFlag('initialize');
      console.log('Qdrant initialized successfully');
    } catch (error) {
      this.fallbackService.handleError('initialize', error);
    }
  }
  
  // Add documents to knowledge base
  public async addDocumentChunks(documents: DocumentChunk[]): Promise<void> {
    return this.fallbackService.withFallback(
      'addDocumentChunks',
      // Fallback function
      () => {
        for (const doc of documents) {
          inMemoryDocuments.set(doc.id, { document: doc });
        }
      },
      // Qdrant function
      async () => {
        if (documents.length === 0) return;
        
        // Prepare points for bulk insertion
        const points = documents.map(doc => {
          return {
            id: uuidv4(),
            vector: doc.embedding,
            payload: {
              id: doc.id,
              documentName: doc.documentName,
              content: doc.content,
              enhancedContent: doc.enhancedContent,
              title: doc.title,
              summary: doc.summary,
              sourceFile: doc.sourceFile,
              domains: doc.domains
            }
          };
        });
        
        // Insert documents
        await this.qdrantClient.upsert(COLLECTION_NAME, {
          wait: true,
          points
        });
      },
      this.fallbackService.isFallbackActive()
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
  public async searchByVector(queryVector: number[], limit = 10): Promise<SearchResult[]> {
    return this.fallbackService.withFallback(
      'searchByVector',
      // Fallback function
      () => {
        // Search documents
        return Array.from(inMemoryDocuments.values())
          .map(item => {
            const doc = item.document;
            return {
              id: doc.id,
              documentName: doc.documentName,
              content: doc.content,
              enhancedContent: doc.enhancedContent,
              title: doc.title,
              summary: doc.summary,
              sourceFile: doc.sourceFile,
              domains: doc.domains,
              score: this.cosineSimilarity(queryVector, doc.embedding)
            };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      // Qdrant function
      async () => {
        const results = await this.qdrantClient.search(COLLECTION_NAME, {
          vector: queryVector,
          limit: limit,
          with_payload: true
        });
        
        return results.map(hit => {
          const payload = hit.payload as any;
          
          return {
            id: payload.id,
            documentName: payload.documentName,
            content: payload.content,
            enhancedContent: payload.enhancedContent,
            title: payload.title,
            summary: payload.summary,
            sourceFile: payload.sourceFile,
            domains: payload.domains || ['default'],
            score: hit.score
          };
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Check if a transcript already exists for a specific videoId
  public async doesTranscriptExist(videoId: string): Promise<boolean> {
    const idPattern = `youtube_${videoId}`;
    
    return this.fallbackService.withFallback(
      'doesTranscriptExist',
      // Fallback function
      () => {
        // Search in-memory documents for the videoId in the id field
        return Array.from(inMemoryDocuments.values())
          .some(item => {
            const doc = item.document;
            return doc.id.startsWith(idPattern);
          });
      },
      // Qdrant function
      async () => {
        // Search for documents with an ID that starts with the pattern
        const filter = {
          must: [
            {
              key: 'id',
              match: {
                text: idPattern,
                exact: false // Using non-exact match to find IDs that start with this pattern
              }
            }
          ]
        };
        
        try {
          const results = await this.qdrantClient.scroll(COLLECTION_NAME, {
            filter: filter,
            limit: 1,
            with_payload: true
          });
          
          return results.points.length > 0;
        } catch (error) {
          // If text matching is not supported, try alternative approach
          console.error('Error searching by ID pattern:', error);
          
          // Alternative: Get all documents and check client-side
          const allResults = await this.qdrantClient.scroll(COLLECTION_NAME, {
            limit: 100, // Reasonable limit to check
            with_payload: true
          });
          
          // Check if any document ID starts with the pattern
          return allResults.points.some(point => {
            const payload = point.payload as any;
            return payload.id && payload.id.startsWith(idPattern);
          });
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Delete all chunks for a specific YouTube video by videoId
  public async deleteYoutubeTranscriptChunks(videoId: string): Promise<number> {
    const idPattern = `youtube_${videoId}`;
    
    return this.fallbackService.withFallback(
      'deleteYoutubeTranscriptChunks',
      // Fallback function for in-memory storage
      () => {
        let deletedCount = 0;
        // Get all keys that start with the pattern
        const keysToDelete = Array.from(inMemoryDocuments.keys())
          .filter(key => {
            const doc = inMemoryDocuments.get(key)?.document;
            return doc && doc.id.startsWith(idPattern);
          });
        
        // Delete each matching document
        keysToDelete.forEach(key => {
          inMemoryDocuments.delete(key);
          deletedCount++;
        });
        
        console.log(`Deleted ${deletedCount} in-memory chunks for YouTube video ${videoId}`);
        return deletedCount;
      },
      // Qdrant function
      async () => {
        try {
          // Create a filter that matches points with id starting with the pattern
          const filter = {
            must: [
              {
                key: 'id',
                match: {
                  text: idPattern 
                }
              }
            ]
          };
          
          console.log(`Attempting to delete chunks that match filter:`, JSON.stringify(filter, null, 2));
          
          // First, find all points that have ids starting with the pattern to count them
          const countResult = await this.qdrantClient.count(COLLECTION_NAME, {
            filter: filter
          });
          
          const pointCount = countResult.count || 0;
          console.log(`Found ${pointCount} chunks to delete for YouTube video ${videoId}`);
          
          if (pointCount === 0) {
            return 0;
          }
          
          // Use the delete method with the filter
          await this.qdrantClient.delete(COLLECTION_NAME, {
            filter: filter
          });
          
          console.log(`Deleted ${pointCount} chunks for YouTube video ${videoId}`);
          return pointCount;
        } catch (error) {
          console.error('Error deleting YouTube transcript chunks:', error);
          throw error;
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }
} 