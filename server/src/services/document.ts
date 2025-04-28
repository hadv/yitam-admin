import fs from 'fs';
import util from 'util';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { GoogleGenerativeAI } from '@google/generative-ai';

const readFile = util.promisify(fs.readFile);

// Initialize the Vision API client
let visionClient: ImageAnnotatorClient;

// Configure Google Cloud Vision client based on available credentials
const setupVisionClient = () => {
  if (visionClient) return visionClient;
  
  try {
    // Use the GOOGLE_CREDENTIALS_BASE64 environment variable
    if (process.env.GOOGLE_CREDENTIALS_BASE64) {
      visionClient = new ImageAnnotatorClient({
        apiKey: process.env.GOOGLE_CREDENTIALS_BASE64,
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID
      });
    } 
    // Fallback to Application Default Credentials
    else {
      visionClient = new ImageAnnotatorClient({
        projectId: process.env.GOOGLE_CLOUD_PROJECT_ID
      });
    }
    
    return visionClient;
  } catch (error) {
    console.error('Error initializing Google Cloud Vision client:', error);
    throw new Error('Failed to initialize OCR service. Check your Google Cloud credentials.');
  }
};

// Load Gemini API key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. OCR correction will be skipped.');
}

// Parse document and extract text content
export const parseDocument = async (filePath: string, mimeType: string): Promise<string> => {
  try {
    // Make sure the file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    let text = '';

    // Parse based on file type
    switch (mimeType) {
      case 'application/pdf':
        // Use pdf-parse
        const pdfBuffer = await readFile(filePath);
        try {
          const pdfData = await pdfParse(pdfBuffer);
          text = pdfData.text;
        } catch (pdfError: unknown) {
          console.error('Error parsing PDF:', pdfError);
          const errorMessage = pdfError instanceof Error ? pdfError.message : 'Unknown error';
          throw new Error(`Failed to parse PDF document: ${errorMessage}`);
        }
        break;
        
      case 'text/plain':
        // Read plain text file
        const textBuffer = await readFile(filePath);
        text = textBuffer.toString('utf-8');
        break;
        
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        // Use mammoth for DOCX files
        const docxBuffer = await readFile(filePath);
        const docxResult = await mammoth.extractRawText({ buffer: docxBuffer });
        text = docxResult.value;
        break;
      
      case 'image/png':
      case 'image/jpeg':
      case 'image/jpg':
      case 'image/tiff':
        // For image files, use Google Cloud Vision OCR
        text = await processImageWithOCR(filePath);
        break;
        
      default:
        // Fallback to reading as plain text
        const buffer = await readFile(filePath);
        text = buffer.toString('utf-8');
    }

    // Basic processing: Remove extra whitespace
    text = text.replace(/\s+/g, ' ').trim();
    
    return text;
  } catch (error) {
    console.error(`Error parsing document ${path.basename(filePath)}:`, error);
    throw new Error('Failed to parse document');
  }
};

// Process an image with Google Cloud Vision OCR
const processImageWithOCR = async (imagePath: string): Promise<string> => {
  try {
    // Initialize the Vision API client if not already initialized
    const client = setupVisionClient();
    
    // Read the image file
    const imageBuffer = await readFile(imagePath);
    
    // Check file size limit
    const maxSizeMB = process.env.MAX_FILE_SIZE_MB ? parseInt(process.env.MAX_FILE_SIZE_MB) : 10;
    const fileSizeMB = imageBuffer.length / (1024 * 1024);
    if (fileSizeMB > maxSizeMB) {
      console.warn(`Image file size (${fileSizeMB.toFixed(2)}MB) exceeds limit of ${maxSizeMB}MB: ${path.basename(imagePath)}`);
    }
    
    console.log(`Processing OCR for image: ${path.basename(imagePath)}`);
    
    // Call the Google Cloud Vision API for text detection
    const [result] = await client.textDetection(imageBuffer);
    const detections = result.textAnnotations || [];
    
    if (detections.length === 0) {
      console.warn(`No text detected in image: ${path.basename(imagePath)}`);
      return '';
    }
    
    // The first annotation contains the entire text from the image
    const fullText = detections[0].description || '';
    
    // Log detection info
    console.log(`Detected ${detections.length - 1} text blocks in image: ${path.basename(imagePath)}`);
    
    return fullText;
  } catch (error) {
    console.error(`Error processing OCR for image ${path.basename(imagePath)}:`, error);
    throw new Error(`OCR processing failed for image: ${path.basename(imagePath)}`);
  }
};

// Parse PDF with page-level extraction
export const parsePdfByPages = async (filePath: string): Promise<{ pages: { pageNumber: number; content: string }[] }> => {
  try {
    // Make sure the file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read PDF file
    const pdfBuffer = await readFile(filePath);
    
    // Array to store page data
    const pages: { pageNumber: number; content: string }[] = [];
    
    // Parse PDF with custom page renderer
    await pdfParse(pdfBuffer, {
      // This function is called for each page
      pagerender: async (pageData: any) => {
        // Extract text content from the page
        const content = await pageData.getTextContent();
        let pageText = '';
        
        // Combine all text items on the page
        for (const item of content.items) {
          if ('str' in item) {
            pageText += item.str + ' ';
          }
        }
        
        // Clean up text and add to pages array
        pageText = pageText.replace(/\s+/g, ' ').trim();
        pages.push({
          pageNumber: pageData.pageNumber,
          content: pageText
        });
        
        // Return an empty string as we're storing pages separately
        return '';
      }
    });
    
    // Sort pages by page number
    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    
    // If the page renderer didn't work, fall back to basic PDF parsing
    if (pages.length === 0) {
      console.log('Falling back to basic PDF parsing');
      const pdfData = await pdfParse(pdfBuffer);
      
      // Create a single page with all content
      pages.push({
        pageNumber: 1,
        content: pdfData.text
      });
    }
    
    return { pages };
  } catch (error) {
    console.error(`Error parsing PDF by pages ${path.basename(filePath)}:`, error);
    throw new Error('Failed to parse PDF document by pages');
  }
};

// Process a folder of scanned document images
export const processImageFolder = async (
  filePaths: string[]
): Promise<{ pages: { pageNumber: number; content: string }[] }> => {
  try {
    // Sort files by their numeric page number in filename
    const sortedFilePaths = sortImagesByPageNumber(filePaths);
    
    // Perform OCR on each image
    const pages: { pageNumber: number; content: string; filePath: string }[] = [];
    
    for (let i = 0; i < sortedFilePaths.length; i++) {
      const filePath = sortedFilePaths[i];
      const pageNumber = extractPageNumberFromFilename(filePath);
      
      // Perform OCR on the image
      const rawContent = await processImageWithOCR(filePath);
      
      pages.push({
        pageNumber,
        content: rawContent,
        filePath
      });
    }
    
    // Process each page to exclude headers/footers
    const processedPages = await processHeadersFooters(pages);
    
    return { pages: processedPages };
  } catch (error) {
    console.error('Error processing image folder:', error);
    throw new Error('Failed to process image folder');
  }
};

// Sort images by page number extracted from filename
const sortImagesByPageNumber = (filePaths: string[]): string[] => {
  return filePaths.sort((a, b) => {
    const pageNumberA = extractPageNumberFromFilename(a);
    const pageNumberB = extractPageNumberFromFilename(b);
    return pageNumberA - pageNumberB;
  });
};

