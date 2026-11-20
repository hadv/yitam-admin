/**
 * Generative LLM client (text + vision) on Alibaba Cloud Model Studio (DashScope, Qwen),
 * OpenAI-compatible chat/completions endpoint, international / Singapore region.
 *
 * Embeddings are NOT handled here: they stay on Gemini (see embedding.ts), because the
 * Qdrant collection is shared with yitam-mcp at gemini-embedding-001 / 768 dims.
 *
 * Tasks map to models (env overridable):
 *  - 'fast'    short metadata / titles / summaries / cleaning   (ALIBABA_LLM_FAST_MODEL,    default qwen3.8-flash)
 *  - 'quality' term correction, careful Vietnamese TCM wording  (ALIBABA_LLM_QUALITY_MODEL, default qwen3.7-plus)
 *  - 'vision'  blackboard / slide OCR from video frames          (ALIBABA_LLM_VISION_MODEL,  default qwen3.8-flash)
 *
 * Behaviour:
 *  - "thinking" is always disabled (top-level enable_thinking:false). qwen3.5+ models think by
 *    default; max_tokens does not cap the reasoning, and it did not help OCR or term correction.
 *  - json:true sends response_format json_object (the API requires the word "json" in the
 *    messages; it is added to the system message when missing). jsonSchema sends a strict
 *    json_schema and falls back to json_object once if the endpoint rejects the schema.
 *  - Retries with exponential backoff (honouring Retry-After) on 429 / 5xx / network errors /
 *    timeouts / empty replies. 4xx (401 key, 403, 404 model, 400 parameter) and billing errors are
 *    never retried; billing errors carry LlmError.billing = true so callers can stop early.
 *  - The API key (DASHSCOPE_API_KEY) is only sent in the Authorization header and is redacted
 *    from every error message and log line.
 */
import dotenv from 'dotenv';

dotenv.config();

export type LlmTask = 'fast' | 'quality' | 'vision';

export type LlmPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; dataBase64: string };

export interface LlmJsonSchema {
  /** Schema name (letters, digits, _ and -). */
  name: string;
  /** JSON Schema of the reply object. Avoid keywords such as uniqueItems / multipleOf (HTTP 400). */
  schema: Record<string, unknown>;
  /** Default true. */
  strict?: boolean;
}

