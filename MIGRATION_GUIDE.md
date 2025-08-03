# Vector Database Migration Guide

This guide explains how to handle vector database migrations when changing embedding models or vector dimensions.

## Problem

When switching from one embedding model to another (e.g., from a 384-dimensional model to Gemini's 768-dimensional model), existing vectors in your Qdrant database become incompatible with the new embedding model. This causes:

- Vector dimension mismatches
- Search failures
- Inability to add new documents
- API errors when querying the database

## Solution

The migration system provides automated tools to handle embedding model transitions safely and efficiently.

## Quick Start

### 1. Check Migration Status

First, check if migration is needed:

```bash
cd server
npm run migrate status
```

This will show:
- Current vector dimensions in your database
- Target vector dimensions for the new model
- Whether migration is required

### 2. Run Migration

#### Option A: Preserve Existing Data (Recommended)
```bash
npm run migrate migrate --preserve-data
```

This will:
- Create a backup of your existing data
- Re-embed all documents with the new model
- Preserve all your existing content

#### Option B: Quick Migration (Data Loss)
```bash
npm run migrate migrate --no-preserve-data
```

This will:
- Delete existing data
- Recreate the collection with new dimensions
- Much faster but loses all existing documents

#### Option C: Dry Run (Test First)
```bash
npm run migrate migrate --dry-run
```

This will:
- Show what would happen without making changes
- Validate the migration process
- Recommended before running actual migration

### 3. Rollback if Needed

If something goes wrong, you can rollback to the backup:

```bash
npm run migrate rollback <backup_collection_name>
```

The backup collection name is shown in the migration output.

## API Endpoints

You can also use the REST API for migration:

### Check Status
```http
GET /api/migrate/status
```

### Run Migration
```http
POST /api/migrate/collection
Content-Type: application/json

{
  "preserveData": true,
  "batchSize": 50,
  "dryRun": false
}
```

### Rollback
```http
POST /api/migrate/rollback
Content-Type: application/json

{
  "backupCollectionName": "knowledge_base_backup_1234567890"
}
```

### Get Help
```http
GET /api/migrate/help
```

## Migration Strategies

### 1. Data Preservation Strategy (`preserveData: true`)

**Best for:** Production environments where data loss is unacceptable

**Process:**
1. Creates backup collection with old vector dimensions
2. Exports all existing documents
3. Copies documents to backup
4. Recreates main collection with new dimensions
5. Re-embeds all documents with new embedding model
6. Stores re-embedded documents in new collection

**Pros:**
- No data loss
- All existing content preserved
- Automatic backup creation
- Rollback capability

**Cons:**
- Slower (requires re-embedding all documents)
- Uses more storage temporarily
- Requires API calls to embedding service

### 2. Quick Recreation Strategy (`preserveData: false`)

**Best for:** Development environments or when starting fresh

**Process:**
1. Deletes existing collection
2. Creates new collection with new dimensions
3. Ready for new documents

**Pros:**
- Very fast
- Minimal storage usage
- Simple process

**Cons:**
- Complete data loss
- No rollback capability
- All existing documents deleted

## Configuration Options

### Environment Variables

Make sure these are set in your `.env` file:

```bash
# Vector size for new embedding model
GEMINI_VECTOR_SIZE=768

# Qdrant configuration
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your_api_key
COLLECTION_NAME=knowledge_base

# Gemini API for re-embedding
GEMINI_API_KEY=your_gemini_api_key
```

### Migration Options

| Option | Default | Description |
|--------|---------|-------------|
| `preserveData` | `true` | Whether to re-embed existing data |
| `batchSize` | `50` | Number of documents to process at once |
| `backupCollectionName` | Auto-generated | Custom backup collection name |
| `dryRun` | `false` | Test migration without making changes |

## Troubleshooting

### Common Issues

#### 1. "Vector dimension mismatch" errors
**Solution:** Run the migration to update vector dimensions

#### 2. "Collection already exists" during migration
**Solution:** The migration handles this automatically

#### 3. "Embedding API rate limits"
**Solution:** Reduce batch size: `--batch-size=10`

#### 4. "Out of memory" during large migrations
**Solution:** Reduce batch size and ensure sufficient system memory

#### 5. Migration fails partway through
**Solution:** Check logs for specific errors, then rollback and retry

### Monitoring Migration Progress

The migration process provides detailed logging:

```
🔄 Starting collection migration (dry run: false)
   Preserve data: true
   Batch size: 50
   Backup collection: knowledge_base_backup_1234567890

📦 Creating backup and re-embedding documents...
📋 Creating backup collection: knowledge_base_backup_1234567890
📄 Found 1250 documents to migrate
💾 Copying 1250 documents to backup...
🔄 Recreating collection with new dimensions...
🧠 Re-embedding documents with new model...
   Processed 50/1250 documents
   Processed 100/1250 documents
   ...
```

### Performance Considerations

- **Large datasets:** Use smaller batch sizes (10-25) to avoid memory issues
- **API rate limits:** Monitor embedding API usage and adjust batch size
- **Storage:** Ensure sufficient disk space for backup collections
- **Time:** Re-embedding can take significant time for large document collections

## Best Practices

1. **Always check status first:** `npm run migrate status`
2. **Test with dry run:** `npm run migrate migrate --dry-run`
3. **Backup important data:** The system creates backups, but consider additional backups
4. **Monitor during migration:** Watch logs for errors or performance issues
5. **Verify after migration:** Test search functionality with new embeddings
6. **Clean up backups:** Remove old backup collections when no longer needed

## Recovery Procedures

### If Migration Fails

1. **Check the error logs** for specific failure reasons
2. **Rollback to backup** if data preservation was used:
   ```bash
   npm run migrate rollback <backup_collection_name>
   ```
3. **Fix the underlying issue** (API keys, network, etc.)
4. **Retry migration** with adjusted parameters

### If Rollback Fails

1. **Manual collection recreation:**
   - Delete corrupted collection via Qdrant API
   - Recreate with correct dimensions
   - Re-upload documents manually

2. **Restore from external backup** if available

## Support

For issues with the migration system:

1. Check the logs for detailed error messages
2. Verify environment variables are correctly set
3. Ensure Qdrant and embedding services are accessible
4. Review this guide for common solutions

The migration system is designed to be safe and recoverable, but always test in a development environment first when possible.