// Extract page number from filename (e.g., "filename-001.png" => 1)
const extractPageNumberFromFilename = (filePath: string): number => {
  const fileName = path.basename(filePath);
  // Match patterns like filename-001.png or filename-1.png
  const match = fileName.match(/-(\d+)\.[^.]+$/);
  
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  
  // If no match found, try to find any number in the filename
  const numMatch = fileName.match(/\d+/);
  if (numMatch) {
    return parseInt(numMatch[0], 10);
  }
  
  // Default to 0 if no number found
  return 0;
};

// Process pages to remove headers and footers
const processHeadersFooters = async (
  pages: { pageNumber: number; content: string; filePath: string }[]
): Promise<{ pageNumber: number; content: string }[]> => {
  if (pages.length === 0) return [];
  
  const processedPages: { pageNumber: number; content: string }[] = [];
  
  // First pass: Analyze patterns across all pages to identify potential headers/footers
  const patternAnalysis = analyzeDocumentPatterns(pages);
  
  for (let i = 0; i < pages.length; i++) {
    const currentPage = pages[i];
    const prevPage = i > 0 ? pages[i - 1] : null;
    const nextPage = i < pages.length - 1 ? pages[i + 1] : null;
    
    let cleanedContent = currentPage.content;
    
    // Process the content based on document analysis and adjacent pages
    cleanedContent = removeHeadersFooters(
      cleanedContent, 
      prevPage?.content || null, 
      nextPage?.content || null
    );
    
    processedPages.push({
      pageNumber: currentPage.pageNumber,
      content: cleanedContent
    });
  }
  
  return processedPages;
};

// Analyze patterns across the entire document to find headers and footers
interface PatternAnalysis {
  topLines: Map<string, number>; // line text -> frequency count
  bottomLines: Map<string, number>;
  avgLineCount: number;
  pageNumberPatterns: RegExp[];
  headerCandidates: string[];
  footerCandidates: string[];
  commonFormatPatterns: RegExp[];
  linePositionScores: Map<string, number>; // line text -> position confidence score (0-1)
}

const analyzeDocumentPatterns = (pages: { pageNumber: number; content: string; filePath: string }[]): PatternAnalysis => {
  const topLines = new Map<string, number>();
  const bottomLines = new Map<string, number>();
  const allLines: string[] = [];
  const pageLineCounts: number[] = [];
  const knownPageNumberFormats: RegExp[] = [
    /^\s*\d+\s*$/,                        // Standalone numbers: "42"
    /^.{0,50}?\s+\d{1,3}\s*$/,            // Text followed by number: "Chapter Title 42"
    /^\s*\d{1,3}\s+.{0,50}?$/,            // Number followed by text: "42 Chapter Title"
    /^[\-–—]\s*\d+\s*[\-–—]$/,            // Dash-wrapped numbers: "-42-"
    /^Page\s+\d+(\s+of\s+\d+)?$/i,        // "Page N" or "Page N of M"
    /^Trang\s+\d+(\s+của\s+\d+)?$/i,      // Vietnamese: "Trang N" or "Trang N của M"
  ];
  
  // Collect common line patterns from both top and bottom of pages
  for (const page of pages) {
    const lines = page.content.split('\n').filter(line => line.trim().length > 0);
    allLines.push(...lines);
    pageLineCounts.push(lines.length);
    
    // Nothing to analyze if page has no content
    if (lines.length === 0) continue;
    
    // Analyze first few lines as potential headers
    const headerLinesToCheck = Math.min(3, Math.floor(lines.length * 0.15));
    for (let i = 0; i < headerLinesToCheck; i++) {
      if (i < lines.length) {
        const line = lines[i].trim();
        if (line.length > 0) {
          topLines.set(line, (topLines.get(line) || 0) + 1);
        }
      }
    }
    
    // Analyze last few lines as potential footers
    const footerLinesToCheck = Math.min(3, Math.floor(lines.length * 0.15));
    for (let i = 0; i < footerLinesToCheck; i++) {
      if (lines.length - 1 - i >= 0) {
        const line = lines[lines.length - 1 - i].trim();
        if (line.length > 0) {
          bottomLines.set(line, (bottomLines.get(line) || 0) + 1);
        }
      }
    }
  }
  
  // Calculate average line count per page
  const avgLineCount = pageLineCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, pageLineCounts.length);
  
  // Identify lines that appear frequently in similar positions across pages
  const linePositionScores = new Map<string, number>();
  
  // Find repeated lines that appear in more than 30% of pages
  const minOccurrences = Math.max(2, Math.ceil(pages.length * 0.3));
  
  // Calculate confidence scores for header/footer candidates
  const headerCandidates: string[] = [];
  const footerCandidates: string[] = [];
  
  // Process top lines (headers)
  for (const [line, count] of topLines.entries()) {
    if (count >= minOccurrences) {
      const score = count / pages.length;
      linePositionScores.set(line, score);
      
      if (score > 0.3) {
        headerCandidates.push(line);
      }
    }
  }
  
  // Process bottom lines (footers)
  for (const [line, count] of bottomLines.entries()) {
    if (count >= minOccurrences) {
      const score = count / pages.length;
      linePositionScores.set(line, score);
      
      if (score > 0.3) {
        footerCandidates.push(line);
      }
    }
  }
  
  // Detect additional formatting patterns
  const formatAnalysis = detectFormatPatterns(allLines);
  
  return {
    topLines,
    bottomLines,
    avgLineCount,
    pageNumberPatterns: knownPageNumberFormats.concat(formatAnalysis.pageNumberPatterns),
    headerCandidates,
    footerCandidates,
    commonFormatPatterns: formatAnalysis.formatPatterns,
    linePositionScores
  };
};