export interface LlmRequest {
  /** User content: plain text, or text + image parts (vision). */
  prompt: string | LlmPart[];
  system?: string;
  /** Default 'fast'. */
  task?: LlmTask;
  /** Explicit model id; overrides the task's model. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Request a JSON object reply (response_format json_object). The raw reply string is returned. */
  json?: boolean;
  /**
   * Optional strict JSON schema (implies json). Preferred for OCR: with json_object the vision model
   * tends to convert traditional characters to simplified in the reply.
   */
  jsonSchema?: LlmJsonSchema;
  /** Per-attempt timeout, default ALIBABA_LLM_TIMEOUT_MS (120 s). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  imageTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  finishReason?: string;
  usage: LlmUsage;
  requestId?: string;
}

export class LlmError extends Error {
  status?: number;
  code?: string;
  requestId?: string;
  retryable: boolean;
  billing: boolean;
  constructor(
    message: string,
    info: { status?: number; code?: string; requestId?: string; retryable?: boolean; billing?: boolean } = {}
  ) {
    super(redact(message));
    this.name = 'LlmError';
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
    this.billing = info.billing ?? isBillingInfo(info.status, info.code, this.message);
    this.retryable = !this.billing && !!info.retryable;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_ASR_BASE_URL = 'https://dashscope-intl.aliyuncs.com';
const DEFAULT_MODELS: Record<LlmTask, string> = {
  fast: 'qwen3.8-flash',
  quality: 'qwen3.7-plus',
  vision: 'qwen3.8-flash'
};
const MODEL_ENV: Record<LlmTask, string> = {
  fast: 'ALIBABA_LLM_FAST_MODEL',
  quality: 'ALIBABA_LLM_QUALITY_MODEL',
  vision: 'ALIBABA_LLM_VISION_MODEL'
};
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 4;
/** DashScope caps the request body at 16 MiB. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function envStr(name: string): string {
  return (process.env[name] || '').trim();
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function apiKey(): string {
  return envStr('DASHSCOPE_API_KEY');
}

function llmEnabled(): boolean {
  return envStr('ALIBABA_LLM_ENABLED').toLowerCase() !== 'false';
}

/** ALIBABA_LLM_BASE_URL, else the ALIBABA_ASR_BASE_URL origin + /compatible-mode/v1. */
export function llmBaseUrl(): string {
  const explicit = envStr('ALIBABA_LLM_BASE_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  const asrBase = envStr('ALIBABA_ASR_BASE_URL') || DEFAULT_ASR_BASE_URL;
  let origin: string;
  try {
    origin = new URL(asrBase).origin;
  } catch {
    origin = DEFAULT_ASR_BASE_URL;
  }
  return `${origin}/compatible-mode/v1`;
}

/** Resolved model id for a task (for logs and result fields). */
export function llmModelFor(task: LlmTask): string {
  return envStr(MODEL_ENV[task]) || DEFAULT_MODELS[task];
}

/** True when ALIBABA_LLM_ENABLED != 'false' and DASHSCOPE_API_KEY is set. */
export function isLlmConfigured(_task: LlmTask = 'fast'): boolean {
  return llmEnabled() && apiKey().length > 0;
}

/** Why the LLM cannot be used (for logs / skip reasons); undefined when it can. */
export function llmUnavailableReason(): string | undefined {
  if (!llmEnabled()) return 'disabled by ALIBABA_LLM_ENABLED=false';
  if (!apiKey()) return 'DASHSCOPE_API_KEY is not set';
  return undefined;
}

/**
 * Approximate input-token limit of a model (undefined = unknown, no pre-flight check).
 * The default models all have a 1M-token window (qwen3.8-flash: 991,808 input tokens without thinking),
 * the same order as Gemini's, so callers that fitted Gemini fit here too.
 */
export function llmInputTokenLimit(model: string): number | undefined {
  const override = intEnv('ALIBABA_LLM_MAX_INPUT_TOKENS', 0, 0, 10_000_000);
  if (override > 0) return override;
  const m = model.toLowerCase();
  if (/^qwen3\.\d+-(flash|plus|max)/.test(m) || /^qwen-(flash|plus)/.test(m)) return 983_000;
  if (/^qwen3-vl-(plus|flash)/.test(m)) return 229_000;
  if (/^qwen-max/.test(m)) return 30_000;
  return undefined;
}

// ---------------------------------------------------------------------------
// Errors / redaction
// ---------------------------------------------------------------------------

/** Remove the API key and any bearer token from a text. */
export function redact(text: string): string {
  let out = String(text ?? '');
  const key = apiKey();
  if (key) out = out.split(key).join('<REDACTED>');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer <REDACTED>')
    .replace(/sk-[A-Za-z0-9_\-]{16,}/g, '<REDACTED>');
}

const BILLING_CODE_RE = /Arrearage|insufficient_quota|FreeTierOnly|BillOverdue|InsufficientBalance|PaymentRequired/i;
const BILLING_MESSAGE_RE = /account is in good standing|overdue|arrear|insufficient (balance|quota|funds)|free tier.*exhausted|credits are depleted|billing|payment required/i;

function isBillingInfo(status: number | undefined, code: string | undefined, message: string): boolean {
  if (status === 402) return true;
  if (code && BILLING_CODE_RE.test(code)) return true;
  return BILLING_MESSAGE_RE.test(message);
}

/** True for 402 / Arrearage / exhausted-credit errors: retrying (or further requests) cannot help. */
export function isLlmBillingError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof LlmError) return err.billing;
  const e = err as any;
  const status = Number(e?.status ?? e?.response?.status);
  return isBillingInfo(Number.isFinite(status) ? status : undefined, e?.code ? String(e.code) : undefined, String(e?.message ?? e));
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

function toContent(prompt: string | LlmPart[]): string | any[] {
  if (typeof prompt === 'string') return prompt;
  return prompt.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    return { type: 'image_url', image_url: { url: `data:${p.mimeType || 'image/jpeg'};base64,${p.dataBase64}` } };
  });
}

