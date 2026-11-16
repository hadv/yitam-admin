import dotenv from 'dotenv';
import { generateChat, generateText, isLlmConfigured, llmModelFor, LlmError } from './llm-client';
import { YtDlpVideoInfo } from './yt-dlp-downloader';
import { getTranscriptFromPublicApi, getVideoDetails } from './youtube-transcript';
import {
  transcribeVideoFile,
  isAudioTranscriptionAvailable,
  AudioTranscriptionOptions
} from './audio-transcription';
import { processAudioTranscript } from './audio-transcript-processor';
import { extractBoardText, BoardOcrResult, BoardTextItem } from './board-ocr';
import { correctDomainTerms, TermCorrection } from './term-correction';
import { getTcmHanVietPairs, scriptForLanguageCode } from './tcm-glossary';
import {
  AUTO_LANGUAGE,
  DEFAULT_TARGET_LANGUAGE,
  analyzeScripts,
  countWords,
  cjkRatio,
  detectLanguageFromText,
  getFillerWordsHint,
  getLanguageName,
  isChineseLanguage,
  isSameLanguage,
  normalizeLanguageCode,
  splitTextIntoSegments,
  stripUndefined,
  toBaseLanguage
} from './language-utils';

// Load environment variables
dotenv.config();

// Generative LLM (Alibaba Cloud Model Studio / Qwen) for metadata, cleaning and translation
if (!isLlmConfigured('fast')) {
  console.warn('DASHSCOPE_API_KEY is not set (or ALIBABA_LLM_ENABLED=false): LLM metadata, transcript cleaning and translation are disabled.');
}

/**
 * Enhanced video metadata interface
 */
export interface EnhancedVideoMetadata {
  // Original metadata from yt-dlp
  originalMetadata: YtDlpVideoInfo;
  
  // AI-enhanced metadata
  enhancedTitle: string;
  enhancedSummary: string;
  contentBasedTitle?: string;
  contentBasedSummary?: string;
  keyTopics: string[];
  contentTags: string[];
  chapters?: VideoChapter[];
  keyQuotes?: string[];

  // Enhancement metadata
  enhancementSource: 'transcript' | 'metadata' | 'combined';
  language: string; // Human name of the ORIGINAL content language, e.g. 'Chinese'
  confidence: number;
  processingTime: number;

  // Audio transcript data
  audioTranscript?: string; // Raw audio transcript text (original language)
  enhancedTranscript?: string; // LLM-cleaned transcript, still in the ORIGINAL language
  transcriptWordCount?: number; // Word count for quality assessment
  originalLanguageCode?: string; // Detected audio language, e.g. 'cmn-Hans-CN'
  originalLanguage?: string; // Human name of the original language, e.g. 'Chinese'
  translatedTranscript?: string; // Translation of enhancedTranscript (only when original != target language)
  translationLanguage?: string; // Target language of translatedTranscript, e.g. 'vi'
  translationPartial?: boolean; // true if some translation segments failed

  // Chinese (Đông y) lecture pipeline
  correctedTranscript?: string; // Raw transcript with mis-recognised domain terms fixed (only set when something was fixed)
  termCorrections?: TermCorrection[]; // What was fixed (present whenever domain-term correction ran, may be empty)
  boardText?: BoardTextItem[]; // Chinese text read from the blackboard / slides, with frame time
  boardTerms?: string[]; // Domain terms seen on the board (used as STT phrase hints + correction evidence)
  boardOcrStatus?: string; // Why no board text is shown (skipped / failed / nothing found); absent when board text was read
  transcriptionEngine?: 'alibaba' | 'chirp' | 'v1'; // Speech-to-Text engine that produced audioTranscript
  transcriptionModel?: string; // e.g. 'chirp_3', 'default'
  confidenceIsNominal?: boolean; // true when confidence is a fixed placeholder (Chirp gives no score): not a quality measure
}

/**
 * Video chapter interface for automatic chapter detection
 */
export interface VideoChapter {
  title: string;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  summary: string;
}

/**
 * Options for video metadata enhancement
 */
export interface EnhancementOptions {
  includeChapters?: boolean;
  includeKeyQuotes?: boolean;
  maxKeyTopics?: number;
  maxContentTags?: number;
  temperature?: number;
  maxOutputTokens?: number;
  languagePreference?: string; // 'auto', 'en', 'vi', etc.
  useAudioTranscription?: boolean; // Enable audio-to-text transcription
  forceAudioTranscription?: boolean; // Force audio transcription even if transcript is available
  audioTranscriptionOptions?: Partial<AudioTranscriptionOptions>;
  /**
   * 'none' = verbatim (no LLM rewrite; enhancedTranscript = term-corrected raw transcript),
   * 'basic' | 'aggressive' = LLM cleaning. When omitted: 'none' for Chinese audio, otherwise 'aggressive'.
   */
  transcriptCleaningLevel?: TranscriptCleaningLevel;
  domainCorrection?: boolean; // Fix mis-recognised Đông y terms in Chinese transcripts (default true)
  boardOcr?: boolean; // Read Chinese text on the blackboard (video frames) for hints + correction (default true)
  embedAudioTranscript?: boolean; // Enable embedding audio transcript into vector database
  domains?: string[]; // Knowledge domains for categorizing the content
  targetLanguage?: string; // Language for translation + generated metadata of audio transcripts (default 'vi')
  translateTranscript?: boolean; // Translate the audio transcript into targetLanguage when it differs (default false: keep the original-language transcript only)
}

export type TranscriptCleaningLevel = 'none' | 'basic' | 'aggressive';
export const TRANSCRIPT_CLEANING_LEVELS: TranscriptCleaningLevel[] = ['none', 'basic', 'aggressive'];
/** Used when the caller did not choose a level and the audio is not Chinese (backward compatible). */
const DEFAULT_CLEANING_LEVEL: TranscriptCleaningLevel = 'aggressive';
/** Chinese lectures default to a verbatim transcript. */
const DEFAULT_CHINESE_CLEANING_LEVEL: TranscriptCleaningLevel = 'none';

// Default enhancement options
const DEFAULT_ENHANCEMENT_OPTIONS: EnhancementOptions = {
  includeChapters: true,
  includeKeyQuotes: true,
  maxKeyTopics: 8,
  maxContentTags: 12,
  temperature: 0.3,
  maxOutputTokens: 4000,
  languagePreference: 'auto',
  useAudioTranscription: true, // Enable by default if available
  forceAudioTranscription: false, // Don't force by default
  // transcriptCleaningLevel intentionally has no static default: it depends on the detected language
  targetLanguage: DEFAULT_TARGET_LANGUAGE,
  translateTranscript: false,
  domainCorrection: true,
  boardOcr: true,
  audioTranscriptionOptions: {
    languageCode: AUTO_LANGUAGE, // Detect Vietnamese / Chinese / English
    enableAutomaticPunctuation: true,
    useEnhancedModel: true
  }
};

// Transcript cleaning / translation are done per segment so long transcripts are never truncated.
// CJK text carries much more content per character, hence smaller segments.
const CLEANING_SEGMENT_CHARS = { cjk: 2000, other: 4000 };
const TRANSLATION_SEGMENT_CHARS = { cjk: 1500, other: 3000 };
const SEGMENT_MAX_OUTPUT_TOKENS = 8192;
const SEGMENT_CONCURRENCY = 3;
const SEGMENT_RETRY_DELAY_MS = 1500;
// Rate-limit / overload errors (429, 503) need real backoff: a quick retry lands in the same quota window.
// llm-client already retries each request (ALIBABA_LLM_MAX_RETRIES, honouring Retry-After); these outer
// attempts add a longer wait on top for a quota window that outlasts those retries.
const SEGMENT_TRANSIENT_MAX_ATTEMPTS = 3;
const SEGMENT_TRANSIENT_BASE_DELAY_MS = 4000;
const SEGMENT_TRANSIENT_MAX_DELAY_MS = 60000;
// Translate a transcript whose dominant language is the target when this share of it is CJK
// (e.g. a Chinese master with a Vietnamese interpreter where Vietnamese narrowly won detection)
const MIXED_CJK_TRANSLATION_THRESHOLD = 0.15;

