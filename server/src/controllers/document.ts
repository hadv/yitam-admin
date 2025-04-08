import { Request, Response } from 'express';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createEmbedding } from '../services/embedding';
import { parseDocument } from '../services/document';
import { DatabaseService } from '../core/database-service';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

// Upload a document, parse it, and store its vector embedding
export const uploadDocument = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Parse the uploaded document
    const fileContent = await parseDocument(req.file.path, req.file.mimetype);
    
    // Create vector embedding
    const embedding = await createEmbedding(fileContent);
    
    // Generate a preview (first ~100 characters)
    const textPreview = fileContent.length > 100 
      ? fileContent.substring(0, 100) + '...' 
      : fileContent;
    
    // Get domains from request body (if provided)
    const domains = req.body.domains ? 
      (Array.isArray(req.body.domains) ? req.body.domains : JSON.parse(req.body.domains)) : 
      [];
    
    // Store document with embedding - use UUID instead of filename to avoid special character issues
    const document = {
      id: uuidv4(),
      filename: req.file.originalname,
      path: req.file.path,
      contentType: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
      preview: textPreview,
      domains: domains,
    };

    await dbService.addDocument(document, embedding);
    
    res.status(200).json({ 
      message: 'Document uploaded and embedded successfully',
      document
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    res.status(500).json({ message: 'Failed to upload and process document' });
  }
};

// Get all documents
export const getDocuments = async (req: Request, res: Response) => {
  try {
    const documents = await dbService.getAllDocuments();
    res.status(200).json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ message: 'Failed to fetch documents' });
  }
};

// Search documents using semantic similarity
export const searchDocuments = async (req: Request, res: Response) => {
  try {
    const { query } = req.query;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'Search query is required' });
    }
    
    // Create embedding for the query
    const queryEmbedding = await createEmbedding(query);
    
    // Search using vector similarity
    const searchResults = await dbService.searchByVector(queryEmbedding);
    
    res.status(200).json(searchResults);
  } catch (error) {
    console.error('Error searching documents:', error);
    res.status(500).json({ message: 'Failed to search documents' });
  }
};

// Delete a document
export const deleteDocument = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Delete from database
    await dbService.deleteDocument(id);
    
    // Find the file path
    const documents = await dbService.getAllDocuments();
    const doc = documents.find(doc => doc.id === id);
    
    // Delete the file if it exists
    if (doc && doc.path && fs.existsSync(doc.path)) {
      fs.unlinkSync(doc.path);
    }
    
    res.status(200).json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ message: 'Failed to delete document' });
  }
}; 