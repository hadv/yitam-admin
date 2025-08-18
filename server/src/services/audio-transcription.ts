import { SpeechClient } from '@google-cloud/speech';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Google Cloud Speech-to-Text configuration
const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID || '';
const GOOGLE_CLOUD_KEY_FILE = process.env.GOOGLE_CLOUD_KEY_FILE || '';
const GOOGLE_CREDENTIALS_BASE64 = process.env.GOOGLE_CREDENTIALS_BASE64 || '';

if (!GOOGLE_CLOUD_PROJECT_ID) {
  console.warn('GOOGLE_CLOUD_PROJECT_ID is not set in environment variables.');
}

if (!GOOGLE_CLOUD_KEY_FILE && !GOOGLE_CREDENTIALS_BASE64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.warn('No Google Cloud credentials found. Set GOOGLE_CLOUD_KEY_FILE, GOOGLE_CREDENTIALS_BASE64, or GOOGLE_APPLICATION_CREDENTIALS.');
}

// Initialize Speech client
let speechClient: SpeechClient | null = null;

try {
  if (GOOGLE_CREDENTIALS_BASE64) {
    // Method 1: Use base64 encoded credentials (same as existing GOOGLE_CREDENTIALS_BASE64)
    const credentials = JSON.parse(Buffer.from(GOOGLE_CREDENTIALS_BASE64, 'base64').toString());
    speechClient = new SpeechClient({
      projectId: GOOGLE_CLOUD_PROJECT_ID,
      credentials: credentials
    });
    console.log('✅ Google Speech-to-Text client initialized with base64 credentials');
  } else if (GOOGLE_CLOUD_KEY_FILE && fs.existsSync(GOOGLE_CLOUD_KEY_FILE)) {
    // Method 2: Use key file path
    speechClient = new SpeechClient({
      projectId: GOOGLE_CLOUD_PROJECT_ID,
      keyFilename: GOOGLE_CLOUD_KEY_FILE
    });
    console.log('✅ Google Speech-to-Text client initialized with key file');
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Method 3: Use application default credentials
    speechClient = new SpeechClient({
      projectId: GOOGLE_CLOUD_PROJECT_ID
    });
    console.log('✅ Google Speech-to-Text client initialized with application credentials');
  } else {
    console.warn('⚠️ Google Speech-to-Text not configured. Audio transcription will not be available.');
    console.warn('   Set GOOGLE_CREDENTIALS_BASE64, GOOGLE_CLOUD_KEY_FILE, or GOOGLE_APPLICATION_CREDENTIALS');
  }
} catch (error) {
  console.error('❌ Failed to initialize Google Speech-to-Text client:', error);
}

/**
 * Audio transcription options
 */
export interface AudioTranscriptionOptions {
  languageCode?: string; // e.g., 'vi-VN', 'en-US'
  enableAutomaticPunctuation?: boolean;
  enableWordTimeOffsets?: boolean;
  maxAlternatives?: number;
  profanityFilter?: boolean;
  useEnhancedModel?: boolean;
  audioChannelCount?: number;
}

/**
 * Audio transcription result
 */
export interface AudioTranscriptionResult {
  transcript: string;
  confidence: number;
  languageCode: string;
  wordCount: number;
  duration: number; // in seconds
  alternatives?: string[];
  wordTimestamps?: Array<{
    word: string;
    startTime: number;
    endTime: number;
  }>;
}

// Default transcription options
const DEFAULT_TRANSCRIPTION_OPTIONS: AudioTranscriptionOptions = {
  languageCode: 'vi-VN', // Default to Vietnamese
  enableAutomaticPunctuation: true,
  enableWordTimeOffsets: false,
  maxAlternatives: 1,
  profanityFilter: false,
  useEnhancedModel: true,
  audioChannelCount: 1
};

// Ensure audio processing directory exists
const AUDIO_PROCESSING_DIR = path.join(process.cwd(), 'audio-processing');
if (!fs.existsSync(AUDIO_PROCESSING_DIR)) {
  fs.mkdirSync(AUDIO_PROCESSING_DIR, { recursive: true });
}

/**
 * Extract audio from video file using ffmpeg
 */
