/**
 * Alibaba Cloud Model Studio (DashScope, international / Singapore) speech recognition.
 *
 * Built on request/response shapes verified live against https://dashscope-intl.aliyuncs.com:
 *
 *  - Temporary upload (no public storage needed):
 *      GET  {BASE}/api/v1/uploads?action=getPolicy&model=<model>      (Bearer key)
 *      POST <upload_host> multipart form (OSS policy fields + file)   (no auth)
 *      -> "oss://<upload_dir>/<file>", valid 48 h for that model; calls that use it send
 *         X-DashScope-OssResourceResolve: enable.
 *  - Async file transcription (whole file, up to 12 h):
 *      POST {BASE}/api/v1/services/audio/asr/transcription  (X-DashScope-Async: enable)
 *      GET  {BASE}/api/v1/tasks/{task_id} until SUCCEEDED / FAILED, then download the
 *      pre-signed transcription_url (no auth) -> transcripts[].sentences[] with ms timestamps.
 *      qwen-audio-*-asr-flash-filetrans and fun-asr: input.file_urls [url], output.results[0];
 *      qwen3-asr-flash-filetrans: input.file_url (singular), output.result.
 *  - Sync recognition (short audio, chunked here):
 *      POST {BASE}/api/v1/services/aigc/multimodal-generation/generation
 *      qwen3-asr-flash: messages [system {text: context}, user {audio: data URI}],
 *        parameters.asr_options {language, enable_itn:false} -> output.choices[0].message.content[].text
 *      qwen-audio-*-asr-flash / fun-asr-flash-*: user content [{type:'input_audio', input_audio:{data}}],
 *        parameters {format, sample_rate, language_hints, vocabulary(_id)} -> output.text
 *  - Hotwords (speech-biasing customization):
 *      POST {BASE}/api/v1/services/audio/asr/customization {model:'speech-biasing', input:{action,...}}
 *      create_vocabulary / query_vocabulary / delete_vocabulary; used as parameters.vocabulary_id,
 *      plus per-request parameters.vocabulary {term: weight} (weight 1-5, 50 = super hotword).
 *
 * The API key (DASHSCOPE_API_KEY) is only ever sent in the Authorization header; it is never
 * logged, put in a URL or written to disk, and error texts are scrubbed before they are thrown.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { getTcmPhraseHints, scriptForLanguageCode } from './tcm-glossary';
import { toBaseLanguage, joinTextFragments } from './language-utils';

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Legacy international endpoint (verified). The workspace endpoint {WorkspaceId}.ap-southeast-1.maas.aliyuncs.com uses the same paths. */
export const DEFAULT_ALIBABA_ASR_BASE_URL = 'https://dashscope-intl.aliyuncs.com';
/** Most verbatim model measured (Chinese numerals with enable_itn:false, no boundary duplication). */
export const DEFAULT_ALIBABA_ASR_MODEL = 'qwen3-asr-flash';
/** Glossary hotword weight (1-5). */
export const DEFAULT_GLOSSARY_WEIGHT = 3;
/** Per-request caller hotword weight (board OCR terms etc., 1-5). */
export const DEFAULT_HOTWORD_WEIGHT = 4;
/** Super hotword weight (Qwen-Audio ASR series only; max 50 per request). */
export const SUPER_HOTWORD_WEIGHT = 50;
export const MAX_SUPER_HOTWORDS = 50;
/** Max terms per vocabulary and per request (vocabulary_id + instant vocabulary are merged, max 2000). */
export const MAX_VOCABULARY_TERMS = 2000;
/** Non-ASCII hotwords: at most 15 characters. */
export const MAX_HOTWORD_CHARS = 15;
/** Context limits: qwen-audio context turns are <= 400 chars (max 5 user turns); qwen3-asr-flash system text is generous (10k tokens). */
const QWEN_AUDIO_CONTEXT_TURN_CHARS = 400;
const QWEN_AUDIO_CONTEXT_MAX_TURNS = 5;
const QWEN3_CONTEXT_MAX_CHARS = 6000;
/**
 * Sync models accept <= 5 min / 10 MB (16 kHz mono WAV in base64 stays < 10 MB up to ~240 s).
 * Measured on real lectures (qwen3-asr-flash): 60 s chunks were as good as or slightly better than
 * 120-240 s (CER 4.23% vs 4.33-4.38%, 5.38% vs 5.44-5.58%), give finer timestamps and make a
 * stalled request cheaper to retry.
 */
const DEFAULT_SYNC_CHUNK_SECONDS = 60;
const VOCABULARY_PREFIX = 'yitam';
/** server/ (this file lives in server/src/services or server/dist/services). */
const SERVER_DIR = path.resolve(__dirname, '..', '..');

