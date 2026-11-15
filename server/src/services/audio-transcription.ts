import { SpeechClient } from '@google-cloud/speech';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  AUTO_LANGUAGE,
  AUTO_PRIMARY_LANGUAGE,
  AUTO_ALTERNATIVE_LANGUAGES,
  MAX_ALTERNATIVE_LANGUAGES,
  normalizeLanguageCode,
  isValidLanguageCode,
  isSameLanguage,
  isChineseLanguage,
  toBaseLanguage,
  cjkRatio,
  countWords,
  detectLanguageCodeFromText,
  analyzeScripts,
  joinTextFragments,
  stripUndefined
} from './language-utils';
import { getTcmPhraseHints, scriptForLanguageCode } from './tcm-glossary';
import {
  resolveGoogleSpeechAuth,
  speechClientOptions,
  isChirpAvailable,
  chirpUnavailableReason,
  getChirpConfig,
  recognizeChirp,
  toChirpLanguageCode,
  ChirpAdaptationMode,
  ChirpRecognizeResult
} from './stt-v2';
import { isAlibabaAsrAvailable, alibabaUnavailableReason, alibabaModelUsesGlossary, transcribeWithAlibaba } from './stt-alibaba';

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

// Initialize Speech client (V1). Credential resolution is shared with the V2 (Chirp) client.
let speechClient: SpeechClient | null = null;

try {
  const auth = resolveGoogleSpeechAuth();
  if (auth) {
    speechClient = new SpeechClient(speechClientOptions(auth));
    const label = auth.source === 'base64' ? 'base64 credentials' : auth.source === 'keyFile' ? 'key file' : 'application credentials';
    console.log(`✅ Google Speech-to-Text client initialized with ${label}`);
  } else {
    console.warn('⚠️ Google Speech-to-Text not configured. Audio transcription will not be available.');
    console.warn('   Set GOOGLE_CREDENTIALS_BASE64, GOOGLE_CLOUD_KEY_FILE, or GOOGLE_APPLICATION_CREDENTIALS');
  }
} catch (error) {
  console.error('❌ Failed to initialize Google Speech-to-Text client:', error);
}

export type TranscriptionEngine = 'alibaba' | 'chirp' | 'v1';
export type TranscriptionEngineOption = 'auto' | TranscriptionEngine;

/**
 * Audio transcription options
 */
export interface AudioTranscriptionOptions {
  /**
   * BCP-47 code (e.g. 'vi-VN', 'cmn-Hans-CN', 'en-US', 'yue-Hant-HK') or the literal 'auto'.
   * 'auto' = primary 'vi-VN' with alternatives ['cmn-Hans-CN', 'en-US'] and Google picks the language.
   */
  languageCode?: string;
  /** Extra candidate languages Google may detect instead of languageCode (max 3). */
  alternativeLanguageCodes?: string[];
  enableAutomaticPunctuation?: boolean;
  enableWordTimeOffsets?: boolean;
  maxAlternatives?: number;
  profanityFilter?: boolean;
  useEnhancedModel?: boolean;
  audioChannelCount?: number;
  /**
   * 'auto' (default): Chinese (cmn/yue/zh) -> engines in STT_CHINESE_ENGINE_ORDER (default
   * 'alibaba,chirp,v1'), each only when available, falling back to the next on failure;
   * everything else stays on V1. 'alibaba' / 'chirp' force that engine (V1 on failure),
   * 'v1' forces V1.
   */
  engine?: TranscriptionEngineOption;
  /** Caller phrase hints (e.g. blackboard OCR terms). Highest priority / boost (Alibaba: per-request hotwords). */
  phraseHints?: string[];
  /** Background text for engines that accept context (Alibaba): video title, description, board text. */
  contextText?: string;
  /** Alibaba model override (default ALIBABA_ASR_MODEL). */
  alibabaModel?: string;
  /** 'tcm' (default): add Traditional Chinese Medicine glossary hints when transcribing Chinese. */
  domainHints?: 'tcm' | 'none';
}

export interface TranscriptSegment {
  /** Seconds from the start of the audio. */
  startTime: number;
  endTime: number;
  text: string;
}

/**
 * Audio transcription result
 */
export interface AudioTranscriptionResult {
  transcript: string;
  /** Average recognizer confidence. Chirp 3 gives no calibrated confidence; a nominal value is used then. */
  confidence: number;
  /** True when `confidence` is the nominal Chirp value, not a recognizer score (do not show it as quality). */
  confidenceIsNominal?: boolean;
  /** Language detected by Google (normalised case, e.g. 'cmn-Hans-CN'); falls back to the configured code. */
  languageCode: string;
  wordCount: number;
  duration: number; // in seconds
  alternatives?: string[];
  wordTimestamps?: Array<{
    word: string;
    startTime: number;
    endTime: number;
  }>;
  /** Engine that produced the transcript. */
  engine: TranscriptionEngine;
  /** e.g. 'qwen3-asr-flash' (Alibaba), 'chirp_3' or 'default' (V1). */
  model?: string;
  /** Per-result timing (best effort; result boundaries inside each chunk). */
  segments?: TranscriptSegment[];
}

// Default transcription options
const DEFAULT_TRANSCRIPTION_OPTIONS: AudioTranscriptionOptions = {
  languageCode: AUTO_LANGUAGE, // Auto-detect (Vietnamese / Chinese / English)
  enableAutomaticPunctuation: true,
  enableWordTimeOffsets: false,
  maxAlternatives: 1,
  profanityFilter: false,
  useEnhancedModel: true,
  audioChannelCount: 1,
  engine: 'auto',
  domainHints: 'tcm'
};

/**
 * Auto mode heuristic: when Google keeps the primary language (vi-VN) but the
 * confidence is this low, the audio is probably in another language and Google's
 * language recognition did not kick in (not every model supports it). We then
 * re-run the same (first) audio piece with each alternative as the primary language
 * and keep the alternative if it is clearly more confident.
 */
const AUTO_PROBE_CONFIDENCE_THRESHOLD = 0.6;
const AUTO_PROBE_MIN_CONFIDENCE_GAIN = 0.15;
/**
 * STT confidences are not calibrated across language models, so when Google's own
 * language recognition was active (alternatives accepted) a probe must also be
 * clearly confident on its own before it can override Google's choice.
 */
const AUTO_PROBE_MIN_ABSOLUTE_CONFIDENCE = 0.8;

/**
 * Auto mode, chunked audio: only lock the language after a chunk with real speech,
 * so a short intro (MC greeting, jingle, a few lyrics) cannot set the language for
 * the whole video. Until then every chunk is detected on its own.
 */
const AUTO_LOCK_MIN_WORDS = 20;
const AUTO_LOCK_MIN_CONFIDENCE = 0.5;
/**
 * Engine 'auto' + language 'auto': the V1 detection pass stops early and hands the whole file
 * to (Chinese-only) Chirp only after this many CONSECUTIVE real-speech chunks that are each
 * almost entirely Chinese (AUTO_CHIRP_CHUNK_SHARE). Any real-speech chunk with a noticeable
 * non-Chinese share (Vietnamese interpreter, Vietnamese lecturer quoting Chinese) disables the
 * early stop for the file; the full V1 pass then decides with AUTO_CHIRP_FILE_SHARE.
 */
const AUTO_CHIRP_LOCK_CHUNKS = 3;
const AUTO_CHIRP_CHUNK_SHARE = 0.9;
/** Minimum Chinese share of the whole V1 pass before it is replaced by a Chinese-only Chirp pass. */
const AUTO_CHIRP_FILE_SHARE = 0.8;

/** chirp_3 returns no calibrated confidence ("isn't truly a confidence score"); nominal value used then. */
const CHIRP_NOMINAL_CONFIDENCE = 0.85;

/** Merge caller options over defaults without letting `undefined` values clobber defaults. */
function mergeTranscriptionOptions(options: Partial<AudioTranscriptionOptions> = {}): AudioTranscriptionOptions {
  const merged: AudioTranscriptionOptions = {
    ...DEFAULT_TRANSCRIPTION_OPTIONS,
    ...stripUndefined(options)
  };
  if (merged.engine !== 'auto' && merged.engine !== 'alibaba' && merged.engine !== 'chirp' && merged.engine !== 'v1') merged.engine = 'auto';
  if (typeof merged.contextText !== 'string' || !merged.contextText.trim()) merged.contextText = undefined;
  if (typeof merged.alibabaModel !== 'string' || !merged.alibabaModel.trim()) merged.alibabaModel = undefined;
  if (merged.domainHints !== 'tcm' && merged.domainHints !== 'none') merged.domainHints = 'tcm';
  if (!Array.isArray(merged.phraseHints)) merged.phraseHints = undefined;
  return merged;
}

interface ResolvedLanguageConfig {
  primary: string;
  alternatives: string[];
  auto: boolean;
}

function uniqueLanguageCodes(codes: string[], exclude: string): string[] {
  const seen = new Set<string>([exclude.toLowerCase()]);
  const out: string[] = [];
  for (const code of codes) {
    const normalized = normalizeLanguageCode(code);
    if (!normalized || !isValidLanguageCode(normalized)) continue;
    if (seen.has(normalized.toLowerCase())) continue;
    seen.add(normalized.toLowerCase());
    out.push(normalized);
  }
  return out.slice(0, MAX_ALTERNATIVE_LANGUAGES);
}

