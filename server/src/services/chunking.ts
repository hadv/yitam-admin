import { TaskType } from '@google/generative-ai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { createEmbedding } from './embedding';
import path from 'path';

// Load environment variables
dotenv.config();

// Gemini API key for generating titles and summaries
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Please add it to your .env file.');
}

// DocumentChunk interface - represents a single chunk of a document
export interface DocumentChunk {
  id: string;
  documentName: string;
  content: string;
  embedding: number[];
  title: string;
  summary: string;
  sourceFile: string;
  domains: string[];
}

// Configuration interface for chunking parameters
export interface ChunkingConfig {
  chunksPerPage: number;
  chunkOverlap: number;
  generateTitles: boolean;
  generateSummaries: boolean;
  respectBoundaries: boolean; // Whether to use boundary-aware chunking
  preserveHeadings: boolean;  // Whether to keep headings with their content
}

// Default chunking configuration
const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunksPerPage: 2, // Each page gets 2 chunks (changed from 3)
  chunkOverlap: 0.2, // 20% overlap between chunks
  generateTitles: true,
  generateSummaries: true,
  respectBoundaries: true, // Default to respecting boundaries
  preserveHeadings: true    // Default to preserving headings with their content
};

/**
 * Process a document into page-based chunks with overlap
 * 
 * @param document Object containing parsed document pages
 * @param sourceFilePath Path to the source file
 * @param config Chunking configuration
 * @param domains Array of domains the document belongs to
 * @param documentTitle Optional title provided by the user
 * @returns Array of document chunks with embeddings, titles, and summaries
 */
export async function chunkDocument(
  document: { pages: { pageNumber: number; content: string }[] },
  sourceFilePath: string,
  config: Partial<ChunkingConfig> = {},
  domains: string[] = ['default'],
  documentTitle: string = ''
): Promise<DocumentChunk[]> {
  // Merge default config with provided config
  const fullConfig: ChunkingConfig = {
    ...DEFAULT_CHUNKING_CONFIG,
    ...config
  };
  
  // Get document name from file path
  const documentName = path.basename(sourceFilePath, path.extname(sourceFilePath))
    .replace(/[^a-zA-Z0-9]/g, '_'); // Replace non-alphanumeric with underscore
  
  console.log(`Chunking document ${documentName} with ${document.pages.length} pages in domains: ${domains.join(', ')}`);
  
  // Process all pages and create chunks
  const allChunks: DocumentChunk[] = [];
  
  for (const page of document.pages) {
    const pageContent = page.content.trim();
    if (!pageContent) continue; // Skip empty pages
    
    // Calculate chunk size based on page content length and desired chunks per page
    const chunkSize = Math.ceil(pageContent.length / (fullConfig.chunksPerPage * (1 - fullConfig.chunkOverlap) + fullConfig.chunkOverlap));
    const overlap = Math.floor(chunkSize * fullConfig.chunkOverlap);
    
    // Create chunks for this page
    const pageChunks: Omit<DocumentChunk, 'embedding' | 'title' | 'summary'>[] = [];
    
    if (fullConfig.respectBoundaries) {
      // Use the boundary-aware chunking approach
      console.log(`Using boundary-aware chunking for page ${page.pageNumber} with preserveHeadings=${fullConfig.preserveHeadings}`);
      const chunks = createBoundaryAwareChunks(
        pageContent, 
        fullConfig.chunksPerPage, 
        chunkSize, 
        overlap,
        fullConfig.preserveHeadings
      );
      
      console.log(`Created ${chunks.length} boundary-aware chunks for page ${page.pageNumber}`);
      
      chunks.forEach((content, i) => {
        // Log first 50 chars of each chunk to help with debugging
        console.log(`Chunk ${i} starts with: "${content.substring(0, 50).replace(/\n/g, ' ')}..."`);
        
        // Create chunk ID: documentName_pageXXX_chunkY
        const id = `${documentName}_page${page.pageNumber.toString().padStart(3, '0')}_chunk${i}`;
        
        pageChunks.push({
          id,
          documentName,
          content,
          sourceFile: sourceFilePath,
          domains: [...domains]
        });
      });
    } else {
      // Use the original chunking approach
      for (let i = 0; i < fullConfig.chunksPerPage; i++) {
        // Calculate start position (with overlap)
        const startPos = i === 0 ? 0 : i * chunkSize - overlap;
        
        // Calculate end position
        const endPos = Math.min(startPos + chunkSize, pageContent.length);
        
        // If we've reached the end of content, break
        if (startPos >= pageContent.length) break;
        
        // Extract chunk content
        const content = pageContent.substring(startPos, endPos);
        
        // Create chunk ID: documentName_pageXXX_chunkY
        const id = `${documentName}_page${page.pageNumber.toString().padStart(3, '0')}_chunk${i}`;
        
        pageChunks.push({
          id,
          documentName,
          content,
          sourceFile: sourceFilePath,
          domains: [...domains]
        });
      }
    }
    
    // Process chunks in parallel - generate embeddings, titles, and summaries
    const processedChunks = await Promise.all(
      pageChunks.map(async (chunk, index) => {
        // Create embedding for the chunk
        const embedding = await createEmbedding(chunk.content, TaskType.RETRIEVAL_DOCUMENT);
        
        // Generate title and summary
        let title = '';
        let summary = '';
        
        // Use provided document title for all chunks
        if (documentTitle) {
          title = documentTitle;
        }
        
        if (fullConfig.generateTitles || fullConfig.generateSummaries) {
          const { generatedTitle, generatedSummary } = await generateChunkMetadata(
            chunk.content,
            fullConfig.generateTitles,
            fullConfig.generateSummaries
          );
          
          // Only use generated title if no user-provided title exists
          if (generatedTitle && !documentTitle) {
            title = generatedTitle;
          }
          
          if (generatedSummary) summary = generatedSummary;
        }
        
        return {
          ...chunk,
          embedding,
          title,
          summary
        };
      })
    );
    
    allChunks.push(...processedChunks);
  }
  
  console.log(`Created ${allChunks.length} chunks for document ${documentName}`);
  return allChunks;
}

