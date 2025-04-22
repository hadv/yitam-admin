import { Request, Response } from 'express';
import { createEmbedding } from '../services/embedding';
import { parseDocument, parsePdfByPages, processImageFolder, prepareContentForChunking } from '../services/document';
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
      console.log(`Processing PDF document: ${req.file.originalname}`);
      // Parse PDF into pages
      const pdfPages = await parsePdfByPages(req.file.path);
      
      // Create proper document structure with ID
      const document = {
        id: path.basename(req.file.originalname, path.extname(req.file.originalname)),
        pages: pdfPages.pages
      };
      
      // Prepare content for better sentence boundaries and OCR correction
      const preparedDocument = await prepareContentForChunking(document);
      
      // Chunk the PDF by pages
      chunks = await chunkDocument(preparedDocument, req.file.path, chunkingConfig, domains, documentTitle);
    } else {
      console.log(`Processing non-PDF document: ${req.file.originalname} (${req.file.mimetype})`);
      // For non-PDF documents, treat as a single page and chunk it
      const fileContent = await parseDocument(req.file.path, req.file.mimetype);
      
      // Create a single page document structure
      const document = {
        id: path.basename(req.file.originalname, path.extname(req.file.originalname)),
        pages: [
          {
            pageNumber: 1,
            content: fileContent
          }
        ]
      };
      
      // Prepare content for better sentence boundaries and OCR correction
      const preparedDocument = await prepareContentForChunking(document);
      
      // Chunk the document
      chunks = await chunkDocument(preparedDocument, req.file.path, chunkingConfig, domains, documentTitle);
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

// Parse and store a folder of scanned document images
export const parseAndStoreImageFolder = async (req: Request, res: Response) => {
  try {
    if (!req.files || !Array.isArray(req.files) || req.files.length === 0) {
      return res.status(400).json({ message: 'No files uploaded' });
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
      if (typeof req.body.domains === 'string') {
        try {
          domains = JSON.parse(req.body.domains);
          if (!Array.isArray(domains)) {
            domains = [req.body.domains];
          }
        } catch (error) {
          domains = [req.body.domains];
        }
      } else if (Array.isArray(req.body.domains)) {
        domains = req.body.domains;
      } else if (req.body.domain) {
        domains = [req.body.domain];
      }
    }
    
    // Get document title from request body if provided
    const documentTitle = req.body.documentTitle || 'Scanned Document';

    console.log(`Processing ${req.files.length} image files for document: ${documentTitle}`);
    
    // Get all image file paths
    const filePaths = (req.files as Express.Multer.File[]).map(file => file.path);
    
    // Process the folder of images
    const processedDocument = await processImageFolder(filePaths);
    
    console.log(`Processed ${processedDocument.pages.length} pages from folder`);
    
    // Process all pages at once instead of skipping first and last
    // and organize them into batches with LLM processing
    const document = {
      id: `scan-batch-${Date.now()}`,
      pages: processedDocument.pages
    };
    
    // Prepare content for better sentence boundaries and OCR correction
    const preparedDocument = await prepareContentForChunking(document);
    
    // Process the document with chunking
    const allChunks = await chunkDocument(
      preparedDocument,
      `scan-batch-${Date.now()}`,
      chunkingConfig,
      domains,
      documentTitle
    );
    
    // Store all chunks in database
    if (allChunks.length > 0) {
      await dbService.addDocumentChunks(allChunks);
    }
    
    console.log(`Created ${allChunks.length} chunks for scanned document folder in domains: ${domains.join(', ')}`);
    
    res.status(200).json({ 
      message: 'Scanned document folder processed, chunked and embedded successfully',
      totalChunks: allChunks.length,
      totalPages: processedDocument.pages.length,
      documentTitle,
      domains
    });
  } catch (error) {
    console.error('Error processing scanned document folder:', error);
    res.status(500).json({ message: 'Failed to process scanned document folder' });
  } finally {
    // Clean up files regardless of success or failure
    if (req.files && Array.isArray(req.files)) {
      for (const file of req.files as Express.Multer.File[]) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
      }
    }
  }
};

// Helper function to preserve paragraph continuity across pages
const preserveParagraphContinuity = (
  prevPageContent: string,
  currentPageContent: string,
  nextPageContent: string
): string => {
  let enhancedContent = currentPageContent;
  
  // Split texts into paragraphs for analysis
  const prevParagraphs = prevPageContent.split(/\n\s*\n/).filter(p => p.trim());
  const currentParagraphs = currentPageContent.split(/\n\s*\n/).filter(p => p.trim());
  const nextParagraphs = nextPageContent.split(/\n\s*\n/).filter(p => p.trim());
  
  // Detect if current page starts with a sentence fragment
  let currentStartsWithFragment = false;
  if (currentParagraphs.length > 0) {
    const firstPara = currentParagraphs[0].trim();
    // Check if starts with lowercase or non-punctuation character
    currentStartsWithFragment = /^[a-zà-ỹ,;]/.test(firstPara);
  }
  
  if (prevParagraphs.length > 0 && currentParagraphs.length > 0) {
    const lastPrevParagraph = prevParagraphs[prevParagraphs.length - 1];
    const firstCurrentParagraph = currentParagraphs[0];
    
    // Check if paragraphs likely continue across pages
    const prevEndsWithPunctuation = /[.!?:;]$/.test(lastPrevParagraph.trim());
    const currentStartsWithLowercase = /^[a-zà-ỹ,;]/.test(firstCurrentParagraph.trim());
    
    // If paragraph likely continues from previous page
    if (!prevEndsWithPunctuation && currentStartsWithLowercase) {
      // Add explicit continuation marker for sentence boundary detection
      enhancedContent = `${lastPrevParagraph} [SENTENCE_FRAGMENT_MARKER] ${enhancedContent}`;
    }
    // Also handle case where previous paragraph ends with punctuation but current page
    // still starts with a fragment (happens in some Vietnamese texts)
    else if (currentStartsWithFragment) {
      // Mark the beginning as a fragment anyway
      enhancedContent = `[SENTENCE_FRAGMENT_MARKER] ${enhancedContent}`;
    }
  } else if (currentStartsWithFragment) {
    // If we have no previous page but current still starts with lowercase
    enhancedContent = `[SENTENCE_FRAGMENT_MARKER] ${enhancedContent}`;
  }
  
  // Detect if current page ends with a fragment
  let currentEndsWithFragment = false;
  if (currentParagraphs.length > 0) {
    const lastPara = currentParagraphs[currentParagraphs.length - 1].trim();
    // Check if ends without proper punctuation
    currentEndsWithFragment = !/[.!?:;]$/.test(lastPara);
  }
  
  if (nextParagraphs.length > 0 && currentParagraphs.length > 0) {
    const lastCurrentParagraph = currentParagraphs[currentParagraphs.length - 1];
    const firstNextParagraph = nextParagraphs[0];
    
    // Check if paragraphs likely continue to next page
    const currentEndsWithPunctuation = /[.!?:;]$/.test(lastCurrentParagraph.trim());
    const nextStartsWithLowercase = /^[a-zà-ỹ,;]/.test(firstNextParagraph.trim());
    
    // If paragraph likely continues to next page
    if (!currentEndsWithPunctuation && nextStartsWithLowercase) {
      // Add explicit fragment marker for sentence boundary detection
      enhancedContent = `${enhancedContent} [SENTENCE_FRAGMENT_MARKER] ${firstNextParagraph}`;
    }
  }
  
  return enhancedContent;
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