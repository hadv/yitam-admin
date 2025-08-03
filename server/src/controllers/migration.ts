import { Request, Response } from 'express';
import { MigrationService, MigrationOptions } from '../services/migration';

// Create a singleton instance of the migration service
const migrationService = new MigrationService();

/**
 * Get collection information
 * GET /api/migrate/info
 */
export const getCollectionInfo = async (req: Request, res: Response) => {
  try {
    const info = await migrationService.getCollectionInfo();

    res.status(200).json({
      ...info,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting collection info:', error);
    res.status(500).json({
      error: 'Failed to get collection info',
      details: String(error)
    });
  }
};

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
 * - forceReEmbed: boolean (default: false) - Force re-embedding even if dimensions match
 * - newCollectionName: string (optional) - Create new collection instead of replacing existing
 */
export const migrateCollection = async (req: Request, res: Response) => {
  try {
    const options: MigrationOptions = {
      preserveData: req.body.preserveData !== false, // Default to true
      batchSize: parseInt(req.body.batchSize) || 50,
      backupCollectionName: req.body.backupCollectionName,
      dryRun: req.body.dryRun === true,
      forceReEmbed: req.body.forceReEmbed === true,
      newCollectionName: req.body.newCollectionName
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
 * Create manual backup of current collection
 * POST /api/migrate/backup
 *
 * Body parameters:
 * - backupCollectionName: string (optional) - Custom backup collection name
 */
export const createManualBackup = async (req: Request, res: Response) => {
  try {
    const { backupCollectionName } = req.body;

    console.log(`📋 Manual backup request received${backupCollectionName ? ` for: ${backupCollectionName}` : ''}`);

    const result = await migrationService.createManualBackup(backupCollectionName);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        details: {
          backupCollectionName: result.backupCollectionName,
          documentsBackedUp: result.documentsBackedUp,
          timestamp: new Date().toISOString()
        }
      });
    } else {
      res.status(500).json({
        success: false,
        message: result.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Manual backup failed with unexpected error:', error);
    res.status(500).json({
      success: false,
      error: 'Manual backup failed with unexpected error',
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
 * List all collections including backups
 * GET /api/migrate/collections
 */
export const listAllCollections = async (req: Request, res: Response) => {
  try {
    const collections = await migrationService.listAllCollections();

    res.status(200).json({
      collections,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error listing collections:', error);
    res.status(500).json({
      error: 'Failed to list collections',
      details: String(error)
    });
  }
};

/**
 * List available backup collections
 * GET /api/migrate/backups
 */
export const listBackupCollections = async (req: Request, res: Response) => {
  try {
    const collections = await migrationService.listAllCollections();
    const backups = collections.filter(c => c.isBackup);

    res.status(200).json({
      backups,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error listing backup collections:', error);
    res.status(500).json({
      error: 'Failed to list backup collections',
      details: String(error)
    });
  }
};
