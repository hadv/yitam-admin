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

// Parse DOCX document into sections/pages for better chunking
export const parseDocxByPages = async (filePath: string): Promise<{ pages: { pageNumber: number; content: string }[] }> => {
  try {
    // Make sure the file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Read DOCX file
    const docxBuffer = await readFile(filePath);
    
    // Extract raw text
    const docxResult = await mammoth.extractRawText({ buffer: docxBuffer });
    const fullText = docxResult.value;
    
    console.log(`📄 Extracted ${fullText.length} characters from DOCX document`);
    
    // Array to store page data
    const pages: { pageNumber: number; content: string }[] = [];
    
    // Split document into logical sections
    // Method 1: Split by paragraph markers (double newlines)
    const paragraphs = fullText.split(/\n\s*\n/).filter(p => p.trim());
    
    // Method 2: Look for headings as section dividers
    const headingRegex = /^(?:[\s\t]*)(#{1,6}|[A-Z\d][\.\)]\s+|[IVXLCDM]+\.\s+|Chapter\s+\d+|Section\s+\d+|Phần\s+\d+|Chương\s+\d+|Mục\s+\d+)(?:[\s\t]*)([^\n]+)$/gm;
    const headingMatches = [...fullText.matchAll(headingRegex)];
    
    // Method 3: Estimate page breaks (~ 3000 characters per "page")
    const estimatedPageSize = 3000;
    
    // If we have clear headings, use them to split
    if (headingMatches.length > 4) {
      console.log(`🔍 Found ${headingMatches.length} headings to use as section breaks`);
      
      let lastIndex = 0;
      let pageNumber = 1;
      
      // Create a map of heading positions
      const headingPositions = headingMatches.map(match => match.index).filter(index => index !== undefined) as number[];
      
      // Split by headings
      for (let i = 0; i < headingPositions.length; i++) {
        const startPos = lastIndex;
        const endPos = i < headingPositions.length - 1 ? headingPositions[i + 1] : fullText.length;
        
        // Extract content for this section
        const content = fullText.substring(startPos, endPos).trim();
        
        // Only add non-empty sections
        if (content.length > 10) {
          pages.push({
            pageNumber,
            content
          });
          pageNumber++;
        }
        
        lastIndex = endPos;
      }
      
      // Add any remaining content
      if (lastIndex < fullText.length) {
        const remainingContent = fullText.substring(lastIndex).trim();
        if (remainingContent.length > 10) {
          pages.push({
            pageNumber,
            content: remainingContent
          });
        }
      }
    } 
    // If we have enough paragraphs, use them to create logical sections
    else if (paragraphs.length > 10) {
      console.log(`🔍 Using ${paragraphs.length} paragraphs to create logical sections`);
      
      // Group paragraphs into sections of roughly equal size
      const paragraphsPerSection = Math.max(3, Math.ceil(paragraphs.length / 15)); // Aim for ~15 sections
      let currentSection: string[] = [];
      let pageNumber = 1;
      
      paragraphs.forEach((para, index) => {
        currentSection.push(para);
        
        // When we reach the paragraphs per section limit, or at the end
        if (currentSection.length >= paragraphsPerSection || index === paragraphs.length - 1) {
          pages.push({
            pageNumber,
            content: currentSection.join('\n\n')
          });
          pageNumber++;
          currentSection = [];
        }
      });
    } 
    // Otherwise, just split by estimated page size
    else {
      console.log(`🔍 Splitting document into ${Math.ceil(fullText.length / estimatedPageSize)} estimated pages`);
      
      // Find reasonable break points (end of paragraphs) near our target page size
      let currentPos = 0;
      let pageNumber = 1;
      
      while (currentPos < fullText.length) {
        // Calculate the target end position
        let targetEndPos = Math.min(currentPos + estimatedPageSize, fullText.length);
        
        // If we're not at the end, find a good break point (end of paragraph)
        if (targetEndPos < fullText.length) {
          // Look for paragraph break within 500 chars of target
          const searchArea = fullText.substring(targetEndPos - 500, targetEndPos + 500);
          const paragraphBreaks = [...searchArea.matchAll(/\.\s+(?=[A-Z])/g)];
          
          if (paragraphBreaks.length > 0) {
            // Find break point closest to our target
            let closestBreak = paragraphBreaks.reduce((closest, match) => {
              const pos = (match.index || 0) + targetEndPos - 500;
              const distance = Math.abs(pos - targetEndPos);
              return distance < Math.abs(closest - targetEndPos) ? pos : closest;
            }, targetEndPos);
            
            targetEndPos = closestBreak + 2; // +2 to include the period and space
          }
        }
        
        // Extract content for this page
        const content = fullText.substring(currentPos, targetEndPos).trim();
        
        // Only add non-empty pages
        if (content.length > 10) {
          pages.push({
            pageNumber,
            content
          });
          pageNumber++;
        }
        
        currentPos = targetEndPos;
      }
    }
    
    console.log(`📑 Created ${pages.length} logical pages/sections from DOCX document`);
    
    return { pages };
  } catch (error) {
    console.error(`Error parsing DOCX by pages ${path.basename(filePath)}:`, error);
    throw new Error('Failed to parse DOCX document by pages');
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
        try {
          // Extract text content from the page with more detailed options
          const content = await pageData.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false
          });
          
          // Improved text extraction logic for better handling of Vietnamese text
          let textItems: { 
            str: string, 
            x: number, 
            y: number, 
            width?: number,
            height?: number,
            fontName?: string
          }[] = [];
          
          // Process each text item while preserving position information
          content.items.forEach((item: any) => {
            if ('str' in item && item.str.trim()) {
              textItems.push({
                str: item.str,
                x: item.transform[4], // x position
                y: item.transform[5],  // y position
                width: item.width,
                height: item.height,
                fontName: item.fontName
              });
            }
          });
          
          // Sort items by y-position (top to bottom), then by x-position (left to right)
          textItems.sort((a, b) => {
            // Use a tolerance value to group items on the same line
            const yTolerance = 3; // Adjust based on your document's font size
            if (Math.abs(a.y - b.y) <= yTolerance) {
              return a.x - b.x; // Same line, sort left to right
            }
            return b.y - a.y; // Different lines, sort top to bottom
          });
          
          // Combine text with proper spacing based on positions
          let pageText = '';
          let currentY: number | null = null;
          let currentLineText = '';
          
          // Process text items into lines
          for (let i = 0; i < textItems.length; i++) {
            const item = textItems[i];
            
            // Check if this is a new line
            if (currentY === null || Math.abs(item.y - currentY) > 3) {
              // Add the previous line to the page text if it exists
              if (currentLineText) {
                pageText += currentLineText + '\n';
                currentLineText = '';
              }
              
              currentY = item.y;
              currentLineText = item.str;
            } else {
              // Check if we need a space between words
              const prevItem = textItems[i - 1];
              
              // More intelligent space detection using character width
              const expectedGapWidth = prevItem.width ? prevItem.str.length * (prevItem.width / prevItem.str.length) * 0.3 : 4;
              const actualGap = item.x - (prevItem.x + (prevItem.width || 0));
              
              // Add space if the gap is significant or if last item didn't end with space
              const spaceNeeded = (actualGap > expectedGapWidth && 
                               !prevItem.str.endsWith(' ') && 
                               !item.str.startsWith(' '));
              
              currentLineText += (spaceNeeded ? ' ' : '') + item.str;
            }
          }
          
          // Add the last line
          if (currentLineText) {
            pageText += currentLineText;
          }
          
          // Fix common Vietnamese ligature issues directly in the PDF parsing
          const cleanedText = pageText
            // Fix common Vietnamese OCR errors
            .replace(/([A-ZÀ-Ỹa-zà-ỹ])\s+([àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ])/g, '$1$2')
            .replace(/\b([A-ZÀ-Ỹa-zà-ỹ])\s+([A-ZÀ-Ỹa-zà-ỹ])\s+([A-ZÀ-Ỹa-zà-ỹ])\s+([A-ZÀ-Ỹa-zà-ỹ])\b/g, '$1$2$3$4')
            .replace(/h\s*u\s*y\s*[eé]\s*[́̀̉̃]\s*t/gi, "huyết")
            .replace(/t\s*h\s*u\s*y\s*[eé]\s*[́̀̉̃]\s*t/gi, "thuyết")
            .replace(/huyếch/gi, "huyết");
          
          // Add page to the result
          pages.push({
            pageNumber: pageData.pageNumber,
            content: cleanedText
          });
          
          // Return an empty string as we're storing pages separately
          return '';
        } catch (pageError) {
          console.error(`Error extracting text from page ${pageData.pageNumber}:`, pageError);
          
          // Fall back to basic extraction
          pages.push({
            pageNumber: pageData.pageNumber,
            content: pageData.getTextContent ? 
                     (await pageData.getTextContent()).items.map((item: any) => item.str || '').join(' ') : 
                     ''
          });
          
          return '';
        }
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
 * Use LLM to correct OCR errors with specific focus on Vietnamese text
 */
export const correctOcrWithLLM = async (text: string): Promise<string> => {
  if (!text.trim()) return '';
  
  try {
    // First, apply targeted regex fixes for the most common Vietnamese OCR errors
    let preProcessedText = text;
    
    // FIX SPECIFIC CHARACTER ERRORS WITHOUT CHANGING MEANING
    
    // Fix spacing in Vietnamese diacritics (this is critical)
    preProcessedText = preProcessedText.replace(/h\s*u\s*y\s*[eé]\s*[́̀̉̃]\s*t/gi, "huyết");
    preProcessedText = preProcessedText.replace(/t\s*h\s*u\s*y\s*[eé]\s*[́̀̉̃]\s*t/gi, "thuyết");
    preProcessedText = preProcessedText.replace(/c\s*h\s*ư\s*([oơ])\s*n\s*g/gi, "chương");
    preProcessedText = preProcessedText.replace(/h\s*o\s*à\s*n/gi, "hoàn");
    preProcessedText = preProcessedText.replace(/h\s*u\s*y\s*[eé]\s*[́̀̉̃]?\s*c\s*h/gi, "huyết");
    
    // Fix specific problem cases
    preProcessedText = preProcessedText.replace(/huyếch/gi, "huyết");
    preProcessedText = preProcessedText.replace(/\b(LỤC VỊ HOÀN|Lục Vị Hoàn) Thuật\b/gi, "$1 Thuyết");
    
    // Get API key - try to use the AI model
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ No AI API key found for OCR correction. Basic regex corrections applied but full correction unavailable.');
      return preProcessedText;
    }

    try {
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-pro", 
        generationConfig: {
          temperature: 0,
          topP: 0.1,
          maxOutputTokens: 4096,
        }
      });
      
      // Enhanced prompt for Vietnamese OCR correction with EXACT examples from user
      const prompt = `
Nhiệm vụ: Sửa lỗi font chữ và ký tự trong văn bản tiếng Việt.

QUY TẮC QUAN TRỌNG:
1. CHỈ sửa lỗi ký tự bị tách rời và lỗi font (ví dụ: "huy ế t" → "huyết")
2. KHÔNG thay đổi cấu trúc đoạn văn gốc hay ý nghĩa của văn bản
3. KHÔNG thêm hoặc xóa đoạn văn, câu, từ
4. Giữ nguyên vị trí của các dấu câu và khoảng cách giữa các đoạn
5. Duy trì chính xác các thuật ngữ y học cổ truyền và triết học
6. TUYỆT ĐỐI KHÔNG thêm dấu đầu dòng, không thêm bullet points hoặc asterisk (*)
7. KHÔNG thay đổi định dạng, KHÔNG định dạng lại văn bản, giữ nguyên cấu trúc gốc
8. KHÔNG đánh số hoặc thêm ký tự đặc biệt trang trí vào văn bản

SỬA CHÍNH XÁC những lỗi này:
- "huy ế t" → "huyết" (KHÔNG phải "huyếch")
- "thuy ế t" → "thuyết" (KHÔNG phải "thuật")
- "t ấ t" → "tất"
- "trư ớ c" → "trước"
- "Chư ơng" → "Chương"

VÍ DỤ CỤ THỂ:
1. Gốc: "Thoát huy ế t trư ớ c t ấ t ích khí."
   Đúng: "Thoát huyết trước tất ích khí."
   Sai: "Thoát huyếch trước tất ích khí."

2. Gốc: "Chư ơng 1 5 L Ụ C V Ị HOÀN THUY Ế T"
   Đúng: "Chương 15 LỤC VỊ HOÀN THUYẾT"
   Sai: "Chương 15 Lục Vị Hoàn Thuật"

3. Gốc: "là vị thuốc trong trọc ở trong loại thuốc trong trọc, có tác dụng cứng mạnh gân xương, bệnh nội thương, bệnh gân xương của can thận đều phải dùng nó."
   Đúng: "là vị thuốc trong trọc ở trong loại thuốc trong trọc, có tác dụng cứng mạnh gân xương, bệnh nội thương, bệnh gân xương của can thận đều phải dùng nó."
   Sai: "• Là vị thuốc trong trọc: Thuộc loại thuốc trong trọc, có tác dụng cứng mạnh gân xương, chữa bệnh nội thương và bệnh gân xương của can thận."

VĂN BẢN CẦN SỬA:
${preProcessedText}

(Instructions in English for model understanding:
Task: Fix ONLY character and font errors in Vietnamese text.
DO NOT change paragraph structure or meanings.
DO NOT add or remove sentences or words.
DO NOT reorganize the text flow.
DO NOT add bullet points, asterisks, or any formatting.
DO NOT reorganize content into lists or add numbering.
KEEP the exact same text structure as the original.
Specifically fix "huy ế t" to "huyết" (NOT "huyếch") and "thuy ế t" to "thuyết" (NOT "thuật").
Return ONLY the corrected text, preserving original structure exactly as provided.)`;

      // Call API with retry mechanism
      let retryCount = 0;
      const maxRetries = 3;
      let correctedText = preProcessedText;
      let currentPrompt = prompt;
      
      while (retryCount < maxRetries) {
        try {
          const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: currentPrompt }] }],
            generationConfig: {
              temperature: 0.1,
              maxOutputTokens: 8000,
            }
          });
          
          correctedText = result.response.text().trim();
          
          // Check if corrections are properly applied
          const hasHuyech = correctedText.includes("huyếch");
          const hasThuat = /\b(LỤC VỊ HOÀN|Lục Vị Hoàn) Thuật\b/i.test(correctedText);
          
          if (hasHuyech || hasThuat) {
            console.log(`⚠️ AI still produced incorrect corrections (retry ${retryCount + 1}/${maxRetries})`);
            retryCount++;
            
            // Make the prompt more specific on problem areas
            currentPrompt += `\n\nCHÚ Ý ĐẶC BIỆT: Văn bản vẫn có các lỗi sau cần sửa:
            ${hasHuyech ? '- "huyếch" phải sửa thành "huyết"' : ''}
            ${hasThuat ? '- "LỤC VỊ HOÀN Thuật" phải sửa thành "LỤC VỊ HOÀN THUYẾT"' : ''}`;
            
            continue;
          }
          
          // Post-process to catch any remaining issues
          correctedText = correctedText
            .replace(/huyếch/gi, "huyết")
            .replace(/\b(LỤC VỊ HOÀN|Lục Vị Hoàn) Thuật\b/gi, "$1 Thuyết");
          
          break;
        } catch (error) {
          console.error(`❌ API error (attempt ${retryCount + 1}/${maxRetries}):`, error);
          retryCount++;
          
          // Short delay before retrying
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      // Verify it's not translated and hasn't lost content
      if (detectTranslationToEnglish(preProcessedText, correctedText) || 
          correctedText.length < preProcessedText.length * 0.8) {
        console.warn('❌ AI correction issue detected. Using pre-processed text with regex fixes instead.');
        return preProcessedText;
      }
      
      console.log(`✅ Enhanced text with AI (${correctedText.length} characters)`);
      return correctedText;
    } catch (error) {
      console.error('❌ Error using AI for text correction:', error);
      // Return regex-processed text if AI fails
      return preProcessedText;
    }
  } catch (error) {
    console.error('Error correcting text:', error);
    return text;
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
  
  // Clean raw pages to prepare for processing
  const rawPages = document.pages.map(page => ({
    ...page,
    content: page.content.trim()
  }));
  
  // First pass: Use the LLM approach to fix obvious issues
  const enhancedPagesPromises = rawPages.map(async (page, index, allPages) => {
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
  
  const enhancedPages = await Promise.all(enhancedPagesPromises);
  
  // Second pass: Manual fixes for remaining issues
  const finalPages = [...enhancedPages];
  
  // Track which pages we've modified to avoid double-modification
  const modifiedIndices = new Set<number>();
  
  for (let i = 0; i < finalPages.length; i++) {
    if (modifiedIndices.has(i)) continue;
    
    const currPage = finalPages[i];
    const prevPage = i > 0 ? finalPages[i - 1] : null;
    const nextPage = i < finalPages.length - 1 ? finalPages[i + 1] : null;
    
    let currContent = currPage.content.trim();
    let modified = false;
    
    // 1. Fix beginning of current page if it starts with a fragment
    if (prevPage && !modifiedIndices.has(i - 1)) {
      const prevContent = prevPage.content.trim();
      
      // Check if current page begins with a fragment
      const startsWithLowercase = /^[a-zà-ỹ]/.test(currContent);
      const startsWithContinuationWord = /^(và|hoặc|hay|nhưng|bởi|vì|rằng|nên|để|mà|thì|là|với|cho|trong|từ|đến|bởi vì|tại vì|vào|ra|lên|xuống|ngoài|theo|sau|trước|cùng|cùng với)/i.test(currContent);
      const startsWithPunctuation = /^[,;)}\]]/.test(currContent);
      
      if (startsWithLowercase || startsWithContinuationWord || startsWithPunctuation) {
        console.log(`⚠️ Page ${currPage.pageNumber} begins with a fragment`);
        
        // Find the last sentence from previous page
        const sentenceRegex = /[^.!?:;。]+[.!?:;。]\s*$/;
        const match = prevContent.match(sentenceRegex);
        
        if (match && match[0]) {
          const lastSentence = match[0].trim();
          
          // Only prepend if it's not too long and not already there
          if (lastSentence.length < 200 && !currContent.startsWith(lastSentence)) {
            currContent = lastSentence + ' ' + currContent;
            modified = true;
            console.log(`✅ Added last sentence from page ${currPage.pageNumber-1} to beginning of page ${currPage.pageNumber}`);
          }
        } else {
          // If no clear sentence, get last 150 characters
          const lastChars = prevContent.substring(Math.max(0, prevContent.length - 150));
          
          // Find a good break point
          const breakPoint = lastChars.search(/[.!?:;。,]\s+[A-ZÀ-Ỹ]/);
          const textToAdd = breakPoint > 0 ? 
                            lastChars.substring(breakPoint + 2) : 
                            lastChars;
          
          if (!currContent.startsWith(textToAdd)) {
            currContent = textToAdd + ' ' + currContent;
            modified = true;
            console.log(`✅ Added ${textToAdd.length} chars from page ${currPage.pageNumber-1} to beginning of page ${currPage.pageNumber}`);
          }
        }
      }
    }
    
    // 2. Fix end of current page if it ends with a fragment
    if (nextPage && !modifiedIndices.has(i + 1)) {
      const nextContent = nextPage.content.trim();
      
      // Check if current page ends with a fragment
      const endsWithoutPunctuation = !/[.!?:;。]\s*$/.test(currContent);
      const lastWord = currContent.split(/\s+/).pop() || '';
      const endsWithPartialWord = lastWord.length <= 2 || /[bcdfghjklmnpqrstvwxzđ]$/i.test(lastWord);
      
      if (endsWithoutPunctuation || endsWithPartialWord) {
        console.log(`⚠️ Page ${currPage.pageNumber} ends with a fragment`);
        
        // Find the first sentence from next page
        const sentenceRegex = /^[^.!?:;。]+[.!?:;。]/;
        const match = nextContent.match(sentenceRegex);
        
        if (match && match[0]) {
          const firstSentence = match[0].trim();
          
          // Only append if it's not too long and not already there
          if (firstSentence.length < 200 && !currContent.endsWith(firstSentence)) {
            currContent = currContent + ' ' + firstSentence;
            modified = true;
            console.log(`✅ Added first sentence from page ${currPage.pageNumber+1} to end of page ${currPage.pageNumber}`);
          }
        } else {
          // If no clear sentence, get first 150 characters
          const firstChars = nextContent.substring(0, Math.min(nextContent.length, 150));
          
          // Find a good break point
          const breakPoint = firstChars.search(/[.!?:;。]\s+/);
          const textToAdd = breakPoint > 0 ? 
                            firstChars.substring(0, breakPoint + 1) : 
                            firstChars;
          
          if (!currContent.endsWith(textToAdd)) {
            currContent = currContent + ' ' + textToAdd;
            modified = true;
            console.log(`✅ Added ${textToAdd.length} chars from page ${currPage.pageNumber+1} to end of page ${currPage.pageNumber}`);
          }
        }
      }
    }
    
    // Update the page if modified
    if (modified) {
      finalPages[i] = {
        ...currPage,
        content: currContent,
        __modified: true
      };
      modifiedIndices.add(i);
    }
  }
  
  // Third pass: Check for overlaps between adjacent pages
  for (let i = 0; i < finalPages.length - 1; i++) {
    if (modifiedIndices.has(i) || modifiedIndices.has(i + 1)) continue;
    
    const currPage = finalPages[i];
    const nextPage = finalPages[i + 1];
    
    const currContent = currPage.content.trim();
    const nextContent = nextPage.content.trim();
    
    // Check for overlap between end of current page and start of next page
    let overlap = 0;
    
    for (let length = 50; length >= 20; length -= 5) {
      if (currContent.length < length || nextContent.length < length) continue;
      
      const currEnd = currContent.substring(currContent.length - length);
      
      if (nextContent.startsWith(currEnd)) {
        overlap = length;
        break;
      }
    }
    
    // Fix overlap if found
    if (overlap > 0) {
      console.log(`✅ Found ${overlap} character overlap between pages ${currPage.pageNumber} and ${nextPage.pageNumber}`);
      
      const fixedNextContent = nextContent.substring(overlap);
      finalPages[i + 1] = {
        ...nextPage,
        content: fixedNextContent,
        __modified: true
      };
      modifiedIndices.add(i + 1);
    }
  }
  
  // Final cleanup to fix any remaining issues
  for (let i = 0; i < finalPages.length; i++) {
    if (modifiedIndices.has(i)) continue;
    
    const page = finalPages[i];
    let content = page.content.trim();
    let modified = false;
    
    // Ensure the page doesn't start with partial word or punctuation
    if (/^[,;)}\]]/.test(content)) {
      content = content.replace(/^[,;)}\]]+\s*/, '');
      modified = true;
    }
    
    // Ensure the page doesn't end with a partial word
    const lastWord = content.split(/\s+/).pop() || '';
    if (lastWord.length <= 2 && !/[.!?:;。,]$/.test(content)) {
      content = content.replace(/\s+\S{1,2}$/, '.');
      modified = true;
    }
    
    // Update if modified
    if (modified) {
      finalPages[i] = {
        ...page,
        content: content,
        __modified: true
      };
    }
  }
  
  // Log the results
  const modifiedPages = finalPages.filter(p => p.__modified).length;
  console.log(`✅ Content preparation complete: ${modifiedPages} pages were modified to ensure complete sentences`);
  
  // Return document with processed pages
  return {
    ...document,
    pages: finalPages
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

CRITICAL FORMATTING RULES:
1. DO NOT add bullet points, asterisks (*), or any formatting to the text
2. DO NOT reorganize text into lists or add numbering
3. KEEP the exact same text structure as the original
4. PRESERVE the exact formatting, paragraph breaks, and layout
5. DO NOT add section headers or text decoration
6. If the original text has no bullet points, do not add them

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
PRESERVE EXACT TEXT STRUCTURE - NO BULLET POINTS OR FORMATTING
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