export interface AlibabaAsrConfig {
  enabled: boolean;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  glossaryWeight: number;
  hotwordWeight: number;
  /** Max glossary terms written into the qwen3-asr-flash context (0 = none). */
  contextGlossaryTerms: number;
  syncChunkSeconds: number;
  concurrency: number;
  /** Overall timeout for one transcription; 0 = derived from the audio duration. */
  timeoutMs: number;
  cacheFile: string;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function apiKey(): string {
  return (process.env.DASHSCOPE_API_KEY || '').trim();
}

export function getAlibabaAsrConfig(): AlibabaAsrConfig {
  const rawBase = (process.env.ALIBABA_ASR_BASE_URL || '').trim() || DEFAULT_ALIBABA_ASR_BASE_URL;
  return {
    enabled: (process.env.ALIBABA_ASR_ENABLED || '').trim().toLowerCase() !== 'false',
    hasKey: apiKey().length > 0,
    baseUrl: rawBase.replace(/\/+$/, ''),
    model: (process.env.ALIBABA_ASR_MODEL || '').trim() || DEFAULT_ALIBABA_ASR_MODEL,
    glossaryWeight: intEnv('ALIBABA_ASR_GLOSSARY_WEIGHT', DEFAULT_GLOSSARY_WEIGHT, 1, 5),
    hotwordWeight: intEnv('ALIBABA_ASR_HOTWORD_WEIGHT', DEFAULT_HOTWORD_WEIGHT, 1, 5),
    contextGlossaryTerms: intEnv('ALIBABA_ASR_CONTEXT_GLOSSARY_TERMS', 0, 0, 2000),
    syncChunkSeconds: intEnv('ALIBABA_ASR_SYNC_CHUNK_SECONDS', DEFAULT_SYNC_CHUNK_SECONDS, 30, 240),
    concurrency: intEnv('ALIBABA_ASR_CONCURRENCY', 3, 1, 8),
    timeoutMs: intEnv('ALIBABA_ASR_TIMEOUT_MS', 0, 0, 24 * 3600 * 1000),
    // Relative values resolve against the server directory (not process.cwd()), so every process
    // shares one cache file inside the git-ignored server/data folder
    cacheFile: path.resolve(SERVER_DIR, (process.env.ALIBABA_ASR_CACHE_FILE || '').trim() || path.join('data', 'alibaba-vocabulary.json'))
  };
}

/**
 * Whether the TCM glossary changes the request for this model (vocabulary models, or qwen3-asr-flash
 * with ALIBABA_ASR_CONTEXT_GLOSSARY_TERMS > 0). The glossary is applied only for a Chinese language code.
 */
export function alibabaModelUsesGlossary(model?: string): boolean {
  const config = getAlibabaAsrConfig();
  const caps = alibabaModelCapabilities(model || config.model);
  return caps.vocabularyId || caps.instantVocabulary || (caps.context === 'system' && config.contextGlossaryTerms > 0);
}

/** True when ALIBABA_ASR_ENABLED != 'false' and DASHSCOPE_API_KEY is set. */
export function isAlibabaAsrAvailable(): boolean {
  const config = getAlibabaAsrConfig();
  return config.enabled && config.hasKey;
}

/** Why Alibaba ASR cannot be used (for logs); undefined when it can. */
export function alibabaUnavailableReason(): string | undefined {
  const config = getAlibabaAsrConfig();
  if (!config.enabled) return 'disabled by ALIBABA_ASR_ENABLED=false';
  if (!config.hasKey) return 'DASHSCOPE_API_KEY is not set';
  return undefined;
}

// ---------------------------------------------------------------------------
// Model families
// ---------------------------------------------------------------------------

export type AlibabaModelFamily =
  /** qwen-audio-*-asr-flash-filetrans: async, file_urls[], vocabulary + super hotwords + context. */
  | 'qwen-audio-filetrans'
  /** fun-asr (async): file_urls[], vocabulary_id + instant vocabulary, no context / super hotwords. */
  | 'fun-asr-filetrans'
  /** qwen3-asr-flash-filetrans: async, file_url (singular), output.result, no hotwords. */
  | 'qwen3-filetrans'
  /** qwen3-asr-flash: sync <= 5 min, context via system message, no hotword API. */
  | 'qwen3-sync'
  /** qwen-audio-*-asr-flash / fun-asr-flash-*: sync <= 5 min, format required, vocabulary. */
  | 'flash-sync';

export interface AlibabaModelCapabilities {
  family: AlibabaModelFamily;
  async: boolean;
  /** parameters.vocabulary_id (precompiled vocabulary) */
  vocabularyId: boolean;
  /** parameters.vocabulary {term: weight} per request */
  instantVocabulary: boolean;
  /** weight 50 hotwords */
  superHotwords: boolean;
  /** 'messages': input.context / extra messages (400 chars per turn); 'system': one system message */
  context: 'messages' | 'system' | 'none';
  /** honours enable_itn:false (Chinese numerals instead of digits) */
  itnOff: boolean;
}

export function alibabaModelCapabilities(model: string): AlibabaModelCapabilities {
  const m = model.trim().toLowerCase();
  if (/realtime/.test(m)) {
    throw new AlibabaAsrError(`Model ${model} is a realtime (WebSocket) model; use a file transcription or sync model`, { retryable: false });
  }
  if (/^qwen3-asr-flash.*filetrans/.test(m)) {
    return { family: 'qwen3-filetrans', async: true, vocabularyId: false, instantVocabulary: false, superHotwords: false, context: 'none', itnOff: true };
  }
  if (/^qwen3-asr-flash/.test(m)) {
    return { family: 'qwen3-sync', async: false, vocabularyId: false, instantVocabulary: false, superHotwords: false, context: 'system', itnOff: true };
  }
  if (/^qwen-audio-.*asr.*filetrans/.test(m)) {
    return { family: 'qwen-audio-filetrans', async: true, vocabularyId: true, instantVocabulary: true, superHotwords: true, context: 'messages', itnOff: false };
  }
  if (/^qwen-audio-.*asr-flash/.test(m)) {
    return { family: 'flash-sync', async: false, vocabularyId: true, instantVocabulary: true, superHotwords: true, context: 'messages', itnOff: false };
  }
  if (/^fun-asr-flash/.test(m)) {
    return { family: 'flash-sync', async: false, vocabularyId: true, instantVocabulary: false, superHotwords: false, context: 'none', itnOff: false };
  }
  // fun-asr, fun-asr-<date>, fun-asr-mtl..., and other async models on the same API (e.g. paraformer-v2)
  return { family: 'fun-asr-filetrans', async: true, vocabularyId: true, instantVocabulary: /^fun-asr/.test(m), superHotwords: false, context: 'none', itnOff: false };
}

// ---------------------------------------------------------------------------
// Errors, redaction, HTTP
// ---------------------------------------------------------------------------

export class AlibabaAsrError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  retryable: boolean;
  constructor(message: string, info: { status?: number; code?: string; requestId?: string; retryable?: boolean } = {}) {
    super(redact(message));
    this.name = 'AlibabaAsrError';
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
    this.retryable = !!info.retryable;
  }
}

/** Remove the API key and any bearer token / signed-URL signature from a text. */
export function redact(text: string): string {
  let out = String(text ?? '');
  const key = apiKey();
  if (key) out = out.split(key).join('<REDACTED>');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer <REDACTED>')
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, '<REDACTED>')
    .replace(/(Signature|OSSAccessKeyId|security-token)=[^&\s"']+/gi, '$1=<REDACTED>');
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); resolve(); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** Network errors raised before the request reached the server (safe to retry a non-idempotent POST). */
const PRE_SEND_NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  const retryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(60000, retryAfter * 1000);
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

/** Only the path of a URL (pre-signed URLs carry credentials in the query). */
function urlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '<url>';
  }
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  /** Send the Bearer key (default true; false for OSS / pre-signed URLs). */
  auth?: boolean;
  timeoutMs?: number;
  /** Retries on 429 / 5xx / network errors (default 4). */
  retries?: number;
  /**
   * false for requests that create something billed (async task submit): a timeout or a network error
   * after the request may have reached the server is then NOT retried (it could create a duplicate task).
   */
  idempotent?: boolean;
  /** Abort the request (and any pending retry) when this signal fires. */
  signal?: AbortSignal;
}

