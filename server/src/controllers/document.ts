import { Request, Response } from 'express';
import { createEmbedding } from '../services/embedding';
import { parseDocument, parsePdfByPages } from '../services/document';
import { DatabaseService } from '../core/database-service';
import { TaskType } from '@google/generative-ai';
import { chunkDocument, ChunkingConfig } from '../services/chunking';
import path from 'path';
import fs from 'fs';

// Create a singleton instance of the database service
const dbService = new DatabaseService();

// Initialize database on startup
dbService.initialize().catch(err => {
  console.error('Error initializing database:', err);
});

// Parse a document, split into chunks, embed each chunk and store in vector DB
export const parseAndStoreDocument = async (req: Request, res: Response) => {
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

    // Get domains from request body or use default
    let domains: string[] = ['default'];
    if (req.body.domains) {
      // If domains is provided as a string, parse it as JSON
      if (typeof req.body.domains === 'string') {
        try {
          domains = JSON.parse(req.body.domains);
          if (!Array.isArray(domains)) {
            domains = [req.body.domains];
          }
        } catch (error) {
          // If parsing fails, use the string as a single domain
          domains = [req.body.domains];
        }
      } 
      // If domains is already an array, use it directly
      else if (Array.isArray(req.body.domains)) {
        domains = req.body.domains;
      }
      // If domain is provided as a single string, use it
      else if (req.body.domain) {
        domains = [req.body.domain];
      }
    }
    
    // Get document title from request body if provided
    const documentTitle = req.body.documentTitle || '';

    // Parse document into chunks based on document type
    let chunks;
    
    if (req.file.mimetype === 'application/pdf') {
      // Parse PDF into pages
      const pdfPages = await parsePdfByPages(req.file.path);
      
      // Chunk the PDF by pages
      chunks = await chunkDocument(pdfPages, req.file.path, chunkingConfig, domains, documentTitle);
    } else {
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
      chunks = await chunkDocument(document, req.file.path, chunkingConfig, domains, documentTitle);
    }
    
    console.log(`Created ${chunks.length} chunks for document ${req.file.originalname} in domains: ${domains.join(', ')}`);
    
    // Store all chunks in database
    await dbService.addDocumentChunks(chunks);
    
    res.status(200).json({ 
      message: 'Document parsed, chunked and embedded successfully',
      totalChunks: chunks.length,
      documentName: path.basename(req.file.originalname, path.extname(req.file.originalname)),
      documentTitle: documentTitle || path.basename(req.file.originalname, path.extname(req.file.originalname)),
      domains
    });
  } catch (error) {
    console.error('Error processing document:', error);
    res.status(500).json({ message: 'Failed to process document' });
  } finally {
    // Clean up file regardless of success or failure
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
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