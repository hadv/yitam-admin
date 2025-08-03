import fs from 'fs';
import path from 'path';

export interface ServerFile {
  fileName: string;
  filePath: string;
  relativePath: string;
  size: number;
  createdAt: Date;
  modifiedAt: Date;
  type: 'document' | 'video' | 'unknown';
  extension: string;
  directory: 'uploads' | 'downloads';
}

// Define file type mappings
const FILE_TYPE_MAPPINGS = {
  // Document types
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  txt: 'document',
  rtf: 'document',
  odt: 'document',
  
  // Image types (treated as documents for OCR)
  jpg: 'document',
  jpeg: 'document',
  png: 'document',
  gif: 'document',
  bmp: 'document',
  tiff: 'document',
  webp: 'document',
  
  // Video types
  mp4: 'video',
  webm: 'video',
  flv: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  mkv: 'video',
  
  // Audio types (treated as video for simplicity)
  mp3: 'video',
  wav: 'video',
  aac: 'video',
  flac: 'video',
  ogg: 'video'
} as const;

/**
 * Get file type based on extension
 */
const getFileType = (extension: string): ServerFile['type'] => {
  const ext = extension.toLowerCase().replace('.', '');
  return FILE_TYPE_MAPPINGS[ext as keyof typeof FILE_TYPE_MAPPINGS] || 'unknown';
};

/**
 * Get all files from a directory
 */
const getFilesFromDirectory = (
  dirPath: string, 
  directoryType: 'uploads' | 'downloads'
): ServerFile[] => {
  try {
    if (!fs.existsSync(dirPath)) {
      console.warn(`Directory does not exist: ${dirPath}`);
      return [];
    }

    const files = fs.readdirSync(dirPath);
    return files
      .filter(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        return stats.isFile(); // Only include files, not directories
      })
      .map(file => {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        const extension = path.extname(file);
        
        return {
          fileName: file,
          filePath,
          relativePath: path.relative(process.cwd(), filePath),
          size: stats.size,
          createdAt: stats.birthtime,
          modifiedAt: stats.mtime,
          type: getFileType(extension),
          extension: extension.toLowerCase(),
          directory: directoryType
        };
      });
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error);
    return [];
  }
};

/**
 * Get all server files from both uploads and downloads directories
 */
export const getAllServerFiles = (): ServerFile[] => {
  const uploadsDir = path.join(process.cwd(), 'uploads');
  const downloadsDir = path.join(process.cwd(), 'downloads');
  
  const uploadFiles = getFilesFromDirectory(uploadsDir, 'uploads');
  const downloadFiles = getFilesFromDirectory(downloadsDir, 'downloads');
  
  // Combine and sort by modification date (newest first)
  const allFiles = [...uploadFiles, ...downloadFiles];
  return allFiles.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
};

/**
 * Get files filtered by type
 */
export const getFilesByType = (type: ServerFile['type']): ServerFile[] => {
  return getAllServerFiles().filter(file => file.type === type);
};

/**
 * Get files filtered by directory
 */
export const getFilesByDirectory = (directory: 'uploads' | 'downloads'): ServerFile[] => {
  return getAllServerFiles().filter(file => file.directory === directory);
};

/**
 * Search files by name
 */
export const searchFilesByName = (searchTerm: string): ServerFile[] => {
  const normalizedTerm = searchTerm.toLowerCase().trim();
  if (!normalizedTerm) {
    return getAllServerFiles();
  }
  
  return getAllServerFiles().filter(file => 
    file.fileName.toLowerCase().includes(normalizedTerm)
  );
};

/**
 * Get file statistics
 */
export const getFileStatistics = () => {
  const allFiles = getAllServerFiles();
  
  const stats = {
    total: allFiles.length,
    byType: {
      document: allFiles.filter(f => f.type === 'document').length,
      video: allFiles.filter(f => f.type === 'video').length,
      unknown: allFiles.filter(f => f.type === 'unknown').length
    },
    byDirectory: {
      uploads: allFiles.filter(f => f.directory === 'uploads').length,
      downloads: allFiles.filter(f => f.directory === 'downloads').length
    },
    totalSize: allFiles.reduce((sum, file) => sum + file.size, 0),
    averageSize: allFiles.length > 0 ? allFiles.reduce((sum, file) => sum + file.size, 0) / allFiles.length : 0
  };
  
  return stats;
};

/**
 * Delete a file
 */
export const deleteServerFile = (fileName: string, directory: 'uploads' | 'downloads'): boolean => {
  try {
    const dirPath = path.join(process.cwd(), directory);
    const filePath = path.join(dirPath, fileName);
    
    if (!fs.existsSync(filePath)) {
      console.warn(`File not found: ${filePath}`);
      return false;
    }
    
    // Security check: ensure the file is within the expected directory
    const resolvedPath = path.resolve(filePath);
    const resolvedDir = path.resolve(dirPath);
    
    if (!resolvedPath.startsWith(resolvedDir)) {
      console.error(`Security violation: Attempted to delete file outside directory: ${filePath}`);
      return false;
    }
    
    fs.unlinkSync(filePath);
    console.log(`Successfully deleted file: ${fileName} from ${directory}`);
    return true;
  } catch (error) {
    console.error(`Error deleting file ${fileName} from ${directory}:`, error);
    return false;
  }
};

/**
 * Get file path for serving
 */
export const getServerFilePath = (fileName: string, directory: 'uploads' | 'downloads'): string | null => {
  const dirPath = path.join(process.cwd(), directory);
  const filePath = path.join(dirPath, fileName);
  
  // Security check: ensure the file is within the expected directory
  const resolvedPath = path.resolve(filePath);
  const resolvedDir = path.resolve(dirPath);
  
  if (!resolvedPath.startsWith(resolvedDir)) {
    console.error(`Security violation: Attempted to access file outside directory: ${filePath}`);
    return null;
  }
  
  return fs.existsSync(filePath) ? filePath : null;
};