/**
 * Merge caller options over defaults. Keys explicitly set to `undefined` (as the
 * controller does for fields missing in the request) must not clobber defaults,
 * and audioTranscriptionOptions is merged one level deep.
 */
function mergeEnhancementOptions(
  options: Partial<EnhancementOptions> = {},
  overrides: Partial<EnhancementOptions> = {}
): EnhancementOptions {
  const provided = stripUndefined(options);
  return {
    ...DEFAULT_ENHANCEMENT_OPTIONS,
    ...provided,
    ...overrides,
    audioTranscriptionOptions: {
      ...DEFAULT_ENHANCEMENT_OPTIONS.audioTranscriptionOptions,
      ...stripUndefined(provided.audioTranscriptionOptions)
    }
  };
}

/**
 * Main function to enhance video metadata using combined approach
 * Priority: Transcript-based enhancement -> Metadata-based enhancement
 */
export async function enhanceVideoMetadata(
  videoInfo: YtDlpVideoInfo,
  youtubeUrl: string,
  videoFilePath?: string,
  options: Partial<EnhancementOptions> = {}
): Promise<EnhancedVideoMetadata> {
  const startTime = Date.now();
  const fullOptions = mergeEnhancementOptions(options);

  console.log(`🚀 Starting video metadata enhancement for: ${videoInfo.title}`);
  console.log(`🔧 Enhancement options:`, {
    useAudioTranscription: fullOptions.useAudioTranscription,
    forceAudioTranscription: fullOptions.forceAudioTranscription,
    hasVideoFile: !!videoFilePath,
    audioTranscriptionAvailable: isAudioTranscriptionAvailable()
  });

  // Blackboard OCR needs only the video file + the vision LLM, not Speech-to-Text: run it up front so
  // its result reaches the client whichever enhancement path produces the metadata.
  let ocr: BoardOcrOutcome | undefined;
  try {
    if (fullOptions.useAudioTranscription && videoFilePath) {
      ocr = await runBoardOcr(videoFilePath, fullOptions);
    }

    // Step 1: Try audio transcription if enabled and video file is available
    if (fullOptions.useAudioTranscription && videoFilePath && isAudioTranscriptionAvailable()) {
      console.log('🎵 Attempting audio transcription-based enhancement...');
      const audioResult = await tryAudioTranscriptionBasedEnhancement(
        videoInfo,
        videoFilePath,
        fullOptions,
        youtubeUrl,
        ocr
      );

      if (audioResult) {
        console.log('✅ Successfully enhanced using audio transcription');
        return {
          ...audioResult,
          ...boardFields(ocr),
          processingTime: Date.now() - startTime
        } as EnhancedVideoMetadata;
      } else {
        console.log('❌ Audio transcription failed, will try other methods');
      }
    } else {
      console.log('⏭️ Skipping audio transcription:', {
        useAudioTranscription: fullOptions.useAudioTranscription,
        hasVideoFile: !!videoFilePath,
        audioTranscriptionAvailable: isAudioTranscriptionAvailable()
      });
    }

    // Step 2: Try transcript-based enhancement (skip if forcing audio transcription)
    if (!fullOptions.forceAudioTranscription) {
      const transcriptResult = await tryTranscriptBasedEnhancement(
        videoInfo,
        youtubeUrl,
        fullOptions
      );

      if (transcriptResult) {
        console.log('✅ Successfully enhanced using transcript-based approach');
        return {
          ...transcriptResult,
          ...boardFields(ocr),
          processingTime: Date.now() - startTime
        } as EnhancedVideoMetadata;
      }
    } else {
      console.log('⏭️ Skipping transcript-based enhancement (force audio transcription enabled)');
    }

    // Step 3: Fallback to metadata-based enhancement
    console.log('📋 Falling back to metadata-based enhancement');
    const metadataResult = await metadataBasedEnhancement(videoInfo, fullOptions);

    return {
      ...metadataResult,
      ...boardFields(ocr),
      processingTime: Date.now() - startTime
    };

  } catch (error) {
    console.error('❌ Error in video metadata enhancement:', error);

    // Return basic enhanced metadata as final fallback
    return { ...createFallbackMetadata(videoInfo, Date.now() - startTime), ...boardFields(ocr) };
  }
}

interface BoardOcrOutcome {
  board?: BoardOcrResult;
  /** Why no board text is available (skipped / failed / nothing found); undefined when text was read. */
  status?: string;
}

/**
 * Blackboard OCR for possibly-Chinese audio (language 'auto' or Chinese). Never throws; the
 * reason for skipping or failing is returned as `status` so the client can show it.
 */
async function runBoardOcr(videoFilePath: string, options: EnhancementOptions): Promise<BoardOcrOutcome> {
  const requestedLanguage = options.audioTranscriptionOptions?.languageCode || AUTO_LANGUAGE;
  const couldBeChinese = requestedLanguage === AUTO_LANGUAGE || isChineseLanguage(requestedLanguage);
  if (options.boardOcr === false) {
    console.log('⏭️ Blackboard OCR disabled');
    return { status: 'disabled' };
  }
  if (!couldBeChinese) {
    console.log(`⏭️ Blackboard OCR not needed for ${requestedLanguage}`);
    return { status: `not needed for ${requestedLanguage}` };
  }
  try {
    console.log('🖍️ Reading Chinese text on the blackboard...');
    const board = await extractBoardText(videoFilePath, {
      languageCode: isChineseLanguage(requestedLanguage) ? requestedLanguage : undefined
    });
    if (board.skippedReason) {
      console.log(`⏭️ Blackboard OCR skipped: ${board.skippedReason}`);
      return { board, status: board.skippedReason };
    }
    console.log(`🖍️ Blackboard OCR: ${board.items.length} text item(s), ${board.terms.length} term(s) from ${board.framesAnalysed} frame(s)`);
    return {
      board,
      status: board.items.length > 0 ? undefined : `no Chinese text found on the board (${board.framesAnalysed} frame(s) analysed)`
    };
  } catch (ocrError: any) {
    const message = ocrError?.message || String(ocrError);
    console.warn('⚠️ Blackboard OCR failed, continuing without it:', message);
    return { status: `OCR failed: ${message}` };
  }
}

/** Board fields for the response (undefined values are dropped by JSON serialisation). */
function boardFields(ocr: BoardOcrOutcome | undefined): Partial<EnhancedVideoMetadata> {
  if (!ocr) return {};
  return {
    boardText: ocr.board?.items?.length ? ocr.board.items : undefined,
    boardTerms: ocr.board?.terms?.length ? ocr.board.terms : undefined,
    boardOcrStatus: ocr.status
  };
}

const TRANSCRIPTION_FAILED_MARKER_RE = /\[TRANSCRIPTION_FAILED\]/g;

