import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
import { DocumentChunk } from './chunking';

// Load environment variables
dotenv.config();

// Gemini API key for generating enhanced content
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Please add it to your .env file.');
}

/**
 * Enhancement types for content processing
 */
export enum EnhancementType {
  FORMATTING = 'formatting',
  EXPLANATION = 'explanation',
  CONTEXT = 'context',
  READABILITY = 'readability',
  STRUCTURE = 'structure',
  COMPLETE = 'complete'
}

/**
 * Options for content enhancement
 */
export interface EnhancementOptions {
  types: EnhancementType[];
  temperature?: number;
  maxOutputTokens?: number;
  domain?: string;
}

// Default enhancement options
const DEFAULT_ENHANCEMENT_OPTIONS: EnhancementOptions = {
  types: [EnhancementType.FORMATTING, EnhancementType.READABILITY],
  temperature: 0.2,
  maxOutputTokens: 8000
};

/**
 * Enhance content using Generative AI
 * 
 * @param chunk DocumentChunk to enhance
 * @param options Enhancement options
 * @returns Enhanced DocumentChunk
 */
export async function enhanceContent(
  chunk: DocumentChunk,
  options: Partial<EnhancementOptions> = {}
): Promise<DocumentChunk> {
  // Merge default options with provided options
  const fullOptions: EnhancementOptions = {
    ...DEFAULT_ENHANCEMENT_OPTIONS,
    ...options
  };

  try {
    console.log(`Enhancing content for ${chunk.documentName} with types: ${fullOptions.types.join(', ')}`);
    
    // Skip enhancement if content is empty
    if (!chunk.content || chunk.content.trim() === '') {
      console.warn(`Skipping enhancement for ${chunk.documentName} - empty content`);
      return chunk;
    }

    // Basic language detection (check for Vietnamese-specific characters)
    const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(chunk.content);
    const detectedLanguage = hasVietnameseChars ? 'Vietnamese' : 'English';
    console.log(`Detected language for chunk ${chunk.id}: ${detectedLanguage}`);

    // Initialize Gemini API
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // Build prompt based on enhancement types
    let prompt = `Enhance the following content according to these specific instructions:\n\n`;
    
    // Add mandatory instruction to preserve the original language
    prompt += `- IMPORTANT: The text is in ${detectedLanguage}. Your response MUST be in ${detectedLanguage} as well. Do not translate to any other language.\n`;
    
    // Add strict instructions to preserve original formatting and structure
    prompt += `- CRITICAL: Preserve the original text structure. DO NOT add bullet points, asterisks (*), or any additional formatting if not in the original text.\n`;
    prompt += `- CRITICAL: DO NOT reorganize content into lists or add numbering if they weren't in the original text.\n`;
    prompt += `- CRITICAL: If the original text has no bullet points or decorative formatting, do not add them.\n`;
    
    // Add domain-specific instructions if available
    if (fullOptions.domain) {
      prompt += `This content is about ${fullOptions.domain}. `;
    }

    // Add enhancement type-specific instructions
    if (fullOptions.types.includes(EnhancementType.FORMATTING)) {
      prompt += "- Fix formatting issues while maintaining the original structure. Only fix inconsistent spacing where necessary. DO NOT add new bullet points or decorative formatting.\n";
    }
    
    if (fullOptions.types.includes(EnhancementType.EXPLANATION)) {
      prompt += "- Add brief explanations to technical terms or complex concepts in parentheses.\n";
    }
    
    if (fullOptions.types.includes(EnhancementType.CONTEXT)) {
      prompt += "- Add relevant contextual information to improve understanding where necessary.\n";
    }
    
    if (fullOptions.types.includes(EnhancementType.READABILITY)) {
      prompt += "- Improve readability without changing meaning (fix awkward phrasing, run-on sentences) while preserving the original text structure.\n";
    }
    
    if (fullOptions.types.includes(EnhancementType.STRUCTURE)) {
      prompt += "- Improve the structure only by fixing issues with existing headings and paragraphs. DO NOT add new bullet points, asterisks, or reorganize content if not already organized that way.\n";
    }
    
    if (fullOptions.types.includes(EnhancementType.COMPLETE)) {
      prompt += "- Apply improvements while preserving the original meaning and formatting structure.\n";
    }

    prompt += `\nCONTENT:\n${chunk.content}\n\nReturn ONLY the enhanced content in ${detectedLanguage}, with no additional explanations or commentary. PRESERVE THE ORIGINAL TEXT STRUCTURE.`;

    // Call Gemini API
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: fullOptions.temperature,
        maxOutputTokens: fullOptions.maxOutputTokens,
      }
    });
    
    const enhancedContent = result.response.text().trim();
    
    // Return enhanced chunk
    return {
      ...chunk,
      enhancedContent
    };
  } catch (error) {
    console.error('Error enhancing content:', error);
    // Return original chunk if enhancement fails
    return chunk;
  }
}

/**
 * Batch enhance multiple document chunks
 * 
 * @param chunks Array of DocumentChunks to enhance
 * @param options Enhancement options
 * @returns Enhanced DocumentChunks
 */
export async function batchEnhanceContent(
  chunks: DocumentChunk[],
  options: Partial<EnhancementOptions> = {}
): Promise<DocumentChunk[]> {
  console.log(`Batch enhancing ${chunks.length} chunks`);
  
  // Process chunks in batches to avoid overwhelming the API
  const batchSize = 10;
  const enhancedChunks: DocumentChunk[] = [];
  
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const promises = batch.map(chunk => enhanceContent(chunk, options));
    const results = await Promise.all(promises);
    enhancedChunks.push(...results);
    
    console.log(`Enhanced batch ${i / batchSize + 1} of ${Math.ceil(chunks.length / batchSize)}`);
  }
  
  return enhancedChunks;
} 