/** Turn languageCode ('auto' or BCP-47) + alternativeLanguageCodes into what Google receives. */
export function resolveLanguageConfig(options: Partial<AudioTranscriptionOptions>): ResolvedLanguageConfig {
  const requested = (options.languageCode || AUTO_LANGUAGE).trim();

  if (requested.toLowerCase() === AUTO_LANGUAGE) {
    return {
      primary: AUTO_PRIMARY_LANGUAGE,
      alternatives: uniqueLanguageCodes(options.alternativeLanguageCodes ?? AUTO_ALTERNATIVE_LANGUAGES, AUTO_PRIMARY_LANGUAGE),
      auto: true
    };
  }

  if (!isValidLanguageCode(requested)) {
    console.warn(`⚠️ Invalid languageCode "${requested}", falling back to auto detection`);
    return resolveLanguageConfig({ ...options, languageCode: AUTO_LANGUAGE });
  }

  const primary = normalizeLanguageCode(requested)!;
  return {
    primary,
    alternatives: uniqueLanguageCodes(options.alternativeLanguageCodes ?? [], primary),
    auto: false
  };
}

/**
 * Sanity-check Google's language code against the script of the transcript:
 * a mostly-CJK transcript is Chinese/Japanese/Korean whatever the code says, and a
 * "Chinese" transcript without CJK characters is not Chinese.
 */
function reconcileDetectedLanguage(code: string, transcript: string, candidates: string[]): string {
  if (!transcript || countWords(transcript) < 5) return code;
  const ratio = cjkRatio(transcript);
  const codeBase = toBaseLanguage(code);
  const codeIsCjk = codeBase === 'zh' || codeBase === 'yue' || codeBase === 'ja' || codeBase === 'ko';
  const textBase = detectLanguageCodeFromText(transcript);

  if (ratio >= 0.5 && !codeIsCjk) {
    const fallback = textBase === 'ja' ? 'ja-JP' : textBase === 'ko' ? 'ko-KR' : 'cmn-Hans-CN';
    const match = textBase === 'zh'
      ? candidates.find(candidate => isChineseLanguage(candidate))
      : candidates.find(candidate => isSameLanguage(candidate, textBase));
    const corrected = match || fallback;
    console.log(`🔤 Transcript is ${(ratio * 100).toFixed(0)}% CJK but language code is ${code}; treating it as ${corrected}`);
    return corrected;
  }

  if (codeIsCjk && ratio < 0.1) {
    const match = candidates.find(candidate => isSameLanguage(candidate, textBase));
    const corrected = match || (textBase === 'vi' ? 'vi-VN' : 'en-US');
    console.log(`🔤 Language code is ${code} but transcript has almost no CJK characters; treating it as ${corrected}`);
    return corrected;
  }

  return code;
}

/** Pick the language with the largest weight; undefined when there is none. */
function dominantLanguage(weights: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestWeight = 0;
  for (const [code, weight] of Object.entries(weights)) {
    if (weight > bestWeight) {
      best = code;
      bestWeight = weight;
    }
  }
  return best;
}

/** Share (0..1) of the language weights that are Chinese; fallback when there are no weights. */
function chineseShare(weights: Record<string, number> | undefined, fallbackCode?: string): number {
  let total = 0;
  let chinese = 0;
  for (const [code, weight] of Object.entries(weights || {})) {
    total += weight;
    if (isChineseLanguage(code)) chinese += weight;
  }
  if (total <= 0) return fallbackCode && isChineseLanguage(fallbackCode) ? 1 : 0;
  return chinese / total;
}

function addWeights(target: Record<string, number>, source: Record<string, number>): void {
  for (const [code, weight] of Object.entries(source)) {
    target[code] = (target[code] || 0) + weight;
  }
}

function isInvalidArgumentError(error: any): boolean {
  // gRPC status 3 = INVALID_ARGUMENT
  return error?.code === 3 || /INVALID_ARGUMENT/i.test(String(error?.message || error?.details || ''));
}

// ---------------------------------------------------------------------------
// Phrase hints (V1 speechContexts / V2 inline phrase sets)
// ---------------------------------------------------------------------------

export interface PhraseHintLimits {
  /** Max caller (board) hints kept. */
  maxCallerHints: number;
  /** Max glossary hints added. */
  maxGlossaryHints: number;
  /** Max phrases in total (board + glossary). */
  maxTotalPhrases: number;
  /** Max characters in total (board + glossary). */
  maxTotalChars: number;
  /** Max characters per phrase (Google: 100). */
  maxPhraseChars: number;
}

/**
 * V1 limits are 5,000 phrases / 100,000 characters per request and 100 characters per phrase;
 * we stay well below to avoid biasing recognition towards the glossary.
 */
export const V1_HINT_LIMITS: PhraseHintLimits = {
  maxCallerHints: 300,
  maxGlossaryHints: 500,
  maxTotalPhrases: 800,
  maxTotalChars: 20000,
  maxPhraseChars: 100
};

/**
 * chirp_3 accepts a dictionary of up to 1,000 phrases and the docs recommend "as few entries as
 * possible to prevent degradation on non-adaptation terms", so the glossary share is smaller.
 */
export const CHIRP_HINT_LIMITS: PhraseHintLimits = {
  maxCallerHints: 200,
  maxGlossaryHints: 300,
  maxTotalPhrases: 500,
  maxTotalChars: 20000,
  maxPhraseChars: 100
};

/** Boosts: board / caller hints are stronger evidence than the generic glossary. Kept moderate. */
export const CALLER_HINT_BOOST = 8;
export const GLOSSARY_HINT_BOOST = 4;

export interface PhraseHintSet {
  /** Caller hints (board OCR etc.), highest priority. */
  caller: string[];
  /** TCM glossary hints in the script of the language. */
  glossary: string[];
}

const EDGE_PUNCTUATION_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

function normalizeHint(raw: unknown, maxChars: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/\s+/g, ' ').replace(EDGE_PUNCTUATION_RE, '').trim();
  const length = Array.from(value).length;
  // Single characters are too generic (false insertions); overly long phrases are rejected by Google
  if (length < 2 || value.length > maxChars) return undefined;
  if (!/[\p{L}\p{N}]/u.test(value)) return undefined;
  return value;
}

function isCjkLanguage(code?: string): boolean {
  const base = toBaseLanguage(code);
  return base === 'zh' || base === 'yue' || base === 'ja' || base === 'ko';
}

/**
 * Build the phrase hints for one recognition language.
 * - Caller hints first (deduplicated, normalised, <= maxPhraseChars). For a non-CJK language
 *   mostly-CJK caller hints are dropped (blackboard terms would only bias e.g. Vietnamese audio).
 * - TCM glossary hints only when domainHints != 'none' AND the language is Chinese, in the
 *   script of the language (simplified for cmn-Hans-*, traditional for cmn-Hant-* / yue-*).
 * - Totals respect the limits (phrases and characters). languageCode 'auto'/undefined: caller
 *   hints are kept, no glossary.
 */
export function buildPhraseHints(params: {
  callerHints?: string[];
  domainHints?: 'tcm' | 'none';
  languageCode?: string;
  limits: PhraseHintLimits;
}): PhraseHintSet {
  const { limits } = params;
  const code = params.languageCode && params.languageCode.toLowerCase() !== AUTO_LANGUAGE ? params.languageCode : undefined;
  const seen = new Set<string>();
  let totalChars = 0;
  const caller: string[] = [];
  const glossary: string[] = [];

  const canAdd = (value: string) =>
    caller.length + glossary.length < limits.maxTotalPhrases && totalChars + value.length <= limits.maxTotalChars;

  for (const raw of params.callerHints ?? []) {
    if (caller.length >= limits.maxCallerHints) break;
    const value = normalizeHint(raw, limits.maxPhraseChars);
    if (!value) continue;
    if (code && !isCjkLanguage(code) && cjkRatio(value) >= 0.5) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    if (!canAdd(value)) break;
    seen.add(key);
    caller.push(value);
    totalChars += value.length;
  }

  if (params.domainHints !== 'none' && code && isChineseLanguage(code)) {
    const script = scriptForLanguageCode(code);
    for (const raw of getTcmPhraseHints(script)) {
      if (glossary.length >= limits.maxGlossaryHints) break;
      const value = normalizeHint(raw, limits.maxPhraseChars);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      if (!canAdd(value)) break;
      seen.add(key);
      glossary.push(value);
      totalChars += value.length;
    }
  }

  return { caller, glossary };
}

function v1SpeechContexts(hints: PhraseHintSet): Array<{ phrases: string[]; boost: number }> {
  const contexts: Array<{ phrases: string[]; boost: number }> = [];
  if (hints.caller.length) contexts.push({ phrases: hints.caller, boost: CALLER_HINT_BOOST });
  if (hints.glossary.length) contexts.push({ phrases: hints.glossary, boost: GLOSSARY_HINT_BOOST });
  return contexts;
}

// ---------------------------------------------------------------------------
// Audio extraction and silence-aware chunking
// ---------------------------------------------------------------------------

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
    // Unique per call: concurrent jobs on files with the same basename must not overwrite each other
    const audioFileName = `${videoFileName}_audio_${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${outputFormat}`;
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
          const stats = fs.statSync(audioFilePath);
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

function runProcess(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data.toString(); });
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => reject(new Error(`Failed to start ${command}: ${error.message}`)));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/** Duration in seconds (ffprobe; falls back to the size of a 16 kHz mono 16-bit WAV). */
export async function probeAudioDuration(audioFilePath: string): Promise<number> {
  try {
    const { code, stdout } = await runProcess('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioFilePath
    ]);
    const value = parseFloat(stdout.trim());
    if (code === 0 && Number.isFinite(value) && value > 0) return value;
  } catch {
    // fall through
  }
  const size = fs.statSync(audioFilePath).size;
  return Math.max(0, size - 44) / 32000;
}

export interface SilenceInterval {
  start: number;
  end: number;
}

/**
 * Parse ffmpeg `silencedetect` stderr (`silence_start: X` / `silence_end: Y | silence_duration: Z`).
 * An unterminated silence at the end of the file ends at totalDuration (when given).
 */