/** Text for downstream LLM / embedding use: failure markers removed, spacing tidied. */
function withoutFailureMarkers(text: string): string {
  return text.replace(TRANSCRIPTION_FAILED_MARKER_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

export type ContentDomain = 'tcm' | 'buddhist' | 'generic';

/**
 * Domain tags (see client/src/constants/domains.ts) that mark Đông y content. Matched as
 * substrings of the NFC-normalised, lower-cased tag, so phrases are kept specific enough not
 * to catch unrelated free-form tags sent through the API (e.g. bare 'bản thảo' also means
 * "draft", bare 'thương hàn' usually means typhoid).
 */
const TCM_DOMAIN_RE = new RegExp([
  // general
  'đông y', 'y học cổ truyền', '\\btcm\\b', 'traditional chinese medicine', '中医', '中醫',
  // classics, teachers and schools
  'nội kinh', 'y tông', 'hải thượng', 'lê hữu trác', 'y quán',
  'ni hải hạ', 'nghê hải hạ', '倪海厦', '倪海廈',
  // subjects
  'châm cứu', 'bài thuốc cổ phương', 'kinh phương', 'thương hàn luận', 'kim quỹ',
  'dược liệu', 'bản thảo kinh', 'bản thảo cương mục', 'thần nông bản thảo',
  // qigong / dưỡng sinh
  'khí công', 'dịch cân kinh', 'bát đoạn cẩm', 'ngũ cầm hí',
].join('|'), 'i');
/** Cosmology tags shared by Đông y and other traditions: count as TCM only without a Buddhist tag. */
const TCM_WEAK_DOMAIN_RE = /âm dương|ngũ hành/i;
const BUDDHIST_DOMAIN_RE = /phật|thiền|buddh|thích nhất hạnh|viên minh|佛|禅|禪/i;

/**
 * Subject domain of the content, from the caller's knowledge domains:
 * a TCM tag wins, then a Buddhist tag, then the shared cosmology tags (âm dương / ngũ hành).
 * Chinese audio with no matching tag defaults to Đông y (TCM).
 * languageCode undefined = not known yet (before transcription).
 */
export function resolveContentDomain(domains: string[] | undefined, languageCode?: string): ContentDomain {
  const list = (domains || []).map(d => String(d).normalize('NFC').trim().toLowerCase());
  if (list.some(d => TCM_DOMAIN_RE.test(d))) return 'tcm';
  if (list.some(d => BUDDHIST_DOMAIN_RE.test(d))) return 'buddhist';
  if (list.some(d => TCM_WEAK_DOMAIN_RE.test(d))) return 'tcm';
  return languageCode === undefined || isChineseLanguage(languageCode) ? 'tcm' : 'generic';
}

/**
 * Try to enhance metadata using audio transcription.
 *
 * Pipeline: (1) blackboard OCR (video, possibly-Chinese audio) -> (2) Speech-to-Text with
 * board terms as phrase hints -> (3) Đông y term correction (Chinese) -> (4) optional LLM
 * cleaning ('none' = verbatim) -> (5) optional translation -> (6) metadata + embedding.
 */
async function tryAudioTranscriptionBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  videoFilePath: string,
  options: EnhancementOptions,
  youtubeUrl?: string,
  ocr?: BoardOcrOutcome
): Promise<Partial<EnhancedVideoMetadata> | null> {
  try {
    console.log('🎤 Attempting audio transcription-based enhancement...');
    console.log(`📁 Video file path: ${videoFilePath}`);
    console.log(`🔧 Audio transcription options:`, options.audioTranscriptionOptions);

    const transcriptionOptions: Partial<AudioTranscriptionOptions> = { ...options.audioTranscriptionOptions };
    const preDomain = resolveContentDomain(options.domains);
    if (transcriptionOptions.domainHints === undefined && preDomain === 'buddhist') {
      transcriptionOptions.domainHints = 'none'; // Đông y hints would only hurt a Buddhist talk
    }

    // 1. Blackboard OCR (normally already run by the caller): the teacher writes the key terms
    // on the board - best evidence we have
    const board = (ocr ?? await runBoardOcr(videoFilePath, options)).board;
    const boardTerms = board?.terms?.length ? board.terms : undefined;

    // 2. Speech-to-Text; caller hints first, then board terms (the STT layer adds the glossary)
    const phraseHints = Array.from(new Set(
      [...(transcriptionOptions.phraseHints || []), ...(boardTerms || [])]
        .map(h => (typeof h === 'string' ? h.trim() : ''))
        .filter(Boolean)
    ));
    // Background text for engines that take context (Alibaba): caller text, then title / description
    const contextText = [transcriptionOptions.contextText, videoInfo.title, videoInfo.description?.slice(0, 1500)]
      .map(part => (typeof part === 'string' ? part.trim() : ''))
      .filter(Boolean)
      .join('\n');
    const transcriptionResult = await transcribeVideoFile(videoFilePath, {
      ...transcriptionOptions,
      phraseHints: phraseHints.length > 0 ? phraseHints : undefined,
      contextText: contextText || undefined
    });

    // Character threshold is language-agnostic via countWords (CJK characters count as words)
    const rawTranscript = transcriptionResult.transcript || '';
    const usableText = withoutFailureMarkers(rawTranscript);
    if (!usableText || (usableText.length < 100 && countWords(usableText) < 20)) {
      console.log('⚠️ Audio transcription too short or failed, skipping audio-based enhancement');
      return null;
    }

    console.log(
      `🎵 Audio transcription successful: ${transcriptionResult.wordCount} words, confidence: ` +
      `${(transcriptionResult.confidence * 100).toFixed(1)}%, engine: ${transcriptionResult.engine || 'v1'}` +
      `${transcriptionResult.model ? ` (${transcriptionResult.model})` : ''}`
    );

    // Original language as detected by Speech-to-Text (already script-checked there)
    const originalLanguageCode = normalizeLanguageCode(transcriptionResult.languageCode) || transcriptionResult.languageCode;
    const language = getLanguageName(originalLanguageCode);
    const isChinese = isChineseLanguage(originalLanguageCode);
    const contentDomain = resolveContentDomain(options.domains, originalLanguageCode);
    const targetLanguage = toBaseLanguage(options.targetLanguage) || DEFAULT_TARGET_LANGUAGE;
    const targetLanguageName = getLanguageName(targetLanguage);
    console.log(`🌐 Detected language from audio: ${language} (${originalLanguageCode}); domain: ${contentDomain}; target language: ${targetLanguageName}`);

    // 3. Đông y term correction on the raw Chinese transcript (proposals verified + applied in code)
    let correctedTranscript: string | undefined;
    let termCorrections: TermCorrection[] | undefined;
    if (isChinese && contentDomain === 'tcm' && options.domainCorrection !== false) {
      const correction = await correctDomainTerms(rawTranscript, {
        languageCode: originalLanguageCode,
        domain: 'tcm',
        boardTerms
      });
      termCorrections = correction.corrections;
      if (correction.applied > 0 && correction.text !== rawTranscript) {
        correctedTranscript = correction.text;
      }
    } else if (isChinese) {
      console.log(`⏭️ Domain-term correction ${options.domainCorrection === false ? 'disabled' : `skipped (domain: ${contentDomain})`}`);
    }
    const verbatimTranscript = correctedTranscript ?? rawTranscript;

    // Translate when the original language differs from the target, or when the target is not
    // CJK but a substantial share of the transcript is (mixed Chinese + interpreter audio where
    // the target language narrowly won detection).
    const translationSourceCode = resolveTranslationSourceCode(originalLanguageCode, targetLanguage, usableText);
    const needsTranslation = options.translateTranscript === true && !!translationSourceCode;
    if (translationSourceCode && !isSameLanguage(translationSourceCode, originalLanguageCode)) {
      console.log(
        `🌐 Transcript is mainly ${language} but ${(cjkRatio(usableText) * 100).toFixed(0)}% CJK; ` +
        `the ${getLanguageName(translationSourceCode)} passages will be translated too`
      );
    }

    // 4. Cleaning IN THE ORIGINAL LANGUAGE. Chinese defaults to verbatim ('none') unless the
    // caller explicitly asked for a level. Faithful cleaning when the result will be translated.
    const cleaningLevel: TranscriptCleaningLevel = options.transcriptCleaningLevel
      ?? (isChinese ? DEFAULT_CHINESE_CLEANING_LEVEL : DEFAULT_CLEANING_LEVEL);
    let enhancedTranscript: string;
    if (cleaningLevel === 'none') {
      console.log('📜 Cleaning level "none": keeping the verbatim transcript (no LLM rewrite)');
      enhancedTranscript = verbatimTranscript;
    } else {
      console.log(`🔧 Enhancing transcript with LLM (${cleaningLevel} mode${needsTranslation ? ', faithful' : ''}, ${language})...`);
      enhancedTranscript = await enhanceTranscriptWithLLM(
        verbatimTranscript,
        language,
        videoInfo,
        cleaningLevel,
        needsTranslation,
        isChinese && contentDomain === 'tcm'
      );
    }
    const enhancedForDownstream = withoutFailureMarkers(enhancedTranscript) || usableText;

    // 5. Optional translation (domain-aware)
    let translatedTranscript: string | undefined;
    let translationPartial: boolean | undefined;
    if (needsTranslation && translationSourceCode) {
      console.log(`🌍 Translating transcript ${getLanguageName(translationSourceCode)} → ${targetLanguageName} (${contentDomain})...`);
      const translation = await translateTranscriptWithLLM(
        enhancedForDownstream,
        translationSourceCode,
        targetLanguage,
        videoInfo,
        resolveContentDomain(options.domains, translationSourceCode)
      );
      translatedTranscript = translation.text;
      translationPartial = translation.partial || undefined;
      if (translatedTranscript) {
        console.log(
          `✅ Translation ${translation.partial ? 'partially ' : ''}completed: ` +
          `${translation.failedSegments}/${translation.totalSegments} segment(s) failed`
        );
      } else {
        console.warn('⚠️ Translation unavailable; metadata and embedding will use the original-language transcript');
      }
    } else if (options.translateTranscript !== true) {
      console.log('⏭️ Transcript translation disabled');
    } else {
      console.log(`⏭️ Original language is already ${targetLanguageName}, no translation needed`);
    }

    // 6. Metadata in the target language, from the translation when available
    const metadataSource = translatedTranscript || enhancedForDownstream;
    // A metadata failure (LLM quota / billing / bad output) must not throw away the transcript,
    // which is the expensive part and the main deliverable: fall back to the video's own metadata.
    let enhanced: Partial<EnhancedVideoMetadata> = {};
    try {
      enhanced = await generateTranscriptBasedMetadata(
        videoInfo,
        metadataSource,
        targetLanguageName,
        options,
        translatedTranscript ? targetLanguageName : language
      );
    } catch (metadataError: any) {
      console.warn('⚠️ Metadata generation failed, keeping the transcript with the original video metadata:', metadataError?.message || metadataError);
    }

    // Higher confidence for audio transcription as it's from actual content
    // (not for Chirp's nominal placeholder, which is no recognizer score at all)
    const confidenceIsNominal = transcriptionResult.confidenceIsNominal === true;
    const confidence = confidenceIsNominal
      ? transcriptionResult.confidence
      : Math.min(0.95, transcriptionResult.confidence + 0.1);

    // Process audio transcript for embedding if enabled
    if (options.embedAudioTranscript) {
      try {
        console.log('🔗 Processing audio transcript for embedding...');
        const videoId = youtubeUrl ? extractVideoIdFromUrl(youtubeUrl) : videoInfo.videoId;
        if (videoId) {
          // Embed the target-language text so searches in Vietnamese work
          const embeddingResult = await processAudioTranscript(
            withoutFailureMarkers(verbatimTranscript),
            translatedTranscript ?? enhancedForDownstream,
            {
              videoId,
              videoTitle: videoInfo.title,
              videoUrl: youtubeUrl || `https://www.youtube.com/watch?v=${videoInfo.videoId}`,
              domains: options.domains || ['youtube', 'audio'],
              originalLanguageCode: translatedTranscript && translationSourceCode ? translationSourceCode : originalLanguageCode,
              isTranslation: !!translatedTranscript
            }
          );
          console.log(`✅ Audio transcript embedded: ${embeddingResult.totalChunks} chunks created`);
        } else {
          console.warn('⚠️ Could not extract video ID for embedding');
        }
      } catch (embeddingError) {
        console.error('❌ Failed to embed audio transcript:', embeddingError);
        // Don't fail the entire process if embedding fails
      }
    }

    return {
      originalMetadata: videoInfo,
      enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
      enhancedSummary: enhanced.enhancedSummary || videoInfo.description || `Video by ${videoInfo.uploader}`,
      contentBasedTitle: enhanced.contentBasedTitle,
      contentBasedSummary: enhanced.contentBasedSummary,
      keyTopics: enhanced.keyTopics || [],
      contentTags: enhanced.contentTags || [],
      keyQuotes: enhanced.keyQuotes,
      enhancementSource: 'transcript' as const, // Audio transcription is still transcript-based
      language, // Original language name
      confidence,
      confidenceIsNominal: confidenceIsNominal || undefined,
      audioTranscript: rawTranscript, // Raw transcript (original language)
      correctedTranscript, // Raw transcript with domain terms fixed (only when something was fixed)
      termCorrections,
      enhancedTranscript, // Verbatim ('none') or LLM-cleaned transcript (original language)
      transcriptWordCount: transcriptionResult.wordCount, // Include word count
      originalLanguageCode,
      originalLanguage: language,
      translatedTranscript,
      translationLanguage: translatedTranscript ? targetLanguage : undefined,
      translationPartial,
      boardText: board?.items?.length ? board.items : undefined,
      boardTerms,
      boardOcrStatus: ocr?.status,
      transcriptionEngine: transcriptionResult.engine,
      transcriptionModel: transcriptionResult.model
    };

  } catch (error: any) {
    console.log('⚠️ Audio transcription-based enhancement failed:', error.message);
    console.log('🔍 Full error details:', error);
    console.log('📊 Error stack:', error.stack);
    return null;
  }
}

/**
 * Try to enhance metadata using transcript content
 */
async function tryTranscriptBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  youtubeUrl: string,
  options: EnhancementOptions
): Promise<Partial<EnhancedVideoMetadata> | null> {
  try {
    console.log('🎬 Attempting transcript-based enhancement...');
    
    // Try to get transcript
    const transcript = await getTranscriptFromPublicApi(videoInfo.videoId);
    
    if (!transcript || transcript.trim().length < 100) {
      console.log('⚠️ Transcript too short or unavailable, skipping transcript-based enhancement');
      return null;
    }

    console.log(`📝 Transcript available (${transcript.length} characters), proceeding with transcript-based enhancement`);

    // Detect the transcript language; metadata is generated in the target language
    const language = detectLanguageFromText(transcript);
    const targetLanguageName = getLanguageName(toBaseLanguage(options.targetLanguage) || DEFAULT_TARGET_LANGUAGE);
    console.log(`🌐 Detected language: ${language}; generating metadata in ${targetLanguageName}`);

    // Generate enhanced metadata using transcript
    const enhanced = await generateTranscriptBasedMetadata(
      videoInfo,
      transcript,
      targetLanguageName,
      options,
      language
    );

    return {
      originalMetadata: videoInfo,
      enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
      enhancedSummary: enhanced.enhancedSummary || videoInfo.description || `Video by ${videoInfo.uploader}`,
      contentBasedTitle: enhanced.contentBasedTitle,
      contentBasedSummary: enhanced.contentBasedSummary,
      keyTopics: enhanced.keyTopics || [],
      contentTags: enhanced.contentTags || [],
      keyQuotes: enhanced.keyQuotes,
      enhancementSource: 'transcript' as const,
      language,
      confidence: 0.9
    };

  } catch (error: any) {
    console.log('⚠️ Transcript-based enhancement failed:', error.message);
    return null;
  }
}

