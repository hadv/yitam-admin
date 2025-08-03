import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseService, SearchResult } from '../core/database-service';
import { createEmbedding, TaskType } from './embedding';
import { DocumentChunk } from './chunking';
import dotenv from 'dotenv';

dotenv.config();

// Migration configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'knowledge_base';
const NEW_VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10);

export interface MigrationOptions {
  preserveData?: boolean;
  batchSize?: number;
  backupCollectionName?: string;
  dryRun?: boolean;
}

export interface MigrationResult {
  success: boolean;
  message: string;
  oldVectorSize?: number;
  newVectorSize?: number;
  documentsProcessed?: number;
  backupCollectionName?: string;
  errors?: string[];
}

export class MigrationService {
  private qdrantClient: QdrantClient;
  private dbService: DatabaseService;

  constructor() {
    this.qdrantClient = new QdrantClient({ 
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY
    });
    this.dbService = new DatabaseService();
  }

  /**
   * Check if migration is needed by comparing vector dimensions
   */
  async checkMigrationNeeded(): Promise<{ needed: boolean; currentSize?: number; targetSize: number; reason?: string }> {
    try {
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections?.some(
        (collection) => collection.name === COLLECTION_NAME
      );

      if (!collectionExists) {
        return {
          needed: false,
          targetSize: NEW_VECTOR_SIZE,
          reason: 'Collection does not exist - will be created with correct dimensions'
        };
      }

      const collectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME);
      const currentVectorSize = collectionInfo.config?.params?.vectors?.size;

      if (!currentVectorSize) {
        return {
          needed: true,
          targetSize: NEW_VECTOR_SIZE,
          reason: 'Unable to determine current vector size'
        };
      }

      if (currentVectorSize !== NEW_VECTOR_SIZE) {
        return {
          needed: true,
          currentSize: currentVectorSize,
          targetSize: NEW_VECTOR_SIZE,
          reason: `Vector dimension mismatch: ${currentVectorSize} → ${NEW_VECTOR_SIZE}`
        };
      }

      return {
        needed: false,
        currentSize: currentVectorSize,
        targetSize: NEW_VECTOR_SIZE,
        reason: 'Vector dimensions already match'
      };
    } catch (error) {
      console.error('Error checking migration status:', error);
      return {
        needed: true,
        targetSize: NEW_VECTOR_SIZE,
        reason: `Error checking collection: ${error}`
      };
    }
  }

  /**
   * Perform collection migration with various strategies
   */
  async migrateCollection(options: MigrationOptions = {}): Promise<MigrationResult> {
    const {
      preserveData = true,
      batchSize = 50,
      backupCollectionName = `${COLLECTION_NAME}_backup_${Date.now()}`,
      dryRun = false
    } = options;

    console.log(`🔄 Starting collection migration (dry run: ${dryRun})`);
    console.log(`   Preserve data: ${preserveData}`);
    console.log(`   Batch size: ${batchSize}`);
    console.log(`   Backup collection: ${backupCollectionName}`);

    try {
      // Check current state
      const migrationCheck = await this.checkMigrationNeeded();
      if (!migrationCheck.needed) {
        return {
          success: true,
          message: migrationCheck.reason || 'No migration needed',
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: migrationCheck.targetSize
        };
      }

      if (dryRun) {
        return {
          success: true,
          message: `DRY RUN: Would migrate from ${migrationCheck.currentSize} to ${migrationCheck.targetSize} dimensions`,
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: migrationCheck.targetSize
        };
      }

      let documentsProcessed = 0;
      const errors: string[] = [];

      // Strategy 1: Preserve data by re-embedding
      if (preserveData) {
        console.log('📦 Creating backup and re-embedding documents...');
        
        // Create backup collection
        await this.createBackupCollection(backupCollectionName, migrationCheck.currentSize || 384);
        
        // Export existing data
        const existingDocuments = await this.exportAllDocuments();
        console.log(`📄 Found ${existingDocuments.length} documents to migrate`);

        if (existingDocuments.length > 0) {
          // Copy to backup
          await this.copyDocumentsToBackup(existingDocuments, backupCollectionName);
          
          // Re-embed and migrate documents
          documentsProcessed = await this.reEmbedDocuments(existingDocuments, batchSize, errors);
        }

        return {
          success: errors.length === 0,
          message: errors.length === 0 
            ? `Successfully migrated ${documentsProcessed} documents with new embeddings`
            : `Migration completed with ${errors.length} errors`,
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: NEW_VECTOR_SIZE,
          documentsProcessed,
          backupCollectionName,
          errors: errors.length > 0 ? errors : undefined
        };
      } else {
        // Strategy 2: Simple recreation (data loss)
        console.log('🗑️  Recreating collection (existing data will be lost)...');
        
        await this.recreateCollection();
        
        return {
          success: true,
          message: 'Collection recreated with new vector dimensions (existing data was removed)',
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: NEW_VECTOR_SIZE,
          documentsProcessed: 0
        };
      }

    } catch (error) {
      console.error('Migration failed:', error);
      return {
        success: false,
        message: `Migration failed: ${error}`,
        errors: [String(error)]
      };
    }
  }

  /**
   * Create a backup collection with the old vector dimensions
   */
  private async createBackupCollection(backupName: string, vectorSize: number): Promise<void> {
    console.log(`📋 Creating backup collection: ${backupName}`);
    
    await this.qdrantClient.createCollection(backupName, {
      vectors: {
        size: vectorSize,
        distance: 'Cosine'
      }
    });

    // Create the same indices as the original collection
    const indices = ['documentName', 'title', 'domains'];
    for (const fieldName of indices) {
      try {
        await this.qdrantClient.createPayloadIndex(backupName, {
          field_name: fieldName,
          field_schema: 'keyword'
        });
      } catch (error) {
        console.warn(`Warning: Could not create index for ${fieldName}:`, error);
      }
    }
  }

  /**
   * Export all documents from the current collection
   */
  private async exportAllDocuments(): Promise<any[]> {
    return this.exportDocumentsFromCollection(COLLECTION_NAME);
  }

  /**
   * Export all documents from a specific collection
   */
  private async exportDocumentsFromCollection(collectionName: string): Promise<any[]> {
    const documents: any[] = [];
    let nextPageOffset: string | undefined;
    const limit = 100;

    do {
      const response = await this.qdrantClient.scroll(collectionName, {
        with_payload: true,
        with_vector: true,
        limit,
        offset: nextPageOffset,
      });

      documents.push(...response.points);
      nextPageOffset = response.next_page_offset as string | undefined;
    } while (nextPageOffset);

    return documents;
  }

  /**
   * Copy documents to backup collection
   */
  private async copyDocumentsToBackup(documents: any[], backupCollectionName: string): Promise<void> {
    console.log(`💾 Copying ${documents.length} documents to backup...`);
    
    const batchSize = 50;
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      
      await this.qdrantClient.upsert(backupCollectionName, {
        wait: true,
        points: batch
      });
    }
  }

  /**
   * Re-embed documents with new embedding model and store in recreated collection
   */
  private async reEmbedDocuments(documents: any[], batchSize: number, errors: string[]): Promise<number> {
    console.log('🔄 Recreating collection with new dimensions...');
    
    // Delete and recreate the main collection
    await this.recreateCollection();
    
    console.log('🧠 Re-embedding documents with new model...');
    let processed = 0;
    
    for (let i = 0; i < documents.length; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);
      
      try {
        const reEmbeddedBatch = await Promise.all(
          batch.map(async (doc) => {
            try {
              const payload = doc.payload as any;
              const content = payload.content || '';
              
              // Generate new embedding
              const newEmbedding = await createEmbedding(content, TaskType.RETRIEVAL_DOCUMENT);
              
              return {
                id: doc.id,
                vector: newEmbedding,
                payload: payload
              };
            } catch (error) {
              errors.push(`Failed to re-embed document ${doc.id}: ${error}`);
              return null;
            }
          })
        );

        // Filter out failed embeddings
        const validDocuments = reEmbeddedBatch.filter(doc => doc !== null);
        
        if (validDocuments.length > 0) {
          await this.qdrantClient.upsert(COLLECTION_NAME, {
            wait: true,
            points: validDocuments
          });
          processed += validDocuments.length;
        }

        console.log(`   Processed ${Math.min(i + batchSize, documents.length)}/${documents.length} documents`);
        
      } catch (error) {
        errors.push(`Failed to process batch ${i}-${i + batchSize}: ${error}`);
      }
    }

    return processed;
  }

  /**
   * Delete and recreate the collection with new vector dimensions
   */
  private async recreateCollection(): Promise<void> {
    try {
      await this.qdrantClient.deleteCollection(COLLECTION_NAME);
      console.log(`🗑️  Deleted existing collection: ${COLLECTION_NAME}`);
    } catch (error) {
      console.log('Collection did not exist or could not be deleted:', error);
    }

    // Create new collection with current vector size
    await this.qdrantClient.createCollection(COLLECTION_NAME, {
      vectors: {
        size: NEW_VECTOR_SIZE,
        distance: 'Cosine'
      }
    });

    // Recreate indices
    const indices = [
      { field_name: 'documentName', field_schema: 'keyword' },
      { field_name: 'title', field_schema: 'keyword' },
      { field_name: 'domains', field_schema: 'keyword' }
    ];

    for (const index of indices) {
      try {
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, index);
      } catch (error) {
        console.warn(`Warning: Could not create index for ${index.field_name}:`, error);
      }
    }

    console.log(`✅ Created new collection: ${COLLECTION_NAME} with ${NEW_VECTOR_SIZE} dimensions`);
  }

  /**
   * Rollback migration by restoring from backup
   */
  async rollbackMigration(backupCollectionName: string): Promise<MigrationResult> {
    try {
      console.log(`🔄 Rolling back migration from backup: ${backupCollectionName}`);
      
      // Check if backup exists
      const collections = await this.qdrantClient.getCollections();
      const backupExists = collections.collections?.some(
        (collection) => collection.name === backupCollectionName
      );

      if (!backupExists) {
        return {
          success: false,
          message: `Backup collection ${backupCollectionName} not found`
        };
      }

      // Get backup collection info
      const backupInfo = await this.qdrantClient.getCollection(backupCollectionName);
      const backupVectorSize = backupInfo.config?.params?.vectors?.size;

      // Export backup data
      const backupDocuments = await this.exportDocumentsFromCollection(backupCollectionName);
      
      // Recreate main collection with backup dimensions
      await this.qdrantClient.deleteCollection(COLLECTION_NAME);
      await this.qdrantClient.createCollection(COLLECTION_NAME, {
        vectors: {
          size: backupVectorSize || 384,
          distance: 'Cosine'
        }
      });

      // Restore data
      if (backupDocuments.length > 0) {
        await this.copyDocumentsToBackup(backupDocuments, COLLECTION_NAME);
      }

      return {
        success: true,
        message: `Successfully rolled back migration. Restored ${backupDocuments.length} documents.`,
        documentsProcessed: backupDocuments.length,
        oldVectorSize: NEW_VECTOR_SIZE,
        newVectorSize: backupVectorSize
      };

    } catch (error) {
      return {
        success: false,
        message: `Rollback failed: ${error}`,
        errors: [String(error)]
      };
    }
  }
}