export async function extractAudioFromVideo(
  videoFilePath: string,
  outputFormat: 'wav' | 'flac' = 'wav'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const videoFileName = path.basename(videoFilePath, path.extname(videoFilePath));
    const audioFileName = `${videoFileName}_audio.${outputFormat}`;
    const audioFilePath = path.join(AUDIO_PROCESSING_DIR, audioFileName);

    console.log(`🎵 Extracting audio from video: ${videoFilePath}`);
    console.log(`📁 Output audio file: ${audioFilePath}`);

    // ffmpeg command to extract audio
    const ffmpegArgs = [
      '-i', videoFilePath,
      '-vn', // No video
      '-acodec', outputFormat === 'wav' ? 'pcm_s16le' : 'flac',
      '-ar', '16000', // 16kHz sample rate (recommended for Speech-to-Text)
      '-ac', '1', // Mono channel
      '-y', // Overwrite output file
      audioFilePath
    ];

    console.log(`🚀 Running ffmpeg with args: ${ffmpegArgs.join(' ')}`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    let errorOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        console.log(`✅ Audio extraction completed: ${audioFilePath}`);
        // Check if file actually exists and has content
        try {
          const stats = require('fs').statSync(audioFilePath);
          console.log(`📊 Audio file size: ${stats.size} bytes`);
          if (stats.size === 0) {
            reject(new Error('Audio extraction produced empty file'));
            return;
          }
        } catch (err: any) {
          reject(new Error(`Audio file not found after extraction: ${err.message}`));
          return;
        }
        resolve(audioFilePath);
      } else {
        console.error(`❌ ffmpeg failed with code ${code}`);
        console.error('📋 ffmpeg command:', ['ffmpeg', ...ffmpegArgs].join(' '));
        console.error('📊 Error output:', errorOutput);
        reject(new Error(`Audio extraction failed (code ${code}): ${errorOutput}`));
      }
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ ffmpeg spawn error:', error);
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });
  });
}

/**
 * Split audio file into chunks for processing
 */
export async function splitAudioIntoChunks(
  audioFilePath: string,
  chunkDurationSeconds: number = 60
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const audioFileName = path.basename(audioFilePath, path.extname(audioFilePath));
    const outputPattern = path.join(AUDIO_PROCESSING_DIR, `${audioFileName}_chunk_%03d.wav`);

    console.log(`✂️ Splitting audio into ${chunkDurationSeconds}s chunks`);

    const ffmpegArgs = [
      '-i', audioFilePath,
      '-f', 'segment',
      '-segment_time', chunkDurationSeconds.toString(),
      '-c', 'copy',
      '-reset_timestamps', '1',
      outputPattern
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    let errorOutput = '';

    ffmpeg.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        // Find all generated chunk files
        const chunkFiles = fs.readdirSync(AUDIO_PROCESSING_DIR)
          .filter(file => file.includes(`${audioFileName}_chunk_`))
          .map(file => path.join(AUDIO_PROCESSING_DIR, file))
          .sort();

        console.log(`✅ Audio split into ${chunkFiles.length} chunks`);
        resolve(chunkFiles);
      } else {
        console.error(`❌ Audio splitting failed with code ${code}`);
        console.error('Error output:', errorOutput);
        reject(new Error(`Audio splitting failed: ${errorOutput}`));
      }
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ ffmpeg spawn error:', error);
      reject(new Error(`Failed to start ffmpeg: ${error.message}`));
    });
  });
}

/**
 * Transcribe audio file using Google Speech-to-Text
 */
