import { SpeechClient } from '@google-cloud/speech';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import util from 'util';
import { spawn } from 'child_process';
import { createEmbedding } from './embedding';
import { DocumentChunk } from './chunking';

const unlink = util.promisify(fs.unlink);

export interface GoogleSpeechResult {
  transcript: string;
  confidence: number;
  words: Array<{
    word: string;
    startTime: number;
    endTime: number;
    confidence: number;
  }>;
  languageCode: string;
}

export interface ProgressCallback {
  (stage: 'audio_download' | 'audio_upload' | 'speech_recognition' | 'chunk_creation' | 'embedding_generation', 
   message: string, 
   progress?: number): void;
}

/**
 * Google Cloud Speech-to-Text client
 */
let speechClient: SpeechClient;

const initializeSpeechClient = () => {
  if (!speechClient) {
    speechClient = new SpeechClient({
      // Uses GOOGLE_APPLICATION_CREDENTIALS environment variable
    });
  }
  return speechClient;
};

/**
 * Check if yt-dlp is available
 */
export const checkYtDlpAvailable = (): Promise<boolean> => {
  return new Promise((resolve) => {
    const ytDlpProcess = spawn('yt-dlp', ['--version']);
    
    ytDlpProcess.on('close', (code) => {
      resolve(code === 0);
    });
    
    ytDlpProcess.on('error', () => {
      resolve(false);
    });
  });
};

/**
 * Download audio from YouTube using yt-dlp with Google API verification
 */
export const downloadYouTubeAudio = async (
  videoId: string,
  outputDir: string,
  progressCallback?: ProgressCallback
): Promise<string> => {
  try {
    // First, verify video exists using YouTube Data API
    const youtube = google.youtube({
      version: 'v3',
      auth: process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY
    });

    if (progressCallback) {
      progressCallback('audio_download', 'Verifying video availability with YouTube Data API', 0);
    }

    const videoResponse = await youtube.videos.list({
      part: ['snippet', 'contentDetails', 'status'],
      id: [videoId]
    });

    if (!videoResponse.data.items || videoResponse.data.items.length === 0) {
      throw new Error('Video not found or not accessible via YouTube Data API');
    }

    const video = videoResponse.data.items[0];
    const title = video.snippet?.title || `Video ${videoId}`;
    console.log(`Found video: "${title}"`);

    if (progressCallback) {
      progressCallback('audio_download', `Found video: "${title}". Starting download...`, 10);
    }

    // Download audio using yt-dlp
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const outputPath = path.join(outputDir, `${videoId}_audio.%(ext)s`);
    
    return new Promise((resolve, reject) => {
      const ytDlpArgs = [
        '--extract-audio',
        '--audio-format', 'wav', // WAV format works better with Google Speech API
        '--audio-quality', '0',
        '--output', outputPath,
        '--no-playlist',
        '--ignore-errors',
        videoUrl
      ];

      const ytDlpProcess = spawn('yt-dlp', ytDlpArgs);
      let finalOutputPath = '';

      ytDlpProcess.stdout.on('data', (data) => {
        const output = data.toString();
        
        const progressMatch = output.match(/(\d+\.?\d*)%/);
        if (progressMatch && progressCallback) {
          const progress = parseFloat(progressMatch[1]);
          progressCallback('audio_download', `Downloading audio: ${progress.toFixed(1)}%`, 10 + (progress * 0.6));
        }

        const destinationMatch = output.match(/\[download\] Destination: (.+)/);
        if (destinationMatch) {
          finalOutputPath = destinationMatch[1];
        }
      });

      ytDlpProcess.on('close', (code) => {
        if (code === 0) {
          if (!finalOutputPath) {
            finalOutputPath = path.join(outputDir, `${videoId}_audio.wav`);
          }
          
          if (fs.existsSync(finalOutputPath)) {
            if (progressCallback) {
              progressCallback('audio_download', 'Audio download completed', 70);
            }
            resolve(finalOutputPath);
          } else {
            reject(new Error('Audio file was not created despite successful yt-dlp execution'));
          }
        } else {
          reject(new Error(`Audio download failed with exit code ${code}`));
        }
      });

      ytDlpProcess.on('error', (error) => {
        reject(new Error(`Failed to start yt-dlp: ${error.message}. Make sure yt-dlp is installed.`));
      });
    });

  } catch (error: any) {
    throw new Error(`YouTube audio download failed: ${error.message}`);
  }
};