export function parseSilenceDetectOutput(stderr: string, totalDuration?: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let openStart: number | undefined;
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stderr)) !== null) {
    const value = Math.max(0, parseFloat(match[2]));
    if (!Number.isFinite(value)) continue;
    if (match[1] === 'start') {
      openStart = value;
    } else if (openStart !== undefined) {
      if (value > openStart) intervals.push({ start: openStart, end: value });
      openStart = undefined;
    }
  }
  if (openStart !== undefined && totalDuration !== undefined && totalDuration > openStart) {
    intervals.push({ start: openStart, end: totalDuration });
  }
  return intervals.sort((a, b) => a.start - b.start);
}

export interface ChunkPlanOptions {
  /** Hard maximum chunk length (sync Recognize accepts < 60 s). Default 55. */
  maxChunkSeconds?: number;
  /** Do not cut before this many seconds into a chunk when a later pause exists. Default 15. */
  minChunkSeconds?: number;
  /** Minimum overlap (s) of a pause with the cut window to count as a pause. Default 0.15. */
  minPauseSeconds?: number;
}

export interface PlannedChunk {
  start: number;
  end: number;
  /** True when the chunk ends inside a detected pause (false = hard cut or end of audio). */
  cutInPause: boolean;
  /** True when the whole chunk lies inside one detected pause (no recognition needed). */
  silent: boolean;
}

export const MAX_CHUNK_SECONDS = 55;
export const FALLBACK_CHUNK_SECONDS = 50;

function markSilent(chunks: PlannedChunk[], silences: SilenceInterval[]): PlannedChunk[] {
  return chunks.map(chunk => ({
    ...chunk,
    silent: silences.some(s => s.start <= chunk.start + 0.05 && s.end >= chunk.end - 0.05)
  }));
}

/**
 * Plan chunk boundaries inside pauses. Each chunk is <= maxChunkSeconds; within the window
 * (start + min, start + max] the pause with the best score (longer pause, later position) is
 * chosen and the cut goes in the middle of its overlap with the window. A hard cut at
 * start + max happens only when the window contains no pause.
 */
export function planChunks(duration: number, silences: SilenceInterval[], options: ChunkPlanOptions = {}): PlannedChunk[] {
  const max = options.maxChunkSeconds ?? MAX_CHUNK_SECONDS;
  const min = Math.min(options.minChunkSeconds ?? 15, max * 0.8);
  const minPause = options.minPauseSeconds ?? 0.15;
  const chunks: PlannedChunk[] = [];
  if (!(duration > 0)) return chunks;

  let pos = 0;
  while (duration - pos > max) {
    const windowStart = pos + min;
    const windowEnd = pos + max;
    let bestCut: number | undefined;
    let bestScore = -Infinity;
    for (const silence of silences) {
      if (silence.end <= windowStart) continue;
      if (silence.start >= windowEnd) break;
      const a = Math.max(silence.start, windowStart);
      const b = Math.min(silence.end, windowEnd);
      const length = b - a;
      if (length < minPause) continue;
      const cut = (a + b) / 2;
      const score = Math.min(length, 1.5) + (cut - pos) / max;
      if (score > bestScore) {
        bestScore = score;
        bestCut = cut;
      }
    }
    const cut = bestCut ?? windowEnd;
    chunks.push({ start: pos, end: cut, cutInPause: bestCut !== undefined, silent: false });
    pos = cut;
  }
  if (duration - pos > 0.05 || chunks.length === 0) {
    chunks.push({ start: pos, end: duration, cutInPause: false, silent: false });
  } else {
    chunks[chunks.length - 1].end = duration;
  }
  return markSilent(chunks, silences);
}

/** Fixed-length cuts (used when silencedetect is unavailable). */
export function planFixedChunks(duration: number, chunkSeconds: number = FALLBACK_CHUNK_SECONDS): PlannedChunk[] {
  const chunks: PlannedChunk[] = [];
  if (!(duration > 0)) return chunks;
  for (let start = 0; start < duration - 0.05 || chunks.length === 0; start += chunkSeconds) {
    chunks.push({ start, end: Math.min(duration, start + chunkSeconds), cutInPause: false, silent: false });
  }
  return chunks;
}

/** silencedetect settings tried in order until every cut lands in a pause (lecture rooms are noisy). */
const SILENCE_DETECT_PASSES: Array<{ noiseDb: number; minDuration: number }> = [
  { noiseDb: -35, minDuration: 0.35 },
  { noiseDb: -30, minDuration: 0.3 },
  { noiseDb: -25, minDuration: 0.25 }
];

export async function detectSilences(audioFilePath: string, noiseDb: number, minDuration: number, totalDuration?: number): Promise<SilenceInterval[]> {
  const { code, stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-i', audioFilePath,
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f', 'null', '-'
  ]);
  if (code !== 0) {
    throw new Error(`ffmpeg silencedetect failed (code ${code}): ${stderr.slice(-500)}`);
  }
  return parseSilenceDetectOutput(stderr, totalDuration);
}

/**
 * Plan pause-aligned chunks for an audio file: silencedetect passes from strict to lenient until
 * no hard cut is needed (the plan with the fewest hard cuts wins); fixed ~50 s cuts if ffmpeg fails.
 */
export async function planAudioChunks(
  audioFilePath: string,
  duration: number,
  planOptions: ChunkPlanOptions = {}
): Promise<{ chunks: PlannedChunk[]; method: string }> {
  const maxChunkSeconds = planOptions.maxChunkSeconds ?? MAX_CHUNK_SECONDS;
  if (duration <= maxChunkSeconds) {
    return { chunks: [{ start: 0, end: duration, cutInPause: false, silent: false }], method: 'single' };
  }
  let best: { chunks: PlannedChunk[]; method: string; hardCuts: number } | undefined;
  // Skipping a chunk as silent is decided only with the strictest pass, whichever pass chose
  // the cut points: a lenient threshold (-25 dB) would classify soft speech in a noisy room as silence.
  let strictSilences: SilenceInterval[] | undefined;
  try {
    for (const pass of SILENCE_DETECT_PASSES) {
      const silences = await detectSilences(audioFilePath, pass.noiseDb, pass.minDuration, duration);
      if (!strictSilences) strictSilences = silences;
      const chunks = planChunks(duration, silences, planOptions);
      const hardCuts = chunks.slice(0, -1).filter(chunk => !chunk.cutInPause).length;
      const method = `silencedetect ${pass.noiseDb}dB/${pass.minDuration}s (${silences.length} pauses, ${hardCuts} hard cuts)`;
      if (!best || hardCuts < best.hardCuts) best = { chunks, method, hardCuts };
      if (hardCuts === 0) break;
    }
  } catch (error: any) {
    const fixedSeconds = maxChunkSeconds <= MAX_CHUNK_SECONDS
      ? Math.min(FALLBACK_CHUNK_SECONDS, maxChunkSeconds)
      : Math.floor(maxChunkSeconds * 0.9);
    console.warn(`⚠️ Silence detection failed (${error.message}); using fixed ${fixedSeconds}s chunks`);
    return { chunks: planFixedChunks(duration, fixedSeconds), method: `fixed ${fixedSeconds}s` };
  }
  return { chunks: markSilent(best!.chunks, strictSilences || []), method: best!.method };
}

export interface AudioChunk extends PlannedChunk {
  index: number;
  path: string;
}

async function extractChunk(audioFilePath: string, chunk: PlannedChunk, outPath: string): Promise<void> {
  const { code, stderr } = await runProcess('ffmpeg', [
    '-hide_banner', '-nostats', '-y',
    '-ss', chunk.start.toFixed(3),
    '-t', (chunk.end - chunk.start).toFixed(3),
    '-i', audioFilePath,
    '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
    outPath
  ]);
  if (code !== 0) throw new Error(`ffmpeg chunk extraction failed (code ${code}): ${stderr.slice(-500)}`);
}

/**
 * Run fn over items with bounded concurrency. On the first rejection the other workers stop
 * picking up new items (no further billed requests / ffmpeg runs into a soon-deleted work dir);
 * `signal.aborted` lets long-running fn calls stop their own retry loops too.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number, signal: { aborted: boolean }) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const signal = { aborted: false };
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!signal.aborted && next < items.length) {
      const current = next++;
      try {
        results[current] = await fn(items[current], current, signal);
      } catch (error) {
        signal.aborted = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/** Write the planned chunks as 16 kHz mono WAV files into workDir (silent chunks are not written). */
async function writeAudioChunks(audioFilePath: string, planned: PlannedChunk[], workDir: string): Promise<AudioChunk[]> {
  if (planned.length === 1) {
    return [{ ...planned[0], index: 0, path: audioFilePath }];
  }
  const chunks: AudioChunk[] = planned.map((chunk, index) => ({
    ...chunk,
    index,
    path: path.join(workDir, `chunk_${String(index).padStart(4, '0')}.wav`)
  }));
  await mapWithConcurrency(chunks.filter(chunk => !chunk.silent), 4, chunk => extractChunk(audioFilePath, chunk, chunk.path));
  for (const chunk of chunks) {
    if (chunk.silent) continue;
    const size = fs.statSync(chunk.path).size;
    if (size > 10 * 1024 * 1024 || chunk.end - chunk.start > 59) {
      console.warn(`⚠️ Chunk ${chunk.index + 1} exceeds sync limits (${(size / 1048576).toFixed(2)} MB, ${(chunk.end - chunk.start).toFixed(1)} s)`);
    }
  }
  return chunks;
}

/**
 * Split audio file into pause-aligned chunks (<= 55 s each) for processing.
 * Returns the chunk file paths (written next to the audio file in the processing directory).
 */
export async function splitAudioIntoChunks(audioFilePath: string): Promise<string[]> {
  const duration = await probeAudioDuration(audioFilePath);
  const { chunks, method } = await planAudioChunks(audioFilePath, duration);
  const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const target = path.join(AUDIO_PROCESSING_DIR, `${baseName}_chunk_${String(i).padStart(3, '0')}.wav`);
    await extractChunk(audioFilePath, chunks[i], target);
    out.push(target);
  }
  console.log(`✅ Audio split into ${out.length} chunks (${method})`);
  return out;
}

