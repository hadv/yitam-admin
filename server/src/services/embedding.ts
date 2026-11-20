import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

// Load .env file from the server directory
dotenv.config();

// Gemini configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
if (!GEMINI_API_KEY) {
  console.warn('GEMINI_API_KEY is not set in environment variables. Please add it to your .env file.');
}

export const GEMINI_VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10);
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-001';

// Retries for transient failures only (429 rate limit, 5xx, network). Billing / auth / bad requests fail at once.
const EMBEDDING_MAX_RETRIES = Math.max(0, parseInt(process.env.EMBEDDING_MAX_RETRIES || '3', 10) || 0);
const EMBEDDING_RETRY_BASE_MS = 1000;
const EMBEDDING_RETRY_MAX_MS = 15000;

// Task type mapping for the new API
export enum TaskType {
  RETRIEVAL_DOCUMENT = 'RETRIEVAL_DOCUMENT',
  RETRIEVAL_QUERY = 'RETRIEVAL_QUERY',
  SEMANTIC_SIMILARITY = 'SEMANTIC_SIMILARITY',
  CLASSIFICATION = 'CLASSIFICATION',
  CLUSTERING = 'CLUSTERING'
}

/**
 * Why an embedding could not be created.
 * - billing:          402 / prepaid credits depleted / daily quota exhausted - top up the Gemini project
 * - auth:             401 / 403 / invalid or missing GEMINI_API_KEY
 * - rate_limit:       429 that is still failing after the retries
 * - transient:        5xx / network error that is still failing after the retries
 * - invalid_request:  other 4xx (e.g. empty or oversized text)
 * - invalid_response: Gemini answered without a usable vector
 */
export type EmbeddingErrorKind =
  | 'billing'
  | 'auth'
  | 'rate_limit'
  | 'transient'
  | 'invalid_request'
  | 'invalid_response';

/**
 * Thrown by createEmbedding when no real embedding could be produced.
 * Callers must NOT store the item (there is no fallback vector any more) and should surface
 * `message` to the user; `httpStatus` is a suitable status for an API response.
 */
export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;
  /** HTTP status returned by the Gemini API, when there was one. */
  readonly status?: number;
  /** True when trying again later (without changing configuration) may succeed. */
  readonly retryable: boolean;
  /** Wait the provider asked for before retrying (RetryInfo / "Please retry in Ns"), when given. */
  readonly retryAfterMs?: number;

  constructor(kind: EmbeddingErrorKind, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'EmbeddingError';
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = kind === 'rate_limit' || kind === 'transient';
    Object.setPrototypeOf(this, EmbeddingError.prototype);
  }

  /** Status code for an API response that reports this failure. */
  get httpStatus(): number {
    // The embedding provider is unavailable: 503 tells the client the request itself was fine
    if (this.kind === 'invalid_request') return 422;
    if (this.kind === 'invalid_response') return 502;
    return 503;
  }
}

export function isEmbeddingError(error: unknown): error is EmbeddingError {
  return error instanceof EmbeddingError || (error as any)?.name === 'EmbeddingError';
}

/** True when further embedding requests cannot succeed until the configuration / billing is fixed. */
export function isFatalEmbeddingError(error: unknown): error is EmbeddingError {
  return isEmbeddingError(error) && (error.kind === 'billing' || error.kind === 'auth');
}

/** Remove the API key from a text (Gemini error bodies never contain it, but keep logs safe anyway). */
function redact(text: string): string {
  let out = String(text ?? '');
  if (GEMINI_API_KEY) out = out.split(GEMINI_API_KEY).join('<REDACTED>');
  return out.replace(/AIza[0-9A-Za-z_\-]{20,}/g, '<REDACTED>');
}

/** Pull the human message out of a Gemini error body like {"error":{"code":402,"message":"..."}} */
function providerMessage(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const msg = parsed?.error?.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // not JSON
  }
  return raw.trim();
}

const BILLING_RE = /credits are depleted|prepayment|billing|payment required|insufficient (balance|quota|funds)/i;
// For HTTP 429 only explicit depletion counts as billing: the standard Gemini 429 text says
// "You exceeded your current quota, please check your plan and billing details" even for per-minute limits.
const DEPLETED_RE = /credits are depleted|prepayment|payment required|insufficient (balance|funds)/i;
// Daily quotas show up in the error details' quotaId, e.g. "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier"
const DAILY_QUOTA_RE = /per[ _-]?day|daily/i;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * How long the provider asked us to wait, from RetryInfo ("retryDelay": "12s") or the
 * message text ("Please retry in 12.3s" / "...in 850ms"). Undefined when not given.
 */
