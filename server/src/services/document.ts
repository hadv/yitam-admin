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
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    
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

Return ONLY the corrected text with proper spacing between words and numbers.`;

    // Call Gemini API
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
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
}

async function ensureCompleteSentences(prevPage: DocumentPage | null, currPage: DocumentPage, nextPage: DocumentPage | null): Promise<DocumentPage> {
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
  
  // Check if page ends without proper sentence terminator
  // Includes Vietnamese-specific ending patterns
  const endsWithFragment = !/[.!?:;。]\s*$|[.:;]\s*"?\s*$/.test(currentPageContent);
  
  // Check for words that are often split across pages in Vietnamese
  const endsWithPartialWord = /[bcdfghjklmnpqrstvwxzđ]$/i.test(currentPageContent.trim()) || 
                              /(vi|đi|xe|ba|bo|ca|co|cu|du|ma|ph|th|tr|ch|nh|kh|gi|qu|ng|gh|đ|b|t|c|l|m|n|p|h|r|x|v|k|g|d)$/i.test(currentPageContent.trim().split(/\s+/).pop() || '');
  
  // If no issues detected, return the original content
  if (!startsWithFragment && !endsWithFragment && !endsWithPartialWord) {
    console.log(`✅ Page ${currPage.pageNumber} has complete sentences. No changes needed.`);
    return currPage;
  }
  
  // Log the detected issues
  if (startsWithFragment) {
    console.log(`⚠️ Page ${currPage.pageNumber} starts with a continuation (fragment detected)`);
  }
  
  if (endsWithFragment) {
    console.log(`⚠️ Page ${currPage.pageNumber} ends with an incomplete sentence`);
  }
  
  if (endsWithPartialWord) {
    console.log(`⚠️ Page ${currPage.pageNumber} ends with a partial word`);
  }
  
  // Prepare content from previous, current and next pages
  // Increased context window to capture more content
  let prevPageContent = '';
  let nextPageContent = '';
  
  if (prevPage && (startsWithFragment || (prevPage.content && currentPageContent.length > 0))) {
    // Get more content from end of previous page (up to 2500 chars)
    prevPageContent = prevPage.content.trim();
    if (prevPageContent.length > 2500) {
      prevPageContent = prevPageContent.substring(prevPageContent.length - 2500);
    }
  }
  
  if (nextPage && (endsWithFragment || endsWithPartialWord)) {
    // Get more content from beginning of next page (up to 2500 chars)
    nextPageContent = nextPage.content.trim();
    if (nextPageContent.length > 2500) {
      nextPageContent = nextPageContent.substring(0, 2500);
    }
  }

  // Add logging to show context sizes
  console.log(`Context sizes - Previous: ${prevPageContent.length}, Current: ${currentPageContent.length}, Next: ${nextPageContent.length}`);

  // Prepare a prompt for the LLM to fix incomplete sentences with more explicit instructions for Vietnamese
  const prompt = `
I have a page from a Vietnamese document that may have incomplete sentences at the beginning or end. 
I need to create a version that ensures all sentences are complete by borrowing minimal necessary text from 
adjacent pages. This is critical for proper document chunking.

PREVIOUS PAGE END:
"""
${prevPageContent}
"""

MIDDLE PAGE (the target content): 
"""
${currentPageContent}
"""

NEXT PAGE START:
"""
${nextPageContent}
"""

Instructions:
1. If the MIDDLE PAGE starts with a fragment (lowercase letter, continuation word, etc.), 
   borrow the minimal necessary text from the PREVIOUS PAGE END to make it start with a complete sentence.
   Vietnamese continuation words include: của, và, hoặc, hay, nhưng, bởi, vì, rằng, nên, để, mà, thì, etc.

2. If the MIDDLE PAGE ends with an incomplete sentence or partial word, borrow the minimal necessary text 
   from the NEXT PAGE START to complete it. Pay special attention to Vietnamese words that might be split across pages.

3. Make sure no Vietnamese syllables are split (like "vi" + "ệc") by borrowing appropriately.

4. Only modify the MIDDLE PAGE content, and only borrow what's ABSOLUTELY NECESSARY to complete sentences.
   Do not alter meaning or remove content.