/**
 * Create chunks that respect headings, paragraph, and sentence boundaries
 * 
 * @param text The text to chunk
 * @param maxChunks Maximum number of chunks to create
 * @param targetSize Target size for each chunk
 * @param overlap Overlap size in characters
 * @param preserveHeadings Whether to prioritize keeping headings with their content
 * @returns Array of text chunks with boundaries preserved
 */
function createBoundaryAwareChunks(
  text: string,
  maxChunks: number,
  targetSize: number,
  overlap: number,
  preserveHeadings: boolean = true
): string[] {
  // Helper function to check if text is a heading
  const isHeading = (text: string): boolean => {
    // Check for markdown headings (e.g., # Heading, ## Heading, etc.)
    if (/^#{1,6}\s+.+/m.test(text)) return true;
    
    // Check for uppercase headings with no punctuation (common in PDFs)
    if (/^[A-Z][A-Z\s]{4,}$/.test(text) && !text.includes('.')) return true;
    
    // Check for numeric section headings (e.g., "1.2.3 Section Name")
    if (/^\d+(\.\d+)*\s+[A-Z]/.test(text)) return true;
    
    return false;
  };
  
  // Helper to determine if a paragraph is a list item
  const isListItem = (text: string): boolean => {
    return /^\s*(\d+\.|[*\-•]|\([a-zA-Z0-9]+\))\s+/.test(text);
  };

  // Split text into paragraphs first
  const rawParagraphs = text.split(/\n\s*\n/);
  
  // Process paragraphs to identify headings and their content
  const structuredContent: Array<{type: 'heading' | 'paragraph' | 'list-item', content: string}> = [];
  
  for (let i = 0; i < rawParagraphs.length; i++) {
    const paragraph = rawParagraphs[i].trim();
    if (!paragraph) continue;
    
    if (isHeading(paragraph)) {
      structuredContent.push({ type: 'heading', content: paragraph });
    } else if (isListItem(paragraph)) {
      structuredContent.push({ type: 'list-item', content: paragraph });
    } else {
      structuredContent.push({ type: 'paragraph', content: paragraph });
    }
  }
  
  // Create chunks that preserve structure
  const chunks: string[] = [];
  let currentChunk = '';
  let lastHeadingIndex = -1;
  
  for (let i = 0; i < structuredContent.length; i++) {
    const item = structuredContent[i];
    const isItemHeading = item.type === 'heading';
    
    // Keep track of the last heading we've seen
    if (isItemHeading) {
      lastHeadingIndex = i;
    }
    
    // Check if adding this item would exceed target size (with special handling for headings)
    const wouldExceedSize = currentChunk.length > 0 && 
                           (currentChunk.length + item.content.length > targetSize) &&
                           (chunks.length < maxChunks - 1);

    // When we need to start a new chunk
    if (wouldExceedSize) {
      // If we have a currentChunk, push it to chunks
      chunks.push(currentChunk);
      
      // Special case: if we just ended a chunk and now have a heading, start fresh
      if (isItemHeading) {
        currentChunk = item.content;
        continue;
      }
      
      // Special case: if preserveHeadings is enabled and this item belongs to the previous heading
      if (preserveHeadings && lastHeadingIndex >= 0) {
        const prevHeadingContent = structuredContent[lastHeadingIndex].content;
        if (i - lastHeadingIndex < 3 && // Close to its heading
            prevHeadingContent.length + item.content.length < targetSize * 0.7) { // Would fit with just the heading
          // Include the previous heading with this item
          currentChunk = prevHeadingContent + '\n\n' + item.content;
          continue;
        }
      } else if (lastHeadingIndex >= 0 && 
         i - lastHeadingIndex < 3 && // Close to its heading
         structuredContent[lastHeadingIndex].content.length + item.content.length < targetSize * 0.7) { // Would fit with just the heading
        // Include the previous heading with this item (old behavior)
        currentChunk = structuredContent[lastHeadingIndex].content + '\n\n' + item.content;
        continue;
      }
      
      // Regular overlap case
      if (currentChunk.length > overlap * 2) {
        // Try to find a paragraph boundary for the overlap
        const paragraphs = currentChunk.split(/\n\s*\n/);
        if (paragraphs.length > 1) {
          // Take the last paragraph if it's not too long
          const lastParagraph = paragraphs[paragraphs.length - 1];
          if (lastParagraph.length < overlap * 1.5) {
            currentChunk = lastParagraph + '\n\n' + item.content;
            continue;
          }
        }
        
        // If no good paragraph boundary, try sentences
        const overlapText = currentChunk.slice(-overlap * 2);
        const sentenceBoundaries = [...overlapText.matchAll(/(?<=[.!?])\s+/g)];
        
        if (sentenceBoundaries.length > 0) {
          // Find the last complete sentence in the overlap region
          const lastBoundaryIndex = sentenceBoundaries[sentenceBoundaries.length - 1].index;
          if (lastBoundaryIndex !== undefined) {
            const overlapPoint = overlapText.length - (overlapText.length - lastBoundaryIndex - sentenceBoundaries[sentenceBoundaries.length - 1][0].length);
            currentChunk = overlapText.slice(overlapPoint) + (overlapText.slice(overlapPoint).endsWith('\n\n') ? '' : '\n\n') + item.content;
            continue;
          }
        }
      }
      
      // If no good boundary found, just start fresh with current item
      currentChunk = item.content;
    } else {
      // Add the item to the current chunk
      if (currentChunk) {
        // Ensure proper spacing between items
        if (isItemHeading && !currentChunk.endsWith('\n\n')) {
          currentChunk += '\n\n' + item.content;
        } else if (item.type === 'list-item' && !currentChunk.endsWith('\n')) {
          currentChunk += '\n' + item.content;
        } else {
          currentChunk += '\n\n' + item.content;
        }
      } else {
        currentChunk = item.content;
      }
    }
  }
  
  // Add the last chunk if it has content
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  // Final cleanup - ensure we don't exceed max chunks, and trim excessive whitespace
  return chunks.slice(0, maxChunks).map(chunk => 
    chunk.replace(/\n{3,}/g, '\n\n').trim()
  );
}

/**
 * Generate title and summary for a chunk using Gemini
 * 
 * @param content Chunk content
 * @param generateTitle Whether to generate a title
 * @param generateSummary Whether to generate a summary
 * @returns Object containing generated title and summary
 */
async function generateChunkMetadata(
  content: string,
  generateTitle: boolean,
  generateSummary: boolean
): Promise<{ generatedTitle?: string; generatedSummary?: string }> {
  // If Gemini API key is not available, return empty metadata
  if (!GEMINI_API_KEY) {
    console.warn('Skipping title/summary generation - GEMINI_API_KEY not set');
    return {};
  }
  
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    
    const result: { generatedTitle?: string; generatedSummary?: string } = {};
    
    // Use a sample of the content for very large chunks
    const contentSample = content.length > 8000
      ? content.substring(0, 8000) + "..." 
      : content;
    
    // Generate title if requested
    if (generateTitle) {
      const titleResponse = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: `Create a concise, descriptive title (max 8 words) for this text without any prefixes or additional explanations. Just respond with the title itself:\n\n${contentSample}` }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 30,
        }
      });
      
      result.generatedTitle = titleResponse.response.text().trim();
    }
    
    // Generate summary if requested
    if (generateSummary) {
      const summaryResponse = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: `Write a brief summary (2-3 sentences) of the key points in this text. Be concise and factual:\n\n${contentSample}` }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 100,
        }
      });
      
      result.generatedSummary = summaryResponse.response.text().trim();
    }
    
    return result;
  } catch (error) {
    console.error('Error generating metadata for chunk:', error);
    return {};
  }
} 