function chunkSummary(chunks: PlannedChunk[]): string {
  const lengths = chunks.map(chunk => chunk.end - chunk.start);
  const longest = lengths.length ? Math.max(...lengths) : 0;
  const silent = chunks.filter(chunk => chunk.silent).length;
  const hard = chunks.slice(0, -1).filter(chunk => !chunk.cutInPause).length;
  return `${chunks.length} chunks, longest ${longest.toFixed(1)}s, ${hard} hard cut(s), ${silent} silent`;
}

/** Millisecond precision for reported times. */
function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}

function joinPieces(pieces: string[]): string {
  return pieces
    .reduce((acc, piece) => joinTextFragments(acc, piece.trim()), '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// V1 recognition
// ---------------------------------------------------------------------------

/**
 * Internal transcription result with the extra state transcribeVideoFile needs
 * to aggregate languages across chunks and to stop re-sending rejected settings.
 */
interface InternalTranscription {
  result: AudioTranscriptionResult;
  /** Normalised language code -> amount of transcript (countWords) Google attributed to it. */
  languageWeights: Record<string, number>;
  /** Google rejected useEnhanced (INVALID_ARGUMENT); don't send it again. */
  droppedEnhanced: boolean;
  /** Google rejected alternativeLanguageCodes (INVALID_ARGUMENT); don't send them again. */
  droppedAlternatives: boolean;
  /** Google rejected speechContexts (INVALID_ARGUMENT); don't send them again. */
  droppedHints: boolean;
}

/** Per-run V1 state that is not a public option. */
interface V1Context {
  /** Phrase hints were rejected once; stop sending them. */
  hintsDisabled: boolean;
}

function v1HintsFor(options: AudioTranscriptionOptions, languageCode: string, ctx: V1Context): PhraseHintSet {
  if (ctx.hintsDisabled) return { caller: [], glossary: [] };
  return buildPhraseHints({
    callerHints: options.phraseHints,
    domainHints: options.domainHints,
    languageCode,
    limits: V1_HINT_LIMITS
  });
}

function buildRecognitionConfig(
  options: AudioTranscriptionOptions,
  primary: string,
  alternatives: string[],
  useEnhanced: boolean,
  hints: PhraseHintSet | null
) {
  const speechContexts = hints ? v1SpeechContexts(hints) : [];
  return {
    encoding: 'LINEAR16' as const,
    sampleRateHertz: 16000,
    languageCode: primary,
    ...(alternatives.length > 0 ? { alternativeLanguageCodes: alternatives } : {}),
    ...(speechContexts.length > 0 ? { speechContexts } : {}),
    enableAutomaticPunctuation: options.enableAutomaticPunctuation,
    enableWordTimeOffsets: options.enableWordTimeOffsets,
    maxAlternatives: options.maxAlternatives,
    profanityFilter: options.profanityFilter,
    useEnhanced,
    audioChannelCount: options.audioChannelCount,
  };
}

/**
 * Call recognize(); if Google answers INVALID_ARGUMENT (typically because the model
 * does not support language recognition or the enhanced model is unavailable),
 * retry without useEnhanced, then without alternatives, then without phrase hints.
 */
async function recognizeWithFallback(
  audioContent: string,
  options: AudioTranscriptionOptions,
  lang: ResolvedLanguageConfig,
  hints: PhraseHintSet
) {
  const hasHints = hints.caller.length + hints.glossary.length > 0;
  type Attempt = { useEnhanced: boolean; alternatives: string[]; hints: PhraseHintSet | null; label: string };
  const attempts: Attempt[] = [
    { useEnhanced: !!options.useEnhancedModel, alternatives: lang.alternatives, hints: hasHints ? hints : null, label: 'as configured' }
  ];
  const last = () => attempts[attempts.length - 1];
  if (options.useEnhancedModel) {
    attempts.push({ ...last(), useEnhanced: false, label: 'without enhanced model' });
  }
  if (lang.alternatives.length > 0) {
    attempts.push({ ...last(), useEnhanced: false, alternatives: [], label: 'without enhanced model and without alternative languages' });
  }
  if (hasHints) {
    attempts.push({ ...last(), useEnhanced: false, alternatives: [], hints: null, label: 'without enhanced model, alternative languages and phrase hints' });
  }

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const [response] = await speechClient!.recognize({
        audio: { content: audioContent },
        config: buildRecognitionConfig(options, lang.primary, attempt.alternatives, attempt.useEnhanced, attempt.hints)
      });
      if (i > 0) {
        console.log(`✅ Speech-to-Text succeeded on retry (${attempt.label})`);
      }
      return {
        response,
        droppedEnhanced: !!options.useEnhancedModel && !attempt.useEnhanced,
        droppedAlternatives: lang.alternatives.length > 0 && attempt.alternatives.length === 0,
        droppedHints: hasHints && attempt.hints === null
      };
    } catch (error: any) {
      const isLast = i === attempts.length - 1;
      if (!isInvalidArgumentError(error) || isLast) {
        throw error;
      }
      console.warn(
        `⚠️ Speech-to-Text rejected request (${attempt.label}; primary=${lang.primary}, ` +
        `alternatives=[${attempt.alternatives.join(', ')}], useEnhanced=${attempt.useEnhanced}, ` +
        `hints=${attempt.hints ? attempt.hints.caller.length + attempt.hints.glossary.length : 0}): ${error.message}. ` +
        `Retrying ${attempts[i + 1].label}...`
      );
    }
  }
  // Unreachable: the loop either returns or throws
  throw new Error('Speech-to-Text recognition failed');
}

function durationSeconds(value: any): number | undefined {
  if (!value) return undefined;
  const seconds = parseFloat(String(value.seconds ?? '0'));
  const nanos = parseFloat(String(value.nanos ?? '0'));
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return undefined;
  return seconds + nanos / 1e9;
}

/** Marker on errors for an empty (silent) response, so chunk loops can skip without a failure marker. */
const EMPTY_RESULT_MESSAGE = 'No transcription results returned from Google Speech-to-Text';

/**
 * Transcribe one audio file (<= 10MB / ~60s) with fully merged options and a resolved language config.
 */
