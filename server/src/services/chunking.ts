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
  chunksPerPage: 2, // Default 2 chunks per page
  chunkOverlap: 0.2, // 20% overlap between chunks
  generateTitles: true,
  generateSummaries: true,
  respectBoundaries: true, // Default to respecting boundaries
  preserveHeadings: true    // Default to preserving headings with their content
};

/**
 * Process a document into page-based chunks with complete sentences
 * 
 * @param document Object containing parsed document pages with __preProcessed flag for complete sentences
 * @param sourceFilePath Path to the source file
 * @param config Chunking configuration
 * @param domains Array of domains the document belongs to
 * @param documentTitle Optional title provided by the user
 * @returns Array of document chunks with embeddings, titles, and summaries
 */
export async function chunkDocument(
  document: { pages: { pageNumber: number; content: string; __preProcessed?: boolean }[] },
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
  
  console.log(`📄 Processing ${documentName} with ${document.pages.length} pages in domains: ${domains.join(', ')}`);
  
  // Sort pages by page number
  const sortedPages = [...document.pages].sort((a, b) => a.pageNumber - b.pageNumber);
  
  // Check if pages have been pre-processed to ensure complete sentences
  const pagesProcessed = sortedPages.some(page => page.__preProcessed);
  if (!pagesProcessed) {
    console.warn('⚠️ Warning: Pages have not been pre-processed for complete sentences. Chunks may contain incomplete sentences.');
    console.warn('⚠️ Recommendation: Use prepareContentForChunking before chunking to ensure complete sentences.');
  } else {
    console.log('✅ Pages have been pre-processed for complete sentences.');
  }
  
  console.log(`🧩 Creating one chunk per page with complete sentences...`);
  
  // Generate chunks - one chunk per page
  const chunks: DocumentChunk[] = [];
  
  // Function to check if text has incomplete sentences at the end
  const hasIncompleteEnding = (text: string): boolean => {
    // If empty text, consider complete
    if (!text || !text.trim()) {
      return false;
    }
    
    const trimmedText = text.trim();
    
    // No ending punctuation
    if (!/[.!?:;。]\s*$/.test(trimmedText)) {
      return true;
    }
    
    // Ends with prepositions or connectors (expanded list for Vietnamese)
    const lastWords = trimmedText.split(/\s+/).slice(-3).join(' ');
    if (/(của|cho|với|trong|về|bởi|từ|đến|tại|qua|bên|theo|giữa|dưới|trên|ngoài|sau|trước|cạnh|gần|dọc|ngang|như|nếu|ví dụ|trường hợp|khi|lúc|tuy|mặc dù|do|bởi vì|vì|để|có thể|cần phải|nên|cần|được|bị|đã|đang|sẽ|và|hay|hoặc|nhưng|mà|vào|ra|lên|xuống|cùng|cùng với)\s*$/i.test(lastWords)) {
      return true;
    }
    
    // Ends with partial Vietnamese word
    const lastWord = trimmedText.split(/\s+/).pop() || '';
    if (/^[bcdfghjklmnpqrstvwxzđ]$/i.test(lastWord)) {
      return true;
    }
    
    // Common Vietnamese prefixes and single consonants that shouldn't end a page
    const partialWordPatterns = ['vi', 'ph', 'th', 'tr', 'ch', 'nh', 'kh', 'gi', 'qu', 'ng', 'nh', 'gh', 'đ', 'b', 't', 'c', 'l', 'm', 'n', 'p', 'h', 'r', 'x', 'v', 'k', 'g', 'd', 'đi', 'xe', 'la', 'ba', 'bo', 'ca', 'co', 'cu', 'du', 'ma'];
    
    // Check for common Vietnamese partial words
    if (partialWordPatterns.includes(lastWord.toLowerCase())) {
      return true;
    }
    
    return false;
  };
  
  // Function to check and fix partial words at the end of content
  const fixPartialWordEnding = (content: string, pageNumber: number, nextPageContent: string | null): string => {
    if (!content || !nextPageContent) {
      return content;
    }
    
    const trimmedContent = content.trim();
    
    // Check for common partial Vietnamese syllables at the end
    const lastWord = trimmedContent.split(/\s+/).pop() || '';
    
    // Common Vietnamese prefixes and single consonants that shouldn't end a chunk
    const partialWordPatterns = ['vi', 'ph', 'th', 'tr', 'ch', 'nh', 'kh', 'gi', 'qu', 'ng', 'nh', 'gh', 'đ', 'b', 't', 'c', 'l', 'm', 'n', 'p', 'h', 'r', 'x', 'v', 'k', 'g', 'd', 'đi', 'xe', 'la', 'ba', 'bo', 'ca', 'co', 'cu', 'du', 'ma'];
    
    const isPartialWord = 
      // Check for common Vietnamese prefixes
      partialWordPatterns.includes(lastWord.toLowerCase()) ||
      // Check for single consonants
      /^[bcdfghjklmnpqrstvwxyzđ]$/.test(lastWord) ||
      // Check for consonant + vowel pattern that's likely incomplete
      /^[bcdfghjklmnpqrstvwxyzđ][aeiouăâêôơưy]?$/i.test(lastWord) ||
      // Ends with prepositions or connectors
      /(của|cho|với|trong|về|bởi vì|và|hoặc|hay|nhưng)\s*$/i.test(trimmedContent);
    
    if (isPartialWord) {
      console.log(`⚠️ Chunk ending detected with partial word/phrase "${lastWord}" on page ${pageNumber}`);
      
      // Get a more substantial amount of text from the next page
      const borrowedText = getBorrowedText(nextPageContent);
      
      if (borrowedText) {
        // For partial words, remove the partial word and add borrowed text
        if (partialWordPatterns.includes(lastWord.toLowerCase()) || /^[bcdfghjklmnpqrstvwxyzđ]/.test(lastWord)) {
          // Remove the partial word and replace with complete borrowed content
          const fixedContent = trimmedContent.substring(0, trimmedContent.lastIndexOf(' ' + lastWord)) + ' ' + borrowedText;
          console.log(`✅ Fixed partial word ending by borrowing text: "${borrowedText.substring(0, 40)}..."`);
          return fixedContent;
        } else {
          // For other cases, just append with proper spacing
          const fixedContent = trimmedContent + ' ' + borrowedText;
          console.log(`✅ Fixed incomplete ending by borrowing text: "${borrowedText.substring(0, 40)}..."`);
          return fixedContent;
        }
      }
    }
    
    return content;
  };
  
  // Helper function to get borrowed text from next page
  const getBorrowedText = (nextPageContent: string): string => {
    const trimmedNextContent = nextPageContent.trim();
    
    // Try to find a complete sentence ending with punctuation
    const sentenceMatch = trimmedNextContent.match(/^[^.!?:;。]*[.!?:;。][^\w]*/);
    if (sentenceMatch && sentenceMatch[0] && sentenceMatch[0].length > 0) {
      return sentenceMatch[0].trim();
    }
    
    // Try to find a paragraph break
    const paragraphMatch = trimmedNextContent.match(/^[^\n\r]*(\n|\r)/);
    if (paragraphMatch && paragraphMatch[0] && paragraphMatch[0].length > 5) {
      return paragraphMatch[0].trim();
    }
    
    // Fallback to first 200 characters
    return trimmedNextContent.substring(0, Math.min(200, trimmedNextContent.length));
  };
  
  // Process pages to create chunks
  for (let i = 0; i < sortedPages.length; i++) {
    const page = sortedPages[i];
    const nextPage = i < sortedPages.length - 1 ? sortedPages[i + 1] : null;
    
    // Skip empty pages
    if (!page.content.trim()) {
      console.log(`⏭️ Skipping empty page ${page.pageNumber}`);
      continue;
    }
    
    console.log(`📝 Processing page ${page.pageNumber}...`);
    
    // Create a unique ID for the chunk
    const chunkId = `${documentName}_page_${page.pageNumber}`;
    
    try {
      // Check for incomplete sentences at the end
      let pageContent = page.content.trim();
      
      // Check for partial words at the end that need to be fixed
      pageContent = fixPartialWordEnding(
        pageContent, 
        page.pageNumber, 
        nextPage ? nextPage.content : null
      );
      
      // If page is not pre-processed and has incomplete sentences at the end, 
      // borrow text from next page to complete it
      if (!page.__preProcessed && hasIncompleteEnding(pageContent) && nextPage) {
        console.log(`⚠️ Page ${page.pageNumber} has incomplete ending, attempting to fix...`);
        
        // Look for the first sentence in the next page
        const nextPageContent = nextPage.content.trim();
        let borrowedText = '';
        
        // Try to find the first complete sentence
        const firstSentenceMatch = nextPageContent.match(/^[^.!?:;。]*[.!?:;。]/);
        if (firstSentenceMatch && firstSentenceMatch[0]) {
          borrowedText = firstSentenceMatch[0].trim();
        } else {
          // If no complete sentence, borrow a reasonable amount
          borrowedText = nextPageContent.substring(0, Math.min(200, nextPageContent.length));
        }
        
        // Add borrowed text
        if (borrowedText) {
          pageContent = pageContent + ' ' + borrowedText;
          console.log(`✅ Fixed incomplete ending by borrowing text from page ${nextPage.pageNumber}`);
        }
      }
      
      // Final check for partial words at the very end
      const lastWord = pageContent.trim().split(/\s+/).pop() || '';
      if (/^[bcdfghjklmnpqrstvwxyzđ]$/.test(lastWord) || ['vi', 'ph', 'th', 'ch'].includes(lastWord.toLowerCase())) {
        console.warn(`⚠️ WARNING: Page ${page.pageNumber} still ends with potential partial word "${lastWord}"`);
        
        // Emergency fix - borrow more content if possible
        if (nextPage) {
          const extraContent = nextPage.content.trim().split(/\s+/).slice(0, 3).join(' ');
          pageContent = pageContent + ' ' + extraContent;
          console.log(`🔧 Emergency fix applied by adding "${extraContent}"`);
        }
      }
      
      // Generate embedding
      const embedding = await createEmbedding(pageContent);
      if (!embedding) {
        console.error(`❌ Failed to generate embedding for page ${page.pageNumber}`);
        continue;
      }
      
      // Create the chunk object with default title and summary
      const chunk: DocumentChunk = {
        id: chunkId,
        documentName: documentTitle || documentName,
        content: pageContent,
        embedding: embedding,
        title: `Page ${page.pageNumber}`, // Default title - will be updated if generateTitles is true
        summary: "", // Will be filled in later if generateSummaries is true
        sourceFile: sourceFilePath,
        domains: domains
      };
      
      // Validate chunk - final check for incomplete ending
      if (hasIncompleteEnding(pageContent)) {
        console.warn(`⚠️ Page ${page.pageNumber} may still have incomplete sentences at the end`);
      }
      
      // Add to chunks array
      chunks.push(chunk);
      
      console.log(`✅ Created chunk for page ${page.pageNumber} (${pageContent.length} chars)`);
    } catch (error) {
      console.error(`❌ Error processing page ${page.pageNumber}:`, error);
    }
  }
  
  console.log(`✅ Created ${chunks.length} chunks (one per page)`);
  
  // Generate titles and summaries if enabled
  if ((fullConfig.generateTitles || fullConfig.generateSummaries) && chunks.length > 0) {
    console.log(`🤖 Generating titles and summaries for chunks...`);
    await generateChunkMetadata(chunks, fullConfig);
  } else {
    console.log(`⏭️ Skipping title/summary generation as requested in config`);
  }
  
  return chunks;
}