function providerRetryAfterMs(raw: string): number | undefined {
  const m = raw.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i) ||
    raw.match(/retry in (\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (!m) return undefined;
  const value = parseFloat(m[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(m[2]?.toLowerCase() === 'ms' ? value : value * 1000);
}

/** Map a raw Gemini SDK / network error to an EmbeddingError. */
export function classifyEmbeddingError(error: unknown): EmbeddingError {
  if (isEmbeddingError(error)) return error;
  const e = error as any;
  const rawStatus = Number(e?.status ?? e?.code ?? e?.response?.status);
  const status = Number.isFinite(rawStatus) && rawStatus >= 100 && rawStatus < 600 ? rawStatus : undefined;
  // The SDK's message is the whole error body (message + details such as QuotaFailure / RetryInfo)
  const raw = redact(String(e?.message ?? e ?? 'unknown error'));
  const detail = redact(providerMessage(raw)).slice(0, 500);
  const where = `Gemini embedding API (${GEMINI_EMBEDDING_MODEL})`;

  if (status === 402 || (status !== undefined && status !== 429 && BILLING_RE.test(detail))) {
    return new EmbeddingError(
      'billing',
      `${where} refused the request (HTTP ${status ?? '?'}): the Gemini project behind GEMINI_API_KEY is out of credits / billing is not active. ` +
      `Top up or enable billing at https://ai.studio/projects, or set GEMINI_API_KEY to a key with credits. Provider message: ${detail}`,
      status
    );
  }
  if (status === 401 || status === 403) {
    return new EmbeddingError(
      'auth',
      `${where} rejected GEMINI_API_KEY (HTTP ${status}): the key is invalid, revoked, or not allowed to use ${GEMINI_EMBEDDING_MODEL}. Provider message: ${detail}`,
      status
    );
  }
  if (status === 400 && /api key/i.test(detail)) {
    return new EmbeddingError('auth', `${where} rejected GEMINI_API_KEY (HTTP 400): ${detail}`, status);
  }
  if (status === 429) {
    if (DAILY_QUOTA_RE.test(raw) || DEPLETED_RE.test(raw)) {
      return new EmbeddingError(
        'billing',
        `${where} quota is exhausted for the Gemini project behind GEMINI_API_KEY (HTTP 429). ` +
        `Wait for the quota to reset or raise it / enable billing at https://ai.studio/projects. Provider message: ${detail}`,
        status
      );
    }
    return new EmbeddingError(
      'rate_limit',
      `${where} is rate limiting requests (HTTP 429) for GEMINI_API_KEY; try again shortly, or check the project's quota / billing. Provider message: ${detail}`,
      status,
      providerRetryAfterMs(raw)
    );
  }
  if (status !== undefined && status >= 500) {
    return new EmbeddingError('transient', `${where} is unavailable (HTTP ${status}). Provider message: ${detail}`, status, providerRetryAfterMs(raw));
  }
  if (status !== undefined && status >= 400) {
    return new EmbeddingError('invalid_request', `${where} rejected the request (HTTP ${status}). Provider message: ${detail}`, status);
  }
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (NETWORK_CODES.has(code) || /fetch failed|network|socket|timed? ?out/i.test(detail)) {
    return new EmbeddingError('transient', `Could not reach the ${where}${code ? ` (${code})` : ''}: ${detail}`);
  }
  return new EmbeddingError('transient', `${where} call failed: ${detail}`);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Upper bound for honouring a provider-requested wait (Gemini per-minute limits ask for up to ~60s)
const EMBEDDING_RETRY_AFTER_MAX_MS = 65000;

function retryDelayMs(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(EMBEDDING_RETRY_MAX_MS, EMBEDDING_RETRY_BASE_MS * 2 ** attempt);
  const backoff = Math.round(base / 2 + Math.random() * (base / 2));
  if (retryAfterMs === undefined) return backoff;
  // Wait at least as long as the provider asked (plus a little jitter), within a sane cap
  return Math.max(backoff, Math.min(EMBEDDING_RETRY_AFTER_MAX_MS, retryAfterMs + Math.round(Math.random() * 500)));
}

/**
 * Generate an embedding vector for the provided text with Gemini (gemini-embedding-001).
 *
 * There is deliberately NO fallback: on failure this throws an EmbeddingError (after a short
 * retry with backoff for 429 / 5xx / network errors). Never store a chunk whose embedding failed.
 *
 * @param text The text to generate an embedding for
 * @param taskType TaskType enum value for the embedding purpose
 * @returns A vector of GEMINI_VECTOR_SIZE numbers
 */
export const createEmbedding = async (
  text: string,
  taskType: TaskType = TaskType.RETRIEVAL_DOCUMENT
): Promise<number[]> => {
  if (!GEMINI_API_KEY) {
    throw new EmbeddingError('auth', 'GEMINI_API_KEY is not set: embeddings (gemini-embedding-001) cannot be created. Add it to server/.env.');
  }
  if (typeof text !== 'string' || !text.trim()) {
    throw new EmbeddingError('invalid_request', 'Cannot create an embedding for empty text.');
  }
  return generateGeminiEmbedding(text, taskType);
};

/**
 * Throw unless `vector` is a usable embedding of the configured size (finite numbers, non-zero).
 * Guards every write to the vector store so a bad vector can never be persisted.
 */
export function assertValidEmbedding(vector: unknown, label = 'embedding', expectedSize = GEMINI_VECTOR_SIZE): asserts vector is number[] {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new EmbeddingError('invalid_response', `${label}: missing embedding vector; refusing to store it.`);
  }
  if (vector.length !== expectedSize) {
    throw new EmbeddingError('invalid_response', `${label}: embedding has ${vector.length} dimensions, expected ${expectedSize} (GEMINI_VECTOR_SIZE); refusing to store it.`);
  }
  let sumSquares = 0;
  for (const x of vector) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new EmbeddingError('invalid_response', `${label}: embedding contains a non-finite value; refusing to store it.`);
    }
    sumSquares += x * x;
  }
  if (sumSquares === 0) {
    throw new EmbeddingError('invalid_response', `${label}: embedding is an all-zero vector; refusing to store it.`);
  }
}

/** Minimal payload shape needed to pick the text a stored chunk was embedded from. */
export interface EmbeddablePayload {
  documentName?: string;
  title?: string;
  content?: string;
  enhancedContent?: string;
}

/** Audio-transcript chunks (audio-transcript-processor) are recognisable by their fixed name / title. */
export function isAudioTranscriptChunk(payload: EmbeddablePayload): boolean {
  return (typeof payload.documentName === 'string' && payload.documentName.endsWith('(Audio Transcript)')) ||
    (typeof payload.title === 'string' && payload.title.startsWith('Audio Transcript Part '));
}

/**
 * The text a stored chunk's vector is (re)created from, matching what ingestion embedded:
 * - audio transcript chunks (audio-transcript-processor): enhancedContent || content
 * - documents (chunking.ts) and YouTube captions (youtube-transcript.ts): content
 *   (their enhancedContent is added after the embedding is made, from the same content)
 */
export function embeddingTextForPayload(payload: EmbeddablePayload): string {
  const content = typeof payload.content === 'string' ? payload.content : '';
  if (isAudioTranscriptChunk(payload)) {
    const enhanced = typeof payload.enhancedContent === 'string' ? payload.enhancedContent : '';
    return enhanced.trim() ? enhanced : content;
  }
  return content;
}

/**
 * Generate embedding using Google's Gemini API
 *
 * @param text Text to generate embedding for
 * @param taskType Task type from TaskType enum
 * @returns Vector representation of the text
 */
async function generateGeminiEmbedding(
  text: string,
  taskType: TaskType
): Promise<number[]> {
  // Gemini has a payload size limit of ~32KB
  // Chunk the text if it's too large (approximately 8K characters to be conservative)
  const MAX_CHUNK_SIZE = 8000;

  if (text.length <= MAX_CHUNK_SIZE) {
    // Text is small enough to process as a single chunk
    return embedChunkWithRetry(text, taskType);
  }

  console.log(`Text is too large (${text.length} chars), chunking into smaller pieces...`);

  // Chunk by paragraphs or sentences to maintain context
  const chunks = chunkText(text, MAX_CHUNK_SIZE).filter(chunk => chunk.trim().length > 0);
  console.log(`Created ${chunks.length} chunks`);

  if (chunks.length === 0) {
    throw new EmbeddingError('invalid_request', 'Text could not be split into embeddable pieces.');
  }

  if (chunks.length === 1) {
    return embedChunkWithRetry(chunks[0], taskType);
  }

  // For multiple chunks, use the average of all chunk embeddings (sequential: gentler on rate limits,
  // and the first failure stops the rest)
  const chunkEmbeddings: number[][] = [];
  for (const chunk of chunks) {
    chunkEmbeddings.push(await embedChunkWithRetry(chunk, taskType));
  }

  const embeddingSize = chunkEmbeddings[0].length;
  const averageEmbedding = new Array(embeddingSize).fill(0);
  for (const embedding of chunkEmbeddings) {
    for (let i = 0; i < embeddingSize; i++) {
      averageEmbedding[i] += embedding[i] / chunks.length;
    }
  }
  return averageEmbedding;
}

/** One Gemini call, retried with backoff for transient failures only. */
async function embedChunkWithRetry(chunk: string, taskType: TaskType): Promise<number[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedChunkOnce(chunk, taskType);
    } catch (error) {
      const embeddingError = classifyEmbeddingError(error);
      if (!embeddingError.retryable || attempt >= EMBEDDING_MAX_RETRIES) {
        if (attempt > 0) {
          throw new EmbeddingError(embeddingError.kind, `${embeddingError.message} (gave up after ${attempt + 1} attempts)`, embeddingError.status, embeddingError.retryAfterMs);
        }
        throw embeddingError;
      }
      const delay = retryDelayMs(attempt, embeddingError.retryAfterMs);
      console.warn(`⚠️ Embedding attempt ${attempt + 1} failed (${embeddingError.kind}${embeddingError.status ? ` ${embeddingError.status}` : ''}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

async function embedChunkOnce(chunk: string, taskType: TaskType): Promise<number[]> {
  const ai = new GoogleGenAI({
    apiKey: GEMINI_API_KEY
  });

  const result = await ai.models.embedContent({
    model: GEMINI_EMBEDDING_MODEL,
    contents: chunk,
    config: {
      taskType,
      outputDimensionality: GEMINI_VECTOR_SIZE
    }
  });

  // The response contains embeddings array, we want the first one
  const values = result.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new EmbeddingError('invalid_response', 'Gemini embedding API returned no embedding values.');
  }
  if (values.length !== GEMINI_VECTOR_SIZE) {
    throw new EmbeddingError('invalid_response', `Gemini embedding API returned ${values.length} dimensions, expected ${GEMINI_VECTOR_SIZE} (GEMINI_VECTOR_SIZE).`);
  }
  return values;
}

/**
 * Split text into chunks that don't exceed the maximum size
 * Tries to split on paragraph boundaries first, then sentences if needed
 */
export function chunkText(text: string, maxChunkSize: number): string[] {
  // Split by paragraphs first (double newlines)
  const paragraphs = text.split(/\n\s*\n/);

  const chunks: string[] = [];
  let currentChunk = '';

  for (const paragraph of paragraphs) {
    // If a single paragraph is too big, we'll need to split by sentences
    if (paragraph.length > maxChunkSize) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      // Split by sentences (period + space or newline)
      const sentences = paragraph.split(/\.\s+|\.\n/);

      for (const sentence of sentences) {
        // Skip empty sentences
        if (!sentence || sentence.trim() === '') continue;

        const trimmedSentence = sentence.trim() + '.'; // Add period back since we split on it

        if (trimmedSentence.length > maxChunkSize) {
          // If even a sentence is too long, split by word boundaries
          const words = trimmedSentence.split(/\s+/).filter(word => word.trim() !== '');
          let sentenceChunk = '';

          for (const word of words) {
            if ((sentenceChunk + ' ' + word).length <= maxChunkSize) {
              sentenceChunk += (sentenceChunk ? ' ' : '') + word;
            } else {
              if (sentenceChunk) chunks.push(sentenceChunk);
              sentenceChunk = word;
            }
          }

          if (sentenceChunk) chunks.push(sentenceChunk);
        } else {
          // Sentence fits in a chunk
          if ((currentChunk + '. ' + trimmedSentence).length <= maxChunkSize) {
            currentChunk += (currentChunk ? '. ' : '') + trimmedSentence;
          } else {
            if (currentChunk) chunks.push(currentChunk);
            currentChunk = trimmedSentence;
          }
        }
      }
    } else {
      // Paragraph fits in a chunk
      if ((currentChunk + '\n\n' + paragraph).length <= maxChunkSize) {
        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
      } else {
        if (currentChunk) chunks.push(currentChunk);
        currentChunk = paragraph;
      }
    }

    // Extra check - if current chunk is getting large, finalize it
    if (currentChunk.length > maxChunkSize * 0.9) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}