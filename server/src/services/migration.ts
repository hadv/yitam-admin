import { QdrantClient } from '@qdrant/js-client-rest';
import { DatabaseService, dbService, SearchResult } from '../core/database-service';
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
  forceReEmbed?: boolean; // Force re-embedding even if dimensions match
  newCollectionName?: string; // Create new collection instead of replacing existing
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
    this.dbService = dbService;
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
      const vectorConfig = collectionInfo.config?.params?.vectors;

      // Handle both single vector config and named vector configs
      let currentVectorSize: number | undefined;
      if (typeof vectorConfig === 'object' && vectorConfig !== null) {
        if ('size' in vectorConfig && typeof vectorConfig.size === 'number') {
          // Single vector configuration
          currentVectorSize = vectorConfig.size;
        } else {
          // Named vector configurations - treat as Record<string, any> for flexibility
          const namedVectors = vectorConfig as Record<string, any>;
          const vectorNames = Object.keys(namedVectors);
          if (vectorNames.length > 0) {
            const firstVector = namedVectors[vectorNames[0]];
            if (typeof firstVector === 'object' && firstVector !== null && 'size' in firstVector && typeof firstVector.size === 'number') {
              currentVectorSize = firstVector.size;
            }
          }
        }
      }

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
      dryRun = false,
      forceReEmbed = false,
      newCollectionName
    } = options;

    const targetCollection = newCollectionName || COLLECTION_NAME;
    const isCreatingNewCollection = !!newCollectionName;

    console.log(`🔄 Starting collection migration (dry run: ${dryRun})`);
    console.log(`   Source collection: ${COLLECTION_NAME}`);
    console.log(`   Target collection: ${targetCollection}`);
    console.log(`   Creating new collection: ${isCreatingNewCollection ? '✅ YES' : '❌ NO'}`);
    console.log(`   Preserve data: ${preserveData}`);
    console.log(`   Force re-embed: ${forceReEmbed}`);
    console.log(`   Batch size: ${batchSize}`);
    if (!isCreatingNewCollection) {
      console.log(`   Backup collection: ${backupCollectionName}`);
    }

    try {
      // Check current state
      const migrationCheck = await this.checkMigrationNeeded();
      if (!migrationCheck.needed && !forceReEmbed) {
        return {
          success: true,
          message: migrationCheck.reason || 'No migration needed',
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: migrationCheck.targetSize
        };
      }

      // If force re-embed is enabled, we proceed even if dimensions match
      if (forceReEmbed && !migrationCheck.needed) {
        console.log('🔄 Force re-embedding enabled - proceeding despite matching dimensions');
      }

      if (dryRun) {
        const collectionInfo = await this.getCollectionInfo();
        let action: string;

        if (isCreatingNewCollection) {
          action = `Would create new collection '${targetCollection}' and migrate ${collectionInfo.documentCount || 0} documents with new embedding model (source collection '${COLLECTION_NAME}' will remain unchanged)`;
        } else if (forceReEmbed) {
          action = `Would force re-embed ${collectionInfo.documentCount || 0} documents with new embedding model`;
        } else {
          action = `Would migrate from ${migrationCheck.currentSize} to ${migrationCheck.targetSize} dimensions`;
        }

        return {
          success: true,
          message: `DRY RUN: ${action}`,
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: migrationCheck.targetSize,
          documentsProcessed: (forceReEmbed || isCreatingNewCollection) ? collectionInfo.documentCount : 0
        };
      }

      let documentsProcessed = 0;
      const errors: string[] = [];

      // Strategy 1: Preserve data by re-embedding
      if (preserveData) {
        if (isCreatingNewCollection) {
          console.log(`📦 Creating new collection '${targetCollection}' and re-embedding documents...`);

          // Check if target collection already exists
          const collections = await this.qdrantClient.getCollections();
          const targetExists = collections.collections?.some(
            (collection) => collection.name === targetCollection
          );

          if (targetExists) {
            return {
              success: false,
              message: `Target collection '${targetCollection}' already exists. Please choose a different name or delete the existing collection.`,
              errors: [`Collection '${targetCollection}' already exists`]
            };
          }

          // Create new target collection
          await this.createNewCollection(targetCollection);

          // Export existing data from source collection
          const existingDocuments = await this.exportAllDocuments();
          console.log(`📄 Found ${existingDocuments.length} documents to migrate from '${COLLECTION_NAME}' to '${targetCollection}'`);

          if (existingDocuments.length > 0) {
            // Re-embed and migrate documents to new collection
            documentsProcessed = await this.reEmbedDocumentsToNewCollection(existingDocuments, targetCollection, batchSize, errors);
          }
        } else {
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
        }

        const successMessage = isCreatingNewCollection
          ? `Successfully created new collection '${targetCollection}' with ${documentsProcessed} documents using new embeddings (source collection '${COLLECTION_NAME}' preserved)`
          : `Successfully migrated ${documentsProcessed} documents with new embeddings`;

        const completedMessage = isCreatingNewCollection
          ? `Migration to new collection completed with ${errors.length} errors`
          : `Migration completed with ${errors.length} errors`;

        return {
          success: errors.length === 0,
          message: errors.length === 0 ? successMessage : completedMessage,
          oldVectorSize: migrationCheck.currentSize,
          newVectorSize: NEW_VECTOR_SIZE,
          documentsProcessed,
          backupCollectionName: isCreatingNewCollection ? undefined : backupCollectionName,
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
   * Create a new collection with specified name and current vector dimensions
   */
  private async createNewCollection(collectionName: string): Promise<void> {
    console.log(`✨ Creating new collection: ${collectionName} with ${NEW_VECTOR_SIZE} dimensions`);

    // Create new collection with current vector size
    await this.qdrantClient.createCollection(collectionName, {
      vectors: {
        size: NEW_VECTOR_SIZE,
        distance: 'Cosine'
      }
    });

    // Create indices
    const indices = [
      { field_name: 'documentName', field_schema: 'keyword' as const },
      { field_name: 'title', field_schema: 'keyword' as const },
      { field_name: 'domains', field_schema: 'keyword' as const }
    ];

    for (const index of indices) {
      try {
        await this.qdrantClient.createPayloadIndex(collectionName, index);
      } catch (error) {
        console.warn(`Warning: Could not create index for ${index.field_name}:`, error);
      }
    }

    console.log(`✅ Created new collection: ${collectionName} with ${NEW_VECTOR_SIZE} dimensions`);
  }

  /**
   * Re-embed documents with new embedding model and store in new collection
   */
  private async reEmbedDocumentsToNewCollection(documents: any[], targetCollection: string, batchSize: number, errors: string[]): Promise<number> {
    console.log(`🧠 Re-embedding ${documents.length} documents with new model to collection '${targetCollection}'...`);
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
          await this.qdrantClient.upsert(targetCollection, {
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
      { field_name: 'documentName', field_schema: 'keyword' as const },
      { field_name: 'title', field_schema: 'keyword' as const },
      { field_name: 'domains', field_schema: 'keyword' as const }
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
   * List all collections including backups
   */
  async listAllCollections(): Promise<Array<{
    name: string;
    vectorSize?: number;
    documentCount?: number;
    isBackup: boolean;
  }>> {
    try {
      const collections = await this.qdrantClient.getCollections();

      if (!collections.collections) {
        return [];
      }

      const collectionInfos = await Promise.all(
        collections.collections.map(async (collection) => {
          try {
            // Get collection details
            const collectionInfo = await this.qdrantClient.getCollection(collection.name);
            const vectorConfig = collectionInfo.config?.params?.vectors;

            // Handle both single vector config and named vector configs
            let vectorSize: number | undefined;
            if (typeof vectorConfig === 'object' && vectorConfig !== null) {
              if ('size' in vectorConfig && typeof vectorConfig.size === 'number') {
                // Single vector configuration
                vectorSize = vectorConfig.size;
              } else {
                // Named vector configurations - treat as Record<string, any> for flexibility
                const namedVectors = vectorConfig as Record<string, any>;
                const vectorNames = Object.keys(namedVectors);
                if (vectorNames.length > 0) {
                  const firstVector = namedVectors[vectorNames[0]];
                  if (typeof firstVector === 'object' && firstVector !== null && 'size' in firstVector && typeof firstVector.size === 'number') {
                    vectorSize = firstVector.size;
                  }
                }
              }
            }

            // Get document count
            const countResponse = await this.qdrantClient.count(collection.name);

            return {
              name: collection.name,
              vectorSize,
              documentCount: countResponse.count,
              isBackup: collection.name.includes('_backup') || collection.name.includes('backup')
            };
          } catch (error) {
            console.warn(`Error getting info for collection ${collection.name}:`, error);
            return {
              name: collection.name,
              vectorSize: undefined,
              documentCount: 0,
              isBackup: collection.name.includes('_backup') || collection.name.includes('backup')
            };
          }
        })
      );

      return collectionInfos;
    } catch (error) {
      console.error('Error listing collections:', error);
      throw error;
    }
  }

  /**
   * Get collection information including document count
   */
  async getCollectionInfo(): Promise<{
    exists: boolean;
    vectorSize?: number;
    documentCount?: number;
    collectionName: string;
  }> {
    try {
      const collections = await this.qdrantClient.getCollections();
      const collectionExists = collections.collections?.some(
        (collection) => collection.name === COLLECTION_NAME
      );

      if (!collectionExists) {
        return {
          exists: false,
          collectionName: COLLECTION_NAME
        };
      }

      // Get collection info
      const collectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME);
      const vectorConfig = collectionInfo.config?.params?.vectors;

      // Handle both single vector config and named vector configs
      let vectorSize: number | undefined;
      if (typeof vectorConfig === 'object' && vectorConfig !== null) {
        if ('size' in vectorConfig && typeof vectorConfig.size === 'number') {
          // Single vector configuration
          vectorSize = vectorConfig.size;
        } else {
          // Named vector configurations - treat as Record<string, any> for flexibility
          const namedVectors = vectorConfig as Record<string, any>;
          const vectorNames = Object.keys(namedVectors);
          if (vectorNames.length > 0) {
            const firstVector = namedVectors[vectorNames[0]];
            if (typeof firstVector === 'object' && firstVector !== null && 'size' in firstVector && typeof firstVector.size === 'number') {
              vectorSize = firstVector.size;
            }
          }
        }
      }

      // Get document count
      const countResponse = await this.qdrantClient.count(COLLECTION_NAME);

      return {
        exists: true,
        vectorSize,
        documentCount: countResponse.count,
        collectionName: COLLECTION_NAME
      };
    } catch (error) {
      console.error('Error getting collection info:', error);
      throw error;
    }
  }

  /**
   * Create a manual backup of the current collection
   */
  async createManualBackup(customBackupName?: string): Promise<{
    success: boolean;
    message: string;
    backupCollectionName?: string;
    documentsBackedUp?: number;
  }> {
    try {
      const backupName = customBackupName || `${COLLECTION_NAME}_legacy_backup_${Date.now()}`;

      console.log(`📋 Creating manual backup: ${backupName}`);

      // Get current collection info
      const collectionInfo = await this.getCollectionInfo();
      if (!collectionInfo.exists) {
        return {
          success: false,
          message: 'Source collection does not exist'
        };
      }

      // Get current vector size
      const currentCollectionInfo = await this.qdrantClient.getCollection(COLLECTION_NAME);
      const vectorConfig = currentCollectionInfo.config?.params?.vectors;
      let currentVectorSize = 768; // Default

      if (typeof vectorConfig === 'object' && vectorConfig !== null) {
        if ('size' in vectorConfig && typeof vectorConfig.size === 'number') {
          currentVectorSize = vectorConfig.size;
        } else {
          const namedVectors = vectorConfig as Record<string, any>;
          const vectorNames = Object.keys(namedVectors);
          if (vectorNames.length > 0) {
            const firstVector = namedVectors[vectorNames[0]];
            if (typeof firstVector === 'object' && firstVector !== null && 'size' in firstVector && typeof firstVector.size === 'number') {
              currentVectorSize = firstVector.size;
            }
          }
        }
      }

      // Create backup collection with same dimensions as current
      await this.createBackupCollection(backupName, currentVectorSize);

      // Export and copy all documents
      const documents = await this.exportAllDocuments();
      console.log(`📄 Found ${documents.length} documents to backup`);

      if (documents.length > 0) {
        await this.copyDocumentsToBackup(documents, backupName);
      }

      return {
        success: true,
        message: `Successfully created backup with ${documents.length} documents`,
        backupCollectionName: backupName,
        documentsBackedUp: documents.length
      };
    } catch (error) {
      console.error('Manual backup failed:', error);
      return {
        success: false,
        message: `Backup failed: ${error}`
      };
    }
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
      const vectorConfig = backupInfo.config?.params?.vectors;

      // Handle both single vector config and named vector configs
      let backupVectorSize: number = 384; // Default fallback
      if (typeof vectorConfig === 'object' && vectorConfig !== null) {
        if ('size' in vectorConfig && typeof vectorConfig.size === 'number') {
          // Single vector configuration
          backupVectorSize = vectorConfig.size;
        } else {
          // Named vector configurations - treat as Record<string, any> for flexibility
          const namedVectors = vectorConfig as Record<string, any>;
          const vectorNames = Object.keys(namedVectors);
          if (vectorNames.length > 0) {
            const firstVector = namedVectors[vectorNames[0]];
            if (typeof firstVector === 'object' && firstVector !== null && 'size' in firstVector && typeof firstVector.size === 'number') {
              backupVectorSize = firstVector.size;
            }
          }
        }
      }

      // Export backup data
      const backupDocuments = await this.exportDocumentsFromCollection(backupCollectionName);

      // Recreate main collection with backup dimensions
      await this.qdrantClient.deleteCollection(COLLECTION_NAME);
      await this.qdrantClient.createCollection(COLLECTION_NAME, {
        vectors: {
          size: backupVectorSize,
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