/**
 * Transcribe audio using Google Cloud Speech-to-Text API
 */
export const transcribeWithGoogleSpeech = async (
  audioPath: string,
  languageCode: string = 'vi-VN',
  progressCallback?: ProgressCallback
): Promise<GoogleSpeechResult> => {
  try {
    const client = initializeSpeechClient();

    if (progressCallback) {
      progressCallback('speech_recognition', 'Preparing audio for Google Speech API', 0);
    }

    // Read the audio file
    const audioBytes = fs.readFileSync(audioPath).toString('base64');

    if (progressCallback) {
      progressCallback('speech_recognition', 'Sending audio to Google Speech API', 25);
    }

    // Configure the request
    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'LINEAR16' as const, // For WAV files
        sampleRateHertz: 16000,
        languageCode: languageCode,
        enableWordTimeOffsets: true,
        enableWordConfidence: true,
        enableAutomaticPunctuation: true,
        model: 'latest_long', // Best for longer audio files
        useEnhanced: true, // Use enhanced model if available
        alternativeLanguageCodes: ['en-US', 'vi-VN'],
        maxAlternatives: 1,
        profanityFilter: false,
        speechContexts: [
          {
            phrases: [
              // Add domain-specific phrases for better recognition
              'võ thuật', 'martial arts', 'bát đoạn cẩm', 'qigong',
              'thái cực quyền', 'tai chi', 'kung fu'
            ],
            boost: 10.0
          }
        ]
      },
    };

    if (progressCallback) {
      progressCallback('speech_recognition', 'Processing speech recognition...', 50);
    }

    // Perform the speech recognition
    const [response] = await client.recognize(request);

    if (progressCallback) {
      progressCallback('speech_recognition', 'Speech recognition completed', 100);
    }

    if (!response.results || response.results.length === 0) {
      throw new Error('No speech recognized in the audio');
    }

    // Combine all results
    let fullTranscript = '';
    const allWords: Array<{
      word: string;
      startTime: number;
      endTime: number;
      confidence: number;
    }> = [];

    let totalConfidence = 0;
    let resultCount = 0;

    for (const result of response.results) {
      if (result.alternatives && result.alternatives[0]) {
        const alternative = result.alternatives[0];
        fullTranscript += alternative.transcript + ' ';
        
        if (alternative.confidence) {
          totalConfidence += alternative.confidence;
          resultCount++;
        }

        // Extract word-level timing information
        if (alternative.words) {
          for (const wordInfo of alternative.words) {
            if (wordInfo.word && wordInfo.startTime && wordInfo.endTime) {
              allWords.push({
                word: wordInfo.word,
                startTime: parseFloat(wordInfo.startTime.seconds || '0') + 
                          (parseFloat(wordInfo.startTime.nanos || '0') / 1000000000),
                endTime: parseFloat(wordInfo.endTime.seconds || '0') + 
                        (parseFloat(wordInfo.endTime.nanos || '0') / 1000000000),
                confidence: wordInfo.confidence || 0.9
              });
            }
          }
        }
      }
    }

    const averageConfidence = resultCount > 0 ? totalConfidence / resultCount : 0;

    return {
      transcript: fullTranscript.trim(),
      confidence: averageConfidence,
      words: allWords,
      languageCode: languageCode
    };

  } catch (error: any) {
    console.error('Google Speech API error:', error);
    throw new Error(`Google Speech recognition failed: ${error.message}`);
  }
};

/**
 * Process YouTube video using Google Services for audio fallback
 */