// Detect formatting patterns in text that might indicate headers/footers
const detectFormatPatterns = (lines: string[]): { pageNumberPatterns: RegExp[], formatPatterns: RegExp[] } => {
  const allPageNumberPatterns: RegExp[] = [];
  const allFormatPatterns: RegExp[] = [];
  
  // Look for potential page number patterns (detect numbers that increment across pages)
  const numberMatches = lines.map(line => {
    const matches = line.match(/\d+/g);
    return matches ? matches.map(m => parseInt(m, 10)) : [];
  }).flat();
  
  // Detect sequences of numbers (1, 2, 3...) that might be page numbers
  if (numberMatches.length > 0) {
    // Create map of number frequency
    const numFrequency = new Map<number, number>();
    for (const num of numberMatches) {
      numFrequency.set(num, (numFrequency.get(num) || 0) + 1);
    }
    
    // Get potential page number ranges
    const potentialPageNumbers = [...numFrequency.entries()]
      .filter(([num, freq]) => num > 0 && num < 10000 && freq <= 3) // Page numbers usually appear ≤ 3 times per document
      .map(([num]) => num)
      .sort((a, b) => a - b);
    
    // Detect sequential ranges
    if (potentialPageNumbers.length > 1) {
      // Check for sequential runs of numbers, as they're likely page numbers
      const sequences: number[][] = [];
      let currentSequence: number[] = [potentialPageNumbers[0]];
      
      for (let i = 1; i < potentialPageNumbers.length; i++) {
        if (potentialPageNumbers[i] === potentialPageNumbers[i-1] + 1) {
          currentSequence.push(potentialPageNumbers[i]);
        } else {
          if (currentSequence.length >= 3) { // Require at least 3 sequential numbers
            sequences.push([...currentSequence]);
          }
          currentSequence = [potentialPageNumbers[i]];
        }
      }
      
      // Add final sequence if it's long enough
      if (currentSequence.length >= 3) {
        sequences.push(currentSequence);
      }
      
      // For each detected sequence, create regex patterns for common formats
      for (const sequence of sequences) {
        if (sequence.length >= 3) { // Ensure we have a meaningful sequence
          const minPageNum = sequence[0];
          const maxPageNum = sequence[sequence.length - 1];
          
          // Create regex patterns for page numbers in the detected sequence range
          const pageRangePattern = new RegExp(`^.{0,50}?\\b(${minPageNum}-${maxPageNum}|${minPageNum}–${maxPageNum})\\b.{0,50}?$`);
          allPageNumberPatterns.push(pageRangePattern);
        }
      }
    }
  }
  
  // Detect all-caps lines (common in headers)
  const allCapsPattern = /^[A-ZÀ-Ỹ0-9\s.,;:\-–—'"!?()[\]{}]+$/;
  allFormatPatterns.push(allCapsPattern);
  
  // Detect centered text
  const centeredTextPattern = /^\s{5,}.{5,60}\s{5,}$/;
  allFormatPatterns.push(centeredTextPattern);
  
  // Detect lines with special characters often used in headers/footers
  const specialCharPattern = /^[\s\-–—=_*•■□◊]+.+[\s\-–—=_*•■□◊]+$/;
  allFormatPatterns.push(specialCharPattern);
  
  return {
    pageNumberPatterns: allPageNumberPatterns,
    formatPatterns: allFormatPatterns
  };
};

// Remove headers and footers by comparing with adjacent pages
const removeHeadersFooters = (
  currentContent: string,
  prevContent: string | null,
  nextContent: string | null
): string => {
  let cleanedContent = currentContent;
  
  // Split content into lines
  const lines = currentContent.split('\n');
  if (lines.length <= 1) return currentContent; // Nothing to analyze
  
  // Calculate statistical properties for smarter detection
  // 1. Get average line length to compare against
  const lineLengths = lines.map(line => line.trim().length).filter(len => len > 0);
  const avgLineLength = lineLengths.reduce((sum, len) => sum + len, 0) / Math.max(1, lineLengths.length);
  
  // 2. Determine if there are patterns in the first/last few lines
  const potentialHeaderLines = lines.slice(0, Math.min(3, Math.floor(lines.length * 0.2)));
  const potentialFooterLines = lines.slice(Math.max(0, lines.length - Math.min(3, Math.floor(lines.length * 0.2))));
  
  // Track which lines to keep
  const linesToKeep = new Array(lines.length).fill(true);
  
  // Analyze each line for header/footer characteristics
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // Skip empty lines
    
    // Calculate probability this is a header/footer
    let headerFooterScore = 0;
    
    // FACTOR 1: Position in document
    if (i < 3) {
      // First few lines are more likely to be headers
      headerFooterScore += 0.3;
    } else if (i >= lines.length - 3) {
      // Last few lines are more likely to be footers
      headerFooterScore += 0.3;
    }
    
    // FACTOR 2: Line appears in adjacent pages (classic header/footer)
    if (prevContent && prevContent.includes(line)) {
      headerFooterScore += 0.4;
    }
    if (nextContent && nextContent.includes(line)) {
      headerFooterScore += 0.4;
    }
    
    // FACTOR 3: Line length compared to average
    if (line.length < avgLineLength * 0.5) {
      // Much shorter than average lines are often headers/footers
      headerFooterScore += 0.2;
    }
    
    // FACTOR 4: Contains patterns typical of headers/footers
    
    // Pattern 4.1: Contains page numbers
    if (/\b\d{1,3}\b/.test(line) && line.length < 60) {
      headerFooterScore += 0.25;
    }
    
    // Pattern 4.2: ALL CAPS text (common in headers)
    if (line === line.toUpperCase() && /[A-ZÀ-Ỹ]{5,}/.test(line) && line.length < 60) {
      headerFooterScore += 0.25;
    }
    
    // Pattern 4.3: Contains special characters used in decorative headers/footers
    if (/[-_=*•■◆◇~]{3,}/.test(line)) {
      headerFooterScore += 0.3;
    }
    
    // Pattern 4.4: Centered text (common format for headers/footers)
    if (line.startsWith('  ') && line.endsWith('  ') && line.length < 60) {
      headerFooterScore += 0.2;
    }
    
    // Pattern 4.5: Contains words typical in headers/footers
    const headerFooterWords = ['chapter', 'page', 'section', 'volume', 'part', 'trang', 'chương', 'phần', 'mục'];
    if (headerFooterWords.some(word => line.toLowerCase().includes(word)) && line.length < 60) {
      headerFooterScore += 0.3;
    }
    
    // Mark lines with high scores for removal
    if (headerFooterScore >= 0.5) {
      linesToKeep[i] = false;
    }
  }
  
  // Additional sequence analysis for detecting page numbers
  
  // Extract all numbers from the document
  const numberMatches = lines.map((line, index) => {
    const match = line.match(/\b(\d{1,3})\b/g);
    return match ? match.map(m => ({ num: parseInt(m, 10), lineIndex: index })) : [];
  }).flat();
  
  // Look for sequential numbers that might be page numbers
  if (numberMatches.length > 1) {
    for (let i = 0; i < numberMatches.length - 1; i++) {
      // If we find sequential numbers that differ by 1, they're likely page numbers
      if (Math.abs(numberMatches[i].num - numberMatches[i+1].num) === 1) {
        // Mark both lines as likely headers/footers
        linesToKeep[numberMatches[i].lineIndex] = false;
        linesToKeep[numberMatches[i+1].lineIndex] = false;
      }
    }
  }
  
  // Build cleaned content from remaining lines
  const resultLines = lines.filter((_, index) => linesToKeep[index]);
  cleanedContent = resultLines.join('\n');
  
  return cleanedContent;
};

/**
 * Use LLM to correct OCR errors
 */
