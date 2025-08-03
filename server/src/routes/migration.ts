import express from 'express';
import {
  getCollectionInfo,
  checkMigrationStatus,
  migrateCollection,
  createManualBackup,
  rollbackMigration,
  getMigrationHelp,
  listAllCollections,
  listBackupCollections
} from '../controllers/migration';

const router = express.Router();

// GET /api/migrate/info - Get collection information
router.get('/info', getCollectionInfo);

// GET /api/migrate/status - Check if migration is needed
router.get('/status', checkMigrationStatus);

// GET /api/migrate/help - Get migration documentation
router.get('/help', getMigrationHelp);

// GET /api/migrate/collections - List all collections
router.get('/collections', listAllCollections);

// GET /api/migrate/backups - List available backup collections
router.get('/backups', listBackupCollections);

// POST /api/migrate/collection - Perform collection migration
router.post('/collection', migrateCollection);

// POST /api/migrate/backup - Create manual backup
router.post('/backup', createManualBackup);

// POST /api/migrate/rollback - Rollback migration from backup
router.post('/rollback', rollbackMigration);

export default router;
