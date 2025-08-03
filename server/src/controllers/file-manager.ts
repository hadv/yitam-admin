import { Request, Response } from 'express';
import {
  getAllServerFiles,
  getFilesByType,
  getFilesByDirectory,
  searchFilesByName,
  getFileStatistics,
  deleteServerFile,
  getServerFilePath,
  ServerFile
} from '../services/file-manager';
import path from 'path';
import fs from 'fs';

/**
 * Get all server files with optional filtering
 */
export const listAllFiles = async (req: Request, res: Response) => {
  try {
    const { type, directory, search, limit } = req.query;
    
    let files: ServerFile[] = [];
    
    // Apply filters based on query parameters
    if (search && typeof search === 'string') {
      files = searchFilesByName(search);
    } else if (type && typeof type === 'string') {
      if (type === 'document' || type === 'video' || type === 'unknown') {
        files = getFilesByType(type);
      } else {
        return res.status(400).json({ 
          message: 'Invalid type parameter. Must be: document, video, or unknown' 
        });
      }
    } else if (directory && typeof directory === 'string') {
      if (directory === 'uploads' || directory === 'downloads') {
        files = getFilesByDirectory(directory);
      } else {
        return res.status(400).json({ 
          message: 'Invalid directory parameter. Must be: uploads or downloads' 
        });
      }
    } else {
      files = getAllServerFiles();
    }
    
    // Apply limit if specified
    const fileLimit = limit && !isNaN(Number(limit)) ? Number(limit) : 0;
    const limitedFiles = fileLimit > 0 ? files.slice(0, fileLimit) : files;
    
    // Get statistics
    const stats = getFileStatistics();
    
    res.status(200).json({
      files: limitedFiles,
      total: files.length,
      hasMore: fileLimit > 0 && files.length > fileLimit,
      statistics: stats
    });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ 
      message: 'Failed to list files',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get file statistics only
 */
export const getFileStats = async (req: Request, res: Response) => {
  try {
    const stats = getFileStatistics();
    res.status(200).json(stats);
  } catch (error) {
    console.error('Error getting file statistics:', error);
    res.status(500).json({ 
      message: 'Failed to get file statistics',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Delete a file
 */
export const deleteFile = async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;
    const { directory } = req.query;
    
    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }
    
    if (!directory || (directory !== 'uploads' && directory !== 'downloads')) {
      return res.status(400).json({ 
        message: 'Directory parameter is required and must be either "uploads" or "downloads"' 
      });
    }
    
    const success = deleteServerFile(fileName, directory as 'uploads' | 'downloads');
    
    if (success) {
      res.status(200).json({
        message: 'File deleted successfully',
        fileName,
        directory
      });
    } else {
      res.status(404).json({
        message: 'File not found or could not be deleted',
        fileName,
        directory
      });
    }
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ 
      message: 'Failed to delete file',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Serve/download a file
 */
export const serveFile = async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;
    const { directory, download } = req.query;
    
    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }
    
    if (!directory || (directory !== 'uploads' && directory !== 'downloads')) {
      return res.status(400).json({ 
        message: 'Directory parameter is required and must be either "uploads" or "downloads"' 
      });
    }
    
    const filePath = getServerFilePath(fileName, directory as 'uploads' | 'downloads');
    
    if (!filePath) {
      return res.status(404).json({
        message: 'File not found',
        fileName,
        directory
      });
    }
    
    // Get file stats for headers
    const stats = fs.statSync(filePath);
    const fileSize = stats.size;
    const extension = path.extname(fileName).toLowerCase();
    
    // Set appropriate headers
    const isDownload = download === 'true';
    
    if (isDownload) {
      // Force download
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    } else {
      // Try to display inline for supported types
      if (['.pdf', '.txt', '.jpg', '.jpeg', '.png', '.gif', '.mp4', '.webm'].includes(extension)) {
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);
      } else {
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      }
    }
    
    // Set content type based on extension
    const mimeTypes: { [key: string]: string } = {
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav'
    };
    
    const contentType = mimeTypes[extension] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', fileSize);
    
    // Handle range requests for video streaming
    const range = req.headers.range;
    if (range && (extension === '.mp4' || extension === '.webm')) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      
      const stream = fs.createReadStream(filePath, { start, end });
      
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      });
      
      stream.pipe(res);
    } else {
      // Regular file serving
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    }
  } catch (error) {
    console.error('Error serving file:', error);
    res.status(500).json({ 
      message: 'Failed to serve file',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};

/**
 * Get file details
 */
export const getFileDetails = async (req: Request, res: Response) => {
  try {
    const { fileName } = req.params;
    const { directory } = req.query;
    
    if (!fileName) {
      return res.status(400).json({ message: 'File name is required' });
    }
    
    if (!directory || (directory !== 'uploads' && directory !== 'downloads')) {
      return res.status(400).json({ 
        message: 'Directory parameter is required and must be either "uploads" or "downloads"' 
      });
    }
    
    const allFiles = getAllServerFiles();
    const file = allFiles.find(f => f.fileName === fileName && f.directory === directory);
    
    if (!file) {
      return res.status(404).json({
        message: 'File not found',
        fileName,
        directory
      });
    }
    
    res.status(200).json(file);
  } catch (error) {
    console.error('Error getting file details:', error);
    res.status(500).json({ 
      message: 'Failed to get file details',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
};
