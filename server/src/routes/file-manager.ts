import express from 'express';
import {
  listAllFiles,
  getFileStats,
  deleteFile,
  serveFile,
  getFileDetails
} from '../controllers/file-manager';

const router = express.Router();

/**
 * @route GET /api/files
 * @desc Get all server files with optional filtering
 * @query type - Filter by file type (document, video, unknown)
 * @query directory - Filter by directory (uploads, downloads)
 * @query search - Search files by name
 * @query limit - Limit number of results
 */
router.get('/', listAllFiles);

/**
 * @route GET /api/files/stats
 * @desc Get file statistics
 */
router.get('/stats', getFileStats);

/**
 * @route GET /api/files/:fileName
 * @desc Get file details
 * @query directory - File directory (uploads, downloads) - required
 */
router.get('/:fileName/details', getFileDetails);

/**
 * @route GET /api/files/:fileName/serve
 * @desc Serve/download a file
 * @query directory - File directory (uploads, downloads) - required
 * @query download - Set to 'true' to force download, otherwise try to display inline
 */
router.get('/:fileName/serve', serveFile);

/**
 * @route DELETE /api/files/:fileName
 * @desc Delete a file
 * @query directory - File directory (uploads, downloads) - required
 */
router.delete('/:fileName', deleteFile);

export default router;