export async function transcribeAudioFile(
  audioFilePath: string,
  options: Partial<AudioTranscriptionOptions> = {}
): Promise<AudioTranscriptionResult> {
  if (!speechClient) {
    throw new Error('Google Speech-to-Text client is not initialized. Please check your configuration.');
  }

  const fullOptions: AudioTranscriptionOptions = {
    ...DEFAULT_TRANSCRIPTION_OPTIONS,
    ...options
  };

  console.log(`🎤 Transcribing audio file: ${audioFilePath}`);
  console.log(`🌐 Language: ${fullOptions.languageCode}`);

  try {
    // Read audio file
    const audioBytes = fs.readFileSync(audioFilePath);
    
    // Get audio duration for result metadata
    const stats = fs.statSync(audioFilePath);
    const fileSizeKB = stats.size / 1024;
    console.log(`📊 Audio file size: ${fileSizeKB.toFixed(2)} KB`);

    // Configure the request
    const request = {
      audio: {
        content: audioBytes.toString('base64'),
      },
      config: {
        encoding: 'LINEAR16' as const,
        sampleRateHertz: 16000,
        languageCode: fullOptions.languageCode!,
        enableAutomaticPunctuation: fullOptions.enableAutomaticPunctuation,
        enableWordTimeOffsets: fullOptions.enableWordTimeOffsets,
        maxAlternatives: fullOptions.maxAlternatives,
        profanityFilter: fullOptions.profanityFilter,
        useEnhanced: fullOptions.useEnhancedModel,
        audioChannelCount: fullOptions.audioChannelCount,
      },
    };

    // Check audio size for sync recognition limits
    const audioSizeKB = audioBytes.length / 1024;
    const audioSizeMB = audioSizeKB / 1024;

    console.log(`📊 Audio size: ${audioSizeKB.toFixed(2)} KB (${audioSizeMB.toFixed(2)} MB)`);

    let response;
    if (audioSizeMB > 10) {
      console.log('📦 Audio larger than 10MB, will be chunked at video level');
      throw new Error('Audio too large for synchronous recognition. Chunking will be used.');
    } else {
      console.log('⚡ Audio size OK for synchronous recognition');
      // Perform the transcription
      const [syncResponse] = await speechClient.recognize(request);
      response = syncResponse;
    }
    
    if (!response.results || response.results.length === 0) {
      throw new Error('No transcription results returned from Google Speech-to-Text');
    }

    // Process results
    let fullTranscript = '';
    let totalConfidence = 0;
    let resultCount = 0;
    const alternatives: string[] = [];
    const wordTimestamps: Array<{ word: string; startTime: number; endTime: number }> = [];

    for (const result of response.results) {
      if (result.alternatives && result.alternatives.length > 0) {
        const alternative = result.alternatives[0];
        if (alternative.transcript) {
          fullTranscript += alternative.transcript + ' ';
          totalConfidence += alternative.confidence || 0;
          resultCount++;

          // Collect alternative transcriptions
          if (result.alternatives.length > 1) {
            for (let i = 1; i < result.alternatives.length; i++) {
              if (result.alternatives[i].transcript) {
                alternatives.push(result.alternatives[i].transcript!);
              }
            }
          }

          // Collect word timestamps if enabled
          if (alternative.words && fullOptions.enableWordTimeOffsets) {
            for (const wordInfo of alternative.words) {
              if (wordInfo.word && wordInfo.startTime && wordInfo.endTime) {
                wordTimestamps.push({
                  word: wordInfo.word,
                  startTime: parseFloat(String(wordInfo.startTime.seconds || '0')) +
                           (parseFloat(String(wordInfo.startTime.nanos || '0')) / 1000000000),
                  endTime: parseFloat(String(wordInfo.endTime.seconds || '0')) +
                          (parseFloat(String(wordInfo.endTime.nanos || '0')) / 1000000000)
                });
              }
            }
          }
        }
      }
    }

    const averageConfidence = resultCount > 0 ? totalConfidence / resultCount : 0;
    const wordCount = fullTranscript.trim().split(/\s+/).length;
    
    // Estimate duration (rough calculation based on file size)
    const estimatedDuration = Math.max(1, Math.round(fileSizeKB / 32)); // Rough estimate

    console.log(`✅ Transcription completed: ${wordCount} words, confidence: ${(averageConfidence * 100).toFixed(1)}%`);

    return {
      transcript: fullTranscript.trim(),
      confidence: averageConfidence,
      languageCode: fullOptions.languageCode!,
      wordCount,
      duration: estimatedDuration,
      alternatives: alternatives.length > 0 ? alternatives : undefined,
      wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : undefined
    };

  } catch (error: any) {
    console.error('❌ Audio transcription failed:', error);
    console.error('🔍 Error type:', typeof error);
    console.error('📊 Error code:', error.code);
    console.error('📋 Error details:', error.details);
    console.error('🌐 Error metadata:', error.metadata);
    throw new Error(`Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Transcribe video file by extracting audio and using Speech-to-Text
 */
export async function transcribeVideoFile(
  videoFilePath: string,
  options: Partial<AudioTranscriptionOptions> = {}
): Promise<AudioTranscriptionResult> {
  console.log(`🎬 Starting video transcription: ${videoFilePath}`);
  console.log(`🔧 Transcription options:`, options);

  try {
    // Step 1: Extract audio from video
    console.log(`🎵 Extracting audio from video: ${videoFilePath}`);
    const audioFilePath = await extractAudioFromVideo(videoFilePath);
    console.log(`✅ Audio extracted successfully: ${audioFilePath}`);

    // Step 2: Check if audio file is too large (Google Speech-to-Text has limits)
    const stats = fs.statSync(audioFilePath);
    const fileSizeMB = stats.size / (1024 * 1024);
    const estimatedDurationSeconds = fileSizeMB * 8; // Rough estimate: 1MB ≈ 8 seconds

    console.log(`📊 Audio file: ${fileSizeMB.toFixed(2)}MB, estimated duration: ${estimatedDurationSeconds.toFixed(1)}s`);

    if (fileSizeMB > 10 || estimatedDurationSeconds > 60) { // 10MB or 60s limit for synchronous recognition
      console.log(`📊 Audio file is ${fileSizeMB.toFixed(2)}MB (${estimatedDurationSeconds.toFixed(1)}s), splitting into chunks...`);
      
      // Split into chunks and transcribe each
      const chunkFiles = await splitAudioIntoChunks(audioFilePath, 45); // 45-second chunks (safer)
      
      let combinedTranscript = '';
      let totalConfidence = 0;
      let totalWordCount = 0;
      let totalDuration = 0;

      for (let i = 0; i < chunkFiles.length; i++) {
        console.log(`🎤 Transcribing chunk ${i + 1}/${chunkFiles.length}`);
        try {
          const chunkResult = await transcribeAudioFile(chunkFiles[i], options);

          combinedTranscript += chunkResult.transcript + ' ';
          totalConfidence += chunkResult.confidence;
          totalWordCount += chunkResult.wordCount;
          totalDuration += chunkResult.duration;

          console.log(`✅ Chunk ${i + 1} completed: ${chunkResult.wordCount} words, confidence: ${(chunkResult.confidence * 100).toFixed(1)}%`);
        } catch (chunkError: any) {
          console.error(`❌ Chunk ${i + 1} failed:`, chunkError.message);
          // Continue with other chunks instead of failing completely
          combinedTranscript += '[TRANSCRIPTION_FAILED] ';
        }

        // Clean up chunk file
        try {
          fs.unlinkSync(chunkFiles[i]);
        } catch (cleanupError) {
          console.warn(`⚠️ Failed to cleanup chunk file: ${chunkFiles[i]}`);
        }
      }

      // Clean up main audio file
      fs.unlinkSync(audioFilePath);

      return {
        transcript: combinedTranscript.trim(),
        confidence: totalConfidence / chunkFiles.length,
        languageCode: options.languageCode || DEFAULT_TRANSCRIPTION_OPTIONS.languageCode!,
        wordCount: totalWordCount,
        duration: totalDuration
      };
    } else {
      // File is small enough for direct transcription
      const result = await transcribeAudioFile(audioFilePath, options);
      
      // Clean up audio file
      fs.unlinkSync(audioFilePath);
      
      return result;
    }

  } catch (error: any) {
    console.error('❌ Video transcription failed:', error);
    console.error('🔍 Error type:', typeof error);
    console.error('📊 Error details:', error instanceof Error ? error.stack : error);
    throw new Error(`Video transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if audio transcription is available
 */
export function isAudioTranscriptionAvailable(): boolean {
  return speechClient !== null;
}

/**
 * Clean up audio processing directory
 */
export function cleanupAudioProcessing(): void {
  try {
    const files = fs.readdirSync(AUDIO_PROCESSING_DIR);
    for (const file of files) {
      fs.unlinkSync(path.join(AUDIO_PROCESSING_DIR, file));
    }
    console.log('🧹 Audio processing directory cleaned up');
  } catch (error) {
    console.error('❌ Failed to cleanup audio processing directory:', error);
  }
}