async function transcribeAudioFileInternal(
  audioFilePath: string,
  fullOptions: AudioTranscriptionOptions,
  lang: ResolvedLanguageConfig,
  ctx: V1Context = { hintsDisabled: false }
): Promise<InternalTranscription> {
  if (!speechClient) {
    throw new Error('Google Speech-to-Text client is not initialized. Please check your configuration.');
  }

  const hints = v1HintsFor(fullOptions, lang.primary, ctx);
  console.log(`🎤 Transcribing audio file: ${audioFilePath}`);
  console.log(
    `🌐 Language: ${lang.primary}${lang.alternatives.length ? ` (alternatives: ${lang.alternatives.join(', ')})` : ''}` +
    `${hints.caller.length + hints.glossary.length ? `, hints: ${hints.caller.length} caller + ${hints.glossary.length} glossary` : ''}`
  );

  try {
    // Read audio file
    const audioBytes = fs.readFileSync(audioFilePath);

    // Get audio duration for result metadata
    const stats = fs.statSync(audioFilePath);
    const fileSizeKB = stats.size / 1024;

    // Check audio size for sync recognition limits
    const audioSizeMB = audioBytes.length / (1024 * 1024);
    console.log(`📊 Audio size: ${fileSizeKB.toFixed(2)} KB (${audioSizeMB.toFixed(2)} MB)`);

    if (audioSizeMB > 10) {
      console.log('📦 Audio larger than 10MB, will be chunked at video level');
      throw new Error('Audio too large for synchronous recognition. Chunking will be used.');
    }

    const { response, droppedEnhanced, droppedAlternatives, droppedHints } = await recognizeWithFallback(
      audioBytes.toString('base64'),
      fullOptions,
      lang,
      hints
    );

    if (!response.results || response.results.length === 0) {
      const empty = new Error(EMPTY_RESULT_MESSAGE);
      (empty as any).emptyResult = true;
      throw empty;
    }

    // Process results
    let fullTranscript = '';
    let totalConfidence = 0;
    let resultCount = 0;
    const alternatives: string[] = [];
    const wordTimestamps: Array<{ word: string; startTime: number; endTime: number }> = [];
    const segments: TranscriptSegment[] = [];
    const languageWeights: Record<string, number> = {};
    let previousEnd = 0;

    for (const result of response.results) {
      const resultEnd = durationSeconds(result.resultEndTime);
      if (result.alternatives && result.alternatives.length > 0) {
        const alternative = result.alternatives[0];
        if (alternative.transcript) {
          const text = alternative.transcript.trim();
          fullTranscript = joinTextFragments(fullTranscript, text);
          totalConfidence += alternative.confidence || 0;
          resultCount++;
          if (text) {
            segments.push({ startTime: previousEnd, endTime: resultEnd ?? previousEnd, text });
          }

          // Language Google used for this result (lower-case in responses, e.g. 'cmn-hans-cn')
          const resultLanguage = normalizeLanguageCode(result.languageCode) || lang.primary;
          languageWeights[resultLanguage] = (languageWeights[resultLanguage] || 0) +
            Math.max(1, countWords(alternative.transcript));

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
                  startTime: durationSeconds(wordInfo.startTime) ?? 0,
                  endTime: durationSeconds(wordInfo.endTime) ?? 0
                });
              }
            }
          }
        }
      }
      if (resultEnd !== undefined) previousEnd = resultEnd;
    }

    const transcript = fullTranscript.trim();
    const averageConfidence = resultCount > 0 ? totalConfidence / resultCount : 0;
    const wordCount = countWords(transcript);
    const detectedLanguage = reconcileDetectedLanguage(
      dominantLanguage(languageWeights) || lang.primary,
      transcript,
      [lang.primary, ...lang.alternatives]
    );

    // Duration of a 16 kHz mono 16-bit WAV
    const estimatedDuration = Math.max(1, Math.round(fileSizeKB / 32));

    console.log(`✅ Transcription completed: ${wordCount} words, confidence: ${(averageConfidence * 100).toFixed(1)}%, language: ${detectedLanguage}`);

    return {
      result: {
        transcript,
        confidence: averageConfidence,
        languageCode: detectedLanguage,
        wordCount,
        duration: estimatedDuration,
        alternatives: alternatives.length > 0 ? alternatives : undefined,
        wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : undefined,
        engine: 'v1',
        model: fullOptions.useEnhancedModel && !droppedEnhanced ? 'default (enhanced)' : 'default',
        segments: segments.length > 0 ? segments : undefined
      },
      languageWeights,
      droppedEnhanced,
      droppedAlternatives,
      droppedHints
    };

  } catch (error: any) {
    if (error?.emptyResult) {
      console.log(`🔇 No speech recognised in ${path.basename(audioFilePath)}`);
      throw error;
    }
    console.error('❌ Audio transcription failed:', error);
    console.error('🔍 Error type:', typeof error);
    console.error('📊 Error code:', error.code);
    console.error('📋 Error details:', error.details);
    console.error('🌐 Error metadata:', error.metadata);
    throw new Error(`Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Script sanity check for a probe result (confidence alone is not comparable across
 * language models). Returns a reason when the probe must be rejected.
 */
function probeScriptMismatch(candidate: string, probeTranscript: string, primaryTranscript: string): string | undefined {
  const base = toBaseLanguage(candidate);
  const isCjkCandidate = base === 'zh' || base === 'yue' || base === 'ja' || base === 'ko';
  if (isCjkCandidate) {
    const ratio = cjkRatio(probeTranscript);
    return ratio >= 0.5 ? undefined : `transcript is only ${(ratio * 100).toFixed(0)}% CJK`;
  }
  if (cjkRatio(probeTranscript) >= 0.1) {
    return 'transcript contains CJK characters';
  }
  // A Latin-script probe (e.g. en-US) must not replace a transcript that clearly is Vietnamese
  const primaryStats = analyzeScripts(primaryTranscript);
  if (base !== 'vi' && primaryStats.latin > 0 && primaryStats.vietnamese / primaryStats.latin >= 0.01) {
    return 'primary transcript contains Vietnamese-only letters';
  }
  return undefined;
}

/**
 * Auto mode: transcribe with Google language recognition; if Google stayed on the
 * primary language with low confidence, probe the alternatives as primary language
 * (see AUTO_PROBE_CONFIDENCE_THRESHOLD) and keep the clearly better one. A probe is
 * only adopted when it is clearly more confident, passes a script check (a Chinese
 * probe must yield Han text, a Latin probe must not replace Vietnamese text) and,
 * when Google's language recognition was active, is confident in absolute terms
 * (AUTO_PROBE_MIN_ABSOLUTE_CONFIDENCE).
 */
async function transcribeWithAutoDetection(
  audioFilePath: string,
  fullOptions: AudioTranscriptionOptions,
  lang: ResolvedLanguageConfig,
  /** Languages to probe; defaults to lang.alternatives (pass them explicitly once alternatives were dropped). */
  probeCandidates: string[] = lang.alternatives,
  ctx: V1Context = { hintsDisabled: false }
): Promise<InternalTranscription> {
  const first = await transcribeAudioFileInternal(audioFilePath, fullOptions, lang, ctx);
  const candidates = probeCandidates.filter(code => !isSameLanguage(code, lang.primary));
  if (!lang.auto || candidates.length === 0) return first;
  // No language recognition happened when Google rejected (or was never sent) the alternatives
  const languageRecognitionActive = !first.droppedAlternatives && lang.alternatives.length > 0;

  const stayedOnPrimary = isSameLanguage(first.result.languageCode, lang.primary);
  if (!stayedOnPrimary || first.result.confidence >= AUTO_PROBE_CONFIDENCE_THRESHOLD) {
    return first;
  }

  console.log(
    `🔎 Auto language: Google kept ${lang.primary} with low confidence ` +
    `(${(first.result.confidence * 100).toFixed(1)}%); probing ${candidates.join(', ')} as primary language...`
  );

  let best = first;
  const probeOptions: AudioTranscriptionOptions = {
    ...fullOptions,
    useEnhancedModel: fullOptions.useEnhancedModel && !first.droppedEnhanced
  };
  const probeCtx: V1Context = { hintsDisabled: ctx.hintsDisabled || first.droppedHints };
  for (const candidate of candidates) {
    try {
      const probe = await transcribeAudioFileInternal(audioFilePath, probeOptions, {
        primary: candidate,
        alternatives: [],
        auto: false
      }, probeCtx);
      console.log(`🔎 Probe ${candidate}: confidence ${(probe.result.confidence * 100).toFixed(1)}%`);
      if (probe.result.confidence < best.result.confidence + AUTO_PROBE_MIN_CONFIDENCE_GAIN) {
        continue;
      }
      // Google's language recognition was active: a probe must be confident in absolute terms too
      if (languageRecognitionActive && probe.result.confidence < AUTO_PROBE_MIN_ABSOLUTE_CONFIDENCE) {
        console.log(
          `🔎 Probe ${candidate} rejected: confidence below ${AUTO_PROBE_MIN_ABSOLUTE_CONFIDENCE * 100}% ` +
          `while Google's language recognition was active`
        );
        continue;
      }
      const scriptProblem = probeScriptMismatch(candidate, probe.result.transcript, first.result.transcript);
      if (scriptProblem) {
        console.log(`🔎 Probe ${candidate} rejected: ${scriptProblem}`);
        continue;
      }
      best = probe;
    } catch (error: any) {
      console.warn(`⚠️ Probe with ${candidate} failed: ${error.message}`);
    }
  }

  if (best !== first) {
    console.log(`🌐 Auto language: switching to ${best.result.languageCode} (confidence ${(best.result.confidence * 100).toFixed(1)}%)`);
    return {
      ...best,
      droppedEnhanced: best.droppedEnhanced || first.droppedEnhanced,
      droppedAlternatives: first.droppedAlternatives,
      droppedHints: best.droppedHints || first.droppedHints
    };
  }
  console.log(`🌐 Auto language: keeping ${first.result.languageCode}`);
  return first;
}

interface V1RunResult {
  result: AudioTranscriptionResult;
  /** Set when the run stopped early because the language locked on Chinese (caller switches to Chirp). */
  stoppedOnChinese?: string;
  /** Language weights aggregated over the chunks that were recognised. */
  languageWeights?: Record<string, number>;
}

/**
 * V1 over all chunks. Language handling in auto mode: the language is detected per chunk
 * until a chunk contains real speech (>= AUTO_LOCK_MIN_WORDS words with confidence
 * >= AUTO_LOCK_MIN_CONFIDENCE), so a short intro cannot decide; the remaining chunks are then
 * LOCKED to that language as primary (for consistency), while the other auto candidates stay as
 * alternatives so segments in another language (e.g. a Vietnamese interpreter after a Chinese
 * speaker) can still be recognised. The final languageCode is the language with the most
 * transcript across all chunks. With stopOnChineseLock the run stops once
 * AUTO_CHIRP_LOCK_CHUNKS consecutive real-speech chunks are (almost) entirely Chinese and no
 * real-speech chunk so far had a noticeable non-Chinese share (the caller then re-transcribes
 * the whole file with Chirp); otherwise it runs to the end.
 */