export const processYouTubeAudioFallback = async (
  videoId: string,
  domains: string[],
  chunkSize: number = 4000,
  chunkOverlap: number = 500,
  languageCode: string = 'vi-VN',
  progressCallback?: ProgressCallback
): Promise<DocumentChunk[]> => {
  const tempDir = path.join(process.cwd(), 'temp', 'youtube-audio');
  let audioPath: string | null = null;

  try {
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Check if yt-dlp is available
    const ytDlpAvailable = await checkYtDlpAvailable();
    if (!ytDlpAvailable) {
      throw new Error('yt-dlp is not installed. Please install yt-dlp to use audio fallback feature.');
    }

    // Download audio from YouTube
    audioPath = await downloadYouTubeAudio(videoId, tempDir, progressCallback);

    // Transcribe using Google Speech API
    const speechResult = await transcribeWithGoogleSpeech(audioPath, languageCode, progressCallback);

    if (progressCallback) {
      progressCallback('chunk_creation', 'Creating text chunks from Google Speech results', 90);
    }

    // Create chunks from transcription
    const chunks = await createChunksFromGoogleSpeech(
      speechResult,
      videoId,
      domains,
      chunkSize,
      chunkOverlap,
      progressCallback
    );

    return chunks;

  } catch (error: any) {
    console.error('Google YouTube audio processing error:', error);
    throw new Error(`Google YouTube audio processing failed: ${error.message}`);
  } finally {
    // Clean up audio file
    if (audioPath && fs.existsSync(audioPath)) {
      try {
        await unlink(audioPath);
        console.log(`Cleaned up audio file: ${audioPath}`);
      } catch (cleanupError) {
        console.warn('Could not clean up audio file:', cleanupError);
      }
    }
  }
};

/**
 * Create document chunks from Google Speech results
 */
const createChunksFromGoogleSpeech = async (
  speechResult: GoogleSpeechResult,
  videoId: string,
  domains: string[],
  chunkSize: number,
  chunkOverlap: number,
  progressCallback?: ProgressCallback
): Promise<DocumentChunk[]> => {
  const chunks: DocumentChunk[] = [];
  const text = speechResult.transcript;
  
  // Create chunks with word-level timing information
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  let currentChunk = '';
  let chunkIndex = 0;

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i].trim();
    
    if (currentChunk.length + sentence.length > chunkSize && currentChunk.length > 0) {
      await createGoogleChunk(currentChunk, chunkIndex, videoId, domains, speechResult, chunks, progressCallback);
      chunkIndex++;
      
      const overlapText = getOverlapText(currentChunk, chunkOverlap);
      currentChunk = overlapText + sentence;
    } else {
      currentChunk += (currentChunk ? '. ' : '') + sentence;
    }
  }

  if (currentChunk.trim().length > 0) {
    await createGoogleChunk(currentChunk, chunkIndex, videoId, domains, speechResult, chunks, progressCallback);
  }

  return chunks;
};

/**
 * Create a chunk with Google Speech metadata
 */
const createGoogleChunk = async (
  content: string,
  chunkIndex: number,
  videoId: string,
  domains: string[],
  speechResult: GoogleSpeechResult,
  chunks: DocumentChunk[],
  progressCallback?: ProgressCallback
): Promise<void> => {
  try {
    if (progressCallback) {
      progressCallback('embedding_generation', `Creating embedding for chunk ${chunkIndex + 1}`, undefined);
    }

    const embedding = await createEmbedding(content);

    const chunk: DocumentChunk = {
      content: content.trim(),
      embedding: embedding,
      metadata: {
        source: `https://www.youtube.com/watch?v=${videoId}`,
        type: 'youtube_google_speech',
        videoId: videoId,
        chunkIndex: chunkIndex,
        domains: domains,
        extractionMethod: 'google_speech_api',
        confidence: speechResult.confidence,
        languageCode: speechResult.languageCode,
        timestamp: new Date().toISOString(),
        wordCount: speechResult.words.length,
        hasWordTimings: speechResult.words.length > 0
      }
    };

    chunks.push(chunk);
  } catch (error) {
    console.error(`Error creating Google chunk ${chunkIndex}:`, error);
    throw error;
  }
};

/**
 * Get overlap text helper function
 */
const getOverlapText = (text: string, overlapSize: number): string => {
  if (text.length <= overlapSize) {
    return text + '. ';
  }
  
  const overlapText = text.slice(-overlapSize);
  const lastSentenceIndex = overlapText.lastIndexOf('.');
  
  if (lastSentenceIndex > 0) {
    return overlapText.slice(lastSentenceIndex + 1).trim() + '. ';
  }
  
  return overlapText + '. ';
};
