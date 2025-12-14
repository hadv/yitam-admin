import express from 'express';
import {
  syncFiles,
  createFolder,
  uploadSingleFile,
  checkFileInDrive,
  renameYoutubeFiles
} from '../controllers/google-drive';

const router = express.Router();

/**
 * @route POST /api/google-drive/sync
 * @desc Sync files from server directory to Google Drive folder
 * @body directoryType - Directory to sync ('uploads' or 'downloads')
 * @body folderName - Name of the Google Drive folder to sync to
 * @body overwriteExisting - Whether to overwrite existing files (optional, default: false)
 * @header Authorization - Bearer token for Google authentication
 */
router.post('/sync', syncFiles);

/**
 * @route POST /api/google-drive/folder
 * @desc Create or find a folder in Google Drive
 * @body folderName - Name of the folder to create/find
 * @body parentFolderId - ID of parent folder (optional)
 * @header Authorization - Bearer token for Google authentication
 */
router.post('/folder', createFolder);

/**
 * @route POST /api/google-drive/upload
 * @desc Upload a single file to Google Drive
 * @body fileName - Name of the file to upload
 * @body directoryType - Directory where file is located ('uploads' or 'downloads')
 * @body folderId - ID of Google Drive folder to upload to (optional)
 * @header Authorization - Bearer token for Google authentication
 */
router.post('/upload', uploadSingleFile);

/**
 * @route GET /api/google-drive/check
 * @desc Check if a file exists in Google Drive
 * @query fileName - Name of the file to check
 * @query folderId - ID of Google Drive folder to check in (optional)
 * @header Authorization - Bearer token for Google authentication
 */
router.get('/check', checkFileInDrive);

/**
 * @route POST /api/google-drive/rename-youtube-files
 * @desc Rename files in Google Drive folder based on YouTube IDs
 * @body folderUrl - URL or ID of the Google Drive folder
 * @header Authorization - Bearer token for Google authentication
 */
router.post('/rename-youtube-files', renameYoutubeFiles);

export default router;
