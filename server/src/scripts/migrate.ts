#!/usr/bin/env ts-node

import { MigrationService } from '../services/migration';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const migrationService = new MigrationService();

  try {
    switch (command) {
      case 'status':
        await checkStatus(migrationService);
        break;
      
      case 'migrate':
        await runMigration(migrationService, args.slice(1));
        break;
      
      case 'rollback':
        await runRollback(migrationService, args.slice(1));
        break;
      
      case 'help':
      default:
        showHelp();
        break;
    }
  } catch (error) {
    console.error('❌ Migration script failed:', error);
    process.exit(1);
  }
}

async function checkStatus(migrationService: MigrationService) {
  console.log('🔍 Checking migration status...\n');
  
  const status = await migrationService.checkMigrationNeeded();
  
  console.log('📊 Migration Status Report:');
  console.log('─'.repeat(40));
  console.log(`Migration needed: ${status.needed ? '✅ YES' : '❌ NO'}`);
  console.log(`Current vector size: ${status.currentSize || 'Unknown'}`);
  console.log(`Target vector size: ${status.targetSize}`);
  console.log(`Reason: ${status.reason}`);
  console.log('─'.repeat(40));
  
  if (status.needed) {
    console.log('\n💡 Next steps:');
    console.log('   • Run a dry migration: npm run migrate migrate --dry-run');
    console.log('   • Run full migration: npm run migrate migrate --preserve-data');
    console.log('   • Quick migration (data loss): npm run migrate migrate --no-preserve-data');
  }
}

async function runMigration(migrationService: MigrationService, args: string[]) {
  const preserveData = !args.includes('--no-preserve-data');
  const dryRun = args.includes('--dry-run');
  const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1]) : 50;

  console.log('🚀 Starting migration...\n');
  console.log('📋 Migration Configuration:');
  console.log('─'.repeat(40));
  console.log(`Preserve data: ${preserveData ? '✅ YES' : '❌ NO'}`);
  console.log(`Dry run: ${dryRun ? '✅ YES' : '❌ NO'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('─'.repeat(40));

  if (!dryRun && !preserveData) {
    console.log('\n⚠️  WARNING: This will delete all existing data!');
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  const result = await migrationService.migrateCollection({
    preserveData,
    dryRun,
    batchSize
  });

  console.log('\n📊 Migration Result:');
  console.log('─'.repeat(40));
  console.log(`Success: ${result.success ? '✅ YES' : '❌ NO'}`);
  console.log(`Message: ${result.message}`);
  
  if (result.oldVectorSize) {
    console.log(`Old vector size: ${result.oldVectorSize}`);
  }
  if (result.newVectorSize) {
    console.log(`New vector size: ${result.newVectorSize}`);
  }
  if (result.documentsProcessed !== undefined) {
    console.log(`Documents processed: ${result.documentsProcessed}`);
  }
  if (result.backupCollectionName) {
    console.log(`Backup collection: ${result.backupCollectionName}`);
  }
  
  if (result.errors && result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(error => console.log(`   • ${error}`));
  }
  
  console.log('─'.repeat(40));

  if (result.success && !dryRun && result.backupCollectionName) {
    console.log('\n💡 Rollback information:');
    console.log(`   To rollback: npm run migrate rollback ${result.backupCollectionName}`);
  }
}

async function runRollback(migrationService: MigrationService, args: string[]) {
  const backupCollectionName = args[0];
  
  if (!backupCollectionName) {
    console.error('❌ Error: Backup collection name is required');
    console.log('Usage: npm run migrate rollback <backup_collection_name>');
    process.exit(1);
  }

  console.log(`🔄 Rolling back from backup: ${backupCollectionName}\n`);
  
  console.log('⚠️  WARNING: This will replace current data with backup data!');
  console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  const result = await migrationService.rollbackMigration(backupCollectionName);

  console.log('\n📊 Rollback Result:');
  console.log('─'.repeat(40));
  console.log(`Success: ${result.success ? '✅ YES' : '❌ NO'}`);
  console.log(`Message: ${result.message}`);
  
  if (result.documentsProcessed !== undefined) {
    console.log(`Documents restored: ${result.documentsProcessed}`);
  }
  if (result.newVectorSize) {
    console.log(`Restored vector size: ${result.newVectorSize}`);
  }
  
  if (result.errors && result.errors.length > 0) {
    console.log('\n❌ Errors:');
    result.errors.forEach(error => console.log(`   • ${error}`));
  }
  
  console.log('─'.repeat(40));
}

function showHelp() {
  console.log('🔧 Vector Database Migration Tool\n');
  
  console.log('Usage:');
  console.log('  npm run migrate <command> [options]\n');
  
  console.log('Commands:');
  console.log('  status                     Check if migration is needed');
  console.log('  migrate [options]          Run migration');
  console.log('  rollback <backup_name>     Rollback from backup');
  console.log('  help                       Show this help\n');
  
  console.log('Migration Options:');
  console.log('  --dry-run                  Perform dry run without changes');
  console.log('  --preserve-data            Re-embed existing data (default)');
  console.log('  --no-preserve-data         Delete existing data (faster)');
  console.log('  --batch-size=N             Set batch size for processing (default: 50)\n');
  
  console.log('Examples:');
  console.log('  npm run migrate status');
  console.log('  npm run migrate migrate --dry-run');
  console.log('  npm run migrate migrate --preserve-data --batch-size=25');
  console.log('  npm run migrate migrate --no-preserve-data');
  console.log('  npm run migrate rollback knowledge_base_backup_1234567890\n');
  
  console.log('Notes:');
  console.log('  • Always check status before migrating');
  console.log('  • Use dry-run to test migration without changes');
  console.log('  • Backup is automatically created when preserving data');
  console.log('  • Migration time depends on number of documents');
}

// Run the script
if (require.main === module) {
  main();
}