/**
 * Enhance metadata using only yt-dlp metadata (fallback approach)
 */
async function metadataBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  options: EnhancementOptions
): Promise<EnhancedVideoMetadata> {
  console.log('📊 Performing metadata-based enhancement...');

  // Detect language from title and description; metadata is generated in the target language
  const language = detectLanguageFromText(videoInfo.title + ' ' + videoInfo.description);
  const targetLanguageName = getLanguageName(toBaseLanguage(options.targetLanguage) || DEFAULT_TARGET_LANGUAGE);

  // Generate enhanced metadata using only available metadata
  const enhanced = await generateMetadataBasedEnhancement(
    videoInfo,
    targetLanguageName,
    options
  );

  // Lower confidence for metadata-only enhancement, especially if description is poor
  const hasGoodDescription = videoInfo.description && videoInfo.description.length > 50;
  const confidence = hasGoodDescription ? 0.4 : 0.2; // Reduced from 0.6

  return {
    originalMetadata: videoInfo,
    enhancedTitle: enhanced.enhancedTitle || videoInfo.title,
    enhancedSummary: enhanced.enhancedSummary || `Video by ${videoInfo.uploader}. Limited information available from metadata only.`,
    keyTopics: enhanced.keyTopics || [],
    contentTags: enhanced.contentTags || [],
    enhancementSource: 'metadata' as const,
    language,
    confidence,
    processingTime: 0 // Will be set by the caller
  };
}

