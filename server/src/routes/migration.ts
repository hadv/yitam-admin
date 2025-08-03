import express from 'express';
import { 
  checkMigrationStatus, 
  migrateCollection, 
  rollbackMigration, 
  getMigrationHelp,
  listBackupCollections 
} from '../controllers/migration';

const router = express.Router();

// GET /api/migrate/status - Check if migration is needed
router.get('/status', checkMigrationStatus);

// GET /api/migrate/help - Get migration documentation
router.get('/help', getMigrationHelp);

// GET /api/migrate/backups - List available backup collections
router.get('/backups', listBackupCollections);

// POST /api/migrate/collection - Perform collection migration
router.post('/collection', migrateCollection);

// POST /api/migrate/rollback - Rollback migration from backup
router.post('/rollback', rollbackMigration);

export default router;
