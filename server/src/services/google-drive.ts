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
  try {
    console.log('Creating Drive client with access token...');
    const oauth2Client = await getClientWithAccessToken(accessToken);
    if (!oauth2Client) {
      throw new Error('Invalid access token');
    }

    const drive = google.drive({
      version: 'v3',
      auth: oauth2Client
    });

    // Test the connection by making a simple API call
    console.log('Testing Drive API connection...');
    await drive.about.get({ fields: 'user' });
    console.log('Drive API connection successful');

    return drive;
  } catch (error) {
    console.error('Error creating Drive client:', error);
    if (error instanceof Error) {
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
    }
    throw error;
  }
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

export interface RenameResult {
  success: boolean;
  renamedFiles: { original: string; new: string }[];
  skippedFiles: string[];
  errors: string[];
}

/**
 * Extract Folder ID from Google Drive URL
 */
export const extractFolderIdFromUrl = (url: string): string | null => {
  // Pattern 1: https://drive.google.com/drive/folders/FOLDER_ID
  // Pattern 2: https://drive.google.com/drive/u/0/folders/FOLDER_ID
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // If the input is just the ID (not a URL), return it
  if (/^[a-zA-Z0-9_-]+$/.test(url)) {
    return url;
  }

  return null;
};

/**
 * Rename files in Google Drive folder based on YouTube Video ID in filename
 */
/**
 * Rename files in Google Drive folder based on YouTube Video ID in filename
 * Orders files by YouTube publish date and adds numeric prefix (00_, 01_, etc.)
 */
export const renameFilesInDrive = async (
  folderId: string,
  userId: string,
  accessToken?: string
): Promise<RenameResult> => {
  const result: RenameResult = {
    success: false,
    renamedFiles: [],
    skippedFiles: [],
    errors: []
  };

  try {
    // 1. Get authenticated clients
    const driveClient = userId
      ? await getDriveClient(userId)
      : await getDriveClientWithToken(accessToken!);

    // Create YouTube client for batch fetching
    const oauth2Client = userId
      ? await getAuthenticatedClient(userId)
      : await getClientWithAccessToken(accessToken!);

    if (!oauth2Client) {
      throw new Error('Failed to create authenticated YouTube client');
    }

    const youtube = google.youtube({
      version: 'v3',
      auth: oauth2Client
    });

    // 2. List all files in the folder
    let files: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: any = await driveClient.files.list({
        // q: `'${folderId}' in parents and trashed=false`, // Removed mimeType filter to get all files
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id, name, mimeType)',
        pageToken: pageToken
      });

      if (response.data.files) {
        files = files.concat(response.data.files);
      }
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    console.log(`Found ${files.length} files in folder ${folderId}`);

    // 3. Identify YouTube files and extract IDs
    const matchedFiles: { file: any; videoId: string; extension: string; originalName: string }[] = [];

    // Regex for ID at Start: 11 chars + something + ext
    const prefixRegex = /^([a-zA-Z0-9_-]{11})(.*)(\.[a-zA-Z0-9]+)$/;
    // Regex for ID at End: something + _ + 11 chars + ext
    const suffixRegex = /.*_([a-zA-Z0-9_-]{11})(\.[a-zA-Z0-9]+)$/;

    for (const file of files) {
      let videoId: string | null = null;
      let extension: string | null = null;

      // Try matching prefix first (yt-dlp uses ID_Title.ext format)
      const prefixMatch = file.name.match(prefixRegex);
      if (prefixMatch) {
        videoId = prefixMatch[1];
        extension = prefixMatch[3];
      } else {
        // Try matching suffix logic as fallback
        const suffixMatch = file.name.match(suffixRegex);
        if (suffixMatch) {
          videoId = suffixMatch[1];
          extension = suffixMatch[2];
        }
      }

      if (videoId && extension) {
        matchedFiles.push({
          file,
          videoId: videoId,
          extension: extension,
          originalName: file.name
        });
      } else {
        console.log(`Skipping file ${file.name} - could not extract YouTube ID`);
        result.skippedFiles.push(file.name);
      }
    }

    if (matchedFiles.length === 0) {
      console.log('No files matched the YouTube ID pattern.');
      // Return success=true because we successfully processed (skipped) all files?
      result.success = true;
      return result;
    }

    console.log(`Found ${matchedFiles.length} matched files to process.`);

    // 4. Batch fetch video details
    const videoDetailsMap = new Map<string, { title: string; publishedAt: string }>();
    const videoIds = matchedFiles.map(i => i.videoId);

    // Chunk IDs into batches of 50
    const chunkSize = 50;
    for (let i = 0; i < videoIds.length; i += chunkSize) {
      const batchIds = videoIds.slice(i, i + chunkSize);

      try {
        const videoResponse = await youtube.videos.list({
          part: ['snippet'],
          id: batchIds
        });

        if (videoResponse.data.items) {
          for (const item of videoResponse.data.items) {
            if (item.id && item.snippet) {
              videoDetailsMap.set(item.id, {
                title: item.snippet.title || `Video ${item.id}`,
                publishedAt: item.snippet.publishedAt || '' // ISO date string
              });
            }
          }
        }
      } catch (err) {
        console.error('Error fetching video batch details:', err);
        // Continue, will handle missing details later
      }
    }

    // 5. Sort matched files by publish date
    // If date missing, put at the end? Or beginning?
    matchedFiles.sort((a, b) => {
      const detailsA = videoDetailsMap.get(a.videoId);
      const detailsB = videoDetailsMap.get(b.videoId);

      const dateA = detailsA?.publishedAt || '9999-99-99'; // Missing dates go last
      const dateB = detailsB?.publishedAt || '9999-99-99';

      return dateA.localeCompare(dateB);
    });

    // 6. Rename files with index prefix
    for (let i = 0; i < matchedFiles.length; i++) {
      const item = matchedFiles[i];
      const details = videoDetailsMap.get(item.videoId);

      try {
        if (!details) {
          throw new Error('Could not fetch video details from YouTube');
        }

        // Sanitize title
        const safeTitle = details.title.replace(/[\/\\]/g, '_');

        // Format index: 01_, 02_, ... 10_, etc.
        const indexPrefix = (i + 1).toString().padStart(2, '0');

        // New name format: XX_Title_ID.ext
        const newName = `${indexPrefix}_${safeTitle}_${item.videoId}${item.extension}`;

        if (item.originalName === newName) {
          console.log(`File ${item.originalName} is already named correctly. Skipping.`);
          result.skippedFiles.push(item.originalName);
          continue;
        }

        console.log(`Renaming '${item.originalName}' to '${newName}' (Date: ${details.publishedAt})`);

        await driveClient.files.update({
          fileId: item.file.id,
          requestBody: {
            name: newName
          }
        });

        result.renamedFiles.push({
          original: item.originalName,
          new: newName
        });

      } catch (err: any) {
        const msg = `Failed to process ${item.originalName} (Video ID: ${item.videoId}): ${err.message}`;
        console.error(msg);
        result.errors.push(msg);
      }
    }

    result.success = result.errors.length === 0;
    return result;

  } catch (error) {
    const errorMessage = `Rename operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    console.error(errorMessage);
    result.errors.push(errorMessage);
    return result;
  }
};