async function transcribeChunksV1(
  chunks: AudioChunk[],
  fullOptions: AudioTranscriptionOptions,
  initialLang: ResolvedLanguageConfig,
  totalDuration: number,
  stopOnChineseLock: boolean
): Promise<V1RunResult> {
  const pieces: string[] = [];
  const segments: TranscriptSegment[] = [];
  const wordTimestamps: Array<{ word: string; startTime: number; endTime: number }> = [];
  let totalConfidence = 0;
  let attemptedChunks = 0;
  let totalWordCount = 0;
  const languageWeights: Record<string, number> = {};
  let model = 'default';

  // Mutable per-run state: settings Google rejected are not re-sent, language gets locked after detection
  const chunkOptions: AudioTranscriptionOptions = { ...fullOptions };
  const ctx: V1Context = { hintsDisabled: false };
  let lang: ResolvedLanguageConfig = { ...initialLang, alternatives: [...initialLang.alternatives] };
  let languageLocked = !initialLang.auto;
  let consecutiveChinese = 0;
  let earlyStopAllowed = stopOnChineseLock;

  for (let i = 0; i < chunks.length; i++) {
    const chunkFile = chunks[i];
    if (chunkFile.silent) {
      console.log(`🔇 Chunk ${i + 1}/${chunks.length} is silent (${chunkFile.start.toFixed(1)}-${chunkFile.end.toFixed(1)}s), skipped`);
      continue;
    }
    console.log(`🎤 Transcribing chunk ${i + 1}/${chunks.length} (${chunkFile.start.toFixed(1)}-${chunkFile.end.toFixed(1)}s)`);
    attemptedChunks++;
    try {
      const chunk = languageLocked
        ? await transcribeAudioFileInternal(chunkFile.path, chunkOptions, lang, ctx)
        : await transcribeWithAutoDetection(chunkFile.path, chunkOptions, lang, initialLang.alternatives, ctx);
      const chunkResult = chunk.result;
      if (chunkResult.model) model = chunkResult.model;

      if (chunk.droppedEnhanced && chunkOptions.useEnhancedModel) {
        console.log('🔧 Disabling enhanced model for remaining chunks (rejected by Speech-to-Text)');
        chunkOptions.useEnhancedModel = false;
      }
      if (chunk.droppedAlternatives && lang.alternatives.length > 0) {
        console.log('🔧 Disabling alternative languages for remaining chunks (rejected by Speech-to-Text)');
        lang = { ...lang, alternatives: [] };
      }
      if (chunk.droppedHints && !ctx.hintsDisabled) {
        console.log('🔧 Disabling phrase hints for remaining chunks (rejected by Speech-to-Text)');
        ctx.hintsDisabled = true;
      }

      const hasRealSpeech =
        countWords(chunkResult.transcript) >= AUTO_LOCK_MIN_WORDS &&
        chunkResult.confidence >= AUTO_LOCK_MIN_CONFIDENCE;
      if (!languageLocked && chunkResult.transcript && !hasRealSpeech) {
        console.log(
          `🌐 Chunk ${i + 1}: ${chunkResult.wordCount} words, confidence ${(chunkResult.confidence * 100).toFixed(1)}% ` +
          `(${chunkResult.languageCode}) - too little speech to lock the language, detecting again on the next chunk`
        );
      }
      if (!languageLocked && hasRealSpeech) {
        const detected = chunkResult.languageCode;
        const canUseAlternatives = lang.alternatives.length > 0;
        lang = {
          primary: detected,
          alternatives: canUseAlternatives
            ? uniqueLanguageCodes(
                [initialLang.primary, ...initialLang.alternatives].filter(code => !isSameLanguage(code, detected)),
                detected
              )
            : [],
          auto: false
        };
        languageLocked = true;
        console.log(
          `🔒 Language detected on chunk ${i + 1}: ${detected}. Remaining chunks use primary=${lang.primary}` +
          `${lang.alternatives.length ? `, alternatives=[${lang.alternatives.join(', ')}]` : ''}`
        );
      }

      if (earlyStopAllowed && hasRealSpeech) {
        const share = chineseShare(chunk.languageWeights, chunkResult.languageCode);
        if (isChineseLanguage(chunkResult.languageCode) && share >= AUTO_CHIRP_CHUNK_SHARE) {
          consecutiveChinese++;
          if (consecutiveChinese >= AUTO_CHIRP_LOCK_CHUNKS) {
            console.log(
              `🔒 ${consecutiveChinese} consecutive Chinese chunks (last: ${chunkResult.languageCode}, ` +
              `${(share * 100).toFixed(0)}% Chinese). Handing the whole file to the Chinese engine(s).`
            );
            return { result: emptyResult(chunkResult.languageCode, totalDuration), stoppedOnChinese: chunkResult.languageCode };
          }
        } else {
          earlyStopAllowed = false;
          consecutiveChinese = 0;
          console.log(
            `🌐 Chunk ${i + 1} is ${(share * 100).toFixed(0)}% Chinese (${chunkResult.languageCode}); ` +
            'mixed-language audio, finishing the V1 pass before choosing the engine'
          );
        }
      }

      addWeights(languageWeights, chunk.languageWeights);
      pieces.push(chunkResult.transcript);
      totalConfidence += chunkResult.confidence;
      totalWordCount += chunkResult.wordCount;
      for (const segment of chunkResult.segments ?? []) {
        segments.push({
          startTime: roundTime(chunkFile.start + segment.startTime),
          endTime: roundTime(Math.min(chunkFile.end, chunkFile.start + segment.endTime)),
          text: segment.text
        });
      }
      for (const word of chunkResult.wordTimestamps ?? []) {
        wordTimestamps.push({ word: word.word, startTime: roundTime(chunkFile.start + word.startTime), endTime: roundTime(chunkFile.start + word.endTime) });
      }

      console.log(`✅ Chunk ${i + 1} completed: ${chunkResult.wordCount} words, confidence: ${(chunkResult.confidence * 100).toFixed(1)}%, language: ${chunkResult.languageCode}`);
    } catch (chunkError: any) {
      if (chunkError?.emptyResult) {
        attemptedChunks--;
        continue;
      }
      console.error(`❌ Chunk ${i + 1} failed:`, chunkError.message);
      // Continue with other chunks instead of failing completely
      pieces.push(' [TRANSCRIPTION_FAILED] ');
    }
  }

  const transcript = joinPieces(pieces);
  const detectedLanguage = reconcileDetectedLanguage(
    dominantLanguage(languageWeights) || initialLang.primary,
    transcript.replace(/\[TRANSCRIPTION_FAILED\]/g, ''),
    [initialLang.primary, ...initialLang.alternatives]
  );
  console.log(`🌐 Detected audio language: ${detectedLanguage} (weights: ${JSON.stringify(languageWeights)})`);

  return {
    result: {
      transcript,
      confidence: attemptedChunks > 0 ? totalConfidence / attemptedChunks : 0,
      languageCode: detectedLanguage,
      wordCount: totalWordCount,
      duration: Math.round(totalDuration),
      wordTimestamps: wordTimestamps.length > 0 ? wordTimestamps : undefined,
      engine: 'v1',
      model,
      segments: segments.length > 0 ? segments : undefined
    },
    languageWeights
  };
}

function emptyResult(languageCode: string, duration: number): AudioTranscriptionResult {
  return { transcript: '', confidence: 0, languageCode, wordCount: 0, duration: Math.round(duration), engine: 'v1' };
}

// ---------------------------------------------------------------------------
// Chirp (Speech-to-Text V2) recognition
// ---------------------------------------------------------------------------

function chirpConcurrency(): number {
  const value = parseInt(process.env.GOOGLE_STT_V2_CONCURRENCY || '', 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 8) : 3;
}

function initialAdaptationMode(): ChirpAdaptationMode {
  const value = (process.env.GOOGLE_STT_V2_ADAPTATION || '').trim().toLowerCase();
  return value === 'plain' || value === 'off' ? value : 'boost';
}

/**
 * Chirp with languageCodes ['auto'] on up to 3 non-silent chunks; returns the dominant
 * language code reported by Google (undefined when Google reported none).
 */
async function detectLanguageWithChirp(chunks: AudioChunk[], fullOptions: AudioTranscriptionOptions): Promise<string | undefined> {
  const sample = chunks.filter(chunk => !chunk.silent).slice(0, 3);
  const weights: Record<string, number> = {};
  let text = '';
  for (const chunk of sample) {
    const result = await recognizeChirp(chunk.path, {
      languageCodes: ['auto'],
      adaptation: 'off',
      enableAutomaticPunctuation: fullOptions.enableAutomaticPunctuation,
      profanityFilter: fullOptions.profanityFilter
    });
    for (const piece of result.pieces) {
      if (piece.languageCode) weights[piece.languageCode] = (weights[piece.languageCode] || 0) + countWords(piece.text);
    }
    text = joinTextFragments(text, result.transcript);
    if (countWords(text) >= AUTO_LOCK_MIN_WORDS * 2) break;
  }
  const dominant = dominantLanguage(weights);
  if (!dominant && !text) return undefined;
  return reconcileDetectedLanguage(dominant || AUTO_LANGUAGE, text, dominant ? [dominant] : []);
}

/**
 * Chirp over all chunks with one language code. The first non-silent chunk runs alone (it
 * establishes that Chirp, the language and the adaptation are accepted); the rest run with
 * bounded concurrency. Throws on any Chirp failure (caller falls back to V1 for the whole file).
 */
async function transcribeChunksChirp(
  chunks: AudioChunk[],
  fullOptions: AudioTranscriptionOptions,
  languageCode: string,
  totalDuration: number
): Promise<AudioTranscriptionResult> {
  const chirpConfig = getChirpConfig();
  const code = toChirpLanguageCode(languageCode);
  const hints = buildPhraseHints({
    callerHints: fullOptions.phraseHints,
    domainHints: fullOptions.domainHints,
    languageCode: code,
    limits: CHIRP_HINT_LIMITS
  });
  const phraseGroups = [
    { phrases: hints.caller, boost: CALLER_HINT_BOOST },
    { phrases: hints.glossary, boost: GLOSSARY_HINT_BOOST }
  ].filter(group => group.phrases.length > 0);
  const hasHints = phraseGroups.length > 0;
  let adaptation: ChirpAdaptationMode = hasHints ? initialAdaptationMode() : 'off';

  console.log(
    `🎧 Chirp: model ${chirpConfig.model} @ ${chirpConfig.location}, language ${code}, ` +
    `hints ${hints.caller.length} caller + ${hints.glossary.length} glossary (adaptation ${adaptation}), ` +
    `${chunks.filter(c => !c.silent).length} chunk(s) to recognise`
  );

  const results: Array<ChirpRecognizeResult | null> = new Array(chunks.length).fill(null);
  const pending = chunks.filter(chunk => !chunk.silent);

  const run = async (chunk: AudioChunk) => {
    const result = await recognizeChirp(chunk.path, {
      languageCodes: [code],
      phraseGroups,
      adaptation,
      enableAutomaticPunctuation: fullOptions.enableAutomaticPunctuation,
      enableWordTimeOffsets: fullOptions.enableWordTimeOffsets,
      profanityFilter: fullOptions.profanityFilter
    });
    if (hasHints && result.adaptation !== adaptation && adaptation !== 'off') {
      console.log(`🔧 Chirp adaptation lowered to '${result.adaptation}' for remaining chunks`);
      adaptation = result.adaptation;
    }
    results[chunk.index] = result;
    console.log(`✅ Chirp chunk ${chunk.index + 1}/${chunks.length}: ${countWords(result.transcript)} words`);
  };

  if (pending.length > 0) {
    await run(pending[0]);
    await mapWithConcurrency(pending.slice(1), chirpConcurrency(), run);
  }

  const pieces: string[] = [];
  const segments: TranscriptSegment[] = [];
  const words: Array<{ word: string; startTime: number; endTime: number }> = [];
  const weights: Record<string, number> = {};
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const chunk of chunks) {
    const result = results[chunk.index];
    if (!result) continue;
    pieces.push(result.transcript);
    for (const piece of result.pieces) {
      segments.push({
        startTime: roundTime(chunk.start + piece.startTime),
        endTime: roundTime(Math.min(chunk.end, chunk.start + (piece.endTime ?? chunk.end - chunk.start))),
        text: piece.text
      });
      const pieceLanguage = piece.languageCode || code;
      weights[pieceLanguage] = (weights[pieceLanguage] || 0) + Math.max(1, countWords(piece.text));
    }
    for (const word of result.words ?? []) {
      words.push({ word: word.word, startTime: roundTime(chunk.start + word.startTime), endTime: roundTime(chunk.start + word.endTime) });
    }
    if (result.confidence !== undefined) {
      confidenceSum += result.confidence;
      confidenceCount++;
    }
  }

  const transcript = joinPieces(pieces);
  if (!transcript && pending.length > 0) {
    throw new Error(`Chirp returned no transcript for ${pending.length} non-silent chunk(s)`);
  }
  const dominant = dominantLanguage(weights) || code;
  // Keep the requested Chinese variant (Google may answer in lower case or with a shorter tag)
  const reported = isSameLanguage(dominant, code) ? code : (normalizeLanguageCode(dominant) || code);
  const detectedLanguage = reconcileDetectedLanguage(reported, transcript, [code]);

  return {
    transcript,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : CHIRP_NOMINAL_CONFIDENCE,
    ...(confidenceCount > 0 ? {} : { confidenceIsNominal: true }),
    languageCode: detectedLanguage,
    wordCount: countWords(transcript),
    duration: Math.round(totalDuration),
    wordTimestamps: words.length > 0 ? words : undefined,
    engine: 'chirp',
    model: chirpConfig.model,
    segments: segments.length > 0 ? segments : undefined
  };
}

