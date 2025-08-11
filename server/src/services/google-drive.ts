import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import { getAuthenticatedClient, getClientWithAccessToken } from './youtube-auth';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink?: string;
  webContentLink?: string;
  parents?: string[];
}

export interface DriveFolder {
  id: string;
  name: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink?: string;
  parents?: string[];
}

export interface SyncResult {
  success: boolean;
  uploadedFiles: string[];
  skippedFiles: string[];
  errors: string[];
  folderId?: string;
  folderName?: string;
}

/**
 * Get authenticated Google Drive client using user ID
 */
export const getDriveClient = async (userId: string) => {
  const oauth2Client = await getAuthenticatedClient(userId);
  if (!oauth2Client) {
    throw new Error('Not authenticated. Please authenticate with Google first.');
  }
  
  return google.drive({
    version: 'v3',
    auth: oauth2Client
  });
};

/**
 * Get authenticated Google Drive client using access token
 */
export const getDriveClientWithToken = async (accessToken: string) => {
  const oauth2Client = await getClientWithAccessToken(accessToken);
  if (!oauth2Client) {
    throw new Error('Invalid access token');
  }
  
  return google.drive({
    version: 'v3',
    auth: oauth2Client
  });
};

/**
 * Create a folder in Google Drive
 */
export const createDriveFolder = async (
  folderName: string,
  parentFolderId?: string,
  userId?: string,
  accessToken?: string
): Promise<DriveFolder> => {
  try {
    const drive = userId 
      ? await getDriveClient(userId)
      : await getDriveClientWithToken(accessToken!);

    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentFolderId ? [parentFolderId] : undefined
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      fields: 'id, name, createdTime, modifiedTime, webViewLink, parents'
    });

    const folder = response.data;
    return {
      id: folder.id!,
      name: folder.name!,
      createdTime: folder.createdTime!,
      modifiedTime: folder.modifiedTime!,
      webViewLink: folder.webViewLink || undefined,
      parents: folder.parents || undefined
    };
  } catch (error) {
    console.error('Error creating Drive folder:', error);
    throw new Error(`Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Find or create a folder in Google Drive
 */
export const findOrCreateFolder = async (
  folderName: string,
  parentFolderId?: string,
  userId?: string,
  accessToken?: string
): Promise<DriveFolder> => {
  try {
    const drive = userId 
      ? await getDriveClient(userId)
      : await getDriveClientWithToken(accessToken!);

    // Search for existing folder
    const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const searchQuery = parentFolderId ? `${query} and '${parentFolderId}' in parents` : query;

    const response = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, createdTime, modifiedTime, webViewLink, parents)',
      pageSize: 1
    });

    if (response.data.files && response.data.files.length > 0) {
      const folder = response.data.files[0];
      return {
        id: folder.id!,
        name: folder.name!,
        createdTime: folder.createdTime!,
        modifiedTime: folder.modifiedTime!,
        webViewLink: folder.webViewLink || undefined,
        parents: folder.parents || undefined
      };
    }

    // Create folder if not found
    return await createDriveFolder(folderName, parentFolderId, userId, accessToken);
  } catch (error) {
    console.error('Error finding or creating folder:', error);
    throw new Error(`Failed to find or create folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Upload a file to Google Drive
 */
export const uploadFileToDrive = async (
  filePath: string,
  fileName: string,
  folderId?: string,
  userId?: string,
  accessToken?: string
): Promise<DriveFile> => {
  try {
    const drive = userId 
      ? await getDriveClient(userId)
      : await getDriveClientWithToken(accessToken!);

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileStats = fs.statSync(filePath);
    const mimeType = getMimeType(fileName);

    const fileMetadata = {
      name: fileName,
      parents: folderId ? [folderId] : undefined
    };

    const media = {
      mimeType,
      body: fs.createReadStream(filePath)
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink, parents'
    });

    const file = response.data;
    return {
      id: file.id!,
      name: file.name!,
      mimeType: file.mimeType!,
      size: file.size || undefined,
      createdTime: file.createdTime!,
      modifiedTime: file.modifiedTime!,
      webViewLink: file.webViewLink || undefined,
      webContentLink: file.webContentLink || undefined,
      parents: file.parents || undefined
    };
  } catch (error) {
    console.error('Error uploading file to Drive:', error);
    throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

/**
 * Check if file exists in Google Drive folder
 */
export const checkFileExists = async (
  fileName: string,
  folderId?: string,
  userId?: string,
  accessToken?: string
): Promise<DriveFile | null> => {
  try {
    const drive = userId 
      ? await getDriveClient(userId)
      : await getDriveClientWithToken(accessToken!);

    const query = `name='${fileName}' and trashed=false`;
    const searchQuery = folderId ? `${query} and '${folderId}' in parents` : query;

    const response = await drive.files.list({
      q: searchQuery,
      fields: 'files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, webContentLink, parents)',
      pageSize: 1
    });

    if (response.data.files && response.data.files.length > 0) {
      const file = response.data.files[0];
      return {
        id: file.id!,
        name: file.name!,
        mimeType: file.mimeType!,
        size: file.size || undefined,
        createdTime: file.createdTime!,
        modifiedTime: file.modifiedTime!,
        webViewLink: file.webViewLink || undefined,
        webContentLink: file.webContentLink || undefined,
        parents: file.parents || undefined
      };
    }

    return null;
  } catch (error) {
    console.error('Error checking file existence:', error);
    return null;
  }
};

/**
 * Get MIME type based on file extension
 */
const getMimeType = (fileName: string): string => {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: { [key: string]: string } = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.csv': 'text/csv',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };
  
  return mimeTypes[ext] || 'application/octet-stream';
};

/**
 * Sync files from server directory to Google Drive folder
 */
export const syncFilesToDrive = async (
  directoryType: 'uploads' | 'downloads',
  folderName: string,
  userId?: string,
  accessToken?: string,
  overwriteExisting: boolean = false
): Promise<SyncResult> => {
  const result: SyncResult = {
    success: false,
    uploadedFiles: [],
    skippedFiles: [],
    errors: []
  };

  try {
    // Get directory path
    const directoryPath = path.join(process.cwd(), directoryType);
    
    if (!fs.existsSync(directoryPath)) {
      throw new Error(`Directory not found: ${directoryPath}`);
    }

    // Find or create folder in Google Drive
    const folder = await findOrCreateFolder(folderName, undefined, userId, accessToken);
    result.folderId = folder.id;
    result.folderName = folder.name;

    // Get all files in directory
    const files = fs.readdirSync(directoryPath).filter(file => {
      const filePath = path.join(directoryPath, file);
      return fs.statSync(filePath).isFile();
    });

    console.log(`Found ${files.length} files to sync from ${directoryType} directory`);

    // Upload each file
    for (const fileName of files) {
      try {
        const filePath = path.join(directoryPath, fileName);
        
        // Check if file already exists in Drive
        if (!overwriteExisting) {
          const existingFile = await checkFileExists(fileName, folder.id, userId, accessToken);
          if (existingFile) {
            console.log(`File already exists in Drive, skipping: ${fileName}`);
            result.skippedFiles.push(fileName);
            continue;
          }
        }

        // Upload file
        console.log(`Uploading file: ${fileName}`);
        await uploadFileToDrive(filePath, fileName, folder.id, userId, accessToken);
        result.uploadedFiles.push(fileName);
        console.log(`Successfully uploaded: ${fileName}`);
      } catch (error) {
        const errorMessage = `Failed to upload ${fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        console.error(errorMessage);
        result.errors.push(errorMessage);
      }
    }

    result.success = result.errors.length === 0 || result.uploadedFiles.length > 0;
    return result;
  } catch (error) {
    const errorMessage = `Sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(errorMessage);
    result.errors.push(errorMessage);
    return result;
  }
};
