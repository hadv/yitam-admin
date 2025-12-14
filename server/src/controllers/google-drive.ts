import { Request, Response } from 'express';
import {
  syncFilesToDrive,
  findOrCreateFolder,
  uploadFileToDrive,
  checkFileExists,
  DriveFolder,
  SyncResult,
  extractFolderIdFromUrl,
  renameFilesInDrive,
  RenameResult
} from '../services/google-drive';
import { validateClientToken } from '../services/youtube-auth';

/**
 * Sync files from server directory to Google Drive
 */
export const syncFiles = async (req: Request, res: Response) => {
  try {
    const { directoryType, folderName, overwriteExisting = false } = req.body;
    const authHeader = req.headers.authorization;

    // Validate required parameters
    if (!directoryType || !folderName) {
      return res.status(400).json({
        message: 'Directory type and folder name are required',
        required: ['directoryType', 'folderName']
      });
    }

    if (directoryType !== 'uploads' && directoryType !== 'downloads') {
      return res.status(400).json({
        message: 'Directory type must be either "uploads" or "downloads"'
      });
    }

    // Extract access token from Authorization header
    let accessToken: string | undefined;
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);

      // Validate the token and get user info
      const tokenValidation = await validateClientToken(accessToken);
      if (!tokenValidation) {
        return res.status(401).json({
          message: 'Invalid or expired access token'
        });
      }
      userId = tokenValidation.userId;
    } else {
      return res.status(401).json({
        message: 'Authorization header with Bearer token is required'
      });
    }

    console.log(`Starting sync of ${directoryType} directory to Google Drive folder: ${folderName}`);

    // Perform the sync
    const result: SyncResult = await syncFilesToDrive(
      directoryType,
      folderName,
      userId,
      accessToken,
      overwriteExisting
    );

    // Return result
    res.status(200).json({
      message: result.success ? 'Sync completed successfully' : 'Sync completed with errors',
      result: {
        success: result.success,
        folderId: result.folderId,
        folderName: result.folderName,
        uploadedFiles: result.uploadedFiles,
        skippedFiles: result.skippedFiles,
        errors: result.errors,
        summary: {
          totalFiles: result.uploadedFiles.length + result.skippedFiles.length + result.errors.length,
          uploaded: result.uploadedFiles.length,
          skipped: result.skippedFiles.length,
          failed: result.errors.length
        }
      }
    });
  } catch (error) {
    console.error('Error syncing files to Google Drive:', error);
    res.status(500).json({
      message: 'Failed to sync files to Google Drive',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Create or find a folder in Google Drive
 */
export const createFolder = async (req: Request, res: Response) => {
  try {
    const { folderName, parentFolderId } = req.body;
    const authHeader = req.headers.authorization;

    if (!folderName) {
      return res.status(400).json({
        message: 'Folder name is required'
      });
    }

    // Extract access token
    let accessToken: string | undefined;
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);

      const tokenValidation = await validateClientToken(accessToken);
      if (!tokenValidation) {
        return res.status(401).json({
          message: 'Invalid or expired access token'
        });
      }
      userId = tokenValidation.userId;
    } else {
      return res.status(401).json({
        message: 'Authorization header with Bearer token is required'
      });
    }

    // Find or create the folder
    const folder: DriveFolder = await findOrCreateFolder(
      folderName,
      parentFolderId,
      userId,
      accessToken
    );

    res.status(200).json({
      message: 'Folder created or found successfully',
      folder: {
        id: folder.id,
        name: folder.name,
        createdTime: folder.createdTime,
        modifiedTime: folder.modifiedTime,
        webViewLink: folder.webViewLink,
        parents: folder.parents
      }
    });
  } catch (error) {
    console.error('Error creating/finding folder:', error);
    res.status(500).json({
      message: 'Failed to create or find folder',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Upload a single file to Google Drive
 */
export const uploadSingleFile = async (req: Request, res: Response) => {
  try {
    const { fileName, directoryType, folderId } = req.body;
    const authHeader = req.headers.authorization;

    if (!fileName || !directoryType) {
      return res.status(400).json({
        message: 'File name and directory type are required'
      });
    }

    if (directoryType !== 'uploads' && directoryType !== 'downloads') {
      return res.status(400).json({
        message: 'Directory type must be either "uploads" or "downloads"'
      });
    }

    // Extract access token
    let accessToken: string | undefined;
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);

      const tokenValidation = await validateClientToken(accessToken);
      if (!tokenValidation) {
        return res.status(401).json({
          message: 'Invalid or expired access token'
        });
      }
      userId = tokenValidation.userId;
    } else {
      return res.status(401).json({
        message: 'Authorization header with Bearer token is required'
      });
    }

    // Construct file path
    const path = require('path');
    const filePath = path.join(process.cwd(), directoryType, fileName);

    // Check if file exists locally
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        message: 'File not found on server'
      });
    }

    // Upload the file
    const driveFile = await uploadFileToDrive(
      filePath,
      fileName,
      folderId,
      userId,
      accessToken
    );

    res.status(200).json({
      message: 'File uploaded successfully',
      file: {
        id: driveFile.id,
        name: driveFile.name,
        mimeType: driveFile.mimeType,
        size: driveFile.size,
        createdTime: driveFile.createdTime,
        modifiedTime: driveFile.modifiedTime,
        webViewLink: driveFile.webViewLink,
        webContentLink: driveFile.webContentLink
      }
    });
  } catch (error) {
    console.error('Error uploading file to Google Drive:', error);
    res.status(500).json({
      message: 'Failed to upload file to Google Drive',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Check if a file exists in Google Drive
 */
export const checkFileInDrive = async (req: Request, res: Response) => {
  try {
    const { fileName, folderId } = req.query;
    const authHeader = req.headers.authorization;

    if (!fileName) {
      return res.status(400).json({
        message: 'File name is required'
      });
    }

    // Extract access token
    let accessToken: string | undefined;
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);

      const tokenValidation = await validateClientToken(accessToken);
      if (!tokenValidation) {
        return res.status(401).json({
          message: 'Invalid or expired access token'
        });
      }
      userId = tokenValidation.userId;
    } else {
      return res.status(401).json({
        message: 'Authorization header with Bearer token is required'
      });
    }

    // Check if file exists
    const existingFile = await checkFileExists(
      fileName as string,
      folderId as string,
      userId,
      accessToken
    );

    res.status(200).json({
      exists: !!existingFile,
      file: existingFile ? {
        id: existingFile.id,
        name: existingFile.name,
        mimeType: existingFile.mimeType,
        size: existingFile.size,
        createdTime: existingFile.createdTime,
        modifiedTime: existingFile.modifiedTime,
        webViewLink: existingFile.webViewLink,
        webContentLink: existingFile.webContentLink
      } : null
    });
  } catch (error) {
    console.error('Error checking file in Google Drive:', error);
    res.status(500).json({
      message: 'Failed to check file in Google Drive',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Rename files in Google Drive folder based on YouTube IDs
 */
export const renameYoutubeFiles = async (req: Request, res: Response) => {
  try {
    const { folderUrl } = req.body;
    const authHeader = req.headers.authorization;

    if (!folderUrl) {
      return res.status(400).json({
        message: 'Folder URL is required'
      });
    }

    // Extract access token
    let accessToken: string | undefined;
    let userId: string | undefined;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);

      const tokenValidation = await validateClientToken(accessToken);
      if (!tokenValidation) {
        return res.status(401).json({
          message: 'Invalid or expired access token'
        });
      }
      userId = tokenValidation.userId;
    } else {
      return res.status(401).json({
        message: 'Authorization header with Bearer token is required'
      });
    }

    // Extract folder ID
    const folderId = extractFolderIdFromUrl(folderUrl);
    if (!folderId) {
      return res.status(400).json({
        message: 'Invalid Google Drive folder URL or ID'
      });
    }

    console.log(`Starting rename process for folder: ${folderId}`);

    // Perform rename operation
    const result: RenameResult = await renameFilesInDrive(
      folderId,
      userId,
      accessToken
    );

    res.status(200).json({
      message: result.success ? 'Rename operation completed successfully' : 'Rename operation completed with errors',
      result
    });

  } catch (error) {
    console.error('Error renaming files:', error);
    res.status(500).json({
      message: 'Failed to rename files',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