// ---------------------------------------------------------------------------
// Engine selection (Alibaba / Chirp / V1)
// ---------------------------------------------------------------------------

export type ChineseEngine = TranscriptionEngine;
export const DEFAULT_CHINESE_ENGINE_ORDER: ChineseEngine[] = ['alibaba', 'chirp', 'v1'];

/** STT_CHINESE_ENGINE_ORDER (comma list of alibaba / chirp / v1); unknown names are ignored. */
export function chineseEngineOrder(raw: string | undefined = process.env.STT_CHINESE_ENGINE_ORDER): ChineseEngine[] {
  const parsed = (raw || '')
    .split(',')
    .map(name => name.trim().toLowerCase())
    .filter((name): name is ChineseEngine => name === 'alibaba' || name === 'chirp' || name === 'v1');
  const unique = Array.from(new Set(parsed));
  return unique.length > 0 ? unique : [...DEFAULT_CHINESE_ENGINE_ORDER];
}

const ENGINE_LABELS: Record<TranscriptionEngine, string> = {
  alibaba: 'Alibaba Model Studio ASR',
  chirp: 'Chirp (Speech-to-Text V2)',
  v1: 'Speech-to-Text V1'
};

function engineUnavailableReason(engine: TranscriptionEngine): string | undefined {
  if (engine === 'alibaba') return alibabaUnavailableReason();
  if (engine === 'chirp') return isChirpAvailable() ? undefined : (chirpUnavailableReason() || 'not available');
  return speechClient ? undefined : 'Google Speech-to-Text V1 client is not initialized';
}

/** Per-file state shared by the engines: the extracted audio and lazily written chunks (V1 / Chirp). */
interface FileRunContext {
  audioFilePath: string;
  duration: number;
  fullOptions: AudioTranscriptionOptions;
  getChunks: () => Promise<AudioChunk[]>;
}

const TEXT_LANGUAGE_TO_CODE: Record<string, string> = {
  zh: 'cmn-Hans-CN',
  vi: 'vi-VN',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR'
};

/** Alibaba on the WHOLE audio file (the adapter chunks itself only for sync models). */
async function transcribeFileWithAlibaba(ctx: FileRunContext, languageCode: string): Promise<AudioTranscriptionResult> {
  const { fullOptions } = ctx;
  const run = (code: string) => transcribeWithAlibaba(ctx.audioFilePath, {
    languageCode: code,
    model: fullOptions.alibabaModel,
    hotwords: fullOptions.phraseHints,
    context: fullOptions.contextText,
    glossary: fullOptions.domainHints
  });
  let result = await run(languageCode);
  let transcript = result.transcript.trim();
  if (!transcript) {
    throw new Error(`Alibaba ASR (${result.model}) returned an empty transcript for ${ctx.duration.toFixed(1)}s of audio`);
  }
  let detected: string;
  if (languageCode.toLowerCase() === AUTO_LANGUAGE) {
    detected = TEXT_LANGUAGE_TO_CODE[detectLanguageCodeFromText(transcript)] || AUTO_PRIMARY_LANGUAGE;
    // Without a language code the TCM glossary was not applied: when the model turned out to hear
    // Chinese and the glossary actually changes this model's request, run once more with the code.
    if (isChineseLanguage(detected) && fullOptions.domainHints !== 'none' && alibabaModelUsesGlossary(result.model)) {
      console.log(`🌐 Alibaba ASR detected ${detected}; re-running with the TCM glossary applied`);
      try {
        const biased = await run(detected);
        if (biased.transcript.trim()) {
          result = biased;
          transcript = biased.transcript.trim();
        }
      } catch (error: any) {
        console.warn(`⚠️ Alibaba ASR glossary pass failed (${error?.message || error}); keeping the unbiased transcript`);
      }
    }
  } else {
    detected = reconcileDetectedLanguage(normalizeLanguageCode(languageCode) || languageCode, transcript, [languageCode]);
  }
  return {
    transcript,
    confidence: result.confidence ?? CHIRP_NOMINAL_CONFIDENCE,
    ...(result.confidence === undefined ? { confidenceIsNominal: true } : {}),
    languageCode: detected,
    wordCount: countWords(transcript),
    duration: Math.round(result.durationSeconds || ctx.duration),
    engine: 'alibaba',
    model: result.model,
    segments: result.segments?.map(segment => ({
      startTime: roundTime(segment.startTime),
      endTime: roundTime(segment.endTime),
      text: segment.text
    }))
  };
}

/**
 * Try the engines in order (each only when available) for one language code; on failure log and
 * fall back to the next. `v1Fallback` is what 'v1' means here (a full V1 pass, or an already
 * finished V1 detection pass). When every listed engine failed or was unavailable, V1 is the
 * last resort even if the order omits it.
 */
async function runEngineChain(
  ctx: FileRunContext,
  order: TranscriptionEngine[],
  languageCode: string,
  v1Fallback: () => Promise<AudioTranscriptionResult>
): Promise<AudioTranscriptionResult> {
  const usable = order.filter(engine => {
    const reason = engineUnavailableReason(engine);
    if (reason) console.log(`ℹ️ ${ENGINE_LABELS[engine]} not available (${reason}); skipping it`);
    return !reason;
  });
  if (!usable.includes('v1') && !engineUnavailableReason('v1')) usable.push('v1');
  console.log(`🧭 Engine order for ${languageCode}: ${usable.join(' -> ') || '(none)'}`);

  let lastError: unknown;
  for (let i = 0; i < usable.length; i++) {
    const engine = usable[i];
    try {
      if (engine === 'alibaba') return await transcribeFileWithAlibaba(ctx, languageCode);
      if (engine === 'chirp') return await transcribeChunksChirp(await ctx.getChunks(), ctx.fullOptions, languageCode, ctx.duration);
      return await v1Fallback();
    } catch (error: any) {
      lastError = error;
      const next = usable[i + 1];
      console.error(
        `❌ ${ENGINE_LABELS[engine]} failed: ${error?.message || error}. ` +
        (next ? `Falling back to ${ENGINE_LABELS[next]} for the whole file.` : 'No engine left.')
      );
    }
  }
  if (lastError instanceof Error) throw lastError;
  throw new Error(`No speech-to-text engine available for ${languageCode} (${order.map(e => `${e}: ${engineUnavailableReason(e) || 'failed'}`).join('; ')})`);
}

/** Language of the first few non-silent chunks with V1 auto detection (for forced engines + 'auto'). */
async function detectLanguageWithV1Sample(ctx: FileRunContext, lang: ResolvedLanguageConfig): Promise<string> {
  const sample = (await ctx.getChunks()).filter(chunk => !chunk.silent).slice(0, 3);
  if (sample.length === 0) return lang.primary;
  const run = await transcribeChunksV1(sample, ctx.fullOptions, lang, ctx.duration, false);
  // No language weight means every sample chunk failed (quota / auth) or held no speech: the
  // languageCode is then just the configured primary, not a detection
  if (!run.languageWeights || !dominantLanguage(run.languageWeights)) {
    console.warn('⚠️ V1 language detection on the first chunks produced no result; leaving the language to Alibaba ASR');
    return AUTO_LANGUAGE;
  }
  return run.result.languageCode;
}

/**
 * Engine selection (see AudioTranscriptionOptions.engine):
 * - 'v1': V1 only.
 * - 'chirp': Chirp (language 'auto' -> detected with Chirp on the first chunks); V1 on failure.
 * - 'alibaba': Alibaba on the whole file (language 'auto' -> detected with V1 on the first chunks
 *   when V1 is configured, else left to the model); V1 on failure.
 * - 'auto': explicit Chinese code -> STT_CHINESE_ENGINE_ORDER (default alibaba, chirp, v1), else V1.
 *   Language 'auto' -> V1 detection as before; when several consecutive chunks are clearly Chinese
 *   (or the full V1 pass is >= 80% Chinese) the whole file is (re)transcribed with the Chinese
 *   engine order in the detected code. Non-Chinese and mixed Chinese/Vietnamese audio stays on V1.
 *   Without V1 credentials, language 'auto' goes straight to Alibaba (model-side detection).
 */
