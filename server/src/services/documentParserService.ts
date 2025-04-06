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

    // Use appropriate parser based on file type
    switch (mimeType) {
      case 'application/pdf':
        // Use pdf-parse
        const pdfBuffer = await readFile(filePath);
        try {
          const pdfData = await pdfParse(pdfBuffer);
          text = pdfData.text;
        } catch (pdfError: unknown) {
          console.error('Error parsing PDF:', pdfError);
          throw new Error(`Failed to parse PDF document: ${(pdfError as Error).message}`);
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