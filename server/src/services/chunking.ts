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
}

// Default chunking configuration
const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  chunksPerPage: 3, // Each page gets 3 chunks
  chunkOverlap: 0.2, // 20% overlap between chunks
  generateTitles: true,
  generateSummaries: true
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