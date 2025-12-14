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
  folderId?: string;
  folderName?: string;
  uploadedFiles: string[];
  skippedFiles: string[];
  errors: string[];
  summary: {
    totalFiles: number;
    uploaded: number;
    skipped: number;
    failed: number;
  };
}

export interface SyncRequest {
  directoryType: 'uploads' | 'downloads';
  folderName: string;
  overwriteExisting?: boolean;
}

export interface CreateFolderRequest {
  folderName: string;
  parentFolderId?: string;
}

export interface UploadFileRequest {
  fileName: string;
  directoryType: 'uploads' | 'downloads';
  folderId?: string;
}

export interface CheckFileRequest {
  fileName: string;
  folderId?: string;
}

export interface GoogleDriveApiResponse<T> {
  message: string;
  result?: T;
  folder?: DriveFolder;
  file?: DriveFile;
  exists?: boolean;
  error?: string;
}

export interface RenameResult {
  success: boolean;
  renamedFiles: { original: string; new: string }[];
  skippedFiles: string[];
  errors: string[];
}

export interface RenameRequest {
  folderUrl: string;
}
