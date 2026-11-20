/**
 * Blackboard OCR (chữ trên bảng) for Chinese lecture videos.
 *
 * TCM teachers write key terms (herbs, formulas, acupoints, classics) in chalk on a
 * green board. Those strings are the strongest evidence we have for what was said, so
 * they are fed to speech recognition as phrase hints and to term-correction as
 * "board terms".
 *
 * Pipeline:
 *  1. ffprobe: is there a real video stream (cover art / attached_pic does not count)?
 *  2. Candidate timestamps at a fixed interval (offset by half an interval so we never
 *     sample exactly on a cut), widened for long videos so at most ~2*maxFrames frames
 *     are extracted.
 *  3. One ffmpeg seek per candidate emits a JPEG (width <= 1280) plus a 64x36 grayscale
 *     thumbnail; thumbnails drop near-duplicate / blank frames cheaply.
 *  4. Kept frames (<= maxFrames) are sent to the vision LLM (Alibaba Qwen, see llm-client.ts)
 *     in small batches with bounded concurrency; llm-client retries 429/5xx with backoff.
 *     JSON output is enforced by a strict schema (it keeps the board's own script).
 *  5. Terms are validated (must appear in that frame's transcribed text, must contain
 *     CJK), then merged across frames preserving first-seen order.
 *
 * Never throws: missing video stream, missing DASHSCOPE_API_KEY, ffmpeg or LLM failures
 * all return an empty result with `skippedReason`, so callers can run it unconditionally.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { generateChat, isLlmConfigured, llmModelFor, llmUnavailableReason, LlmError, LlmPart } from './llm-client';
import { scriptForLanguageCode } from './tcm-glossary';

dotenv.config();

export interface BoardTextItem {
  time: number; // seconds, timestamp of the representative frame
  text: string;
  terms: string[];
}

export interface BoardOcrResult {
  items: BoardTextItem[];
  terms: string[];
  framesAnalysed: number;
  skippedReason?: string;
}

export interface BoardOcrOptions {
  languageCode?: string;
  maxFrames?: number;
  intervalSeconds?: number;
}

const DEFAULT_MAX_FRAMES = 60;
const DEFAULT_INTERVAL_SECONDS = 20;
const THUMB_W = 64;
const THUMB_H = 36;
const EXTRACT_CONCURRENCY = 4;
const LLM_CONCURRENCY = 3;
const MAX_TERM_CHARS = 30;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw !== undefined && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

/**
 * Per-attempt timeout for a vision OCR call: BOARD_OCR_TIMEOUT_MS when set, otherwise the larger of
 * 180 s (multi-frame, high-resolution batches run long) and the general ALIBABA_LLM_TIMEOUT_MS.
 */
function boardOcrTimeoutMs(): number {
  const general = envInt('ALIBABA_LLM_TIMEOUT_MS', 120_000, 5_000, 30 * 60_000);
  return envInt('BOARD_OCR_TIMEOUT_MS', Math.max(180_000, general), 5_000, 30 * 60_000);
}

function runProcess(
  cmd: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 20000) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

interface ProbeInfo {
  hasVideo: boolean;
  duration?: number;
}

async function probeVideo(filePath: string): Promise<ProbeInfo> {
  const { code, stdout, stderr } = await runProcess(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,duration:stream_disposition=attached_pic:format=duration', '-of', 'json', filePath],
    60_000
  );
  if (code !== 0) throw new Error(`ffprobe failed (code ${code}): ${stderr.slice(0, 500)}`);
  const json = JSON.parse(stdout.toString() || '{}');
  const streams: any[] = Array.isArray(json.streams) ? json.streams : [];
  // Embedded cover art in audio files shows up as a video stream with attached_pic=1.
  const videoStreams = streams.filter(
    (s) => s.codec_type === 'video' && !(s.disposition && Number(s.disposition.attached_pic) === 1)
  );
  const candidates = [json.format?.duration, ...videoStreams.map((s) => s.duration)]
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d > 0);
  return { hasVideo: videoStreams.length > 0, duration: candidates.length ? Math.max(...candidates) : undefined };
}

interface Frame {
  time: number;
  jpegPath: string;
  thumb: Buffer; // THUMB_W * THUMB_H grayscale bytes
}