/**
 * Generate titles and summaries for document chunks using Gemini API
 * 
 * @param chunks Array of document chunks
 * @param config Chunking configuration
 */
async function generateChunkMetadata(
  chunks: DocumentChunk[],
  config: ChunkingConfig
): Promise<void> {
  // Skip if no API key
  if (!GEMINI_API_KEY) {
    console.warn('⚠️ Skipping title/summary generation - GEMINI_API_KEY not set');
    return;
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  
  // Process chunks in batches to avoid API rate limits
  const batchSize = 3;
  const batchCount = Math.ceil(chunks.length / batchSize);
  
  for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
    const batchStart = batchIndex * batchSize;
    const batchEnd = Math.min((batchIndex + 1) * batchSize, chunks.length);
    const currentBatch = chunks.slice(batchStart, batchEnd);
    
    console.log(`Processing metadata batch ${batchIndex + 1}/${batchCount} (chunks ${batchStart + 1}-${batchEnd})`);
    
    // Process each chunk in the batch sequentially to avoid overwhelming the API
    for (const chunk of currentBatch) {
      try {
        // Prepare content sample that emphasizes the beginning and end
        let contentSample = '';
        
        if (chunk.content.length > 10000) {
          // For very long content, take beginning, middle and end
          contentSample = 
            chunk.content.substring(0, 4000) + 
            "\n...[MIDDLE CONTENT OMITTED]...\n" + 
            chunk.content.substring(chunk.content.length - 4000);
        } else if (chunk.content.length > 6000) {
          // For long content, take beginning and end with more emphasis on the end
          contentSample = 
            chunk.content.substring(0, 2000) + 
            "\n...[MIDDLE CONTENT OMITTED]...\n" + 
            chunk.content.substring(chunk.content.length - 3000);
        } else {
          // For regular content, use the full text
          contentSample = chunk.content;
        }
        
        // Generate title if needed
        if (config.generateTitles) {
          if (!chunk.title.includes(`Page ${chunk.id.split('_page_')[1]}`)) {
            console.log(`Skipping title generation for chunk ${chunk.id} - already has custom title: "${chunk.title}"`);
          } else {
            try {
              const titlePrompt = `
Generate a descriptive title for this document chunk from a Vietnamese text. The title should capture the main topic.

CHUNK CONTENT:
"""
${contentSample}
"""

INSTRUCTIONS:
1. Create a concise title (5-7 words) that accurately reflects the main topic
2. If the content is in Vietnamese, write the title in Vietnamese
3. Focus especially on the predominant theme or subject matter
4. Make the title specific and descriptive, not generic
5. Include key terms or concepts that appear throughout the content
6. Pay special attention to both the beginning and end of the text
7. Avoid using phrases like "Title:", "Page:", etc.

RETURN ONLY THE TITLE TEXT WITH NO OTHER COMMENTARY.
`;

              const titleResult = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: titlePrompt }] }],
                generationConfig: {
                  temperature: 0.2,
                  maxOutputTokens: 60,
                }
              });
              
              const title = titleResult.response.text().trim();
              if (title && title.length > 0) {
                chunk.title = title;
                console.log(`Generated title for chunk ${chunk.id}: "${title}"`);
              } else {
                console.warn(`Empty title generated for chunk ${chunk.id}, keeping default`);
              }
            } catch (error) {
              console.error(`Error generating title for chunk ${chunk.id}:`, error);
              // Keep the default title
            }
          }
        }
        
        // Generate summary if needed
        if (config.generateSummaries) {
          try {
            // Create a summary prompt that emphasizes complete understanding
            const summaryPrompt = `
Summarize this document chunk comprehensively, including important information from both the beginning and end. For Vietnamese text, write the summary in Vietnamese.

CHUNK CONTENT:
"""
${contentSample}
"""

INSTRUCTIONS:
1. Create a 3-4 sentence summary (70-100 words)
2. Capture key information from throughout the text, especially:
   - Main concepts and ideas from the beginning
   - Important conclusions or results from the end
   - Critical details that appear throughout
3. Be factual and objective - don't add information not in the text
4. If the content is in Vietnamese, write the summary in Vietnamese
5. Include key names, places, numbers, and specific terminology
6. Ensure the summary is complete and doesn't end mid-thought
7. Focus on giving a well-rounded overview of all major points

RETURN ONLY THE SUMMARY WITH NO OTHER COMMENTARY.
`;

            const summaryResult = await model.generateContent({
              contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 250,
              }
            });
            
            const summary = summaryResult.response.text().trim();
            if (summary && summary.length > 0) {
              chunk.summary = summary;
              console.log(`Generated summary for chunk ${chunk.id} (${summary.length} chars)`);
            } else {
              console.warn(`Empty summary generated for chunk ${chunk.id}`);
              chunk.summary = ""; // Empty summary on error
            }
          } catch (error) {
            console.error(`Error generating summary for chunk ${chunk.id}:`, error);
            chunk.summary = ""; // Empty summary on error
          }
        }
        
        // Add a small delay between chunk processing to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`Error processing metadata for chunk ${chunk.id}:`, error);
      }
    }
    
    // Add a small delay between batches to avoid rate limits
    if (batchIndex < batchCount - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  
  console.log(`✅ Metadata generation complete for ${chunks.length} chunks`);
}