5. Return ONLY the fixed MIDDLE PAGE content with complete sentences and words.

6. Be extremely careful with Vietnamese text, ensuring complete grammatical units are preserved.

I want the output to be the MIDDLE PAGE content with minimal changes - only fix incomplete sentences at 
the beginning and end by borrowing minimally from adjacent pages. If the content already has complete sentences, 
return it unchanged.`;

  try {
    // Use Gemini to fix the content
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ No AI API key found, using manual fallback for sentence completion');
      return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment || endsWithPartialWord, currPage);
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-pro", 
      generationConfig: {
        temperature: 0,
        topP: 0.1,
        maxOutputTokens: 4096,
      }
    });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });

    const response = result.response;
    const enhancedContent = response.text().trim();
    
    // Verify the LLM actually made meaningful changes
    if (!enhancedContent || enhancedContent.length < currentPageContent.length * 0.5) {
      console.warn(`⚠️ LLM output for page ${currPage.pageNumber} seems too short, using manual fallback`);
      return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment || endsWithPartialWord, currPage);
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
  } catch (error) {
    console.error(`❌ Error enhancing page ${currPage.pageNumber}:`, error);
    // Try manual fallback if LLM fails
    return manuallyFixTruncations(prevPageContent, currentPageContent, nextPageContent, startsWithFragment, endsWithFragment || endsWithPartialWord, currPage);
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
    // Find last sentence in previous page
    const sentencePattern = /[^.!?:;。]+[.!?:;。][^\w]*$/;
    const lastSentenceMatch = prevPageContent.match(sentencePattern);
    
    if (lastSentenceMatch && lastSentenceMatch[0]) {
      const lastSentence = lastSentenceMatch[0].trim();
      enhancedContent = lastSentence + ' ' + enhancedContent;
      console.log(`✅ Manually added content from previous page: "${lastSentence.substring(0, 30)}..."`);
      wasModified = true;
    } else {
      // If no sentence break found, take last few lines or chunk
      const lastLines = prevPageContent.split('\n').slice(-3).join('\n');
      enhancedContent = lastLines + ' ' + enhancedContent;
      console.log(`✅ Manually added last lines from previous page`);
      wasModified = true;
    }
  }
  
  // Fix end truncation
  if (endsWithFragment && nextPageContent) {
    // Find first sentence in next page
    const firstSentencePattern = /^[^.!?:;。]+[.!?:;。][^\w]*/;
    const firstSentenceMatch = nextPageContent.match(firstSentencePattern);
    
    if (firstSentenceMatch && firstSentenceMatch[0]) {
      const firstSentence = firstSentenceMatch[0].trim();
      enhancedContent = enhancedContent + ' ' + firstSentence;
      console.log(`✅ Manually added content from next page: "${firstSentence.substring(0, 30)}..."`);
      wasModified = true;
    } else {
      // If no sentence break found, take first few lines or chunk
      const firstLines = nextPageContent.split('\n').slice(0, 3).join('\n');
      enhancedContent = enhancedContent + ' ' + firstLines;
      console.log(`✅ Manually added first lines from next page`);
      wasModified = true;
    }
  }
  
  // Better fix for partial words at the end
  const lastWord = currentPageContent.trim().split(/\s+/).pop() || '';
  const endsWithPartialWord = /^[bcdfghjklmnpqrstvwxzđ]$/i.test(lastWord) || 
    /(vi|đi|xe|ba|bo|ca|co|cu|du|ma|ph|th|tr|ch|nh|kh|gi|qu|ng|gh)$/i.test(lastWord);
  
  if (endsWithPartialWord && nextPageContent && !wasModified) {
    // Try to find the completion in the next page
    const nextWords = nextPageContent.trim().split(/\s+/).slice(0, 5).join(' ');
    enhancedContent = enhancedContent + ' ' + nextWords;
    console.log(`✅ Manually fixed partial word "${lastWord}" by adding "${nextWords}"`);
    wasModified = true;
  }
  
  return {
    ...originalPage,
    content: enhancedContent,
    __modified: wasModified
  };
}

// Add this static property to the function
(ensureCompleteSentences as unknown as EnsureCompleteSentencesFunction).genAI = null;

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