import fs from 'fs';
import util from 'util';
import path from 'path';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';

const readFile = util.promisify(fs.readFile);

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