import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { FallbackService } from './fallback-service';
import { DocumentChunk } from '../services/chunking';

// Load environment variables
dotenv.config();

// Configuration constants
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const CHUNKS_COLLECTION_NAME = process.env.CHUNKS_COLLECTION_NAME || 'document_chunks';
const VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10); // Gemini embedding size

// In-memory storage for fallback when Qdrant is not available
const inMemoryChunks = new Map<string, { chunk: DocumentChunk }>();

// Search result interface with scores
export interface SearchResult {
  id: string;
  documentName: string;
  pageNumber: number;
  chunkNumber: number;
  content: string;
  title?: string;
  summary?: string;
  sourceFile?: string;
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
      
      // Check if the chunks collection exists
      const chunksCollectionExists = collections.collections?.some(
        (collection) => collection.name === CHUNKS_COLLECTION_NAME
      );
      
      if (!chunksCollectionExists) {
        console.log(`Creating Qdrant collection: ${CHUNKS_COLLECTION_NAME} with vector size: ${VECTOR_SIZE}`);
        
        // Create chunks collection
        await this.qdrantClient.createCollection(CHUNKS_COLLECTION_NAME, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine'
          }
        });
        
        // Create relevant payload indices for chunks
        await this.qdrantClient.createPayloadIndex(CHUNKS_COLLECTION_NAME, {
          field_name: 'documentName',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(CHUNKS_COLLECTION_NAME, {
          field_name: 'title',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(CHUNKS_COLLECTION_NAME, {
          field_name: 'pageNumber',
          field_schema: 'integer'
        });
        
        await this.qdrantClient.createPayloadIndex(CHUNKS_COLLECTION_NAME, {
          field_name: 'chunkNumber',
          field_schema: 'integer'
        });
      }
      
      this.fallbackService.resetWarningFlag('initialize');
      console.log('Qdrant initialized successfully');
    } catch (error) {
      this.fallbackService.handleError('initialize', error);
    }
  }
  
  // Add document chunks to database
  public async addDocumentChunks(chunks: DocumentChunk[]): Promise<void> {
    return this.fallbackService.withFallback(
      'addDocumentChunks',
      // Fallback function
      () => {
        for (const chunk of chunks) {
          inMemoryChunks.set(chunk.id, { chunk });
        }
      },
      // Qdrant function
      async () => {
        if (chunks.length === 0) return;
        
        // Prepare points for bulk insertion
        const points = chunks.map(chunk => ({
          id: chunk.id,
          vector: chunk.embedding,
          payload: {
            id: chunk.id,
            documentName: chunk.documentName,
            parentDocumentId: chunk.parentDocumentId,
            pageNumber: chunk.pageNumber,
            chunkNumber: chunk.chunkNumber,
            content: chunk.content,
            title: chunk.title,
            summary: chunk.summary,
            sourceFile: chunk.sourceFile
          }
        }));
        
        // Insert chunks
        await this.qdrantClient.upsert(CHUNKS_COLLECTION_NAME, {
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
        // Search chunks
        return Array.from(inMemoryChunks.values())
          .map(item => {
            const chunk = item.chunk;
            return {
              id: chunk.id,
              documentName: chunk.documentName,
              pageNumber: chunk.pageNumber,
              chunkNumber: chunk.chunkNumber,
              content: chunk.content,
              title: chunk.title,
              summary: chunk.summary,
              sourceFile: chunk.sourceFile,
              score: this.cosineSimilarity(queryVector, chunk.embedding)
            };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      // Qdrant function
      async () => {
        const results = await this.qdrantClient.search(CHUNKS_COLLECTION_NAME, {
          vector: queryVector,
          limit: limit,
          with_payload: true
        });
        
        return results.map(hit => {
          const payload = hit.payload as any;
          
          return {
            id: payload.id,
            documentName: payload.documentName,
            pageNumber: payload.pageNumber,
            chunkNumber: payload.chunkNumber,
            content: payload.content,
            title: payload.title,
            summary: payload.summary,
            sourceFile: payload.sourceFile,
            score: hit.score
          };
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Get all chunks
  public async getAllChunks(): Promise<DocumentChunk[]> {
    return this.fallbackService.withFallback(
      'getAllChunks',
      // Fallback function
      () => Array.from(inMemoryChunks.values()).map(item => item.chunk),
      // Qdrant function
      async () => {
        const result = await this.qdrantClient.scroll(CHUNKS_COLLECTION_NAME, {
          with_payload: true,
          with_vector: true,
          limit: 1000
        });
        
        if (!result.points) {
          return [];
        }
        
        return result.points.map(point => {
          const payload = point.payload as any;
          const vector = point.vector as number[];
          
          return {
            id: payload.id,
            documentName: payload.documentName,
            parentDocumentId: payload.parentDocumentId,
            pageNumber: payload.pageNumber,
            chunkNumber: payload.chunkNumber,
            content: payload.content,
            title: payload.title,
            summary: payload.summary,
            sourceFile: payload.sourceFile,
            embedding: vector
          };
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }
  
  // Get document chunks by document name
  public async getDocumentChunksByName(documentName: string): Promise<DocumentChunk[]> {
    return this.fallbackService.withFallback(
      'getDocumentChunksByName',
      // Fallback function
      () => {
        return Array.from(inMemoryChunks.values())
          .filter(item => item.chunk.documentName === documentName)
          .map(item => item.chunk)
          .sort((a, b) => {
            // Sort by page number first, then by chunk number
            if (a.pageNumber !== b.pageNumber) {
              return a.pageNumber - b.pageNumber;
            }
            return a.chunkNumber - b.chunkNumber;
          });
      },
      // Qdrant function
      async () => {
        const result = await this.qdrantClient.scroll(CHUNKS_COLLECTION_NAME, {
          filter: {
            must: [
              { key: "documentName", match: { value: documentName } }
            ]
          },
          with_payload: true,
          with_vector: true,
          limit: 1000
        });
        
        if (!result.points) {
          return [];
        }
        
        return result.points.map(point => {
          const payload = point.payload as any;
          const vector = point.vector as number[];
          
          return {
            id: payload.id,
            documentName: payload.documentName,
            parentDocumentId: payload.parentDocumentId,
            pageNumber: payload.pageNumber,
            chunkNumber: payload.chunkNumber,
            content: payload.content,
            title: payload.title,
            summary: payload.summary,
            sourceFile: payload.sourceFile,
            embedding: vector
          };
        }).sort((a, b) => {
          // Sort by page number first, then by chunk number
          if (a.pageNumber !== b.pageNumber) {
            return a.pageNumber - b.pageNumber;
          }
          return a.chunkNumber - b.chunkNumber;
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Delete a document by name (all chunks with this document name)
  public async deleteDocumentByName(documentName: string): Promise<number> {
    return this.fallbackService.withFallback(
      'deleteDocumentByName',
      // Fallback function
      () => {
        // Get all chunks for this document
        const chunkIds = Array.from(inMemoryChunks.keys())
          .filter(chunkId => {
            const chunk = inMemoryChunks.get(chunkId)!.chunk;
            return chunk.documentName === documentName;
          });
        
        // Delete chunks
        for (const chunkId of chunkIds) {
          inMemoryChunks.delete(chunkId);
        }
        
        return chunkIds.length;
      },
      // Qdrant function
      async () => {
        // First count how many chunks will be deleted
        const countResult = await this.qdrantClient.count(CHUNKS_COLLECTION_NAME, {
          exact: true,
          filter: {
            must: [
              { key: "documentName", match: { value: documentName } }
            ]
          }
        });
        
        // Delete all chunks for this document
        await this.qdrantClient.delete(CHUNKS_COLLECTION_NAME, {
          wait: true,
          filter: {
            must: [
              { key: "documentName", match: { value: documentName } }
            ]
          }
        });
        
        return countResult.count;
      },
      this.fallbackService.isFallbackActive()
    );
  }
} 