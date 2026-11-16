/**
 * Google Cloud Speech-to-Text V2 (Chirp) client wrapper.
 *
 * - Regional endpoint `{location}-speech.googleapis.com` (chirp_3 is GA in the `us` and `eu`
 *   multi-regions; the global endpoint does not serve it).
 * - Implicit recognizer `projects/{project}/locations/{location}/recognizers/_` (no Recognizer
 *   resource has to be created).
 * - Sync Recognize only (inline content; <= 10 MB and < 60 s per request). BatchRecognize needs
 *   audio in Cloud Storage, so it is not used here; callers chunk the audio instead.
 * - Inline adaptation (phrase sets). If Google rejects it, the request is retried with plain
 *   phrases (no boost) and then without adaptation.
 *
 * Credentials are resolved exactly like the V1 client (see resolveGoogleSpeechAuth), so both
 * engines always run against the same project.
 */
import { v2, protos } from '@google-cloud/speech';
import fs from 'fs';
import dotenv from 'dotenv';
import { normalizeLanguageCode, joinTextFragments } from './language-utils';

dotenv.config();

type V2Config = protos.google.cloud.speech.v2.IRecognitionConfig;
type V2Response = protos.google.cloud.speech.v2.IRecognizeResponse;
type V2Duration = protos.google.protobuf.IDuration | null | undefined;

// ---------------------------------------------------------------------------
// Credentials (shared with the V1 client)
// ---------------------------------------------------------------------------

export interface GoogleSpeechAuth {
  /** May be '' for application default credentials without a configured project; resolve lazily then. */
  projectId: string;
  credentials?: Record<string, any>;
  keyFilename?: string;
  source: 'base64' | 'keyFile' | 'applicationDefault';
}

function readProjectIdFromKeyFile(file?: string): string {
  if (!file) return '';
  try {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof json.project_id === 'string' ? json.project_id : '';
  } catch {
    return '';
  }
}

/**
 * Same order as the V1 client always used: GOOGLE_CREDENTIALS_BASE64, then GOOGLE_CLOUD_KEY_FILE
 * (when the file exists), then GOOGLE_APPLICATION_CREDENTIALS (application default credentials).
 * The project id is GOOGLE_CLOUD_PROJECT_ID, falling back to project_id from the credentials.
 * Returns null when nothing is configured. Throws when GOOGLE_CREDENTIALS_BASE64 is not valid JSON.
 */
export function resolveGoogleSpeechAuth(): GoogleSpeechAuth | null {
  const configuredProject = process.env.GOOGLE_CLOUD_PROJECT_ID || '';
  const base64 = process.env.GOOGLE_CREDENTIALS_BASE64 || '';
  const keyFile = process.env.GOOGLE_CLOUD_KEY_FILE || '';
  const adcFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';

  if (base64) {
    const credentials = JSON.parse(Buffer.from(base64, 'base64').toString());
    return {
      projectId: configuredProject || (typeof credentials.project_id === 'string' ? credentials.project_id : ''),
      credentials,
      source: 'base64'
    };
  }
  if (keyFile && fs.existsSync(keyFile)) {
    return {
      projectId: configuredProject || readProjectIdFromKeyFile(keyFile),
      keyFilename: keyFile,
      source: 'keyFile'
    };
  }
  if (adcFile) {
    return {
      projectId: configuredProject || process.env.GOOGLE_CLOUD_PROJECT || readProjectIdFromKeyFile(adcFile),
      source: 'applicationDefault'
    };
  }
  return null;
}

