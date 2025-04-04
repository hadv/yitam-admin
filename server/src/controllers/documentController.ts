import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { createEmbedding, searchDocumentsByVector } from '../services/embeddingService.js';
import { addDocumentToQdrant, deleteDocumentFromQdrant, getAllDocuments } from '../services/qdrantService.js';
import { parseDocument } from '../services/documentParserService.js';

// Upload a document, parse it, and store its vector embedding in Qdrant
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
    
    // Store in Qdrant
    const document = {
      id: path.basename(req.file.path, path.extname(req.file.path)),
      filename: req.file.originalname,
      path: req.file.path,
      contentType: req.file.mimetype,
      uploadedAt: new Date().toISOString(),
      preview: textPreview,
    };

    await addDocumentToQdrant(document, embedding);
    
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
    const documents = await getAllDocuments();
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
    
    // Search in Qdrant
    const searchResults = await searchDocumentsByVector(queryEmbedding);
    
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
    
    // Delete from Qdrant
    await deleteDocumentFromQdrant(id);
    
    // Find the file path
    const documents = await getAllDocuments();
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