async function extractFrame(videoPath: string, time: number, outDir: string, index: number): Promise<Frame | null> {
  const jpegPath = path.join(outDir, `frame_${String(index).padStart(4, '0')}.jpg`);
  const frameWidth = envInt('BOARD_OCR_FRAME_WIDTH', 1280, 480, 3840);
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-ss', time.toFixed(3),
    '-i', videoPath,
    '-frames:v', '1',
    '-filter_complex',
    `[0:v]split=2[a][b];[a]scale='min(${frameWidth},iw)':-2[big];[b]scale=${THUMB_W}:${THUMB_H},format=gray[small]`,
    '-map', '[big]', '-frames:v', '1', '-q:v', '3', '-y', jpegPath,
    '-map', '[small]', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
  ];
  try {
    const { code, stdout } = await runProcess('ffmpeg', args, 60_000);
    if (code !== 0 || stdout.length < THUMB_W * THUMB_H || !fs.existsSync(jpegPath)) return null;
    if (fs.statSync(jpegPath).size === 0) return null;
    return { time, jpegPath, thumb: stdout.subarray(0, THUMB_W * THUMB_H) };
  } catch {
    return null;
  }
}

/** Fraction of thumbnail pixels whose luminance changed noticeably. */
function thumbChange(a: Buffer, b: Buffer): number {
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 18) changed++;
  return changed / a.length;
}

/** Near-uniform frames (black, fades, blank screens) carry no text. */
function isBlank(thumb: Buffer): boolean {
  let sum = 0;
  let sq = 0;
  for (const v of thumb) {
    sum += v;
    sq += v * v;
  }
  const mean = sum / thumb.length;
  return sq / thumb.length - mean * mean < 4; // std-dev < 2 grey levels
}

/** 0.6% of a 64x36 thumbnail is ~14 pixels: enough for a newly written line of chalk. */
const DUPLICATE_CHANGE_THRESHOLD = 0.006;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

function pickEvenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const out: T[] = [];
  for (let k = 0; k < n; k++) out.push(items[Math.floor(((k + 0.5) * items.length) / n)]);
  return out;
}

// ---------------------------------------------------------------------------
// Vision LLM
// ---------------------------------------------------------------------------

function buildPrompt(script: 'hans' | 'hant', frameCount: number): string {
  const scriptName = script === 'hant' ? 'Traditional Chinese (繁體)' : 'Simplified Chinese (简体)';
  return [
    `You are an OCR engine. You get ${frameCount} still frame(s) from a Chinese lecture video on Traditional Chinese Medicine (中医).`,
    'For EACH frame, transcribe ONLY the Chinese text that is physically written on the blackboard / whiteboard (usually white chalk on a green board) or shown on a presentation slide.',
    'Ignore: burned-in subtitles/captions, channel logos, watermarks, video titles/overlays, text on clothing, books or background posters.',
    `Preferred script: ${scriptName}. If the board clearly uses the other script, report it exactly as written — do NOT convert.`,
    'Keep line order (top-to-bottom, left-to-right), one board line per output line (use \\n). Keep arrows (→), numbers and punctuation that are on the board.',
    'Rules against hallucination: transcribe only characters you can actually read. If a character is unreadable write □. If no Chinese text is legible, return an empty text and empty terms. Never guess or complete text from your own knowledge.',
    '"terms": the domain words that appear in YOUR transcription of that frame, copied exactly: herb names (e.g. 柴胡), formulas (e.g. 小柴胡汤), acupoints (e.g. 足三里), classics (e.g. 伤寒论), theory / diagnosis / pulse words (e.g. 脾虚, 湿盛, 弦脉). Each term must be a substring of "text". No explanations.',
    `Return JSON: {"frames":[{"frame":<1..${frameCount}>,"text":"...","terms":["..."]}]} with exactly one entry per frame.`,
  ].join('\n');
}

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['frames'],
  properties: {
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['frame', 'text', 'terms'],
        properties: {
          frame: { type: 'integer' },
          text: { type: 'string' },
          terms: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

interface FrameOcr {
  frame: number;
  text: string;
  terms: string[];
}

/** Tolerant JSON parsing: code fences, leading prose, bare arrays, [{"frames":[...]}] wrappers. */
export function parseBoardOcrJson(raw: string): FrameOcr[] {
  if (!raw) return [];
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const tryParse = (t: string): any => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  let parsed = tryParse(s);
  if (parsed === undefined) {
    const objStart = s.indexOf('{');
    const arrStart = s.indexOf('[');
    const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
    if (start !== -1 && end > start) parsed = tryParse(s.slice(start, end + 1));
  }
  if (parsed === undefined) return [];
  // Some models wrap the object in an array: [{"frames":[...]}]
  if (Array.isArray(parsed) && parsed.length && parsed.every((p) => p && typeof p === 'object' && Array.isArray(p.frames))) {
    parsed = { frames: parsed.flatMap((p: any) => p.frames) };
  }
  const list: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.frames)
      ? parsed.frames
      : typeof parsed.text === 'string'
        ? [{ frame: 1, ...parsed }]
        : [];
  return list
    .filter((f) => f && typeof f === 'object')
    .map((f, i) => ({
      frame: Number.isFinite(Number(f.frame)) ? Number(f.frame) : i + 1,
      text: typeof f.text === 'string' ? f.text : '',
      terms: Array.isArray(f.terms) ? f.terms.filter((t: unknown) => typeof t === 'string') : [],
    }));
}

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const TERM_STRIP_RE = /[\s　，,。.、；;：:！!？?“”"'‘’（）()【】\[\]《》<>·•\-—…→←↑↓=+*\/\\|]/g;

function normalizeTerm(t: string): string {
  return t.replace(TERM_STRIP_RE, '').trim();
}

function compact(s: string): string {
  return s.replace(/\s+/g, '');
}

/** Keep only plausible terms that really occur in the frame's own transcription. */
function validateTerms(text: string, terms: string[]): string[] {
  const hay = compact(text);
  const out: string[] = [];
  for (const raw of terms) {
    const t = normalizeTerm(raw);
    if (!t || t.length > MAX_TERM_CHARS || !CJK_RE.test(t) || t.includes('□')) continue;
    if (!hay.includes(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function cleanText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t　]+/g, ' ').trim())
    .filter(Boolean);
  const joined = lines.join('\n');
  return CJK_RE.test(joined) ? joined : '';
}

/** Auth / billing / permission / unknown-model problems: further batches would fail the same way. */
function isFatal(err: any): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.billing) return true;
  if (err.code === 'not_configured') return true;
  return err.status === 401 || err.status === 402 || err.status === 403 || err.status === 404;
}