export const correctOcrWithLLM = async (text: string): Promise<string> => {
  if (!text.trim()) return '';
  if (!GEMINI_API_KEY) return text;
  
  try {
    // Apply targeted regex fixes for the most common OCR issues before sending to LLM
    let preProcessedText = text;
    
    // 1. Fix words with incorrectly attached numbers (e.g., "con21" → "con 21")
    preProcessedText = preProcessedText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?\s]|$)/g, '$1 $2$3');
    
    // 2. Fix words with numbers and punctuation (e.g., "khí17." → "khí 17.")
    preProcessedText = preProcessedText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?])/g, '$1 $2$3');
    
    // 3. Fix numbers in quotes (e.g., "chị" sinh ra3, → "chị" sinh ra 3,)
    preProcessedText = preProcessedText.replace(/([\"""'][\s\w])([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?\s]|$)/g, '$1$2 $3$4');
    
    // 4. Fix sentence-ending patterns (e.g., "con21." → "con 21.")
    preProcessedText = preProcessedText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?])(\s|$)/g, '$1 $2$3$4');
    
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro", 
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: 4096,
      }
    });
    
    // Prepare prompt for OCR correction with specific examples
    const prompt = `Correct OCR errors in this Vietnamese text, focusing on these specific patterns:

1. Words with attached numbers (VERY COMMON ERROR):
   - "con21" → "con 21"
   - "khí17" → "khí 17"
   - "ra3" → "ra 3"
   - "sinh nở19" → "sinh nở 19"
   - "dương hỏa nên mới có con21. Đến năm" → "dương hỏa nên mới có con 21. Đến năm"

2. Other OCR issues to fix:
   - Spacing and line breaks (merge broken lines)
   - Fix obvious OCR character substitutions
   - Preserve all factual information and content meaning

3. EXPLANATION: These attached numbers are usually:
   - Footnote references
   - Page numbers that got merged during scanning
   - Line numbers from source documents
   - Section references

TEXT:
${preProcessedText}

Return ONLY the corrected text with proper spacing between words and numbers.

IMPORTANT: DO NOT translate to English. Keep the text in Vietnamese.`;
    
    // Create a stronger prompt that emphasizes NOT translating
    const noTranslatePrompt = `
IMPORTANT INSTRUCTION - DO NOT TRANSLATE: You must process this Vietnamese text exactly as is, without translating to any other language.

${prompt}

FINAL REMINDER: Your output MUST be in Vietnamese only. Do NOT translate anything to English or any other language.`;
    
    // Call Gemini API with the enhanced prompt
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: noTranslatePrompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8000,
      }
    });
    
    const correctedText = result.response.text().trim();
    
    // Apply final thorough regex fixes for any remaining issues
    let finalText = correctedText;
    
    // More aggressive final pass to catch any remaining issues
    // 1. General word-number separation (both directions)
    finalText = finalText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)/g, '$1 $2');
    finalText = finalText.replace(/(\d+)([a-zà-ỹA-ZÀ-Ỹ])/g, '$1 $2');
    
    // 2. Special case for Vietnamese text ending with numbers
    finalText = finalText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?])(\s|$)/g, '$1 $2$3$4');
    
    // 3. Handle specific patterns from user examples
    finalText = finalText.replace(/có con(\d+)/g, 'có con $1');
    finalText = finalText.replace(/khí(\d+)/g, 'khí $1');
    finalText = finalText.replace(/ra(\d+),/g, 'ra $1,');
    finalText = finalText.replace(/sinh nở(\d+)/g, 'sinh nở $1');
    
    console.log(`Corrected OCR text: ${finalText.length} characters`);
    return finalText;
  } catch (error) {
    console.error('Error correcting OCR with LLM:', error);
    
    // Apply comprehensive regex fixes as fallback if LLM fails
    let fallbackText = text;
    
    // Apply all the same regex fixes from the pre-processing
    fallbackText = fallbackText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?\s]|$)/g, '$1 $2$3');
    fallbackText = fallbackText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?])/g, '$1 $2$3');
    fallbackText = fallbackText.replace(/([\"""'][\s\w])([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?\s]|$)/g, '$1$2 $3$4');
    fallbackText = fallbackText.replace(/([a-zà-ỹA-ZÀ-Ỹ])(\d+)([.,;:!?])(\s|$)/g, '$1 $2$3$4');
    
    // Add the specific patterns from user examples
    fallbackText = fallbackText.replace(/có con(\d+)/g, 'có con $1');
    fallbackText = fallbackText.replace(/khí(\d+)/g, 'khí $1');
    fallbackText = fallbackText.replace(/ra(\d+),/g, 'ra $1,');
    fallbackText = fallbackText.replace(/sinh nở(\d+)/g, 'sinh nở $1');
    
    return fallbackText;
  }
};

/**
 * Use LLM to directly fix page boundaries to ensure complete sentences and paragraphs
 */
export async function createCompleteSentencePages(document: Document): Promise<DocumentPage[]> {
  if (!document.pages || document.pages.length === 0) {
    return [];
  }

  console.log(`Creating complete sentence pages for document with ${document.pages.length} pages`);

  try {
    // First correct OCR errors if needed
    const correctedPages = await Promise.all(
      document.pages.map(async (page) => {
        if (!page.content.trim()) {
          return page;
        }
        try {
          const corrected = await correctOcrWithLLM(page.content);
          return {
            ...page,
            content: corrected || page.content,
          };
        } catch (error) {
          console.error(`Error correcting OCR for page ${page.pageNumber}:`, error);
          return page;
        }
      })
    );

    // Then ensure complete sentences by checking previous and next pages
    const enhancedPages: DocumentPage[] = [];
    
    for (let i = 0; i < correctedPages.length; i++) {
      const previousPage = i > 0 ? correctedPages[i - 1] : null;
      const currentPage = correctedPages[i];
      const nextPage = i < correctedPages.length - 1 ? correctedPages[i + 1] : null;
      
      const enhancedPage = await ensureCompleteSentences(previousPage, currentPage, nextPage);
      enhancedPages.push(enhancedPage as DocumentPage);
    }
    
    console.log(`Created ${enhancedPages.length} pages with complete sentences`);
    return enhancedPages;
  } catch (error) {
    console.error('Error creating complete sentence pages:', error);
    return document.pages;
  }
}

/**
 * Prepares raw document content for chunking by ensuring complete sentences,
 * adding metadata, and optimizing for embedding and retrieval.
 * 
 * @param document The document with pages to prepare
 * @returns Document with processed content ready for chunking
 */
export async function prepareContentForChunking(document: Document): Promise<Document> {
  console.log(`🔍 Preparing ${document.pages.length} pages for chunking...`);
  
  // 1. Process pages to ensure complete sentences
  const completePages = document.pages.map((page, index, allPages) => {
    // Keep original page properties and add __preProcessed flag
    return {
      ...page,
      __preProcessed: true
    };
  });
  
  // 2. Create complete sentence pages with proper types
  const improvedPagesPromises = completePages.map(async (page, index, allPages) => {
    const prevPage = index > 0 ? allPages[index - 1] : null;
    const nextPage = index < allPages.length - 1 ? allPages[index + 1] : null;
    
    // Use ensureCompleteSentences to fix sentence boundaries
    const enhancedPage = await ensureCompleteSentences(prevPage, page, nextPage);
    return {
      ...page,
      ...enhancedPage,
      __modified: enhancedPage.content !== page.content
    };
  });
  
  // Process all pages sequentially
  const improvedPages = await Promise.all(improvedPagesPromises).then(processedPages => {
    // 3. Additional post-processing for edge cases
    for (let i = 0; i < processedPages.length; i++) {
      const currPage = processedPages[i];
      const nextPage = i < processedPages.length - 1 ? processedPages[i + 1] : null;
      
      // Check for partial syllables at the end of content
      if (nextPage) {
        const content = currPage.content.trim();
        const lastWord = content.split(/\s+/).pop() || '';
        
        // Comprehensive list of Vietnamese partial syllables that shouldn't end a chunk
        const partialPatterns = [
          // Single consonants
          'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'x',
          // Common Vietnamese onset consonant clusters
          'gh', 'gi', 'kh', 'ng', 'nh', 'ph', 'th', 'tr', 'ch', 'nh', 'qu', 'gi',
          // Common partial syllables
          'vi', 'ba', 'bo', 'ca', 'co', 'cu', 'du', 'đi', 'đo', 'đa', 'ga', 'ha', 'ho', 'la', 'lo', 
          'ma', 'mi', 'mo', 'mu', 'na', 'pa', 'ta', 'to', 'tu', 'xa', 'xu'
        ];
        
        // Check if content ends with a partial Vietnamese syllable
        const hasPartialSyllable = partialPatterns.some(pattern => 
          content.endsWith(' ' + pattern) || content.endsWith('\n' + pattern)
        );
        
        // Additional regex checks for partial words
        const endsWithConsonantPattern = /[bcdfghjklmnpqrstvwxzđ]$/i.test(content);
        const endsWithConsonantVowelPattern = /[bcdfghjklmnpqrstvwxzđ][aeiouăâêôơư]$/i.test(content);
        
        if (hasPartialSyllable || endsWithConsonantPattern || endsWithConsonantVowelPattern) {
          console.log(`⚠️ Page ${currPage.pageNumber} ends with a partial syllable "${lastWord}"`);
          
          // Find a good amount of text to borrow from the next page
          const nextPageContent = nextPage.content.trim();
          let borrowedText = '';
          
          // Look for the first complete sentence or reasonable chunk
          const firstSentenceMatch = nextPageContent.match(/^[^.!?:;。]*[.!?:;。]/);
          if (firstSentenceMatch && firstSentenceMatch[0]) {
            borrowedText = firstSentenceMatch[0];
          } else {
            // If no complete sentence found, take first 150 characters or first paragraph
            const firstParaMatch = nextPageContent.match(/^[^\n\r]*/);
            if (firstParaMatch && firstParaMatch[0] && firstParaMatch[0].length > 0) {
              borrowedText = firstParaMatch[0];
            } else {
              borrowedText = nextPageContent.substring(0, Math.min(150, nextPageContent.length));
            }
          }
          
          if (borrowedText) {
            // Identify where to cut the current content by finding the last complete word
            const lastWordIndex = content.lastIndexOf(' ' + lastWord);
            
            if (lastWordIndex !== -1) {
              // Remove the partial word and append the borrowed text
              const fixedContent = content.substring(0, lastWordIndex) + ' ' + borrowedText;
              
              // Update the current page's content
              processedPages[i] = {
                ...currPage,
                content: fixedContent,
                __modified: true
              };
              
              console.log(`✅ Fixed partial syllable by borrowing text: "${borrowedText.substring(0, 40)}..."`);
            } else {
              // If we can't find where to cut precisely, just append
              processedPages[i] = {
                ...currPage,
                content: content + ' ' + borrowedText,
                __modified: true
              };
              console.log(`⚠️ Couldn't find exact cut point, appended borrowed text`);
            }
          }
        }
      }
      
      // One more check: if the last "word" is suspiciously short (1-2 characters)
      const content = processedPages[i].content.trim();
      const lastWord = content.split(/\s+/).pop() || '';
      
      if (lastWord.length <= 2 && nextPage && 
         !/[.!?:;。,)}\]]$/.test(content) && // Not ending with punctuation
         !/^[0-9]+$/.test(lastWord)) { // Not a number
        console.log(`⚠️ Page ${processedPages[i].pageNumber} ends with suspicious short word "${lastWord}"`);
        
        // Get the first few words from the next page
        const nextWords = nextPage.content.trim().split(/\s+/).slice(0, 3).join(' ');
        
        // Append them to complete the potential partial word
        processedPages[i] = {
          ...processedPages[i],
          content: content + ' ' + nextWords,
          __modified: true
        };
        
        console.log(`✅ Added "${nextWords}" to complete potential partial word`);
      }
    }
    
    return processedPages;
  });
  
  // Log the results
  const modifiedPages = improvedPages.filter(p => p.__modified).length;
  console.log(`✅ Content preparation complete: ${modifiedPages} pages were modified to ensure complete sentences`);
  
  // Return document with processed pages
  return {
    ...document,
    pages: improvedPages
  };
}

// Type definition for genAI static property
interface EnsureCompleteSentencesFunction extends Function {
  genAI: GoogleGenerativeAI | null;
  apiFailureCount: number;
  maxApiFailures: number;
  apiDisabled: boolean;
}

// Add this helper function to sanitize content before sending to the API
function sanitizeContentForAPI(text: string): string {
  if (!text) return '';
  
  // 1. Remove control characters except for normal whitespace
  let sanitized = text.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  
  // 2. Replace unusual Unicode characters that might cause issues
  // This is a conservative approach that keeps most Unicode but removes rare characters
  sanitized = sanitized.replace(/[\uFFF0-\uFFFF]/g, '');
  
  // 3. Trim extremely long content to avoid token limits
  const MAX_PROMPT_CHARS = 8000; // More conservative limit (reduced from 12000)
  
  if (sanitized.length > MAX_PROMPT_CHARS) {
    console.log(`⚠️ Content too long (${sanitized.length} chars), truncating to ${MAX_PROMPT_CHARS} chars`);
    
    // Check if the text contains "CURRENT PAGE:" marker
    const currentPageIndex = sanitized.indexOf("CURRENT PAGE:");
    
    if (currentPageIndex !== -1) {
      // Find the previous and next page markers
      const prevPageIndex = sanitized.indexOf("PREVIOUS PAGE:");
      const nextPageIndex = sanitized.indexOf("NEXT PAGE:");
      
      // Determine how to distribute the characters
      // Keep most of the CURRENT PAGE content, which is the most important
      const currentPageContent = 
        nextPageIndex !== -1 ? 
        sanitized.substring(currentPageIndex, nextPageIndex) : 
        sanitized.substring(currentPageIndex);
      
      // Give 70% of the budget to the current page
      const currentPageBudget = Math.floor(MAX_PROMPT_CHARS * 0.7);
      let truncatedCurrentPage = currentPageContent;
      
      if (currentPageContent.length > currentPageBudget) {
        truncatedCurrentPage = currentPageContent.substring(0, currentPageBudget);
        console.log(`  - Truncated current page content to ${truncatedCurrentPage.length} chars`);
      }
      
      // Give 15% each to previous and next pages
      const otherPagesBudget = Math.floor(MAX_PROMPT_CHARS * 0.15);
      
      // Get previous page portion
      let prevPageContent = prevPageIndex !== -1 ? 
        sanitized.substring(prevPageIndex, currentPageIndex) : "";
      
      if (prevPageContent.length > otherPagesBudget) {
        prevPageContent = prevPageContent.substring(0, otherPagesBudget);
        console.log(`  - Truncated previous page content to ${prevPageContent.length} chars`);
      }
      
      // Get next page portion
      let nextPageContent = nextPageIndex !== -1 ? 
        sanitized.substring(nextPageIndex) : "";
      
      if (nextPageContent.length > otherPagesBudget) {
        nextPageContent = nextPageContent.substring(0, otherPagesBudget);
        console.log(`  - Truncated next page content to ${nextPageContent.length} chars`);
      }
      
      // Reassemble the prompt with truncated content
      sanitized = prevPageContent + truncatedCurrentPage + nextPageContent;
      console.log(`  - Final prompt length: ${sanitized.length} chars`);
    } else {
      // Simple truncation if we can't find the structure
      sanitized = sanitized.substring(0, MAX_PROMPT_CHARS);
    }
  }
  
  return sanitized;
}

// Add this simple sleep function to throttle requests
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function ensureCompleteSentences(prevPage: DocumentPage | null, currPage: DocumentPage, nextPage: DocumentPage | null): Promise<DocumentPage> {
  // Check if API has been disabled due to too many failures
  const funcWithProps = ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction;
  
  // Check environment variable to completely disable API usage
  const skipApiCompletely = process.env.DISABLE_GEMINI_API === 'true' || process.env.DISABLE_AI_APIS === 'true';
  
  if (skipApiCompletely || funcWithProps.apiDisabled) {
    const reason = skipApiCompletely ? 'disabled by environment variable' : 'too many failures';
    console.log(`⚠️ API is ${reason}. Using manual fallback for page ${currPage.pageNumber}`);
    return manuallyFixTruncations(
      prevPage?.content?.trim() || '', 
      currPage?.content?.trim() || '', 
      nextPage?.content?.trim() || '',
      false, false, currPage
    );
  }

  if (!currPage || !currPage.content) {
    return currPage;
  }
  
  // Get content from current page
  const currentPageContent = currPage.content.trim();
  
  // If content is very short, no need to process
  if (currentPageContent.length < 10) {
    return currPage;
  }
  
  console.log(`🔍 Checking page ${currPage.pageNumber} for sentence completeness...`);
  
  // Expanded list of Vietnamese continuation patterns
  const continuationPatterns = [
    /^[a-zà-ỹ]/i,                  // Starts with lowercase or accented letter
    /^[,;)}\]]/,                   // Starts with punctuation that typically doesn't begin sentences
    /^(của|và|hoặc|hay|nhưng|bởi|vì|rằng|nên|để|mà|thì|là|với|cho|trong|từ|đến|bởi vì|tại vì|vào|ra|lên|xuống|ngoài|theo|sau|trước|cùng|cùng với)/i,  // Common Vietnamese continuation words
    /^[bcdfghjklmnpqrstvwxzđ][aeiouăâêôơưy]/i  // Starts with consonant+vowel pattern (likely mid-word)
  ];
  
  // Expanded checking for sentence fragments at start of current page
  const startsWithFragment = continuationPatterns.some(pattern => pattern.test(currentPageContent));
  
  // Vietnamese word endings that shouldn't be at the end of content
  const partialWordEndings = [
    /[bcdfghjklmnpqrstvwxzđ]$/i,  // Ends with a consonant
    /(ch|nh|ng|th|tr|ph|kh|gh|gi|qu)$/i,  // Common Vietnamese consonant clusters
    /(vi|đi|xe|ba|bo|ca|co|cu|du|ma)$/i  // Common Vietnamese syllable starts
  ];
  
  // Check for partial words at the end
  const endsWithPartialWord = partialWordEndings.some(pattern => pattern.test(currentPageContent));
  
  // Check if page ends without proper sentence terminator
  const endsWithFragment = !/[.!?:;。]\s*$|[.:;]\s*"?\s*$/.test(currentPageContent);
  
  // If the content already looks complete (doesn't start or end with fragments), return as is
  if (!startsWithFragment && !endsWithPartialWord && !endsWithFragment) {
    return currPage;
  }
  
  // Get content from previous and next pages if available
  const prevPageContent = prevPage?.content?.trim() || '';
  const nextPageContent = nextPage?.content?.trim() || '';
  
  // Log context sizes for debugging
  console.log(`Context sizes - Previous: ${prevPageContent.length}, Current: ${currentPageContent.length}, Next: ${nextPageContent.length}`);
  
  // Create a prompt for the language model with stronger language preservation instructions
  const promptBase = `
Please help fix incomplete sentences in a document page. I will provide the content of three consecutive pages (previous, current, and next).
Your task is to ensure the current page has complete sentences by fixing truncated sentences at the beginning and end.

CRITICAL INSTRUCTION: DO NOT TRANSLATE THE TEXT. Keep the text in its original language (Vietnamese). Your task is only to fix sentence boundaries, not to translate.

PREVIOUS PAGE: "${prevPageContent.substring(0, Math.min(500, prevPageContent.length))}..."

CURRENT PAGE: "${currentPageContent}"

NEXT PAGE: "${nextPageContent.substring(0, Math.min(500, nextPageContent.length))}..."

I want the output to be the MIDDLE PAGE content with minimal changes - only fix incomplete sentences at 
the beginning and end by borrowing minimally from adjacent pages. If the content already has complete sentences, 
return it unchanged.

IMPORTANT: Output must be in the original language (Vietnamese). DO NOT translate to English, even if you detect the content is in Vietnamese.`;

  const finalPrompt = `
VIETNAMESE TEXT PROCESSING - DO NOT TRANSLATE TO ANY OTHER LANGUAGE
${promptBase}
YOUR RESPONSE MUST BE IN VIETNAMESE ONLY - NO ENGLISH WORDS ALLOWED
`;

  try {
    // Use Gemini to fix the content
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ No AI API key found, using manual fallback for sentence completion');
      return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
    }

    // Sanitize content before sending to API to avoid issues with problematic characters
    const sanitizedPrompt = sanitizeContentForAPI(finalPrompt);

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-pro", 
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8000,
        }
      });

      // Add a throttling delay to avoid overwhelming the API
      await sleep(500); // 500ms delay between API calls
      
      // Set up a simple timeout with a flag
      const timeoutMs = 30000; // 30 seconds
      console.log(`⏱️ Setting API timeout of ${timeoutMs/1000} seconds for page ${currPage.pageNumber}`);
      
      let apiTimedOut = false;
      const timeoutId = setTimeout(() => {
        apiTimedOut = true;
        console.error(`⏱️ API timeout for page ${currPage.pageNumber} after ${timeoutMs/1000} seconds`);
        
        // Track API failures
        const funcWithProps = ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction;
        funcWithProps.apiFailureCount = (funcWithProps.apiFailureCount || 0) + 1;
        
        // Log failure count and potentially disable API
        console.log(`⚠️ API failure count: ${funcWithProps.apiFailureCount}/${funcWithProps.maxApiFailures}`);
        
        if (funcWithProps.apiFailureCount >= funcWithProps.maxApiFailures) {
          console.log(`🚫 Disabling API due to too many failures (${funcWithProps.apiFailureCount})`);
          funcWithProps.apiDisabled = true;
        }
      }, timeoutMs);
      
      console.log(`📤 Sending API request for page ${currPage.pageNumber} (content length: ${sanitizedPrompt.length} chars)`);
      const startTime = Date.now();
      
      try {
        // Make the API call with retry
        const result = await retryApiCall(async () => {
          return await model.generateContent({
            contents: [{ role: "user", parts: [{ text: sanitizedPrompt }] }],
          });
        }, 3, 1000); // 3 retries with 1s initial delay
        
        // Clear the timeout as the request completed
        clearTimeout(timeoutId);
        
        // If the timeout already occurred, don't process the result
        if (apiTimedOut) {
          console.log(`⚠️ API result arrived after timeout for page ${currPage.pageNumber}, ignoring`);
          return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
        }
        
        const elapsedTime = (Date.now() - startTime) / 1000;
        console.log(`✅ API request completed in ${elapsedTime.toFixed(2)} seconds for page ${currPage.pageNumber}`);
        
        // Process the result
        const response = result.response;
        const enhancedContent = response.text().trim();
        
        // Check if the content was accidentally translated to English
        const wasTranslated = detectTranslationToEnglish(currentPageContent, enhancedContent);
        
        // If it was translated, use the original content instead
        if (wasTranslated) {
          console.warn(`🚫 Ignoring API result for page ${currPage.pageNumber} due to translation to English`);
          return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
        }
        
        // Verify the LLM actually made meaningful changes
        if (!enhancedContent || enhancedContent.length < currentPageContent.length * 0.5) {
          console.warn(`⚠️ LLM output for page ${currPage.pageNumber} seems too short, using manual fallback`);
          return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
        }

        // Check if content was modified meaningfully
        const wasChanged = enhancedContent !== currentPageContent;
        
        // More detailed logging about changes
        if (wasChanged) {
          const startDiff = !enhancedContent.startsWith(currentPageContent.substring(0, 50)) ? 
            `Changed start: "${enhancedContent.substring(0, 50)}..."` : 'No changes at start';
            
          const endDiff = !enhancedContent.endsWith(currentPageContent.substring(currentPageContent.length - 50)) ?
            `Changed end: "...${enhancedContent.substring(enhancedContent.length - 50)}"` : 'No changes at end';
          
          console.log(`✅ Enhanced page ${currPage.pageNumber}: ${startDiff}, ${endDiff}`);
        } else {
          console.log(`ℹ️ Page ${currPage.pageNumber}: LLM didn't make changes, content may already be complete`);
        }
        
        return { 
          ...currPage,
          content: enhancedContent,
          __modified: wasChanged
        };
      } catch (error: any) {
        // Clear the timeout if an error occurs
        clearTimeout(timeoutId);
        
        // Don't count the error if we already timed out
        if (!apiTimedOut) {
          // Track API failures
          const funcWithProps = ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction;
          funcWithProps.apiFailureCount = (funcWithProps.apiFailureCount || 0) + 1;
          
          console.error(`❌ API error for page ${currPage.pageNumber}:`, error);
          
          // Log failure count and potentially disable API
          console.log(`⚠️ API failure count: ${funcWithProps.apiFailureCount}/${funcWithProps.maxApiFailures}`);
          
          if (funcWithProps.apiFailureCount >= funcWithProps.maxApiFailures) {
            console.log(`🚫 Disabling API due to too many failures (${funcWithProps.apiFailureCount})`);
            funcWithProps.apiDisabled = true;
          }
        }
        
        console.log(`⚠️ Falling back to manual processing for page ${currPage.pageNumber}`);
        return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
      }
    } catch (error) {
      console.error(`❌ Unexpected error when enhancing page ${currPage.pageNumber}:`, error);
      // Try manual fallback for any other errors
      return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
    }
  } catch (error) {
    console.error(`❌ Error enhancing page ${currPage.pageNumber}:`, error);
    // Try manual fallback if LLM fails
    return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment, currPage);
  }
}

/**
 * Manual fallback function to fix truncated sentences when LLM is unavailable
 */
function manuallyFixTruncations(
  prevPageContent: string, 
  currentPageContent: string, 
  nextPageContent: string,
  startsWithFragment: boolean,
  endsWithFragment: boolean,
  originalPage: DocumentPage
): DocumentPage {
  console.log('🔧 Using manual fallback to fix truncations');
  let enhancedContent = currentPageContent;
  let wasModified = false;
  
  // Fix start truncation
  if (startsWithFragment && prevPageContent) {
    // Try multiple strategies to find a good sentence break in the previous page
    const strategies = [
      // Strategy 1: Find last full sentence with punctuation
      /[^.!?:;。]+[.!?:;。][^\w]*$/,
      // Strategy 2: Find last paragraph
      /\n\s*([^\n]+)$/,
      // Strategy 3: Take last 150 characters
      /(.{1,150})$/
    ];
    
    let lastContent = '';
    for (const pattern of strategies) {
      const match = prevPageContent.match(pattern);
      if (match && match[0]) {
        lastContent = match[0].trim();
        console.log(`✅ Found content from previous page using pattern: ${pattern}`);
        break;
      }
    }
    
    if (lastContent) {
      // Avoid duplicate content - check if current page already starts with this content
      if (!currentPageContent.startsWith(lastContent)) {
        enhancedContent = lastContent + ' ' + enhancedContent;
        console.log(`✅ Manually added content from previous page: "${lastContent.substring(0, 30)}..."`);
        wasModified = true;
      } else {
        console.log(`ℹ️ Current page already starts with the content from previous page`);
      }
    } else {
      // Fallback: Take last 100 characters or so
      lastContent = prevPageContent.substring(Math.max(0, prevPageContent.length - 100));
      enhancedContent = lastContent + ' ' + enhancedContent;
      console.log(`✅ Manually added last 100 chars from previous page as fallback`);
      wasModified = true;
    }
  }
  
  // Fix end truncation
  if (endsWithFragment && nextPageContent) {
    // Try multiple strategies to find a good sentence break in the next page
    const strategies = [
      // Strategy 1: Find first full sentence with punctuation
      /^[^.!?:;。]+[.!?:;。][^\w]*/,
      // Strategy 2: Find first paragraph
      /^([^\n]+)\n/,
      // Strategy 3: Take first 150 characters
      /^(.{1,150})/
    ];
    
    let nextContent = '';
    for (const pattern of strategies) {
      const match = nextPageContent.match(pattern);
      if (match && match[0]) {
        nextContent = match[0].trim();
        console.log(`✅ Found content from next page using pattern: ${pattern}`);
        break;
      }
    }
    
    if (nextContent) {
      // Avoid duplicate content - check if current page already ends with this content
      if (!currentPageContent.endsWith(nextContent)) {
        enhancedContent = enhancedContent + ' ' + nextContent;
        console.log(`✅ Manually added content from next page: "${nextContent.substring(0, 30)}..."`);
        wasModified = true;
      } else {
        console.log(`ℹ️ Current page already ends with the content from next page`);
      }
    } else {
      // Fallback: Take first 100 characters
      nextContent = nextPageContent.substring(0, 100);
      enhancedContent = enhancedContent + ' ' + nextContent;
      console.log(`✅ Manually added first 100 chars from next page as fallback`);
      wasModified = true;
    }
  }
  
  // Better fix for partial words at the end
  const lastWord = currentPageContent.trim().split(/\s+/).pop() || '';
  
  // Check if the last word is likely to be a partial word
  const endsWithPartialWord = /^[bcdfghjklmnpqrstvwxzđ]$/i.test(lastWord) || 
    /(vi|đi|xe|ba|bo|ca|co|cu|du|ma|ph|th|tr|ch|nh|kh|gi|qu|ng|gh|tr|ph|Tr|Ph|Kh|Ngh|Gi)$/i.test(lastWord) ||
    lastWord.length <= 2;
  
  if (endsWithPartialWord && nextPageContent && !wasModified) {
    // Try to find the completion in the next page - take multiple words to ensure we get a complete phrase
    const nextWords = nextPageContent.trim().split(/\s+/).slice(0, 5).join(' ');
    
    if (nextWords && nextWords.length > 0) {
      enhancedContent = enhancedContent + ' ' + nextWords;
      console.log(`✅ Manually fixed potential partial word "${lastWord}" by adding "${nextWords}"`);
      wasModified = true;
    }
  }
  
  // Ensure we don't have double spaces
  enhancedContent = enhancedContent.replace(/\s{2,}/g, ' ');
  
  // If we really couldn't fix anything, just keep the original content
  if (!wasModified) {
    console.log(`ℹ️ No manual fixes applied to page ${originalPage.pageNumber}`);
    return originalPage;
  }
  
  return {
    ...originalPage,
    content: enhancedContent,
    __modified: wasModified
  };
}

// Add static properties to the function
(ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction).genAI = null;
(ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction).apiFailureCount = 0;
(ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction).maxApiFailures = 5; // After 5 failures, disable API
(ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction).apiDisabled = false;

// Make sure the Document type has pages property - find its definition
interface Document {
  id: string;
  pages: DocumentPage[];
  // ... other properties
}

export interface DocumentPage {
  pageNumber: number;
  content: string;
  __preProcessed?: boolean;
  __modified?: boolean;
}

// Keep the function but make it a private helper function only used within document.ts
const markSentenceBoundaries = (text: string): string => {
  if (!text) return '';
  
  // First, handle any continuation markers from cross-page processing
  let processedText = text.replace(/\[CONTINUATION_MARKER\]/g, ' ');
  
  // Also handle paragraph continuation markers
  processedText = processedText.replace(/\[PARAGRAPH_CONTINUATION_FROM_PREVIOUS_PAGE\]/g, '[SENTENCE_FRAGMENT_MARKER] ');
  processedText = processedText.replace(/\[PARAGRAPH_CONTINUATION_TO_NEXT_PAGE\]/g, ' [SENTENCE_FRAGMENT_MARKER]');
  
  // Regex pattern to detect sentence boundaries
  // Handles common punctuation in multiple languages (including Vietnamese)
  const sentenceEndPattern = /([.!?;:])\s+(?=[A-ZÀ-Ỹ0-9])/g;
  
  // Add special markers at sentence boundaries
  let markedText = processedText.replace(sentenceEndPattern, '$1[SENTENCE_BOUNDARY]');
  
  // Handle sentences that end with punctuation at paragraph breaks
  markedText = markedText.replace(/([.!?;:])\n+/g, '$1[SENTENCE_BOUNDARY]\n');
  
  // Special handling for Vietnamese text
  
  // 1. Detect Vietnamese sentence patterns with specific ending particles
  markedText = markedText.replace(/(\s(vậy|nhỉ|nhé|ạ|a|đấy|đó|chứ))\s+(?=[A-ZÀ-Ỹ])/g, '$1[SENTENCE_BOUNDARY]');
  
  // 2. Look for capitalization patterns that might indicate sentence boundaries
  markedText = markedText.replace(/(\s+)(?=[A-ZÀ-Ỹ][a-zà-ỹ]+\s)/g, '$1[POSSIBLE_SENTENCE_BOUNDARY]');
  
  // 3. Special case for proper names in Vietnamese (avoid false positives)
  const vnProperNames = /(Nguyễn|Trần|Lê|Phạm|Hoàng|Huỳnh|Phan|Vũ|Võ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Lý)/g;
  markedText = markedText.replace(new RegExp(`\\[POSSIBLE_SENTENCE_BOUNDARY\\](${vnProperNames.source})`, 'g'), ' $1');
  
  // Add sentence start markers at the beginning of paragraphs
  markedText = markedText.replace(/^\s*/gm, '[SENTENCE_START]');
  
  // Force SENTENCE_FRAGMENT_MARKER at the very beginning of the text if no clear sentence start
  if (!/^\[SENTENCE_START\]/.test(markedText) && !/^[A-ZÀ-Ỹ0-9"']/.test(markedText)) {
    markedText = '[SENTENCE_FRAGMENT_MARKER] ' + markedText;
  }
  
  // Remove duplicate markers
  markedText = markedText.replace(/\[SENTENCE_BOUNDARY\]\s*\[SENTENCE_START\]/g, '[SENTENCE_BOUNDARY]');
  
  return markedText;
};

// Add this helper function for retrying API calls with exponential backoff
async function retryApiCall<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 1000
): Promise<T> {
  let lastError: any;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      // Check if we should retry based on the error
      const isNetworkError = 
        error.message?.includes('fetch failed') || 
        error.message?.includes('network') ||
        error.message?.includes('timeout') ||
        error.message?.includes('ECONNRESET');
      
      // Don't retry if it's not a network error
      if (!isNetworkError) {
        console.log(`❌ Non-retryable error: ${error.message}`);
        throw error;
      }
      
      // If this was the last retry, throw the error
      if (attempt === maxRetries) {
        console.log(`❌ Failed after ${maxRetries} retries`);
        throw error;
      }
      
      // Calculate exponential backoff delay
      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      console.log(`⏱️ Retry ${attempt}/${maxRetries} after ${delayMs}ms delay (${error.message})`);
      
      // Wait before retrying
      await sleep(delayMs);
    }
  }
  
  // This should never happen, but TypeScript requires a return
  throw lastError;
}

// Add this helper function to check for common proxy environment variables
function checkProxySettings() {
  const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy;
  const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  
  if (!httpProxy && !httpsProxy) {
    console.warn(`
⚠️ WARNING: No proxy environment variables detected (HTTP_PROXY, HTTPS_PROXY).
If you're behind a corporate firewall or proxy, fetch requests might fail.
Consider setting HTTP_PROXY and HTTPS_PROXY environment variables if needed.
For example: 
  HTTP_PROXY=http://proxy.example.com:8080
  HTTPS_PROXY=http://proxy.example.com:8080
  NO_PROXY=localhost,127.0.0.1
    `);
  } else {
    console.log(`ℹ️ Proxy settings detected: HTTP_PROXY=${httpProxy ? 'set' : 'not set'}, HTTPS_PROXY=${httpsProxy ? 'set' : 'not set'}`);
  }
}

// Call the proxy check when the module is loaded
checkProxySettings();

// Add a simple function to detect if text might have been accidentally translated to English
function detectTranslationToEnglish(originalText: string, enhancedText: string): boolean {
  // Skip empty content
  if (!originalText || !enhancedText) return false;
  
  // Common English words that shouldn't appear much in Vietnamese text
  const englishWords = [
    'the', 'and', 'is', 'in', 'are', 'to', 'of', 'for', 'with', 'that', 'this',
    'fire', 'water', 'page', 'chapter', 'women', 'men', 'people', 'should', 'must', 
    'could', 'would', 'caution', 'extreme', 'fundamental'
  ];
  
  // Count English words
  let englishWordCount = 0;
  const enhancedWords = enhancedText.toLowerCase().split(/\s+/);
  
  for (const word of enhancedWords) {
    if (englishWords.includes(word.replace(/[.,;:!?'"]/g, ''))) {
      englishWordCount++;
    }
  }
  
  // If more than 20% of the words seem to be English, it's likely translated
  const threshold = 0.20;
  const englishRatio = englishWordCount / enhancedWords.length;
  
  if (englishRatio > threshold) {
    console.error(`⚠️ TRANSLATION DETECTED! Content appears to have been translated to English (${(englishRatio * 100).toFixed(1)}% English words)`);
    console.error(`⚠️ Original language should have been preserved. Using original content instead.`);
    return true;
  }
  
  return false;
} 