async function requestJson(method: 'GET' | 'POST', url: string, options: RequestOptions = {}): Promise<any> {
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 120000;
  const label = `${method} ${urlLabel(url)}`;
  let lastError: AlibabaAsrError | undefined;
  const idempotent = options.idempotent !== false;
  const aborted = () => new AlibabaAsrError(`${label}: aborted`, { retryable: false });
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) throw aborted();
    let retryAfter: string | null = null;
    try {
      const headers: Record<string, string> = { ...(options.headers || {}) };
      if (options.auth !== false) headers.Authorization = `Bearer ${apiKey()}`;
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (response.ok) {
        if (json === null) throw new AlibabaAsrError(`${label}: response is not JSON`, { status: response.status, retryable: true });
        return json;
      }
      retryAfter = response.headers.get('retry-after');
      const code = json?.code ? String(json.code) : undefined;
      const message = json?.message ? String(json.message) : text.slice(0, 300);
      const retryable = response.status === 429 || response.status >= 500 || /throttl|ratelimit|rate limit/i.test(code || '');
      lastError = new AlibabaAsrError(`${label} -> HTTP ${response.status}${code ? ` ${code}` : ''}: ${message}`, {
        status: response.status,
        code,
        requestId: json?.request_id,
        retryable
      });
    } catch (error: any) {
      if (options.signal?.aborted) throw aborted();
      if (error instanceof AlibabaAsrError) {
        lastError = error;
      } else {
        const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        const causeCode = error?.cause?.code ? String(error.cause.code) : undefined;
        const reason = timedOut ? `timed out after ${timeoutMs} ms` : (causeCode || error?.message || String(error));
        const retryable = idempotent || (!timedOut && !!causeCode && PRE_SEND_NETWORK_CODES.has(causeCode));
        lastError = new AlibabaAsrError(`${label}: network error (${reason})${retryable ? '' : '; not retried (the request may have been accepted)'}`, { retryable });
      }
    }
    if (!lastError.retryable || attempt === retries) break;
    const wait = backoffMs(attempt, retryAfter);
    console.warn(`⚠️ Alibaba ASR: ${lastError.message}; retry ${attempt + 1}/${retries} in ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait, options.signal);
  }
  throw lastError ?? new AlibabaAsrError(`${label}: request failed`);
}

// ---------------------------------------------------------------------------
// Temporary file upload (DashScope OSS, valid 48 h, per model)
// ---------------------------------------------------------------------------

async function openFileBlob(filePath: string): Promise<Blob> {
  const opener = (fs as any).openAsBlob as ((p: string) => Promise<Blob>) | undefined;
  if (typeof opener === 'function') return opener(filePath); // streams from disk (Node >= 19.8)
  return new Blob([fs.readFileSync(filePath)]);
}

/** Upload a local file to DashScope temporary storage for `model`; returns the oss:// URL. */
export async function uploadTemporaryFile(model: string, filePath: string): Promise<string> {
  const config = getAlibabaAsrConfig();
  const size = fs.statSync(filePath).size;
  const ext = (path.extname(filePath) || '.wav').toLowerCase().replace(/[^.a-z0-9]/g, '');
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const policy = await requestJson(
        'GET',
        `${config.baseUrl}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model)}`,
        { retries: 3, timeoutMs: 30000 }
      );
      const data = policy?.data;
      if (!data?.upload_host || !data?.upload_dir || !data?.policy || !data?.signature) {
        throw new AlibabaAsrError('Upload policy response is missing fields', { retryable: false });
      }
      const maxBytes = Number(data.max_file_size_mb) > 0 ? Number(data.max_file_size_mb) * 1024 * 1024 : Infinity;
      if (size > maxBytes) {
        throw new AlibabaAsrError(`Audio file is ${(size / 1048576).toFixed(1)} MB; temporary upload limit is ${data.max_file_size_mb} MB`, { retryable: false });
      }
      // x-oss-forbid-overwrite is on: a fresh object name per attempt
      const fileName = `audio-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      const key = `${data.upload_dir}/${fileName}`;
      const form = new FormData();
      form.append('OSSAccessKeyId', String(data.oss_access_key_id));
      form.append('Signature', String(data.signature));
      form.append('policy', String(data.policy));
      if (data.x_oss_object_acl) form.append('x-oss-object-acl', String(data.x_oss_object_acl));
      if (data.x_oss_forbid_overwrite) form.append('x-oss-forbid-overwrite', String(data.x_oss_forbid_overwrite));
      form.append('key', key);
      form.append('success_action_status', '200');
      form.append('file', await openFileBlob(filePath), fileName);
      const timeoutMs = 60000 + Math.ceil(size / (256 * 1024)) * 1000; // >= 256 KB/s
      const response = await fetch(String(data.upload_host), { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300);
        throw new AlibabaAsrError(`Temporary upload failed: HTTP ${response.status} ${text}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500
        });
      }
      return `oss://${key}`;
    } catch (error: any) {
      lastError = error;
      const retryable = error instanceof AlibabaAsrError ? error.retryable : true;
      if (!retryable || attempt === 2) break;
      const wait = backoffMs(attempt);
      console.warn(`⚠️ Alibaba ASR upload attempt ${attempt + 1} failed (${redact(error?.message || String(error))}); retrying in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  }
  if (lastError instanceof AlibabaAsrError) throw lastError;
  throw new AlibabaAsrError(`Temporary upload failed: ${(lastError as any)?.message || lastError}`);
}

// ---------------------------------------------------------------------------
// Hotword vocabularies (speech-biasing customization API)
// ---------------------------------------------------------------------------

export interface VocabularyTerm {
  text: string;
  weight: number;
  lang?: string;
}

interface VocabularyCacheEntry {
  vocabularyId: string;
  targetModel: string;
  script: 'hans' | 'hant';
  hash: string;
  termCount: number;
  weight: number;
  createdAt: string;
  /** Last time a process confirmed the id is still valid (bumped on every revalidation). */
  verifiedAt?: string;
}

interface VocabularyCacheFile {
  version: 1;
  entries: Record<string, VocabularyCacheEntry>;
}

const EDGE_PUNCTUATION_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/** Normalise a hotword: trimmed, no edge punctuation, 2..15 characters (non-ASCII) / <= 50 (ASCII). */
export function normalizeHotword(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.replace(/\s+/g, ' ').replace(EDGE_PUNCTUATION_RE, '').trim();
  const length = Array.from(value).length;
  if (length < 2) return undefined;
  const ascii = /^[\x20-\x7e]+$/.test(value);
  if (ascii ? value.length > 50 : length > MAX_HOTWORD_CHARS) return undefined;
  if (!/[\p{L}\p{N}]/u.test(value)) return undefined;
  return value;
}

/** Glossary hotwords for a script (deduplicated, valid length, <= MAX_VOCABULARY_TERMS). */
export function glossaryVocabulary(script: 'hans' | 'hant', weight: number): VocabularyTerm[] {
  const seen = new Set<string>();
  const out: VocabularyTerm[] = [];
  for (const raw of getTcmPhraseHints(script)) {
    const text = normalizeHotword(raw);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ text, weight, lang: 'zh' });
    if (out.length >= MAX_VOCABULARY_TERMS) break;
  }
  return out;
}

function vocabularyHash(terms: VocabularyTerm[]): string {
  const payload = terms.map(term => `${term.text}\t${term.weight}\t${term.lang || ''}`).join('\n');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function readVocabularyCache(file: string): VocabularyCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed;
  } catch {
    // missing or unreadable: start fresh
  }
  return { version: 1, entries: {} };
}

function writeVocabularyCache(file: string, cache: VocabularyCacheFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (error: any) {
    console.warn(`⚠️ Could not write Alibaba vocabulary cache ${file}: ${error?.message || error}`);
  }
}

async function customization(input: Record<string, unknown>): Promise<any> {
  const config = getAlibabaAsrConfig();
  const response = await requestJson('POST', `${config.baseUrl}/api/v1/services/audio/asr/customization`, {
    body: { model: 'speech-biasing', input },
    retries: 3,
    timeoutMs: 60000
  });
  return response?.output ?? {};
}

async function createVocabulary(targetModel: string, terms: VocabularyTerm[]): Promise<string> {
  const output = await customization({
    action: 'create_vocabulary',
    target_model: targetModel,
    prefix: VOCABULARY_PREFIX,
    vocabulary: terms
  });
  const id = output?.vocabulary_id;
  if (!id) throw new AlibabaAsrError('create_vocabulary returned no vocabulary_id', { retryable: false });
  // Usually ready immediately; wait briefly if the service reports otherwise
  for (let i = 0; i < 10; i++) {
    const status = await queryVocabularyStatus(id).catch(() => undefined);
    if (!status || status === 'OK') break;
    await sleep(2000);
  }
  return String(id);
}

/** 'OK' when usable, other strings for other states; throws for HTTP errors (4xx = unknown id). */
async function queryVocabularyStatus(vocabularyId: string): Promise<string | undefined> {
  const output = await customization({ action: 'query_vocabulary', vocabulary_id: vocabularyId });
  return output?.status ? String(output.status) : undefined;
}

export async function deleteVocabulary(vocabularyId: string): Promise<void> {
  await customization({ action: 'delete_vocabulary', vocabulary_id: vocabularyId });
}

export type VocabularyOutcome = 'created' | 'reused' | 'none';

/** A memoized vocabulary id is re-checked with query_vocabulary after this long. */
const VOCABULARY_REVALIDATE_MS = 30 * 60 * 1000;
/** Cache entries nobody has revalidated for this long are deleted (remote + cache) by the GC. */
const VOCABULARY_STALE_MS = 3 * 24 * 3600 * 1000;
/** yitam vocabularies that no cache entry references are deleted by the GC once they are this old. */
const VOCABULARY_ORPHAN_MIN_AGE_MS = 6 * 3600 * 1000;

/** In-process memo per cache key + glossary hash; re-validated after VOCABULARY_REVALIDATE_MS. */
const vocabularyInFlight = new Map<string, { at: number; promise: Promise<{ id?: string; outcome: VocabularyOutcome }> }>();
/** Cache files whose GC already ran in this process. */
const vocabularyGcDone = new Set<string>();

function updateVocabularyCache(file: string, mutate: (cache: VocabularyCacheFile) => boolean): void {
  // Read-modify-write right before writing to keep the window for lost updates small
  const cache = readVocabularyCache(file);
  if (mutate(cache)) writeVocabularyCache(file, cache);
}

/** Parse the service's "yyyy-MM-dd HH:mm:ss" timestamp as UTC (the service clock is UTC+8, so this errs towards "younger"). */
function parseServiceTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value.trim()) ? `${value.trim().replace(' ', 'T')}Z` : value.trim();
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

async function deleteVocabularyQuietly(vocabularyId: string, why: string): Promise<boolean> {
  try {
    await deleteVocabulary(vocabularyId);
    console.log(`🧹 Alibaba ASR: deleted ${why} vocabulary ${vocabularyId}`);
    return true;
  } catch (error: any) {
    // 4xx: already gone
    if (error instanceof AlibabaAsrError && error.status && error.status >= 400 && error.status < 500) return true;
    console.warn(`⚠️ Alibaba ASR: could not delete ${why} vocabulary ${vocabularyId} (${error?.message || error})`);
    return false;
  }
}

/**
 * Frees vocabulary slots (50 per account): deletes cache entries nobody revalidated for 3 days, and
 * yitam-prefixed vocabularies that no cache entry references (orphans from lost cache writes, an
 * unwritable cache file or rejected ids) once they are older than 6 h. Never throws.
 */
export async function collectVocabularyGarbage(reason: string): Promise<void> {
  const config = getAlibabaAsrConfig();
  try {
    const now = Date.now();
    const stale: string[] = [];
    const cache = readVocabularyCache(config.cacheFile);
    for (const entry of Object.values(cache.entries)) {
      const touched = Date.parse(entry.verifiedAt || entry.createdAt);
      if (!Number.isFinite(touched) || now - touched > VOCABULARY_STALE_MS) stale.push(entry.vocabularyId);
    }
    for (const id of stale) {
      if (await deleteVocabularyQuietly(id, 'unused (stale cache entry)')) {
        updateVocabularyCache(config.cacheFile, fresh => {
          let changed = false;
          for (const [key, entry] of Object.entries(fresh.entries)) {
            if (entry.vocabularyId === id) { delete fresh.entries[key]; changed = true; }
          }
          return changed;
        });
      }
    }

    const referenced = new Set(Object.values(readVocabularyCache(config.cacheFile).entries).map(entry => entry.vocabularyId));
    const idPrefix = `vocab-${VOCABULARY_PREFIX}-`;
    const orphans: string[] = [];
    for (let page = 0; page < 10; page++) {
      const output = await customization({ action: 'list_vocabulary', prefix: VOCABULARY_PREFIX, page_index: page, page_size: 10 });
      const list: any[] = Array.isArray(output?.vocabulary_list) ? output.vocabulary_list : [];
      for (const item of list) {
        const id = item?.vocabulary_id ? String(item.vocabulary_id) : '';
        if (!id.startsWith(idPrefix) || referenced.has(id)) continue;
        const created = parseServiceTime(item?.gmt_create);
        if (created !== undefined && now - created > VOCABULARY_ORPHAN_MIN_AGE_MS) orphans.push(id);
      }
      if (list.length < 10) break;
    }
    for (const id of orphans) await deleteVocabularyQuietly(id, 'orphaned');
    if (stale.length || orphans.length) {
      console.log(`🧹 Alibaba ASR vocabulary GC (${reason}): ${stale.length} stale, ${orphans.length} orphaned`);
    }
  } catch (error: any) {
    console.warn(`⚠️ Alibaba ASR vocabulary GC (${reason}) failed: ${error?.message || error}`);
  }
}

/**
 * Glossary vocabulary for (model, script, glossary hash): reused from the on-disk cache when the
 * service still knows the id (re-checked every 30 min per process); otherwise created. Entries are
 * keyed by hash, so processes with different glossaries / weights never delete each other's
 * vocabularies; unused ones are removed later by collectVocabularyGarbage. Failures return no id
 * (the caller then sends the glossary as instant hotwords when the model supports them).
 */
export async function ensureGlossaryVocabulary(
  targetModel: string,
  script: 'hans' | 'hant'
): Promise<{ id?: string; outcome: VocabularyOutcome; terms: VocabularyTerm[] }> {
  const config = getAlibabaAsrConfig();
  const terms = glossaryVocabulary(script, config.glossaryWeight);
  if (terms.length === 0) return { outcome: 'none', terms };
  const hash = vocabularyHash(terms);
  const host = urlLabel(config.baseUrl).replace(/\/$/, '');
  const key = `${host}|${targetModel}|${script}|${hash}`;
  const memoKey = `${config.cacheFile}|${key}`;

  const memo = vocabularyInFlight.get(memoKey);
  let pending = memo && Date.now() - memo.at < VOCABULARY_REVALIDATE_MS ? memo.promise : undefined;
  if (!pending) {
    pending = (async () => {
      const cached = readVocabularyCache(config.cacheFile).entries[key];
      if (cached && cached.hash === hash && cached.targetModel === targetModel) {
        try {
          const status = await queryVocabularyStatus(cached.vocabularyId);
          if (status === 'OK' || status === undefined) {
            console.log(`♻️ Alibaba ASR: reusing cached glossary vocabulary ${cached.vocabularyId} (${cached.termCount} terms, ${targetModel}/${script})`);
            updateVocabularyCache(config.cacheFile, fresh => {
              const entry = fresh.entries[key];
              if (!entry || entry.vocabularyId !== cached.vocabularyId) return false;
              entry.verifiedAt = new Date().toISOString();
              return true;
            });
            return { id: cached.vocabularyId, outcome: 'reused' as const };
          }
          console.warn(`⚠️ Alibaba ASR: cached vocabulary ${cached.vocabularyId} has status ${status}; recreating`);
        } catch (error: any) {
          if (error instanceof AlibabaAsrError && error.status && error.status >= 400 && error.status < 500) {
            console.warn(`⚠️ Alibaba ASR: cached vocabulary ${cached.vocabularyId} is not valid any more (${error.message}); recreating`);
          } else {
            // Service hiccup: the id is most likely still fine
            console.warn(`⚠️ Alibaba ASR: could not verify vocabulary ${cached.vocabularyId} (${error?.message || error}); using it anyway`);
            return { id: cached.vocabularyId, outcome: 'reused' as const };
          }
        }
      }
      let id: string;
      try {
        id = await createVocabulary(targetModel, terms);
      } catch (error: any) {
        // Most likely the 50-per-account limit: free orphaned / stale slots and try once more
        console.warn(`⚠️ Alibaba ASR: create_vocabulary failed (${error?.message || error}); collecting unused vocabularies and retrying once`);
        await collectVocabularyGarbage('create failed');
        id = await createVocabulary(targetModel, terms);
      }
      console.log(`🆕 Alibaba ASR: created glossary vocabulary ${id} (${terms.length} terms, weight ${config.glossaryWeight}, ${targetModel}/${script})`);
      const now = new Date().toISOString();
      let replaced: string | undefined;
      updateVocabularyCache(config.cacheFile, fresh => {
        const previous = fresh.entries[key];
        if (previous && previous.vocabularyId !== id) replaced = previous.vocabularyId;
        fresh.entries[key] = {
          vocabularyId: id,
          targetModel,
          script,
          hash,
          termCount: terms.length,
          weight: config.glossaryWeight,
          createdAt: now,
          verifiedAt: now
        };
        return true;
      });
      // Same key + hash means the same glossary: the replaced id was rejected or is a lost race duplicate
      if (replaced && replaced === cached?.vocabularyId) void deleteVocabularyQuietly(replaced, 'invalid');
      return { id, outcome: 'created' as const };
    })().catch(error => {
      vocabularyInFlight.delete(memoKey);
      console.warn(`⚠️ Alibaba ASR: glossary vocabulary unavailable (${error?.message || error}); continuing without it`);
      return { id: undefined, outcome: 'none' as const };
    });
    vocabularyInFlight.set(memoKey, { at: Date.now(), promise: pending });
  }
  const result = await pending;
  // First GC of this process runs after the lookup (which bumps verifiedAt of a reused entry), so it
  // never deletes the vocabulary this job is about to send
  if (!vocabularyGcDone.has(config.cacheFile)) {
    vocabularyGcDone.add(config.cacheFile);
    void collectVocabularyGarbage('startup');
  }
  return { ...result, terms };
}

/** Forget a vocabulary id the service rejected and delete it remotely (next call recreates it). */
function invalidateVocabulary(vocabularyId: string): void {
  const config = getAlibabaAsrConfig();
  updateVocabularyCache(config.cacheFile, cache => {
    let changed = false;
    for (const [key, entry] of Object.entries(cache.entries)) {
      if (entry.vocabularyId === vocabularyId) {
        delete cache.entries[key];
        changed = true;
      }
    }
    return changed;
  });
  for (const memoKey of Array.from(vocabularyInFlight.keys())) vocabularyInFlight.delete(memoKey);
  void deleteVocabularyQuietly(vocabularyId, 'rejected');
}

function isVocabularyError(error: unknown): boolean {
  return error instanceof AlibabaAsrError && !!error.status && error.status >= 400 && error.status < 500 &&
    /vocab|hotword|customiz|ResourceNotExist/i.test(error.message);
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface AlibabaTranscribeOptions {
  /** BCP-47 ('cmn-Hans-CN', 'yue-Hant-HK', ...) or 'auto' (no language hint). */
  languageCode: string;
  /** Model id; default ALIBABA_ASR_MODEL / DEFAULT_ALIBABA_ASR_MODEL. */
  model?: string;
  /** Per-request hotwords (e.g. blackboard OCR terms). */
  hotwords?: string[];
  /** Per-request super hotwords (weight 50, Qwen-Audio ASR series only; else normal hotwords). */
  superHotwords?: string[];
  /** Background text (video title / description, board text). */
  context?: string;
  /** 'tcm' (default): bias towards the TCM glossary when the language is Chinese. */
  glossary?: 'tcm' | 'none';
}

export interface AlibabaTranscribeResult {
  transcript: string;
  languageCode: string;
  model: string;
  segments?: Array<{ startTime: number; endTime: number; text: string }>;
  confidence?: number;
  /** Audio duration in seconds (service-reported or ffprobe). */
  durationSeconds?: number;
  details: {
    family: AlibabaModelFamily;
    vocabularyId?: string;
    vocabulary: VocabularyOutcome;
    instantHotwords: number;
    superHotwords: number;
    contextChars: number;
    chunks?: number;
    uploadMs?: number;
    taskMs?: number;
    totalMs: number;
    taskId?: string;
  };
}

/** Language hint for the models ('zh', 'yue', 'en', ...); undefined = let the model detect. */
export function alibabaLanguageHint(languageCode: string): string | undefined {
  if (!languageCode || languageCode.trim().toLowerCase() === 'auto') return undefined;
  const base = toBaseLanguage(languageCode);
  if (!base) return undefined;
  return ['zh', 'yue', 'en', 'ja', 'ko', 'de', 'fr', 'ru', 'es', 'pt', 'it', 'ar'].includes(base) ? base : undefined;
}

function uniqueHotwords(list: string[] | undefined, exclude: Set<string>, max: number): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    if (out.length >= max) break;
    const text = normalizeHotword(raw);
    if (!text || exclude.has(text)) continue;
    exclude.add(text);
    out.push(text);
  }
  return out;
}

function splitContext(text: string, turnChars: number, maxTurns: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const turns: string[] = [];
  for (let i = 0; i < clean.length && turns.length < maxTurns; i += turnChars) {
    turns.push(clean.slice(i, i + turnChars));
  }
  return turns;
}

interface PreparedBiasing {
  vocabularyId?: string;
  vocabularyOutcome: VocabularyOutcome;
  /** parameters.vocabulary {term: weight} */
  instant: Record<string, number>;
  superCount: number;
  instantCount: number;
  /** context text (already trimmed to the model's limits) */
  contextText: string;
}

async function prepareBiasing(model: string, caps: AlibabaModelCapabilities, opts: AlibabaTranscribeOptions): Promise<PreparedBiasing> {
  const config = getAlibabaAsrConfig();
  const base = toBaseLanguage(opts.languageCode);
  const chinese = base === 'zh' || base === 'yue';
  const useGlossary = opts.glossary !== 'none' && chinese;
  const script = scriptForLanguageCode(opts.languageCode);

  let vocabularyId: string | undefined;
  let vocabularyOutcome: VocabularyOutcome = 'none';
  const instant: Record<string, number> = {};
  const used = new Set<string>();

  // Glossary: precompiled vocabulary (cached), else instant hotwords as a fallback
  if (useGlossary && caps.vocabularyId) {
    const vocab = await ensureGlossaryVocabulary(model, script);
    vocabularyId = vocab.id;
    vocabularyOutcome = vocab.outcome;
    if (!vocabularyId && caps.instantVocabulary) {
      for (const term of vocab.terms) instant[term.text] = term.weight;
    }
  }

  // Caller hotwords: super (weight 50) when supported, else normal per-request hotwords
  const superWords = uniqueHotwords(opts.superHotwords, used, caps.superHotwords ? MAX_SUPER_HOTWORDS : MAX_VOCABULARY_TERMS);
  const callerWords = uniqueHotwords(opts.hotwords, used, MAX_VOCABULARY_TERMS);
  let superCount = 0;
  let instantCount = 0;
  if (caps.instantVocabulary) {
    // Caller words override a glossary weight for the same term; total stays <= 2000
    const budget = () => MAX_VOCABULARY_TERMS - Object.keys(instant).length;
    for (const word of superWords) {
      if (!(word in instant) && budget() <= 0) break;
      instant[word] = caps.superHotwords ? SUPER_HOTWORD_WEIGHT : 5;
      if (caps.superHotwords) superCount++; else instantCount++;
    }
    for (const word of callerWords) {
      if (!(word in instant) && budget() <= 0) break;
      instant[word] = config.hotwordWeight;
      instantCount++;
    }
  }

  // Context text
  let contextText = '';
  if (caps.context !== 'none') {
    const parts: string[] = [];
    if (opts.context?.trim()) parts.push(opts.context.trim());
    if (caps.context === 'system') {
      // qwen3-asr-flash has no hotword API: caller terms (and optionally glossary terms) go into the context
      const terms = [...superWords, ...callerWords];
      if (terms.length) parts.push(`板书/关键术语：${terms.join('、')}`);
      if (useGlossary && config.contextGlossaryTerms > 0) {
        const glossary = glossaryVocabulary(script, 1).map(term => term.text).filter(term => !used.has(term)).slice(0, config.contextGlossaryTerms);
        if (glossary.length) parts.push(`中医术语：${glossary.join('、')}`);
      }
      contextText = parts.join('\n').slice(0, QWEN3_CONTEXT_MAX_CHARS);
    } else {
      contextText = parts.join('\n').slice(0, QWEN_AUDIO_CONTEXT_TURN_CHARS * QWEN_AUDIO_CONTEXT_MAX_TURNS);
    }
  }

  return { vocabularyId, vocabularyOutcome, instant, superCount, instantCount, contextText };
}

// ---------------------------------------------------------------------------
// Async file transcription
// ---------------------------------------------------------------------------

interface TaskOutcome {
  output: any;
  taskMs: number;
}

async function waitForTask(taskId: string, deadline: number): Promise<TaskOutcome> {
  const config = getAlibabaAsrConfig();
  const started = Date.now();
  let delay = 1500;
  let lastLog = started;
  for (;;) {
    const response = await requestJson('GET', `${config.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, { retries: 5, timeoutMs: 30000 });
    const output = response?.output ?? {};
    const status = String(output.task_status || '');
    if (status === 'SUCCEEDED') return { output, taskMs: Date.now() - started };
    if (status === 'FAILED' || status === 'UNKNOWN' || status === 'CANCELED') {
      throw new AlibabaAsrError(
        `Alibaba ASR task ${taskId} ${status}${output.code ? ` (${output.code})` : ''}${output.message ? `: ${output.message}` : ''}`,
        { code: output.code, retryable: false }
      );
    }
    if (Date.now() + delay > deadline) {
      throw new AlibabaAsrError(`Alibaba ASR task ${taskId} still ${status || 'pending'} after ${Math.round((Date.now() - started) / 1000)}s (timeout)`, { retryable: false });
    }
    if (Date.now() - lastLog >= 60000) {
      lastLog = Date.now();
      console.log(`⏳ Alibaba ASR task ${taskId}: ${status || 'pending'} after ${Math.round((Date.now() - started) / 1000)}s`);
    }
    await sleep(delay);
    delay = Math.min(15000, Math.round(delay * 1.5));
  }
}

export interface ParsedTranscription {
  transcript: string;
  segments: Array<{ startTime: number; endTime: number; text: string }>;
  durationSeconds?: number;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Parse the transcription_url JSON (transcripts[].sentences[] with ms timestamps). */
export function parseTranscriptionJson(json: any): ParsedTranscription {
  const transcripts: any[] = Array.isArray(json?.transcripts) ? json.transcripts : [];
  const channel = transcripts.find(t => Number(t?.channel_id ?? 0) === 0) ?? transcripts[0];
  const sentences: any[] = Array.isArray(channel?.sentences) ? channel.sentences : [];
  const segments = sentences
    .map(sentence => ({
      startTime: round3(Number(sentence?.begin_time ?? 0) / 1000),
      endTime: round3(Number(sentence?.end_time ?? 0) / 1000),
      text: String(sentence?.text ?? '').trim()
    }))
    .filter(segment => segment.text.length > 0);
  const joined = segments.reduce((acc, segment) => joinTextFragments(acc, segment.text), '');
  const transcript = (joined || String(channel?.text ?? '')).trim();
  const ms = Number(json?.properties?.original_duration_in_milliseconds);
  return { transcript, segments, durationSeconds: Number.isFinite(ms) && ms > 0 ? ms / 1000 : undefined };
}

async function transcribeAsync(
  filePath: string,
  model: string,
  caps: AlibabaModelCapabilities,
  opts: AlibabaTranscribeOptions,
  biasing: PreparedBiasing,
  deadline: number,
  timings: { uploadMs?: number; taskMs?: number; taskId?: string }
): Promise<ParsedTranscription> {
  const config = getAlibabaAsrConfig();
  const uploadStarted = Date.now();
  const fileUrl = await uploadTemporaryFile(model, filePath);
  timings.uploadMs = Date.now() - uploadStarted;

  const language = alibabaLanguageHint(opts.languageCode);
  const buildBody = (vocabularyId: string | undefined) => {
    const input: Record<string, unknown> = caps.family === 'qwen3-filetrans' ? { file_url: fileUrl } : { file_urls: [fileUrl] };
    const parameters: Record<string, unknown> = { channel_id: [0] };
    if (caps.family === 'qwen3-filetrans') {
      if (language) parameters.language = language;
      parameters.enable_itn = false;
      parameters.enable_words = false;
    } else {
      if (language) parameters.language_hints = [language];
      if (vocabularyId) parameters.vocabulary_id = vocabularyId;
      if (Object.keys(biasing.instant).length > 0) parameters.vocabulary = biasing.instant;
      if (biasing.contextText && caps.context === 'messages') {
        input.context = splitContext(biasing.contextText, QWEN_AUDIO_CONTEXT_TURN_CHARS, QWEN_AUDIO_CONTEXT_MAX_TURNS)
          .map(text => ({ role: 'user', content: [{ type: 'input_text', text }] }));
      }
    }
    return { model, input, parameters };
  };

  const submit = (vocabularyId: string | undefined) => requestJson('POST', `${config.baseUrl}/api/v1/services/audio/asr/transcription`, {
    body: buildBody(vocabularyId),
    headers: { 'X-DashScope-Async': 'enable', 'X-DashScope-OssResourceResolve': 'enable' },
    retries: 3,
    timeoutMs: 60000,
    // A timed-out submit may already have created a billed task: do not resubmit blindly
    idempotent: false
  });

  let submitted: any;
  try {
    submitted = await submit(biasing.vocabularyId);
  } catch (error) {
    if (biasing.vocabularyId && isVocabularyError(error)) {
      console.warn(`⚠️ Alibaba ASR rejected vocabulary ${biasing.vocabularyId} (${(error as Error).message}); retrying without it`);
      invalidateVocabulary(biasing.vocabularyId);
      biasing.vocabularyId = undefined;
      biasing.vocabularyOutcome = 'none';
      submitted = await submit(undefined);
    } else {
      throw error;
    }
  }
  const taskId = submitted?.output?.task_id;
  if (!taskId) throw new AlibabaAsrError('Alibaba ASR submit returned no task_id', { retryable: false });
  timings.taskId = String(taskId);
  console.log(`⏳ Alibaba ASR task ${taskId} submitted (${model})`);

  const { output, taskMs } = await waitForTask(String(taskId), deadline);
  timings.taskMs = taskMs;
  const result = Array.isArray(output.results) ? output.results[0] : output.result;
  if (!result) throw new AlibabaAsrError(`Alibaba ASR task ${taskId} succeeded without a result`, { retryable: false });
  if (result.subtask_status && result.subtask_status !== 'SUCCEEDED') {
    throw new AlibabaAsrError(
      `Alibaba ASR subtask ${result.subtask_status}${result.code ? ` (${result.code})` : ''}${result.message ? `: ${result.message}` : ''}`,
      { code: result.code, retryable: false }
    );
  }
  if (!result.transcription_url) throw new AlibabaAsrError(`Alibaba ASR task ${taskId} has no transcription_url`, { retryable: false });
  const json = await requestJson('GET', String(result.transcription_url), { auth: false, retries: 4, timeoutMs: 60000 });
  return parseTranscriptionJson(json);
}

// ---------------------------------------------------------------------------
// Sync (short audio) recognition, chunked
// ---------------------------------------------------------------------------

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data.toString(); });
    child.on('error', error => reject(new Error(`Failed to start ffmpeg: ${error.message}`)));
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed (code ${code}): ${stderr.slice(-400)}`))));
  });
}

/** Sync calls normally take ~5 s per 2 min of audio, but occasionally stall: time out early and retry. */
function syncRequestTimeoutMs(chunkSeconds: number): number {
  return Math.max(45000, Math.round(30000 + chunkSeconds * 400));
}

async function syncRecognize(
  chunkPath: string,
  chunkSeconds: number,
  model: string,
  caps: AlibabaModelCapabilities,
  opts: AlibabaTranscribeOptions,
  biasing: PreparedBiasing,
  signal?: AbortSignal
): Promise<string> {
  const config = getAlibabaAsrConfig();
  const dataUri = `data:audio/wav;base64,${fs.readFileSync(chunkPath).toString('base64')}`;
  const language = alibabaLanguageHint(opts.languageCode);
  let body: Record<string, unknown>;
  if (caps.family === 'qwen3-sync') {
    const messages: any[] = [];
    if (biasing.contextText) messages.push({ role: 'system', content: [{ text: biasing.contextText }] });
    messages.push({ role: 'user', content: [{ audio: dataUri }] });
    body = {
      model,
      input: { messages },
      parameters: { asr_options: { ...(language ? { language } : {}), enable_itn: false } }
    };
  } else {
    const messages: any[] = [];
    if (biasing.contextText && caps.context === 'messages') {
      for (const text of splitContext(biasing.contextText, QWEN_AUDIO_CONTEXT_TURN_CHARS, QWEN_AUDIO_CONTEXT_MAX_TURNS)) {
        messages.push({ role: 'user', content: [{ type: 'input_text', text }] });
      }
    }
    messages.push({ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] });
    const parameters: Record<string, unknown> = { format: 'wav', sample_rate: '16000' };
    if (language) parameters.language_hints = [language];
    if (biasing.vocabularyId) parameters.vocabulary_id = biasing.vocabularyId;
    if (Object.keys(biasing.instant).length > 0) parameters.vocabulary = biasing.instant;
    body = { model, input: { messages }, parameters };
  }
  const response = await requestJson('POST', `${config.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    body,
    headers: { 'X-DashScope-SSE': 'disable' },
    retries: 4,
    timeoutMs: syncRequestTimeoutMs(chunkSeconds),
    signal
  });
  const output = response?.output ?? {};
  if (caps.family === 'qwen3-sync') {
    const content = output?.choices?.[0]?.message?.content;
    if (Array.isArray(content)) return content.map((part: any) => String(part?.text ?? '')).join('').trim();
    return typeof content === 'string' ? content.trim() : '';
  }
  return String(output?.text ?? output?.sentence?.text ?? '').trim();
}