interface BatchOutcome {
  results: Map<number, FrameOcr>; // index within batch (0-based) -> OCR
  ok: boolean;
  error?: string;
  promptTokens?: number;
  outputTokens?: number;
}

async function ocrBatch(
  model: string,
  frames: Frame[],
  script: 'hans' | 'hant',
  abort: { reason?: string }
): Promise<BatchOutcome> {
  if (abort.reason) return { results: new Map(), ok: false, error: abort.reason };
  const parts: LlmPart[] = [{ type: 'text', text: buildPrompt(script, frames.length) }];
  frames.forEach((f, i) => {
    parts.push({ type: 'text', text: `Frame ${i + 1}:` });
    parts.push({ type: 'image', mimeType: 'image/jpeg', dataBase64: fs.readFileSync(f.jpegPath).toString('base64') });
  });

  try {
    // llm-client retries 429 / 5xx / network errors / empty replies with backoff
    const resp = await generateChat({
      task: 'vision',
      model,
      prompt: parts,
      temperature: 0,
      maxOutputTokens: 1024 + 1024 * frames.length,
      jsonSchema: { name: 'board_ocr', schema: RESPONSE_SCHEMA },
      timeoutMs: boardOcrTimeoutMs(),
    });
    const parsed = parseBoardOcrJson(resp.text);
    const results = new Map<number, FrameOcr>();
    for (const p of parsed) {
      const idx = p.frame - 1;
      if (idx >= 0 && idx < frames.length && !results.has(idx)) results.set(idx, p);
    }
    return {
      results,
      ok: true,
      promptTokens: resp.usage.promptTokens,
      outputTokens: resp.usage.completionTokens,
    };
  } catch (err: any) {
    const error = String(err?.message ?? err).slice(0, 300);
    if (isFatal(err)) abort.reason = error;
    return { results: new Map(), ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// main entry
// ---------------------------------------------------------------------------

export async function extractBoardText(
  videoFilePath: string,
  opts: BoardOcrOptions = {}
): Promise<BoardOcrResult> {
  const empty = (skippedReason: string): BoardOcrResult => ({ items: [], terms: [], framesAnalysed: 0, skippedReason });

  if (!isLlmConfigured('vision')) return empty(`vision LLM not configured: ${llmUnavailableReason() ?? 'DASHSCOPE_API_KEY is not set'}`);
  if (!videoFilePath || !fs.existsSync(videoFilePath)) return empty(`file not found: ${videoFilePath}`);

  const maxFrames = Math.max(1, Math.floor(opts.maxFrames ?? DEFAULT_MAX_FRAMES));
  const baseInterval = Math.max(2, opts.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  const script = scriptForLanguageCode(opts.languageCode);
  const model = llmModelFor('vision');
  const framesPerCall = envInt('BOARD_OCR_FRAMES_PER_CALL', 4, 1, 10);

  let probe: ProbeInfo;
  try {
    probe = await probeVideo(videoFilePath);
  } catch (err: any) {
    return empty(`ffprobe failed: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  if (!probe.hasVideo) return empty('no video stream');

  let tmpDir: string | undefined;
  const started = Date.now();
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-ocr-'));

    // 1. candidate timestamps — widen the interval so we never extract more than ~2*maxFrames.
    const duration = probe.duration;
    let interval = baseInterval;
    if (duration) interval = Math.max(baseInterval, duration / (maxFrames * 2));
    const times: number[] = [];
    const end = duration ?? interval * maxFrames * 2; // unknown duration: extraction failures end the list
    for (let t = Math.min(interval / 2, (duration ?? interval) / 2); t < end - 0.25 && times.length < maxFrames * 2; t += interval) {
      times.push(Math.round(t * 1000) / 1000);
    }
    if (!times.length) times.push(0);

    // 2. extract frames + thumbnails
    const extracted = (
      await mapLimit(times, EXTRACT_CONCURRENCY, (t, i) => extractFrame(videoFilePath, t, tmpDir as string, i))
    ).filter((f): f is Frame => f !== null);
    if (!extracted.length) return empty('could not extract any video frame');

    // 3. drop blank and near-duplicate frames (compared with the last kept frame)
    const kept: Frame[] = [];
    let blank = 0;
    let dup = 0;
    for (const f of extracted) {
      if (isBlank(f.thumb)) {
        blank++;
        continue;
      }
      const prev = kept[kept.length - 1];
      if (prev && thumbChange(prev.thumb, f.thumb) < DUPLICATE_CHANGE_THRESHOLD) {
        dup++;
        continue;
      }
      kept.push(f);
    }
    const selected = pickEvenly(kept, maxFrames);
    console.log(
      `🖼️ Board OCR: ${times.length} candidates (every ${interval.toFixed(1)}s), ${extracted.length} extracted, ` +
        `${blank} blank, ${dup} near-duplicate, ${selected.length} sent to ${model} (script=${script})`
    );
    if (!selected.length) return { items: [], terms: [], framesAnalysed: 0, skippedReason: 'no usable frames (all blank)' };

    // 4. vision-LLM OCR in batches
    const abort: { reason?: string } = {};
    const batches: Frame[][] = [];
    for (let i = 0; i < selected.length; i += framesPerCall) batches.push(selected.slice(i, i + framesPerCall));
    const outcomes = await mapLimit(batches, LLM_CONCURRENCY, (b) => ocrBatch(model, b, script, abort));

    let framesAnalysed = 0;
    let promptTokens = 0;
    let outputTokens = 0;
    const errors: string[] = [];
    const perFrame: Array<{ time: number; text: string; terms: string[] }> = [];
    outcomes.forEach((o, bi) => {
      if (!o.ok) {
        errors.push(o.error ?? 'unknown error');
        return;
      }
      promptTokens += o.promptTokens ?? 0;
      outputTokens += o.outputTokens ?? 0;
      batches[bi].forEach((frame, fi) => {
        framesAnalysed++;
        const r = o.results.get(fi);
        if (!r) return;
        const text = cleanText(r.text);
        if (!text) return;
        perFrame.push({ time: frame.time, text, terms: validateTerms(text, r.terms) });
      });
    });

    if (!framesAnalysed) {
      return { items: [], terms: [], framesAnalysed: 0, skippedReason: `${model} OCR failed: ${errors[0] ?? 'unknown'}` };
    }
    if (errors.length) console.warn(`⚠️ Board OCR: ${errors.length}/${batches.length} batch(es) failed: ${errors[0]}`);

    // 5. merge: drop items that repeat (or are contained in) the previous board state
    perFrame.sort((a, b) => a.time - b.time);
    const items: BoardTextItem[] = [];
    for (const p of perFrame) {
      const prev = items[items.length - 1];
      if (prev && compact(prev.text).includes(compact(p.text))) {
        for (const t of p.terms) if (!prev.terms.includes(t)) prev.terms.push(t);
        continue;
      }
      items.push({ time: Math.round(p.time * 10) / 10, text: p.text, terms: [...p.terms] });
    }
    const terms: string[] = [];
    for (const it of items) for (const t of it.terms) if (!terms.includes(t)) terms.push(t);

    console.log(
      `✅ Board OCR: ${items.length} board text item(s), ${terms.length} term(s) from ${framesAnalysed} frame(s) ` +
        `in ${((Date.now() - started) / 1000).toFixed(1)}s; tokens in=${promptTokens} out=${outputTokens}`
    );
    return { items, terms, framesAnalysed };
  } catch (err: any) {
    console.error('❌ Board OCR failed:', err);
    return empty(`board OCR error: ${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    if (tmpDir) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}