/**
 * Generate enhanced metadata using transcript content
 */
async function generateTranscriptBasedMetadata(
  videoInfo: YtDlpVideoInfo,
  transcript: string,
  language: string,
  options: EnhancementOptions,
  transcriptLanguage?: string // Language the transcript is written in, when it differs from `language`
): Promise<Partial<EnhancedVideoMetadata>> {
  if (!isLlmConfigured('fast')) {
    throw new Error('DASHSCOPE_API_KEY is required for transcript-based enhancement');
  }

  // Truncate transcript if too long (keep first 8000 chars for context)
  const transcriptSample = transcript.length > 8000 
    ? transcript.substring(0, 8000) + "..." 
    : transcript;

  const prompt = buildTranscriptEnhancementPrompt(
    videoInfo,
    transcriptSample,
    language,
    options,
    transcriptLanguage
  );

  const responseText = await generateText({
    prompt,
    task: 'fast',
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens
  });
  return parseEnhancementResponse(responseText, 'transcript');
}

/**
 * Generate enhanced metadata using only video metadata
 */
async function generateMetadataBasedEnhancement(
  videoInfo: YtDlpVideoInfo,
  language: string,
  options: EnhancementOptions
): Promise<Partial<EnhancedVideoMetadata>> {
  if (!isLlmConfigured('fast')) {
    throw new Error('DASHSCOPE_API_KEY is required for metadata-based enhancement');
  }

  const prompt = buildMetadataEnhancementPrompt(videoInfo, language, options);

  const responseText = await generateText({
    prompt,
    task: 'fast',
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens
  });
  return parseEnhancementResponse(responseText, 'metadata');
}

/**
 * Build prompt for transcript-based enhancement
 */
function buildTranscriptEnhancementPrompt(
  videoInfo: YtDlpVideoInfo,
  transcript: string,
  language: string,
  options: EnhancementOptions,
  transcriptLanguage?: string
): string {
  const languageNote = transcriptLanguage && transcriptLanguage !== language
    ? `\nNOTE: The transcript below is in ${transcriptLanguage}. Write ALL generated fields in ${language} (key quotes translated into ${language}).\n`
    : '';
  return `You are analyzing a YouTube video with both metadata and transcript content. Generate enhanced metadata in ${language}.
${languageNote}
VIDEO METADATA:
- Original Title: ${videoInfo.title}
- Description: ${videoInfo.description}
- Duration: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}
- Uploader: ${videoInfo.uploader}
- Upload Date: ${videoInfo.uploadDate}

TRANSCRIPT CONTENT:
${transcript}

Please generate the following in ${language}:

1. ENHANCED_TITLE: A more descriptive and engaging title (max 80 characters)
2. ENHANCED_SUMMARY: A comprehensive summary of the video content (max 300 words)
3. CONTENT_TITLE: A title based purely on the actual content discussed (max 80 characters)
4. CONTENT_SUMMARY: A summary of the key points from the transcript (max 200 words)
5. KEY_TOPICS: ${options.maxKeyTopics} main topics/themes (comma-separated)
6. CONTENT_TAGS: ${options.maxContentTags} relevant tags for categorization (comma-separated)
${options.includeKeyQuotes ? '7. KEY_QUOTES: 3-5 important quotes or statements from the video (one per line)' : ''}

Format your response exactly as:
ENHANCED_TITLE: [title]
ENHANCED_SUMMARY: [summary]
CONTENT_TITLE: [content-based title]
CONTENT_SUMMARY: [content-based summary]
KEY_TOPICS: [topic1, topic2, topic3, ...]
CONTENT_TAGS: [tag1, tag2, tag3, ...]
${options.includeKeyQuotes ? 'KEY_QUOTES:\n- [quote1]\n- [quote2]\n- [quote3]' : ''}`;
}

/**
 * Build prompt for metadata-only enhancement
 */
function buildMetadataEnhancementPrompt(
  videoInfo: YtDlpVideoInfo,
  language: string,
  options: EnhancementOptions
): string {
  return `You are analyzing YouTube video metadata to generate enhanced descriptions. Generate all content in ${language}.

IMPORTANT: You only have access to basic metadata (title, description, uploader). DO NOT invent or assume specific content details that are not explicitly mentioned in the metadata. If information is unclear, acknowledge the limitation.

VIDEO METADATA:
- Title: ${videoInfo.title}
- Description: ${videoInfo.description}
- Duration: ${Math.floor(videoInfo.duration / 60)}:${(videoInfo.duration % 60).toString().padStart(2, '0')}
- Uploader: ${videoInfo.uploader}
- Upload Date: ${videoInfo.uploadDate}
- View Count: ${videoInfo.viewCount.toLocaleString()}

Please generate the following in ${language}, based ONLY on the provided metadata:

1. ENHANCED_TITLE: A clearer version of the title without adding unverified details (max 80 characters)
2. ENHANCED_SUMMARY: A summary based strictly on available metadata, acknowledging limitations (max 200 words)
3. KEY_TOPICS: ${options.maxKeyTopics} topics that can be reasonably inferred from title and description only (comma-separated)
4. CONTENT_TAGS: ${options.maxContentTags} tags based on explicit metadata only (comma-separated)

If the metadata is insufficient to determine specific content, mention this limitation in your summary.

Format your response exactly as:
ENHANCED_TITLE: [title]
ENHANCED_SUMMARY: [summary]
KEY_TOPICS: [topic1, topic2, topic3, ...]
CONTENT_TAGS: [tag1, tag2, tag3, ...]`;
}

/**
 * Parse the AI response and extract structured data
 */
