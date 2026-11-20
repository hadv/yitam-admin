import dotenv from 'dotenv';
import { DocumentChunk } from './chunking';
import { detectLanguageFromText } from './language-utils';
import { generateText, isLlmConfigured, llmUnavailableReason } from './llm-client';

// Load environment variables
dotenv.config();

// Content enhancement runs on Alibaba Cloud Model Studio (Qwen) via llm-client.
// llm-client retries 429 / 5xx / network errors / timeouts itself (and never retries billing errors).
if (!isLlmConfigured('fast')) {
  console.warn(`Content enhancement LLM unavailable (${llmUnavailableReason()}). Set DASHSCOPE_API_KEY in your .env file.`);
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
  /** Language the content is written in (e.g. 'Chinese'); detected from the text when omitted. */
  language?: string;
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

    // Skip enhancement if the LLM is not configured (same result as a failed call: original chunk)
    if (!isLlmConfigured('fast')) {
      console.warn(`Skipping enhancement for ${chunk.documentName} - ${llmUnavailableReason()}`);
      return chunk;
    }

    // Basic language detection (check for Vietnamese-specific characters)
    const hasVietnameseChars = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(chunk.content);
    const detectedLanguage = fullOptions.language
      || (hasVietnameseChars ? 'Vietnamese' : detectLanguageFromText(chunk.content)); // CJK-aware fallback
    console.log(`Detected language for chunk ${chunk.id}: ${detectedLanguage}`);

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

    // Call the LLM (llm-client retries temporary failures: 429 / 5xx / network errors)
    const enhancedContent = await generateText({
      task: 'fast',
      prompt,
      temperature: fullOptions.temperature,
      maxOutputTokens: fullOptions.maxOutputTokens,
    });
    
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

/**
 * Enhance transcript text using Generative AI
 * Specifically designed for audio transcripts to fix grammar, punctuation, and readability
 *
 * @param transcript Raw transcript text
 * @param language Language of the transcript (default: 'Vietnamese')
 * @returns Enhanced transcript text
 */
export async function enhanceTranscriptWithLLM(
  transcript: string,
  language: string = 'Vietnamese'
): Promise<string> {
  try {
    console.log(`Enhancing transcript with LLM (${language})`);

    // Skip enhancement if transcript is empty
    if (!transcript || transcript.trim() === '') {
      console.warn('Skipping transcript enhancement - empty content');
      return transcript;
    }

    // Skip enhancement if the LLM is not configured (same result as a failed call: original transcript)
    if (!isLlmConfigured('fast')) {
      console.warn(`Skipping transcript enhancement - ${llmUnavailableReason()}`);
      return transcript;
    }

    // Build prompt for transcript enhancement
    const prompt = `You are an expert transcript editor. Please enhance the following audio transcript by:

1. LANGUAGE: The transcript is in ${language}. Your response MUST be in ${language} as well.
2. GRAMMAR: Fix grammar mistakes and awkward phrasing
3. PUNCTUATION: Add proper punctuation (periods, commas, question marks, etc.)
4. CAPITALIZATION: Fix capitalization issues
5. SLANG/COLLOQUIALISMS: Convert slang words and colloquial expressions to proper language
6. READABILITY: Improve overall readability while preserving the original meaning
7. STRUCTURE: Break into proper sentences and paragraphs where appropriate

IMPORTANT RULES:
- Preserve the original meaning and content completely
- Do not add new information or interpretations
- Do not remove any important content
- Keep the conversational tone but make it more polished
- Return ONLY the enhanced transcript, no additional commentary

ORIGINAL TRANSCRIPT:
${transcript}

ENHANCED TRANSCRIPT:`;

    // Call the LLM
    const enhancedTranscript = await generateText({
      task: 'fast',
      prompt,
      temperature: 0.2,
      maxOutputTokens: 8000,
    });
    console.log('✅ Transcript enhanced successfully');

    return enhancedTranscript;
  } catch (error) {
    console.error('Error enhancing transcript:', error);
    // Return original transcript if enhancement fails
    return transcript;
  }
}