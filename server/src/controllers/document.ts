import { Request, Response } from 'express';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createEmbedding } from '../services/embedding';
import { parseDocument, parsePdfByPages } from '../services/document';
import { DatabaseService } from '../core/database-service';
import { TaskType } from '@google/generative-ai';
import { chunkPdfDocument, ChunkingConfig } from '../services/chunking';
import path from 'path';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

// Initialize database on startup
dbService.initialize().catch(err => {
  console.error('Error initializing database:', err);
});

// Upload a document, parse it, chunk it, and store in vector DB
export const uploadDocument = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    // Extract chunking configuration from request body (if any)
    const chunkingConfig: Partial<ChunkingConfig> = {};
    
    if (req.body.chunksPerPage && !isNaN(Number(req.body.chunksPerPage))) {
      chunkingConfig.chunksPerPage = Number(req.body.chunksPerPage);
    }
    
    if (req.body.chunkOverlap && !isNaN(Number(req.body.chunkOverlap))) {
      chunkingConfig.chunkOverlap = Number(req.body.chunkOverlap);
    }
    
    if (req.body.generateTitles !== undefined) {
      chunkingConfig.generateTitles = req.body.generateTitles === 'true' || req.body.generateTitles === true;
    }
    
    if (req.body.generateSummaries !== undefined) {
      chunkingConfig.generateSummaries = req.body.generateSummaries === 'true' || req.body.generateSummaries === true;
    }

    // Special handling for PDFs - use page-based chunking
    if (req.file.mimetype === 'application/pdf') {
      // Parse PDF into pages
      const pdfPages = await parsePdfByPages(req.file.path);
      
      // Chunk the PDF by pages
      const chunks = await chunkPdfDocument(pdfPages, req.file.path, chunkingConfig);
      console.log(`Created ${chunks.length} chunks for PDF ${req.file.originalname}`);
      
      // Store all chunks in database
      await dbService.addDocumentChunks(chunks);
      
      return res.status(200).json({ 
        message: 'PDF document chunked and embedded successfully',
        totalChunks: chunks.length,
        documentName: path.basename(req.file.originalname, path.extname(req.file.originalname))
      });
    } 
    
    // For non-PDF documents, treat as a single page and chunk it
    const fileContent = await parseDocument(req.file.path, req.file.mimetype);
    
    // Create a single page document structure
    const document = {
      pages: [
        {
          pageNumber: 1,
          content: fileContent
        }
      ]
    };
    
    // Chunk the document
    const chunks = await chunkPdfDocument(document, req.file.path, chunkingConfig);
    console.log(`Created ${chunks.length} chunks for document ${req.file.originalname}`);
    
    // Store all chunks in database
    await dbService.addDocumentChunks(chunks);
    
    res.status(200).json({ 
      message: 'Document chunked and embedded successfully',
      totalChunks: chunks.length,
      documentName: path.basename(req.file.originalname, path.extname(req.file.originalname))
    });
  } catch (error) {
    console.error('Error processing document:', error);
    res.status(500).json({ message: 'Failed to process document' });
  }
};

// Get all documents
export const getDocuments = async (req: Request, res: Response) => {
  try {
    // Since we're now only storing chunks, we'll retrieve unique document names
    const chunks = await dbService.getAllChunks();
    
    // Extract unique document names
    const uniqueDocuments = new Map();
    
    for (const chunk of chunks) {
      if (!uniqueDocuments.has(chunk.documentName)) {
        uniqueDocuments.set(chunk.documentName, {
          documentName: chunk.documentName,
          sourceFile: chunk.sourceFile,
          totalChunks: 0,
          firstChunk: chunk
        });
      }
      
      // Increment total chunks for this document
      const docInfo = uniqueDocuments.get(chunk.documentName);
      docInfo.totalChunks++;
    }
    
    const documents = Array.from(uniqueDocuments.values()).map(docInfo => ({
      documentName: docInfo.documentName,
      sourceFile: docInfo.sourceFile,
      totalChunks: docInfo.totalChunks,
      preview: docInfo.firstChunk.content.substring(0, 200) + '...',
      title: docInfo.firstChunk.title
    }));
    
    res.status(200).json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    res.status(500).json({ message: 'Failed to fetch documents' });
  }
};

// Get document chunks
export const getDocumentChunks = async (req: Request, res: Response) => {
  try {
    const { documentName } = req.params;
    
    if (!documentName) {
      return res.status(400).json({ message: 'Document name is required' });
    }
    
    const chunks = await dbService.getDocumentChunksByName(documentName);
    
    res.status(200).json(chunks);
  } catch (error) {
    console.error('Error fetching document chunks:', error);
    res.status(500).json({ message: 'Failed to fetch document chunks' });
  }
};

// Search documents using semantic similarity
export const searchDocuments = async (req: Request, res: Response) => {
  try {
    const { query } = req.query;
    
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'Search query is required' });
    }
    
    // Create embedding for the query using TaskType enum for search queries
    const queryEmbedding = await createEmbedding(query, TaskType.RETRIEVAL_QUERY);
    
    // Search using vector similarity
    const searchResults = await dbService.searchByVector(queryEmbedding, 10);
    
    res.status(200).json(searchResults);
  } catch (error) {
    console.error('Error searching documents:', error);
    res.status(500).json({ message: 'Failed to search documents' });
  }
};

// Delete a document (all chunks with the same document name)
export const deleteDocument = async (req: Request, res: Response) => {
  try {
    const { documentName } = req.params;
    
    // Delete all chunks for this document
    const deletedCount = await dbService.deleteDocumentByName(documentName);
    
    res.status(200).json({ 
      message: 'Document deleted successfully',
      deletedChunks: deletedCount
    });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ message: 'Failed to delete document' });
  }
}; 