/**
 * Runs fn over items with at most `limit` in flight. On the first failure the shared signal is aborted
 * (in-flight requests stop, no new items start) and all workers are awaited before the error is rethrown,
 * so the caller's cleanup never races a still-running worker.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const controller = new AbortController();
  let next = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (!controller.signal.aborted && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], controller.signal);
      } catch (error) {
        if (firstError === undefined) firstError = error;
        controller.abort();
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

async function transcribeSyncChunked(
  filePath: string,
  model: string,
  caps: AlibabaModelCapabilities,
  opts: AlibabaTranscribeOptions,
  biasing: PreparedBiasing,
  duration: number,
  deadline: number
): Promise<ParsedTranscription & { chunks: number }> {
  const config = getAlibabaAsrConfig();
  // Lazy import: audio-transcription imports this module at load time
  const { planAudioChunks } = await import('./audio-transcription');
  const plan = await planAudioChunks(filePath, duration, {
    maxChunkSeconds: config.syncChunkSeconds,
    minChunkSeconds: Math.max(10, Math.round(config.syncChunkSeconds * 0.5))
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'alibaba-asr-'));
  try {
    const chunks = plan.chunks.map((chunk, index) => ({ ...chunk, index, path: path.join(workDir, `chunk_${String(index).padStart(4, '0')}.wav`) }));
    const pending = chunks.filter(chunk => !chunk.silent);
    console.log(`✂️ Alibaba ASR (${model}): ${chunks.length} chunk(s) <= ${config.syncChunkSeconds}s (${plan.method}), ${pending.length} to recognise`);
    const texts = await mapLimit(pending, config.concurrency, async (chunk, signal) => {
      if (Date.now() > deadline) throw new AlibabaAsrError('Alibaba ASR timed out (sync chunks)', { retryable: false });
      await runFfmpeg([
        '-hide_banner', '-nostats', '-y',
        '-ss', chunk.start.toFixed(3), '-t', (chunk.end - chunk.start).toFixed(3),
        '-i', filePath, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', chunk.path
      ]);
      if (signal.aborted) throw new AlibabaAsrError('Alibaba ASR chunk cancelled', { retryable: false });
      const text = await syncRecognize(chunk.path, chunk.end - chunk.start, model, caps, opts, biasing, signal);
      fs.rmSync(chunk.path, { force: true });
      console.log(`✅ Alibaba ASR chunk ${chunk.index + 1}/${chunks.length} (${chunk.start.toFixed(1)}-${chunk.end.toFixed(1)}s): ${Array.from(text).length} chars`);
      return { chunk, text };
    });
    const segments = texts
      .filter(item => item.text)
      .map(item => ({ startTime: round3(item.chunk.start), endTime: round3(item.chunk.end), text: item.text }));
    const transcript = segments.reduce((acc, segment) => joinTextFragments(acc, segment.text), '').trim();
    return { transcript, segments, durationSeconds: duration, chunks: chunks.length };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

async function probeDuration(filePath: string): Promise<number> {
  const { probeAudioDuration } = await import('./audio-transcription');
  return probeAudioDuration(filePath);
}

/** Large WAV files are re-encoded to FLAC (lossless, ~half the size) before upload. */
async function prepareUploadFile(filePath: string): Promise<{ path: string; cleanup: () => void }> {
  const size = fs.statSync(filePath).size;
  if (path.extname(filePath).toLowerCase() !== '.wav' || size < 20 * 1024 * 1024) {
    return { path: filePath, cleanup: () => undefined };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alibaba-upload-'));
  const target = path.join(dir, 'audio.flac');
  try {
    await runFfmpeg(['-hide_banner', '-nostats', '-y', '-i', filePath, '-ac', '1', '-ar', '16000', '-c:a', 'flac', target]);
    console.log(`🗜️ Alibaba ASR: WAV ${(size / 1048576).toFixed(1)} MB -> FLAC ${(fs.statSync(target).size / 1048576).toFixed(1)} MB for upload`);
    return { path: target, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (error: any) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.warn(`⚠️ FLAC re-encode failed (${error?.message || error}); uploading the WAV`);
    return { path: filePath, cleanup: () => undefined };
  }
}

/**
 * Transcribe a whole audio file with Alibaba Model Studio.
 * Async (filetrans) models get the whole file in one task; sync models (qwen3-asr-flash, *-asr-flash)
 * get pause-aligned chunks of <= ALIBABA_ASR_SYNC_CHUNK_SECONDS. Throws AlibabaAsrError on failure.
 */
export async function transcribeWithAlibaba(audioFilePath: string, opts: AlibabaTranscribeOptions): Promise<AlibabaTranscribeResult> {
  const reason = alibabaUnavailableReason();
  if (reason) throw new AlibabaAsrError(`Alibaba ASR is not available: ${reason}`, { retryable: false });
  if (!fs.existsSync(audioFilePath)) throw new AlibabaAsrError(`Audio file not found: ${audioFilePath}`, { retryable: false });

  const config = getAlibabaAsrConfig();
  const model = (opts.model || config.model).trim();
  const caps = alibabaModelCapabilities(model);
  const started = Date.now();
  const duration = await probeDuration(audioFilePath).catch(() => 0);
  // Never hang: explicit timeout, else 10 min + the audio duration (async tasks normally take seconds)
  const timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : 10 * 60 * 1000 + Math.round(duration * 1000);
  const deadline = started + timeoutMs;

  const biasing = await prepareBiasing(model, caps, opts);
  console.log(
    `🎧 Alibaba ASR: model ${model} (${caps.family}), language ${alibabaLanguageHint(opts.languageCode) || 'auto'}, ` +
    `${duration ? `${duration.toFixed(1)}s audio, ` : ''}glossary vocabulary ${biasing.vocabularyId ? `${biasing.vocabularyId} (${biasing.vocabularyOutcome})` : 'none'}, ` +
    `${biasing.instantCount} hotword(s), ${biasing.superCount} super hotword(s), context ${biasing.contextText.length} chars`
  );

  const timings: { uploadMs?: number; taskMs?: number; taskId?: string } = {};
  let parsed: ParsedTranscription;
  let chunkCount: number | undefined;
  if (caps.async) {
    const upload = await prepareUploadFile(audioFilePath);
    try {
      parsed = await transcribeAsync(upload.path, model, caps, opts, biasing, deadline, timings);
    } finally {
      upload.cleanup();
    }
  } else {
    const result = await transcribeSyncChunked(audioFilePath, model, caps, opts, biasing, duration, deadline);
    parsed = result;
    chunkCount = result.chunks;
  }

  const totalMs = Date.now() - started;
  console.log(`✅ Alibaba ASR done in ${(totalMs / 1000).toFixed(1)}s: ${Array.from(parsed.transcript).length} chars, ${parsed.segments.length} segment(s)`);
  return {
    transcript: parsed.transcript,
    languageCode: opts.languageCode,
    model,
    segments: parsed.segments.length > 0 ? parsed.segments : undefined,
    durationSeconds: parsed.durationSeconds ?? (duration || undefined),
    details: {
      family: caps.family,
      vocabularyId: biasing.vocabularyId,
      vocabulary: biasing.vocabularyOutcome,
      instantHotwords: biasing.instantCount,
      superHotwords: biasing.superCount,
      contextChars: biasing.contextText.length,
      chunks: chunkCount,
      uploadMs: timings.uploadMs,
      taskMs: timings.taskMs,
      totalMs,
      taskId: timings.taskId
    }
  };
}
