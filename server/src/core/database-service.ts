import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { FallbackService } from './fallback-service';
import { DocumentChunk } from '../services/chunking';

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
        const points = documents.map(doc => ({
          id: doc.id,
          vector: doc.embedding,
          payload: {
            id: doc.id,
            documentName: doc.documentName,
            content: doc.content,
            title: doc.title,
            summary: doc.summary,
            sourceFile: doc.sourceFile,
            domains: doc.domains
          }
        }));
        
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
} 