/** Constructor options (projectId + credentials/keyFilename) for any @google-cloud/speech client. */
export function speechClientOptions(auth: GoogleSpeechAuth): { projectId?: string; credentials?: any; keyFilename?: string } {
  return {
    ...(auth.projectId ? { projectId: auth.projectId } : {}),
    ...(auth.credentials ? { credentials: auth.credentials } : {}),
    ...(auth.keyFilename ? { keyFilename: auth.keyFilename } : {})
  };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CHIRP_LOCATION = 'us';
export const DEFAULT_CHIRP_MODEL = 'chirp_3';

export interface ChirpConfig {
  enabled: boolean;
  location: string;
  model: string;
  apiEndpoint: string;
}

/** Read lazily so dotenv order and tests that change process.env both work. */
export function getChirpConfig(): ChirpConfig {
  const location = (process.env.GOOGLE_STT_V2_LOCATION || DEFAULT_CHIRP_LOCATION).trim().toLowerCase();
  const model = (process.env.GOOGLE_STT_V2_MODEL || DEFAULT_CHIRP_MODEL).trim();
  const enabledFlag = (process.env.GOOGLE_STT_V2_ENABLED || '').trim().toLowerCase();
  return {
    enabled: !['false', '0', 'no', 'off'].includes(enabledFlag),
    location,
    model,
    apiEndpoint: location === 'global' ? 'speech.googleapis.com' : `${location}-speech.googleapis.com`
  };
}

let cachedClient: { key: string; client: v2.SpeechClient; projectId: string } | null = null;
let clientInitError: string | null = null;

function getClient(): { client: v2.SpeechClient; projectId: string; config: ChirpConfig } | null {
  const config = getChirpConfig();
  if (!config.enabled) return null;
  const key = `${config.apiEndpoint}`;
  if (cachedClient && cachedClient.key === key) {
    return { client: cachedClient.client, projectId: cachedClient.projectId, config };
  }
  try {
    const auth = resolveGoogleSpeechAuth();
    if (!auth) {
      clientInitError = 'no Google Cloud credentials configured';
      return null;
    }
    const client = new v2.SpeechClient({ ...speechClientOptions(auth), apiEndpoint: config.apiEndpoint });
    cachedClient = { key, client, projectId: auth.projectId };
    clientInitError = null;
    console.log(`✅ Google Speech-to-Text V2 client ready (model ${config.model}, endpoint ${config.apiEndpoint})`);
    return { client, projectId: auth.projectId, config };
  } catch (error: any) {
    clientInitError = error?.message || String(error);
    console.error(`❌ Failed to initialise Google Speech-to-Text V2 client: ${clientInitError}`);
    return null;
  }
}

/** True when Chirp is enabled (GOOGLE_STT_V2_ENABLED != false) and a client could be created. */
export function isChirpAvailable(): boolean {
  return getClient() !== null;
}

/** Why Chirp is not available (for logs); undefined when it is. */
export function chirpUnavailableReason(): string | undefined {
  const config = getChirpConfig();
  if (!config.enabled) return 'disabled by GOOGLE_STT_V2_ENABLED=false';
  if (getClient()) return undefined;
  return clientInitError || 'client could not be created';
}

async function resolveProjectId(client: v2.SpeechClient, projectId: string): Promise<string> {
  if (projectId) return projectId;
  const detected = await client.getProjectId();
  if (cachedClient) cachedClient.projectId = detected;
  return detected;
}

// ---------------------------------------------------------------------------
// Language codes
// ---------------------------------------------------------------------------

/**
 * Map a Chinese code to the tags Chirp lists (no zh-* codes are listed for Chirp models):
 * zh / zh-CN / cmn / cmn-CN -> cmn-Hans-CN, zh-TW / cmn-TW / zh-Hant -> cmn-Hant-TW,
 * zh-HK / yue / yue-HK -> yue-Hant-HK. Other codes are returned normalised.
 */
export function toChirpLanguageCode(code: string): string {
  const normalized = normalizeLanguageCode(code) || code;
  const lower = normalized.toLowerCase();
  if (lower === 'auto') return 'auto';
  const parts = lower.split('-');
  const primary = parts[0];
  if (primary === 'yue' || (primary === 'zh' && (parts.includes('hk') || parts.includes('yue') || parts.includes('mo')))) {
    return 'yue-Hant-HK';
  }
  if (primary === 'zh' || primary === 'cmn') {
    if (parts.includes('hant') || parts.includes('tw')) return 'cmn-Hant-TW';
    return 'cmn-Hans-CN';
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ChirpErrorKind = 'transient' | 'invalid' | 'config';

const TRANSIENT_CODES = new Set([4, 8, 13, 14]); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE

export class ChirpError extends Error {
  constructor(message: string, readonly kind: ChirpErrorKind, readonly code?: number) {
    super(message);
    this.name = 'ChirpError';
  }
}

export function classifyChirpError(error: any): ChirpErrorKind {
  const code = typeof error?.code === 'number' ? error.code : undefined;
  const text = String(error?.message || error?.details || error || '');
  if (code !== undefined && TRANSIENT_CODES.has(code)) return 'transient';
  if (/\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text)) return 'transient';
  if (code === 3 || /INVALID_ARGUMENT/i.test(text)) return 'invalid';
  // PERMISSION_DENIED (7), NOT_FOUND (5), FAILED_PRECONDITION (9), UNIMPLEMENTED (12),
  // UNAUTHENTICATED (16), API not enabled, unsupported location, ...
  return 'config';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Recognize
// ---------------------------------------------------------------------------

export interface ChirpPhraseGroup {
  phrases: string[];
  /** Set-level boost (0 < boost <= 20). Ignored in 'plain' adaptation mode. */
  boost: number;
}

/** 'boost' = phrase sets with boosts; 'plain' = phrases without boost; 'off' = no adaptation. */
export type ChirpAdaptationMode = 'boost' | 'plain' | 'off';

export interface ChirpRecognizeOptions {
  /** e.g. ['cmn-Hans-CN'] or ['auto']. */
  languageCodes: string[];
  phraseGroups?: ChirpPhraseGroup[];
  adaptation?: ChirpAdaptationMode;
  enableAutomaticPunctuation?: boolean;
  enableWordTimeOffsets?: boolean;
  profanityFilter?: boolean;
  /** Per-call timeout (ms). Default 120 s. */
  timeoutMs?: number;
  /** Retries for transient errors (429/503/...). Default 4. */
  maxRetries?: number;
}

export interface ChirpResultPiece {
  text: string;
  /** Seconds from the start of the audio sent (best effort). */
  startTime: number;
  endTime?: number;
  languageCode?: string;
  confidence?: number;
}

export interface ChirpRecognizeResult {
  transcript: string;
  pieces: ChirpResultPiece[];
  /** Normalised language code reported by the most text; undefined when Google gave none. */
  languageCode?: string;
  /** Average alternative confidence where Google gave one (> 0); not a calibrated score for chirp_3. */
  confidence?: number;
  words?: Array<{ word: string; startTime: number; endTime: number }>;
  /** Adaptation mode that was finally accepted (may be lower than requested). */
  adaptation: ChirpAdaptationMode;
  model: string;
  location: string;
}

const MAX_PHRASE_SETS = 20; // per SpeechAdaptation
const MAX_PHRASES_PER_SET = 1200;
const MAX_PHRASES_PER_REQUEST = 1000; // chirp_3 dictionary limit (generic V2 limit is 5,000)
const MAX_PHRASE_CHARS = 100;
const MAX_ADAPTATION_CHARS = 100000;

function durationToSeconds(d: V2Duration): number | undefined {
  if (!d) return undefined;
  const seconds = Number(d.seconds ?? 0);
  const nanos = Number(d.nanos ?? 0);
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) return undefined;
  return seconds + nanos / 1e9;
}

/** Build RecognitionConfig.adaptation within the V2 / chirp_3 limits. Exported for tests. */
export function buildChirpAdaptation(
  groups: ChirpPhraseGroup[] | undefined,
  mode: ChirpAdaptationMode
): protos.google.cloud.speech.v2.ISpeechAdaptation | undefined {
  if (mode === 'off' || !groups || groups.length === 0) return undefined;
  const seen = new Set<string>();
  let total = 0;
  let chars = 0;
  const sets: Array<{ phrases: string[]; boost: number }> = [];
  for (const group of groups) {
    const phrases: string[] = [];
    for (const raw of group.phrases) {
      const value = (raw || '').trim();
      if (!value || value.length > MAX_PHRASE_CHARS || seen.has(value)) continue;
      if (total >= MAX_PHRASES_PER_REQUEST || chars + value.length > MAX_ADAPTATION_CHARS) break;
      if (phrases.length >= MAX_PHRASES_PER_SET) break;
      seen.add(value);
      phrases.push(value);
      total++;
      chars += value.length;
    }
    if (phrases.length > 0) {
      const boost = Math.min(20, Math.max(0.1, group.boost || 1));
      sets.push({ phrases, boost });
    }
    if (sets.length >= MAX_PHRASE_SETS) break;
  }
  if (sets.length === 0) return undefined;
  if (mode === 'plain') {
    return { phraseSets: [{ inlinePhraseSet: { phrases: sets.flatMap(s => s.phrases).map(value => ({ value })) } }] };
  }
  return {
    phraseSets: sets.map(s => ({ inlinePhraseSet: { phrases: s.phrases.map(value => ({ value })), boost: s.boost } }))
  };
}

function nextAdaptationMode(mode: ChirpAdaptationMode): ChirpAdaptationMode | undefined {
  return mode === 'boost' ? 'plain' : mode === 'plain' ? 'off' : undefined;
}

function parseResponse(response: V2Response, model: string, location: string, adaptation: ChirpAdaptationMode): ChirpRecognizeResult {
  const pieces: ChirpResultPiece[] = [];
  const words: Array<{ word: string; startTime: number; endTime: number }> = [];
  const weights: Record<string, number> = {};
  let transcript = '';
  let confidenceSum = 0;
  let confidenceCount = 0;
  let previousEnd = 0;

  for (const result of response.results ?? []) {
    const alternative = result.alternatives?.[0];
    const endTime = durationToSeconds(result.resultEndOffset);
    const text = (alternative?.transcript || '').trim();
    if (text) {
      const languageCode = normalizeLanguageCode(result.languageCode) || undefined;
      pieces.push({
        text,
        startTime: previousEnd,
        endTime,
        languageCode,
        confidence: alternative?.confidence ?? undefined
      });
      transcript = joinTextFragments(transcript, text);
      if (languageCode) weights[languageCode] = (weights[languageCode] || 0) + text.length;
      if (alternative?.confidence && alternative.confidence > 0) {
        confidenceSum += alternative.confidence;
        confidenceCount++;
      }
      for (const word of alternative?.words ?? []) {
        const start = durationToSeconds(word.startOffset);
        const end = durationToSeconds(word.endOffset);
        if (word.word && start !== undefined && end !== undefined) {
          words.push({ word: word.word, startTime: start, endTime: end });
        }
      }
    }
    if (endTime !== undefined) previousEnd = endTime;
  }

  let languageCode: string | undefined;
  let best = 0;
  for (const [code, weight] of Object.entries(weights)) {
    if (weight > best) {
      best = weight;
      languageCode = code;
    }
  }

  return {
    transcript,
    pieces,
    languageCode,
    confidence: confidenceCount > 0 ? confidenceSum / confidenceCount : undefined,
    words: words.length > 0 ? words : undefined,
    adaptation,
    model,
    location
  };
}

/**
 * Sync Recognize one audio chunk (WAV with header; < 60 s and <= 10 MB) with Chirp.
 *
 * Ladder: transient errors (429/503/deadline/internal) are retried with exponential backoff;
 * INVALID_ARGUMENT while adaptation is on steps the adaptation down (boost -> plain -> off) and
 * retries; any other failure throws a ChirpError (callers fall back to V1 for the whole file).
 */
export async function recognizeChirp(
  audio: Buffer | string,
  options: ChirpRecognizeOptions
): Promise<ChirpRecognizeResult> {
  const handle = getClient();
  if (!handle) {
    throw new ChirpError(`Chirp is not available: ${chirpUnavailableReason()}`, 'config');
  }
  const { client, config } = handle;
  const content = typeof audio === 'string' ? fs.readFileSync(audio) : audio;
  if (content.length > 10 * 1024 * 1024) {
    throw new ChirpError(`Audio chunk is ${(content.length / 1048576).toFixed(1)} MB; sync Recognize accepts at most 10 MB`, 'invalid');
  }

  let projectId: string;
  try {
    projectId = await resolveProjectId(client, handle.projectId);
  } catch (error: any) {
    throw new ChirpError(`Cannot determine Google Cloud project id for Chirp: ${error?.message || error}`, 'config');
  }
  const recognizer = client.recognizerPath(projectId, config.location, '_');
  const maxRetries = options.maxRetries ?? 4;
  let adaptationMode: ChirpAdaptationMode = options.adaptation ?? 'boost';
  if (!options.phraseGroups || options.phraseGroups.every(g => g.phrases.length === 0)) adaptationMode = 'off';
  let transientAttempts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const adaptation = buildChirpAdaptation(options.phraseGroups, adaptationMode);
    const requestConfig: V2Config = {
      autoDecodingConfig: {},
      model: config.model,
      languageCodes: options.languageCodes,
      features: {
        enableAutomaticPunctuation: options.enableAutomaticPunctuation ?? true,
        enableWordTimeOffsets: !!options.enableWordTimeOffsets,
        profanityFilter: !!options.profanityFilter
      },
      ...(adaptation ? { adaptation } : {})
    };

    try {
      const [response] = await client.recognize(
        { recognizer, config: requestConfig, content },
        { timeout: options.timeoutMs ?? 120000 }
      );
      return parseResponse(response, config.model, config.location, adaptation ? adaptationMode : 'off');
    } catch (error: any) {
      const kind = classifyChirpError(error);
      const message = error?.details || error?.message || String(error);
      if (kind === 'transient' && transientAttempts < maxRetries) {
        const delay = Math.min(16000, 1000 * 2 ** transientAttempts) + Math.floor(Math.random() * 400);
        transientAttempts++;
        console.warn(`⚠️ Chirp transient error (code ${error?.code}): ${message}. Retry ${transientAttempts}/${maxRetries} in ${delay} ms`);
        await sleep(delay);
        continue;
      }
      if (kind === 'invalid' && adaptation) {
        const next = nextAdaptationMode(adaptationMode)!;
        console.warn(`⚠️ Chirp rejected the request with adaptation '${adaptationMode}' (${message}); retrying with adaptation '${next}'`);
        adaptationMode = next;
        continue;
      }
      throw new ChirpError(
        `Chirp ${config.model} @ ${config.location} failed (code ${error?.code ?? 'n/a'}, ${kind}): ${message}`,
        kind,
        typeof error?.code === 'number' ? error.code : undefined
      );
    }
  }
}