function promptText(prompt: string | LlmPart[]): string {
  if (typeof prompt === 'string') return prompt;
  return prompt.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
}

/** Conservative-low token estimate (CJK ~1 token per character, other text ~4 characters per token). */
function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[㐀-鿿豈-﫿　-〿＀-￯]/.test(ch)) cjk++;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

type ResponseFormatMode = 'none' | 'json_object' | 'json_schema';

function buildBody(req: LlmRequest, model: string, mode: ResponseFormatMode): Record<string, unknown> {
  const messages: any[] = [];
  let system = req.system;
  if (mode !== 'none') {
    const mentionsJson = /json/i.test(system || '') || /json/i.test(promptText(req.prompt));
    // json_object is rejected (HTTP 400) unless the messages contain the word "json"
    if (!mentionsJson) system = `${system ? `${system}\n` : ''}Respond with a single JSON object.`;
  }
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: toContent(req.prompt) });

  const body: Record<string, unknown> = { model, messages, enable_thinking: false };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.maxOutputTokens !== undefined) body.max_tokens = Math.max(1, Math.floor(req.maxOutputTokens));
  if (mode === 'json_object') body.response_format = { type: 'json_object' };
  if (mode === 'json_schema' && req.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: req.jsonSchema.name, strict: req.jsonSchema.strict !== false, schema: req.jsonSchema.schema }
    };
  }
  return body;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function backoffMs(attempt: number, retryAfterHeader?: string | null): number {
  const retryAfter = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(60_000, retryAfter * 1000);
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return base / 2 + Math.random() * (base / 2);
}

function isSchemaRejection(err: LlmError): boolean {
  return err.status === 400 && /response_format|json_schema|schema|strict/i.test(err.message);
}

async function postOnce(url: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<LlmResponse> {
  const model = String(body.model);
  const label = `Qwen ${model}`;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
  } catch (error: any) {
    if (signal?.aborted) throw new LlmError(`${label}: aborted`, { code: 'aborted', retryable: false });
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    const causeCode = error?.cause?.code ? String(error.cause.code) : undefined;
    const reason = timedOut ? `timed out after ${timeoutMs} ms` : causeCode || error?.message || String(error);
    throw new LlmError(`${label}: network error (${reason})`, { code: timedOut ? 'timeout' : causeCode || 'network', retryable: true });
  }

  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const errObj = json?.error && typeof json.error === 'object' ? json.error : json;
    const code = errObj?.code ? String(errObj.code) : errObj?.type ? String(errObj.type) : undefined;
    const message = errObj?.message ? String(errObj.message) : text.slice(0, 300);
    const status = response.status;
    const billing = isBillingInfo(status, code, message);
    const retryable = !billing && (status === 408 || status === 429 || status >= 500 || /throttl|ServiceUnavailable|overload/i.test(code || ''));
    const err = new LlmError(`${label} -> HTTP ${status}${code ? ` ${code}` : ''}: ${message}`, {
      status,
      code,
      requestId: json?.request_id ?? json?.id,
      retryable,
      billing
    });
    (err as any).retryAfter = response.headers.get('retry-after');
    throw err;
  }

  if (!json) throw new LlmError(`${label}: response is not JSON`, { status: response.status, code: 'bad_response', retryable: true });
  const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
  const finishReason: string | undefined = choice?.finish_reason ?? undefined;
  const rawContent = choice?.message?.content;
  const content =
    typeof rawContent === 'string'
      ? rawContent
      : Array.isArray(rawContent)
        ? rawContent.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('')
        : '';
  const usage: LlmUsage = {
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    cachedTokens: json.usage?.prompt_tokens_details?.cached_tokens,
    imageTokens: json.usage?.prompt_tokens_details?.image_tokens
  };
  if (finishReason === 'content_filter') {
    throw new LlmError(`${label}: reply blocked by content filter`, { code: 'content_filter', requestId: json.id, retryable: false });
  }
  if (!content.trim()) {
    throw new LlmError(`${label}: empty reply (finish_reason=${finishReason ?? 'none'})`, {
      code: 'empty_response',
      requestId: json.id,
      retryable: true
    });
  }
  if (finishReason === 'length') {
    console.warn(`⚠️ ${label}: reply truncated at max tokens (finish_reason=length, ${usage.completionTokens ?? '?'} completion tokens)`);
  }
  return { text: content.trim(), model: json.model || model, finishReason, usage, requestId: json.id };
}