async function transcribeWithEngines(ctx: FileRunContext, initialLang: ResolvedLanguageConfig): Promise<AudioTranscriptionResult> {
  const { fullOptions, duration } = ctx;
  const engine = fullOptions.engine ?? 'auto';
  const runV1Full = async (lang: ResolvedLanguageConfig = initialLang) => {
    // Without a V1 client every chunk would fail and come back as [TRANSCRIPTION_FAILED] markers
    if (!speechClient) {
      throw new Error(
        'Google Speech-to-Text V1 is not configured (client is not initialized); choose the Alibaba engine ' +
        'or configure Google credentials'
      );
    }
    return (await transcribeChunksV1(await ctx.getChunks(), fullOptions, lang, duration, false)).result;
  };

  if (engine === 'v1') return runV1Full();

  if (!initialLang.auto) {
    const code = initialLang.primary;
    if (engine === 'chirp' || engine === 'alibaba') return runEngineChain(ctx, [engine, 'v1'], code, () => runV1Full());
    if (isChineseLanguage(code)) return runEngineChain(ctx, chineseEngineOrder(), code, () => runV1Full());
    if (!speechClient && isAlibabaAsrAvailable()) {
      console.log(`ℹ️ Speech-to-Text V1 is not configured; using Alibaba ASR for ${code}`);
      return runEngineChain(ctx, ['alibaba'], code, () => runV1Full());
    }
    return runV1Full();
  }

  // Language 'auto'
  if (engine === 'chirp') {
    const reason = engineUnavailableReason('chirp');
    if (reason) {
      console.warn(`⚠️ Engine 'chirp' requested but Chirp is not available (${reason}); using Speech-to-Text V1`);
      return runV1Full();
    }
    let code: string;
    try {
      code = (await detectLanguageWithChirp(await ctx.getChunks(), fullOptions)) || AUTO_LANGUAGE;
      console.log(`🌐 Chirp language detection: ${code}`);
    } catch (error: any) {
      console.error(`❌ Chirp language detection failed, falling back to Speech-to-Text V1: ${error?.message || error}`);
      return runV1Full();
    }
    return runEngineChain(ctx, ['chirp', 'v1'], code, () => runV1Full());
  }

  if (engine === 'alibaba') {
    let code = AUTO_LANGUAGE;
    if (speechClient) {
      code = await detectLanguageWithV1Sample(ctx, initialLang);
      console.log(`🌐 V1 language detection (first chunks) for Alibaba: ${code}`);
    }
    return runEngineChain(ctx, ['alibaba', 'v1'], code, () => runV1Full());
  }

  // engine 'auto' + language 'auto'
  if (!speechClient) {
    console.log('ℹ️ Speech-to-Text V1 is not configured; language detection is left to Alibaba ASR');
    return runEngineChain(ctx, ['alibaba'], AUTO_LANGUAGE, () => runV1Full());
  }
  const order = chineseEngineOrder();
  // Stop V1 early on Chinese only when a non-V1 engine can take over; else the V1 rerun from chunk 1
  // would bill the leading chunks twice for nothing
  const canHandOff = order.some(candidate => candidate !== 'v1' && !engineUnavailableReason(candidate));
  const detection = await transcribeChunksV1(await ctx.getChunks(), fullOptions, initialLang, duration, canHandOff);
  if (detection.stoppedOnChinese) {
    return runEngineChain(ctx, order, detection.stoppedOnChinese, () => runV1Full());
  }
  if (isChineseLanguage(detection.result.languageCode)) {
    // The Chinese engines get ONE Chinese code: only replace the V1 pass (which kept vi-VN / en-US
    // as alternatives) when the audio is overwhelmingly Chinese, else non-Chinese speech is lost.
    const share = chineseShare(detection.languageWeights, detection.result.languageCode);
    if (share >= AUTO_CHIRP_FILE_SHARE) {
      console.log(
        `🌐 Final language is ${detection.result.languageCode} (${(share * 100).toFixed(0)}% Chinese); ` +
        `re-transcribing the whole file with the Chinese engine order (${order.join(', ')})`
      );
      return runEngineChain(ctx, order, detection.result.languageCode, async () => detection.result);
    }
    console.log(
      `🌐 Final language is ${detection.result.languageCode} but only ${(share * 100).toFixed(0)}% Chinese ` +
      `(< ${AUTO_CHIRP_FILE_SHARE * 100}%); keeping the multi-language V1 transcript`
    );
  }
  return detection.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Transcribe one short audio file (<= 10 MB, < 60 s) with Speech-to-Text V1.
 * (Long audio / Chirp: use transcribeVideoFile, which also accepts audio files.)
 */
export async function transcribeAudioFile(
  audioFilePath: string,
  options: Partial<AudioTranscriptionOptions> = {}
): Promise<AudioTranscriptionResult> {
  if (!speechClient) {
    throw new Error('Google Speech-to-Text client is not initialized. Please check your configuration.');
  }

  const fullOptions = mergeTranscriptionOptions(options);
  const lang = resolveLanguageConfig(fullOptions);
  const { result } = await transcribeWithAutoDetection(audioFilePath, fullOptions, lang);
  return result;
}

/**
 * Transcribe a video (or audio) file: extract 16 kHz mono audio, then recognise it with the
 * selected engine (see transcribeWithEngines). Alibaba gets the whole extracted file; V1 / Chirp
 * get pause-aligned chunks of <= 55 s (ffmpeg silencedetect; fixed 50 s cuts if that fails),
 * written only when one of them runs (see transcribeChunksV1 for the auto-language rules).
 */
export async function transcribeVideoFile(
  videoFilePath: string,
  options: Partial<AudioTranscriptionOptions> = {}
): Promise<AudioTranscriptionResult> {
  console.log(`🎬 Starting video transcription: ${videoFilePath}`);
  console.log(`🔧 Transcription options:`, {
    ...options,
    ...(options.phraseHints ? { phraseHints: `[${options.phraseHints.length} hints]` } : {}),
    ...(options.contextText ? { contextText: `[${options.contextText.length} chars]` } : {})
  });

  if (!speechClient && !isAlibabaAsrAvailable()) {
    throw new Error(
      'Video transcription failed: no speech-to-text engine is configured (Google Speech-to-Text client is not ' +
      `initialized and Alibaba ASR is unavailable: ${alibabaUnavailableReason()}). Please check your configuration.`
    );
  }

  const fullOptions = mergeTranscriptionOptions(options);
  const initialLang = resolveLanguageConfig(fullOptions);
  console.log(
    `🌐 Language config: ${initialLang.auto ? 'auto, ' : ''}primary=${initialLang.primary}, ` +
    `alternatives=[${initialLang.alternatives.join(', ')}], engine=${fullOptions.engine}, domainHints=${fullOptions.domainHints}`
  );

  let audioFilePath: string | undefined;
  let workDir: string | undefined;
  try {
    // Step 1: Extract audio from video
    audioFilePath = await extractAudioFromVideo(videoFilePath);
    console.log(`✅ Audio extracted successfully: ${audioFilePath}`);

    // Step 2: Pause-aligned chunks within the sync Recognize limits (< 60 s, <= 10 MB), written
    // lazily: only V1 / Chirp need them (Alibaba takes the whole file)
    const duration = await probeAudioDuration(audioFilePath);
    const extractedAudio = audioFilePath;
    let chunksPromise: Promise<AudioChunk[]> | undefined;
    const getChunks = () => {
      if (!chunksPromise) {
        chunksPromise = (async () => {
          const plan = await planAudioChunks(extractedAudio, duration);
          workDir = fs.mkdtempSync(path.join(AUDIO_PROCESSING_DIR, 'chunks-'));
          const chunks = await writeAudioChunks(extractedAudio, plan.chunks, workDir);
          console.log(`✂️ Audio ${duration.toFixed(1)}s -> ${chunkSummary(plan.chunks)} (${plan.method})`);
          return chunks;
        })();
      }
      return chunksPromise;
    };

    // Step 3: Recognise
    const result = await transcribeWithEngines({ audioFilePath: extractedAudio, duration, fullOptions, getChunks }, initialLang);
    console.log(
      `✅ Transcription done with ${result.engine}${result.model ? ` (${result.model})` : ''}: ` +
      `${result.wordCount} words, language ${result.languageCode}`
    );
    return result;
  } catch (error: any) {
    console.error('❌ Video transcription failed:', error);
    console.error('📊 Error details:', error instanceof Error ? error.stack : error);
    throw new Error(`Video transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  } finally {
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        console.warn(`⚠️ Failed to clean up chunk directory: ${workDir}`);
      }
    }
    if (audioFilePath) {
      try {
        fs.unlinkSync(audioFilePath);
      } catch {
        console.warn(`⚠️ Failed to clean up audio file: ${audioFilePath}`);
      }
    }
  }
}

/**
 * Check if audio transcription is available (Google V1 or Alibaba ASR).
 */
export function isAudioTranscriptionAvailable(): boolean {
  return speechClient !== null || isAlibabaAsrAvailable();
}

/** Whether Google Speech-to-Text V1 is configured (needed for transcribeAudioFile and 'auto' language detection). */
export function isGoogleV1Available(): boolean {
  return speechClient !== null;
}

/** Whether the Chirp (Speech-to-Text V2) engine can be used. */
export { isChirpAvailable } from './stt-v2';
/** Whether the Alibaba Model Studio ASR engine can be used. */
export { isAlibabaAsrAvailable } from './stt-alibaba';

/**
 * Clean up audio processing directory
 */
export function cleanupAudioProcessing(): void {
  try {
    const entries = fs.readdirSync(AUDIO_PROCESSING_DIR);
    for (const entry of entries) {
      fs.rmSync(path.join(AUDIO_PROCESSING_DIR, entry), { recursive: true, force: true });
    }
    console.log('🧹 Audio processing directory cleaned up');
  } catch (error) {
    console.error('❌ Failed to cleanup audio processing directory:', error);
  }
}
