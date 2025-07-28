import { Request, Response } from 'express';
import { MigrationService, MigrationOptions } from '../services/migration';

// Create a singleton instance of the migration service
const migrationService = new MigrationService();

/**
 * Check if migration is needed
 * GET /api/migrate/status
 */
export const checkMigrationStatus = async (req: Request, res: Response) => {
  try {
    const status = await migrationService.checkMigrationNeeded();
    
    res.status(200).json({
      migrationNeeded: status.needed,
      currentVectorSize: status.currentSize,
      targetVectorSize: status.targetSize,
      reason: status.reason,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error checking migration status:', error);
    res.status(500).json({ 
      error: 'Failed to check migration status',
      details: String(error)
    });
  }
};

/**
 * Perform collection migration
 * POST /api/migrate/collection
 * 
 * Body parameters:
 * - preserveData: boolean (default: true) - Whether to re-embed existing data
 * - batchSize: number (default: 50) - Batch size for processing documents
 * - backupCollectionName: string (optional) - Custom backup collection name
 * - dryRun: boolean (default: false) - Perform a dry run without actual changes
 */
export const migrateCollection = async (req: Request, res: Response) => {
  try {
    const options: MigrationOptions = {
      preserveData: req.body.preserveData !== false, // Default to true
      batchSize: parseInt(req.body.batchSize) || 50,
      backupCollectionName: req.body.backupCollectionName,
      dryRun: req.body.dryRun === true
    };

    console.log('🚀 Migration request received with options:', options);

    // Validate batch size
    if (options.batchSize && (options.batchSize < 1 || options.batchSize > 200)) {
      return res.status(400).json({
        error: 'Invalid batch size. Must be between 1 and 200.'
      });
    }

    const result = await migrationService.migrateCollection(options);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        details: {
          oldVectorSize: result.oldVectorSize,
          newVectorSize: result.newVectorSize,
          documentsProcessed: result.documentsProcessed,
          backupCollectionName: result.backupCollectionName,
          timestamp: new Date().toISOString()
        },
        warnings: result.errors && result.errors.length > 0 ? result.errors : undefined
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        errors: result.errors,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Migration failed with unexpected error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Migration failed with unexpected error',
      details: String(error),
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * Rollback migration from backup
 * POST /api/migrate/rollback
 * 
 * Body parameters:
 * - backupCollectionName: string (required) - Name of the backup collection to restore from
 */
export const rollbackMigration = async (req: Request, res: Response) => {
  try {
    const { backupCollectionName } = req.body;

    if (!backupCollectionName) {
      return res.status(400).json({
        error: 'backupCollectionName is required for rollback'
      });
    }

    console.log(`🔄 Rollback request received for backup: ${backupCollectionName}`);

    const result = await migrationService.rollbackMigration(backupCollectionName);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        details: {
          documentsRestored: result.documentsProcessed,
          restoredVectorSize: result.newVectorSize,
          previousVectorSize: result.oldVectorSize,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        errors: result.errors,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Rollback failed with unexpected error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Rollback failed with unexpected error',
      details: String(error),
      timestamp: new Date().toISOString()
    });
  }
};

/**
 * Get migration help and documentation
 * GET /api/migrate/help
 */
export const getMigrationHelp = async (req: Request, res: Response) => {
  const helpInfo = {
    title: "Vector Database Migration API",
    description: "API endpoints for managing vector database migrations when embedding models change",
    endpoints: {
      "GET /api/migrate/status": {
        description: "Check if migration is needed",
        returns: "Migration status and vector dimension information"
      },
      "POST /api/migrate/collection": {
        description: "Perform collection migration",
        parameters: {
          preserveData: "boolean (default: true) - Re-embed existing data with new model",
          batchSize: "number (default: 50) - Batch size for processing documents",
          backupCollectionName: "string (optional) - Custom backup collection name",
          dryRun: "boolean (default: false) - Perform dry run without changes"
        },
        example: {
          preserveData: true,
          batchSize: 50,
          dryRun: false
        }
      },
      "POST /api/migrate/rollback": {
        description: "Rollback migration from backup",
        parameters: {
          backupCollectionName: "string (required) - Name of backup collection"
        },
        example: {
          backupCollectionName: "knowledge_base_backup_1234567890"
        }
      }
    },
    migrationStrategies: {
      "preserveData: true": "Re-embeds all existing documents with the new embedding model. Slower but preserves all data.",
      "preserveData: false": "Simply recreates the collection with new dimensions. Fast but loses all existing data."
    },
    commonScenarios: {
      "Check migration status": "GET /api/migrate/status",
      "Dry run migration": "POST /api/migrate/collection with dryRun: true",
      "Full migration with data preservation": "POST /api/migrate/collection with preserveData: true",
      "Quick migration (data loss)": "POST /api/migrate/collection with preserveData: false",
      "Rollback to previous state": "POST /api/migrate/rollback with backup collection name"
    },
    notes: [
      "Always check migration status first",
      "Consider doing a dry run before actual migration",
      "Backup collections are automatically created when preserveData is true",
      "Migration can take time depending on the number of documents",
      "Rollback is only possible if a backup was created during migration"
    ]
  };

  res.status(200).json(helpInfo);
};

/**
 * List available backup collections
 * GET /api/migrate/backups
 */
export const listBackupCollections = async (req: Request, res: Response) => {
  try {
    // This would require access to Qdrant client, so we'll implement it in the migration service
    // For now, return a placeholder response
    res.status(200).json({
      message: "Backup listing functionality will be implemented in migration service",
      note: "Backup collections follow the pattern: {collection_name}_backup_{timestamp}"
    });
  } catch (error) {
    console.error('Error listing backup collections:', error);
    res.status(500).json({ 
      error: 'Failed to list backup collections',
      details: String(error)
    });
  }
};