function parseEnhancementResponse(
  responseText: string,
  source: 'transcript' | 'metadata'
): Partial<EnhancedVideoMetadata> {
  const result: Partial<EnhancedVideoMetadata> = {
    keyTopics: [],
    contentTags: [],
    keyQuotes: []
  };

  // Extract enhanced title
  const enhancedTitleMatch = responseText.match(/ENHANCED_TITLE:\s*(.*?)(?=\n|$)/i);
  if (enhancedTitleMatch) {
    result.enhancedTitle = enhancedTitleMatch[1].trim();
  }

  // Extract enhanced summary
  const enhancedSummaryMatch = responseText.match(/ENHANCED_SUMMARY:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
  if (enhancedSummaryMatch) {
    result.enhancedSummary = enhancedSummaryMatch[1].trim();
  }

  // Extract content-based title (only for transcript source)
  if (source === 'transcript') {
    const contentTitleMatch = responseText.match(/CONTENT_TITLE:\s*(.*?)(?=\n|$)/i);
    if (contentTitleMatch) {
      result.contentBasedTitle = contentTitleMatch[1].trim();
    }

    const contentSummaryMatch = responseText.match(/CONTENT_SUMMARY:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
    if (contentSummaryMatch) {
      result.contentBasedSummary = contentSummaryMatch[1].trim();
    }
  }

  // Extract key topics
  const keyTopicsMatch = responseText.match(/KEY_TOPICS:\s*(.*?)(?=\n|$)/i);
  if (keyTopicsMatch) {
    result.keyTopics = keyTopicsMatch[1]
      .split(',')
      .map(topic => topic.trim())
      .filter(topic => topic.length > 0);
  }

  // Extract content tags
  const contentTagsMatch = responseText.match(/CONTENT_TAGS:\s*(.*?)(?=\n|$)/i);
  if (contentTagsMatch) {
    result.contentTags = contentTagsMatch[1]
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
  }

  // Extract key quotes (only for transcript source)
  if (source === 'transcript') {
    const keyQuotesMatch = responseText.match(/KEY_QUOTES:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/i);
    if (keyQuotesMatch) {
      result.keyQuotes = keyQuotesMatch[1]
        .split('\n')
        .map(quote => quote.replace(/^-\s*/, '').trim())
        .filter(quote => quote.length > 0);
    }
  }

  return result;
}

/**
 * Run fn over items with at most `limit` calls in flight; results keep input order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Rate-limit / overload errors (429 / 5xx) that outlasted llm-client's own retries and are worth one
 * more round after a longer backoff. Other retryable LlmErrors (timeout, network, empty or non-JSON
 * reply) have already been retried by llm-client, so they are not treated as transient here.
 */
function isTransientLlmError(error: any): boolean {
  if (error instanceof LlmError) {
    const status = Number(error.status);
    return error.retryable && (status === 429 || status >= 500 || /throttl|ServiceUnavailable|overload/i.test(error.code || ''));
  }
  const message = String(error?.message || '');
  const status = Number(error?.status ?? error?.code);
  return status === 408 || status === 429 || status >= 500 ||
    /\b(408|429|500|502|503|504)\b|Throttling|Too Many Requests|Service Unavailable|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

/**
 * Errors a retry cannot fix: billing (402 / Arrearage / credits depleted), invalid key (401),
 * permission (403), unknown model (404), bad request (400), content filter, oversized input,
 * LLM not configured. llm-client marks all of these non-retryable.
 */
function isFatalLlmError(error: any): boolean {
  return error instanceof LlmError && !error.retryable;
}

/**
 * Retryable LlmErrors other than 429 / 5xx (timeout, network, empty or non-JSON reply): llm-client
 * already made ALIBABA_LLM_MAX_RETRIES + 1 attempts, so another outer round would only multiply
 * billed requests (and, for timeouts, minutes of waiting).
 */
function isLlmRetriesExhausted(error: any): boolean {
  return error instanceof LlmError && error.retryable && !isTransientLlmError(error);
}

/**
 * One LLM call for a transcript segment. llm-client already retries each request with backoff
 * (honouring Retry-After). On top of that, an ordinary failure (e.g. truncated output) is retried
 * once after a short delay, and a rate-limit / overload error (429 / 5xx) that outlasted the client
 * retries is retried with a longer exponential backoff + jitter. Billing / auth / bad-request errors,
 * and timeouts / empty replies that llm-client already retried, stop at once. A truncated (finish_reason=length) or empty answer counts as a failure so we never keep
 * half a segment silently.
 */
async function generateSegmentText(prompt: string, temperature: number, label: string): Promise<string> {
  let lastError: any;
  let ordinaryFailures = 0;
  for (let attempt = 1; attempt <= SEGMENT_TRANSIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateChat({
        prompt,
        task: 'fast',
        temperature,
        maxOutputTokens: SEGMENT_MAX_OUTPUT_TOKENS
      });
      const finishReason = String(result.finishReason || '');
      if (finishReason === 'length') {
        throw new Error('output truncated (finish_reason=length)');
      }
      const text = result.text.trim();
      if (!text) {
        throw new Error(`empty response${finishReason ? ` (finish_reason=${finishReason})` : ''}`);
      }
      return text;
    } catch (error: any) {
      lastError = error;
      const fatal = isFatalLlmError(error);
      const exhausted = !fatal && isLlmRetriesExhausted(error);
      const transient = !fatal && !exhausted && isTransientLlmError(error);
      if (!transient) ordinaryFailures++;
      const canRetry = !fatal && !exhausted && attempt < SEGMENT_TRANSIENT_MAX_ATTEMPTS && (transient || ordinaryFailures < 2);
      console.warn(`⚠️ ${label} attempt ${attempt} failed${transient ? ' (rate limit / unavailable)' : fatal ? ' (not retryable)' : exhausted ? ' (already retried by llm-client)' : ''}: ${error.message}`);
      if (!canRetry) break;
      let delay = SEGMENT_RETRY_DELAY_MS;
      if (transient) {
        const backoff = Math.min(SEGMENT_TRANSIENT_MAX_DELAY_MS, SEGMENT_TRANSIENT_BASE_DELAY_MS * Math.pow(2, attempt - 1));
        delay = backoff + Math.floor(Math.random() * 1000);
        console.log(`⏳ ${label}: retrying in ${(delay / 1000).toFixed(1)}s`);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

/**
 * Source language to translate from, or undefined when no translation is needed:
 * the original language when it differs from the target; for a target-language
 * transcript with a substantial CJK share (mixed audio), the CJK language.
 */
function resolveTranslationSourceCode(originalLanguageCode: string, targetLanguage: string, text: string): string | undefined {
  if (!isSameLanguage(originalLanguageCode, targetLanguage)) return originalLanguageCode;
  const targetBase = toBaseLanguage(targetLanguage);
  const targetIsCjk = targetBase === 'zh' || targetBase === 'yue' || targetBase === 'ja' || targetBase === 'ko';
  if (targetIsCjk || cjkRatio(text) < MIXED_CJK_TRANSLATION_THRESHOLD) return undefined;
  const scripts = analyzeScripts(text);
  if (scripts.hangul > scripts.han + scripts.kana) return 'ko-KR';
  if (scripts.kana > 0 && scripts.kana / (scripts.han + scripts.kana) >= 0.15) return 'ja-JP';
  return 'cmn-Hans-CN';
}

function segmentSizeFor(text: string, sizes: { cjk: number; other: number }): number {
  return cjkRatio(text) >= 0.3 ? sizes.cjk : sizes.other;
}

function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
}

/**
 * Enhance raw transcript using LLM - fix grammar, slang, improve readability.
 * The output stays in the ORIGINAL language (no translation). Long transcripts
 * are processed in segments so nothing gets truncated; a failed segment falls
 * back to its raw text.
 */
async function enhanceTranscriptWithLLM(
  rawTranscript: string,
  language: string,
  videoInfo: YtDlpVideoInfo,
  cleaningLevel: 'basic' | 'aggressive' = 'aggressive',
  /** The result will be translated: never drop or condense content, only remove noise. */
  faithful = false,
  /** Đông y lecture whose domain terms were already verified: keep them exactly. */
  preserveDomainTerms = false
): Promise<string> {
  if (!isLlmConfigured('fast')) {
    console.log('⚠️ LLM not configured (DASHSCOPE_API_KEY), returning raw transcript');
    return rawTranscript;
  }

  try {
    const cleanInput = rawTranscript.replace(/\[TRANSCRIPTION_FAILED\]/g, ' ').replace(/[ \t]{2,}/g, ' ').trim();
    const segments = splitTextIntoSegments(cleanInput, segmentSizeFor(cleanInput, CLEANING_SEGMENT_CHARS));
    console.log(`🔧 Enhancing transcript with ${llmModelFor('fast')} in ${language} (${segments.length} segment(s))...`);

    const isAggressive = cleaningLevel === 'aggressive';
    const fillerHint = getFillerWordsHint(language);
    const chineseNote = isChineseLanguage(language)
      ? '\n- Keep the same Chinese script as the input (Simplified stays Simplified, Traditional stays Traditional) and use full-width Chinese punctuation (，。？！).'
      : '';
    const domainTermsNote = preserveDomainTerms
      ? '\n- This is a Traditional Chinese Medicine (中医) lecture. Its domain terms (herbs, formulas, acupoints, meridians, classics, syndromes) were already checked: keep every such term exactly as written, and keep all doses, numbers and units.'
      : '';

    const faithfulAggressiveInstructions = `
THOROUGH CLEANING (this transcript will be translated - it must stay COMPLETE) - Remove only:
1. Filler words and hesitation sounds, e.g. ${fillerHint}
2. False starts, stutters and immediate word repetitions
3. Channel promotion boilerplate (like, subscribe) unless it's main content

IMPROVEMENTS:
- Fix grammar and spelling errors and obvious speech-recognition mistakes
- Add proper punctuation and capitalization
- Improve sentence structure while preserving meaning
- Do NOT summarise, shorten or condense. Keep EVERY substantive sentence, including stories,
  examples, anecdotes, greetings and questions/answers`;

    const aggressiveInstructions = `
AGGRESSIVE CLEANING - Remove completely:
1. Filler words and hesitation sounds, e.g. ${fillerHint}
2. Profanity and inappropriate language
3. Unnecessary exclamations and interjections
4. Irrelevant small talk (greetings, weather, personal matters)
5. Channel promotion content (like, subscribe) unless it's main content
6. Off-topic conversations unrelated to main subject

IMPROVEMENTS:
- Fix grammar and spelling errors and obvious speech-recognition mistakes
- Replace slang with proper language
- Add proper punctuation and capitalization
- Improve sentence structure while preserving meaning
- Keep only core content directly related to main topic
- Make result concise and focused`;

    const basicInstructions = `
BASIC CLEANING:
- Fix grammar and spelling errors and obvious speech-recognition mistakes
- Replace slang with proper language
- Add proper punctuation and capitalization
- Remove basic filler words, e.g. ${fillerHint}
- Improve sentence structure while preserving meaning
- ${faithful ? 'Keep ALL of the original content - do not summarise or shorten' : 'Keep most of the original content'}`;

    let failedSegments = 0;
    const cleanedSegments = await mapWithConcurrency(segments, SEGMENT_CONCURRENCY, async (segment, index) => {
      const prompt = `You are a professional transcript editor. Clean and improve this raw speech-to-text transcript${segments.length > 1 ? ` (segment ${index + 1} of ${segments.length}; continue seamlessly, no introduction or conclusion)` : ''}.

LANGUAGE (MANDATORY):
- The transcript is mainly in ${language} and may contain passages in other languages (e.g. an interpreter).
- Keep every sentence in the language it was spoken in. Do NOT translate anything (not into Vietnamese, not into English, not into ${language}).${chineseNote}${domainTermsNote}

VIDEO CONTEXT:
- Title: ${videoInfo.title}
- Channel: ${videoInfo.uploader}
- Duration: ${formatDuration(videoInfo.duration)}
${isAggressive ? (faithful ? faithfulAggressiveInstructions : aggressiveInstructions) : basicInstructions}

OUTPUT: Return ONLY the cleaned transcript text, in its original language(s) - no headings, labels, notes or commentary.

RAW TRANSCRIPT:
${segment}`;

      try {
        return await generateSegmentText(prompt, 0.2, `Cleaning segment ${index + 1}/${segments.length}`);
      } catch (error: any) {
        failedSegments++;
        console.error(`❌ Cleaning segment ${index + 1}/${segments.length} failed, keeping raw text: ${error.message}`);
        return segment;
      }
    });

    const enhancedTranscript = cleanedSegments.join('\n\n').trim();
    console.log(`✅ Transcript enhanced (${segments.length - failedSegments}/${segments.length} segment(s) cleaned)`);

    return enhancedTranscript || rawTranscript;

  } catch (error: any) {
    console.error('❌ Transcript enhancement failed:', error.message);
    console.log('⚠️ Returning raw transcript as fallback');
    return rawTranscript;
  }
}

interface TranscriptTranslationResult {
  /** Full translation; undefined when no segment could be translated. */
  text?: string;
  partial: boolean;
  totalSegments: number;
  failedSegments: number;
}

const MAX_HAN_VIET_TERMS_PER_SEGMENT = 80;

/** Glossary pairs whose Chinese term occurs in the segment; a term inside a longer listed one is skipped. */
function hanVietTermsInSegment(
  segment: string,
  pairsLongestFirst: Array<{ zh: string; vi: string }>
): Array<{ zh: string; vi: string }> {
  const found: Array<{ zh: string; vi: string }> = [];
  for (const pair of pairsLongestFirst) {
    if (found.length >= MAX_HAN_VIET_TERMS_PER_SEGMENT) break;
    if (!pair.zh || !segment.includes(pair.zh)) continue;
    if (found.some(f => f.zh.includes(pair.zh))) continue;
    found.push(pair);
  }
  return found;
}

/** Translator role + terminology rules for the content domain. */
function buildTranslationDomainProfile(
  domain: ContentDomain,
  sourceName: string,
  targetName: string,
  chineseToVietnamese: boolean
): { speciality: string; terminologyRule: string; notes: string } {
  if (domain === 'tcm') {
    return {
      speciality: 'Traditional Chinese Medicine (中医 / Đông y) lectures',
      terminologyRule: 'Keep Traditional Chinese Medicine terminology (herbs, formulas, acupoints, meridians, classics, syndromes, pulses, theory) accurate and consistent. Keep every dose, number and unit exactly.',
      notes: chineseToVietnamese
        ? `
- Use the established Sino-Vietnamese (Hán-Việt) names used in Vietnamese Đông y, e.g. 当归 → Đương quy, 黄芪 → Hoàng kỳ, 脾虚 → Tỳ hư, 足三里 → Túc tam lý, 伤寒论 → Thương hàn luận, 黄帝内经 → Hoàng đế nội kinh, 气血 → khí huyết, 阴阳 → âm dương, 肝郁 → can uất, 辨证论治 → biện chứng luận trị.
- Herb, formula, acupoint and book names: Hán-Việt reading only (capitalised as a name); do not add the Chinese characters or explanations.
- Chinese personal names: customary Hán-Việt reading.`
        : ''
    };
  }
  if (domain === 'buddhist') {
    return {
      speciality: 'spoken lectures and Buddhist teachings',
      terminologyRule: 'Keep Buddhist, philosophical and technical terminology accurate and consistent.',
      notes: chineseToVietnamese
        ? `
- For Chinese Buddhist / religious vocabulary use the established Sino-Vietnamese (Hán-Việt) terms, e.g. 菩萨 → Bồ Tát, 般若 → Bát-nhã, 涅槃 → Niết bàn, 阿弥陀佛 → A Di Đà Phật, 因缘 → nhân duyên, 功德 → công đức, 法师 → Pháp sư, 念佛 → niệm Phật, 净土 → Tịnh độ, 烦恼 → phiền não, 众生 → chúng sinh, 经 → Kinh.
- Chinese personal names, temple names and sutra titles: use their customary Hán-Việt reading.`
        : ''
    };
  }
  return {
    speciality: `spoken ${sourceName} lectures`,
    terminologyRule: `Keep technical terminology accurate and consistent; use the established ${targetName} term when one exists.`,
    notes: chineseToVietnamese
      ? `
- Chinese personal names, place names, book titles and established technical terms: use their customary Sino-Vietnamese (Hán-Việt) reading.`
      : ''
  };
}

/**
 * Faithfully translate a (cleaned) transcript into the target language, segment by
 * segment on sentence boundaries. A segment that still fails after one retry is kept
 * in the original language behind a marker, and the result is flagged as partial.
 */
async function translateTranscriptWithLLM(
  transcript: string,
  sourceLanguageCode: string,
  targetLanguage: string,
  videoInfo: YtDlpVideoInfo,
  domain: ContentDomain = 'generic'
): Promise<TranscriptTranslationResult> {
  const sourceName = getLanguageName(sourceLanguageCode);
  const targetName = getLanguageName(targetLanguage);

  if (!isLlmConfigured('fast')) {
    console.log('⚠️ LLM not configured (DASHSCOPE_API_KEY), skipping transcript translation');
    return { text: undefined, partial: true, totalSegments: 0, failedSegments: 0 };
  }

  const segments = splitTextIntoSegments(transcript, segmentSizeFor(transcript, TRANSLATION_SEGMENT_CHARS));
  if (segments.length === 0) {
    return { text: undefined, partial: false, totalSegments: 0, failedSegments: 0 };
  }
  console.log(`🌍 Translating ${segments.length} segment(s) ${sourceName} → ${targetName} with ${llmModelFor('fast')}`);

  const chineseToVietnamese = isChineseLanguage(sourceLanguageCode) && isSameLanguage(targetLanguage, 'vi');
  // Hán-Việt readings for the Đông y terms that actually occur, per segment (keeps prompts small)
  const hanVietPairs = domain === 'tcm' && chineseToVietnamese
    ? getTcmHanVietPairs(scriptForLanguageCode(sourceLanguageCode)).sort((a, b) => b.zh.length - a.zh.length)
    : [];
  const domainProfile = buildTranslationDomainProfile(domain, sourceName, targetName, chineseToVietnamese);

  const failedMarker = isSameLanguage(targetLanguage, 'vi')
    ? '[⚠️ Đoạn này chưa dịch được – giữ nguyên văn]'
    : '[⚠️ Translation failed for this segment – original text kept]';

  let failedSegments = 0;
  const translatedSegments = await mapWithConcurrency(segments, SEGMENT_CONCURRENCY, async (segment, index) => {
    const segmentTerms = hanVietPairs.length > 0 ? hanVietTermsInSegment(segment, hanVietPairs) : [];
    const termList = segmentTerms.length > 0
      ? `\n- Đông y terms in this segment (use these Vietnamese readings): ${segmentTerms.map(p => `${p.zh} → ${p.vi}`).join('; ')}.`
      : '';
    const prompt = `You are a professional ${sourceName}-${targetName} translator specialised in ${domainProfile.speciality}.
Translate the following ${sourceName} transcript${segments.length > 1 ? ` (segment ${index + 1} of ${segments.length} of one continuous talk)` : ''} into ${targetName}.

VIDEO CONTEXT:
- Title: ${videoInfo.title}
- Channel: ${videoInfo.uploader}

RULES:
- Translate faithfully and COMPLETELY, sentence by sentence. Do NOT summarise, shorten, omit, or add explanations.
- Preserve the meaning, tone and the speaker's voice; write natural, fluent ${targetName}.
- Keep paragraph breaks.
- ${domainProfile.terminologyRule}${domainProfile.notes}${termList}
- If some sentences are already in ${targetName}, keep them as they are.
- If a phrase looks like a speech-recognition error, translate the most plausible intended meaning; never invent content.
- Output ONLY the ${targetName} translation - no headings, notes, the original text, or quotation marks around it.

${sourceName.toUpperCase()} TEXT:
${segment}`;

    try {
      return await generateSegmentText(prompt, 0.2, `Translation segment ${index + 1}/${segments.length}`);
    } catch (error: any) {
      failedSegments++;
      console.error(`❌ Translation segment ${index + 1}/${segments.length} failed, keeping original text: ${error.message}`);
      return `${failedMarker}\n${segment}`;
    }
  });

  if (failedSegments === segments.length) {
    console.error('❌ All translation segments failed');
    return { text: undefined, partial: true, totalSegments: segments.length, failedSegments };
  }

  return {
    text: translatedSegments.join('\n\n').trim(),
    partial: failedSegments > 0,
    totalSegments: segments.length,
    failedSegments
  };
}

/**
 * Audio-only enhancement - ONLY uses audio transcription, no fallbacks
 */
export async function enhanceVideoMetadataAudioOnly(
  videoInfo: YtDlpVideoInfo,
  videoFilePath: string,
  options: Partial<EnhancementOptions> = {},
  youtubeUrl?: string
): Promise<EnhancedVideoMetadata> {
  const startTime = Date.now();
  const fullOptions = mergeEnhancementOptions(options, {
    useAudioTranscription: true,
    forceAudioTranscription: true
  });

  console.log(`🎵 AUDIO-ONLY enhancement for: ${videoInfo.title}`);
  console.log(`📁 Video file: ${videoFilePath}`);

  if (!isAudioTranscriptionAvailable()) {
    throw new Error('Audio transcription is not available. Please configure Google Speech-to-Text API.');
  }

  try {
    const ocr = await runBoardOcr(videoFilePath, fullOptions);
    console.log('🔥 FORCING audio transcription (no fallbacks)...');
    const audioResult = await tryAudioTranscriptionBasedEnhancement(
      videoInfo,
      videoFilePath,
      fullOptions,
      youtubeUrl,
      ocr
    );

    if (audioResult) {
      console.log('✅ Audio-only enhancement successful');
      return {
        ...audioResult,
        ...boardFields(ocr),
        processingTime: Date.now() - startTime
      } as EnhancedVideoMetadata;
    } else {
      const boardItems = ocr.board?.items?.length || 0;
      throw new Error(
        'Audio transcription failed - no fallback in audio-only mode' +
        (boardItems > 0 ? ` (blackboard OCR had read ${boardItems} text item(s); use the standard mode to keep them)` : '')
      );
    }

  } catch (error: any) {
    console.error('❌ Audio-only enhancement failed:', error.message);
    throw new Error(`Audio-only enhancement failed: ${error.message}`);
  }
}

/**
 * Extract YouTube video ID from URL
 */
function extractVideoIdFromUrl(url: string): string | null {
  if (!url) return null;

  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
    /youtube\.com\/v\/([^&\n?#]+)/,
    /youtube\.com\/watch\?.*v=([^&\n?#]+)/
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Create fallback metadata when all enhancement attempts fail
 */
function createFallbackMetadata(
  videoInfo: YtDlpVideoInfo,
  processingTime: number
): EnhancedVideoMetadata {
  return {
    originalMetadata: videoInfo,
    enhancedTitle: videoInfo.title,
    enhancedSummary: videoInfo.description || `Video by ${videoInfo.uploader} uploaded on ${videoInfo.uploadDate}`,
    keyTopics: [],
    contentTags: [],
    enhancementSource: 'metadata' as const,
    language: detectLanguageFromText(videoInfo.title + ' ' + videoInfo.description),
    confidence: 0.3,
    processingTime
  };
}