/** Full reply (text, model, finish reason, token usage). Throws LlmError on failure. */
export async function generateChat(req: LlmRequest): Promise<LlmResponse> {
  const task: LlmTask = req.task || 'fast';
  const model = (req.model || '').trim() || llmModelFor(task);
  const reason = llmUnavailableReason();
  if (reason) throw new LlmError(`Alibaba LLM is not available: ${reason}`, { code: 'not_configured', retryable: false });

  const limit = llmInputTokenLimit(model);
  if (limit) {
    const estimate = estimateTokens(`${req.system || ''}\n${promptText(req.prompt)}`);
    if (estimate > limit) {
      throw new LlmError(`Qwen ${model}: input of ~${estimate} tokens exceeds the ~${limit}-token context window`, {
        code: 'context_length_exceeded',
        retryable: false
      });
    }
  }

  let mode: ResponseFormatMode = req.jsonSchema ? 'json_schema' : req.json ? 'json_object' : 'none';
  const url = `${llmBaseUrl()}/chat/completions`;
  const timeoutMs = req.timeoutMs ?? intEnv('ALIBABA_LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 5_000, 30 * 60_000);
  const maxRetries = intEnv('ALIBABA_LLM_MAX_RETRIES', DEFAULT_MAX_RETRIES, 0, 10);

  let lastError: LlmError | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (req.signal?.aborted) throw new LlmError(`Qwen ${model}: aborted`, { code: 'aborted', retryable: false });
    const body = buildBody(req, model, mode);
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_BODY_BYTES) {
      throw new LlmError(`Qwen ${model}: request body is ${(size / 1048576).toFixed(1)} MiB (limit 16 MiB)`, {
        code: 'request_too_large',
        retryable: false
      });
    }
    try {
      return await postOnce(url, body, timeoutMs, req.signal);
    } catch (error: any) {
      lastError = error instanceof LlmError ? error : new LlmError(String(error?.message ?? error), { retryable: false });
      if (mode === 'json_schema' && isSchemaRejection(lastError)) {
        console.warn(`⚠️ Qwen ${model}: json_schema rejected (${lastError.message.slice(0, 160)}); falling back to json_object`);
        mode = 'json_object';
        attempt--; // the fallback does not consume a retry
        continue;
      }
      if (!lastError.retryable || attempt === maxRetries) break;
      const wait = backoffMs(attempt, (error as any)?.retryAfter);
      console.warn(`⚠️ ${lastError.message.slice(0, 200)}; retry ${attempt + 1}/${maxRetries} in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait, req.signal);
    }
  }
  throw lastError ?? new LlmError(`Qwen ${model}: request failed`);
}

/** Assistant reply text (trimmed). Throws LlmError on failure. */
export async function generateText(req: LlmRequest): Promise<string> {
  return (await generateChat(req)).text;
}
