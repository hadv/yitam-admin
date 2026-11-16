/**
 * Language helpers shared by audio transcription, metadata enhancement and
 * transcript embedding.
 *
 * Everything here is pure (no I/O) so it can be unit-tested in isolation.
 */

/** Literal value accepted as AudioTranscriptionOptions.languageCode to enable auto detection. */
export const AUTO_LANGUAGE = 'auto';

/** In auto mode: primary language sent to Google Speech-to-Text. */
export const AUTO_PRIMARY_LANGUAGE = 'vi-VN';

/** In auto mode: alternative languages Google may pick instead of the primary one. */
export const AUTO_ALTERNATIVE_LANGUAGES = ['cmn-Hans-CN', 'en-US'];

/** Google STT v1 accepts at most 3 alternative language codes. */
export const MAX_ALTERNATIVE_LANGUAGES = 3;

/** Default language that metadata / translations are produced in. */
export const DEFAULT_TARGET_LANGUAGE = 'vi';

// Base language (ISO 639-ish) -> English name used in LLM prompts
const LANGUAGE_NAMES: Record<string, string> = {
  vi: 'Vietnamese',
  zh: 'Chinese',
  yue: 'Cantonese Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  ru: 'Russian',
  th: 'Thai',
  km: 'Khmer',
  lo: 'Lao',
  hi: 'Hindi',
  id: 'Indonesian',
  ms: 'Malay'
};

// Base language -> Vietnamese name (used in Vietnamese-facing labels, e.g. chunk titles)
const VIETNAMESE_LANGUAGE_NAMES: Record<string, string> = {
  vi: 'tiếng Việt',
  zh: 'tiếng Trung',
  yue: 'tiếng Quảng Đông',
  en: 'tiếng Anh',
  ja: 'tiếng Nhật',
  ko: 'tiếng Hàn',
  fr: 'tiếng Pháp',
  de: 'tiếng Đức',
  es: 'tiếng Tây Ban Nha',
  it: 'tiếng Ý',
  pt: 'tiếng Bồ Đào Nha',
  ru: 'tiếng Nga',
  th: 'tiếng Thái',
  km: 'tiếng Khmer',
  lo: 'tiếng Lào',
  hi: 'tiếng Hindi',
  id: 'tiếng Indonesia',
  ms: 'tiếng Mã Lai'
};

// Human names (lower-case) -> base language, so names and codes can be compared
const NAME_TO_BASE: Record<string, string> = {
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  chinese: 'zh',
  mandarin: 'zh',
  'mandarin chinese': 'zh',
  'tiếng trung': 'zh',
  cantonese: 'yue',
  'cantonese chinese': 'yue',
  english: 'en',
  'tiếng anh': 'en',
  japanese: 'ja',
  korean: 'ko',
  french: 'fr',
  german: 'de',
  spanish: 'es'
};

// Typical filler words per language, used as hints in the transcript-cleaning prompt
const FILLER_WORD_HINTS: Record<string, string> = {
  vi: '"à", "ừ", "ờ", "ừm", "ơ", "thì là", "kiểu như là", "nói chung là" (when used as fillers)',
  zh: '"嗯", "啊", "呃", "哦", "那个", "这个", "就是说", "然后" (when used as fillers)',
  yue: '"嗯", "啊", "呃", "咁", "即係", "跟住" (when used as fillers)',
  en: '"um", "uh", "er", "ah", "you know", "like", "I mean" (when used as fillers)',
  ja: '"えーと", "あの", "まあ", "えー", "その" (when used as fillers)',
  ko: '"음", "어", "그", "저기", "뭐" (when used as fillers)'
};

/**
 * Normalise the case of a BCP-47 code. Google returns e.g. 'cmn-hans-cn'
 * in results; we want 'cmn-Hans-CN'.
 */
export function normalizeLanguageCode(code?: string | null): string | undefined {
  if (!code) return undefined;
  const parts = code.trim().replace(/_/g, '-').split('-').filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts
    .map((part, index) => {
      if (index === 0) return part.toLowerCase();
      if (/^[a-z]{4}$/i.test(part)) return part[0].toUpperCase() + part.slice(1).toLowerCase(); // script
      if (/^([a-z]{2}|\d{3})$/i.test(part)) return part.toUpperCase(); // region
      return part.toLowerCase();
    })
    .join('-');
}

/** Loose BCP-47 syntax check (enough to reject garbage before sending it to Google). */
export function isValidLanguageCode(code?: string | null): boolean {
  return !!code && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code.trim());
}

/**
 * Reduce a BCP-47 code or a human language name to a base language:
 * 'cmn-Hans-CN' -> 'zh', 'zh-TW' -> 'zh', 'yue-Hant-HK' -> 'yue', 'vi-VN' -> 'vi',
 * 'Vietnamese' -> 'vi', 'Chinese' -> 'zh'.
 */
export function toBaseLanguage(codeOrName?: string | null): string | undefined {
  if (!codeOrName) return undefined;
  const lower = codeOrName.trim().toLowerCase();
  if (!lower) return undefined;
  if (NAME_TO_BASE[lower]) return NAME_TO_BASE[lower];
  const subtags = lower.replace(/_/g, '-').split('-');
  const primary = subtags[0];
  if (primary === 'yue' || (primary === 'zh' && subtags.includes('yue'))) return 'yue';
  if (primary === 'cmn' || primary === 'zh') return 'zh';
  return primary;
}

/** True for Mandarin and Cantonese (and any other zh variant). */
export function isChineseLanguage(codeOrName?: string | null): boolean {
  const base = toBaseLanguage(codeOrName);
  return base === 'zh' || base === 'yue';
}

/** Compare two language codes / names by base language. */
export function isSameLanguage(a?: string | null, b?: string | null): boolean {
  const baseA = toBaseLanguage(a);
  const baseB = toBaseLanguage(b);
  return !!baseA && baseA === baseB;
}

/** English human name for prompts: 'cmn-Hans-CN' -> 'Chinese', 'yue-Hant-HK' -> 'Cantonese Chinese'. */
export function getLanguageName(codeOrName?: string | null): string {
  const base = toBaseLanguage(codeOrName);
  if (base && LANGUAGE_NAMES[base]) return LANGUAGE_NAMES[base];
  return codeOrName ? codeOrName.trim() : 'English';
}

/** Vietnamese name: 'cmn-Hans-CN' -> 'tiếng Trung'. */
export function getVietnameseLanguageName(codeOrName?: string | null): string {
  const base = toBaseLanguage(codeOrName);
  if (base && VIETNAMESE_LANGUAGE_NAMES[base]) return VIETNAMESE_LANGUAGE_NAMES[base];
  return codeOrName ? `tiếng ${codeOrName.trim()}` : 'tiếng nước ngoài';
}

/** Filler-word hint for the cleaning prompt (generic fallback for unknown languages). */
export function getFillerWordsHint(codeOrName?: string | null): string {
  const base = toBaseLanguage(codeOrName);
  return (base && FILLER_WORD_HINTS[base]) || 'hesitation sounds and filler words typical of the language';
}

// ---------------------------------------------------------------------------
// Script analysis / text-based language detection
// ---------------------------------------------------------------------------

const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const LATIN_RE = /\p{Script=Latin}/u;
// Letters that (practically) only occur in Vietnamese. Plain â/ê/ô and acute/grave
// vowels are excluded because French/Portuguese/etc. use them too.
const VIETNAMESE_ONLY_CHARS = new Set(
  'ăắằẳẵặđơớờởỡợưứừửữựạảấầẩẫậẹẻẽếềểễệỉịĩọỏốồổỗộụủũỳỵỷỹ'.split('')
);

export interface ScriptStats {
  han: number;
  kana: number;
  hangul: number;
  latin: number;
  vietnamese: number;
}

export function analyzeScripts(text: string): ScriptStats {
  const stats: ScriptStats = { han: 0, kana: 0, hangul: 0, latin: 0, vietnamese: 0 };
  if (!text) return stats;
  for (const ch of text) {
    if (HAN_RE.test(ch)) stats.han++;
    else if (KANA_RE.test(ch)) stats.kana++;
    else if (HANGUL_RE.test(ch)) stats.hangul++;
    else if (LATIN_RE.test(ch)) {
      stats.latin++;
      if (VIETNAMESE_ONLY_CHARS.has(ch.toLowerCase())) stats.vietnamese++;
    }
  }
  return stats;
}

/** Share of CJK characters (Han + kana + hangul) among all letters, 0..1. */
export function cjkRatio(text: string): number {
  const s = analyzeScripts(text);
  const cjk = s.han + s.kana + s.hangul;
  const letters = cjk + s.latin;
  return letters === 0 ? 0 : cjk / letters;
}

/**
 * Detect base language from text: 'zh' | 'ja' | 'ko' | 'vi' | 'en'.
 * Defaults to 'en' when nothing more specific is recognised.
 */
export function detectLanguageCodeFromText(text: string): string {
  const s = analyzeScripts(text || '');
  const cjk = s.han + s.kana + s.hangul;
  const letters = cjk + s.latin;
  if (letters === 0) return 'en';

  if (cjk / letters >= 0.3) {
    if (s.hangul > 0 && s.hangul >= s.han + s.kana) return 'ko';
    if (s.kana > 0 && s.kana / (s.han + s.kana) >= 0.15) return 'ja';
    return 'zh';
  }

  // Vietnamese: a non-trivial share of Vietnamese-only letters
  if (s.vietnamese > 0 && s.vietnamese / Math.max(1, s.latin) >= 0.01) return 'vi';

  return 'en';
}

/** Detect language from text and return its English human name (e.g. 'Chinese'). */
export function detectLanguageFromText(text: string): string {
  return getLanguageName(detectLanguageCodeFromText(text));
}

/**
 * Language-agnostic "word" count: every Han / kana character counts as one word
 * (≈ one syllable), other text is counted by whitespace-separated tokens.
 */
export function countWords(text: string): number {
  if (!text) return 0;
  let ideographs = 0;
  let rest = '';
  for (const ch of text) {
    if (HAN_RE.test(ch) || KANA_RE.test(ch)) {
      ideographs++;
      rest += ' ';
    } else {
      rest += ch;
    }
  }
  const tokens = rest.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token));
  return ideographs + tokens.length;
}

// ---------------------------------------------------------------------------
// Sentence / segment splitting (handles 。！？ as well as .!? and newlines)
// ---------------------------------------------------------------------------

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '!', '?', '…', '；', '｡']);
const CLOSING_PUNCTUATION = new Set(['"', "'", '”', '’', '」', '』', '）', ')', '】', '》', ']', '〕']);
const SOFT_BREAK_CHARS = new Set([' ', '\t', ',', '，', '、', ';', ':', '：']);

/**
 * Split text into sentence pieces. Concatenating the pieces gives back the
 * original text exactly (punctuation and whitespace are kept with the piece).
 */
export function splitIntoSentencePieces(text: string): string[] {
  const pieces: string[] = [];
  if (!text) return pieces;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    let cut = false;
    if (ch === '\n' || SENTENCE_TERMINATORS.has(ch)) {
      cut = true;
    } else if (ch === '.') {
      // Only treat '.' as a sentence end before whitespace / closing quote / end (not "3.14", "e.g.x")
      const next = text[i + 1];
      cut = next === undefined || /\s/.test(next) || CLOSING_PUNCTUATION.has(next);
    }
    if (!cut) continue;

    let j = i + 1;
    while (j < text.length && (SENTENCE_TERMINATORS.has(text[j]) || text[j] === '.' || CLOSING_PUNCTUATION.has(text[j]))) j++;
    while (j < text.length && /\s/.test(text[j])) j++;
    pieces.push(text.slice(start, j));
    start = j;
    i = j - 1;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

/** Sentences with surrounding whitespace trimmed and empty ones removed. */
export function splitIntoSentences(text: string): string[] {
  return splitIntoSentencePieces(text)
    .map(piece => piece.trim())
    .filter(piece => piece.length > 0);
}

/** Hard-split a piece that is longer than maxChars, preferring whitespace / commas. */
function hardSplit(piece: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = piece;
  while (rest.length > maxChars) {
    let cut = -1;
    for (let k = maxChars; k >= Math.floor(maxChars * 0.5); k--) {
      if (SOFT_BREAK_CHARS.has(rest[k - 1])) {
        cut = k;
        break;
      }
    }
    if (cut === -1) cut = maxChars;
    // Do not cut a surrogate pair in half
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

/**
 * Split text into segments of at most maxChars, cutting on sentence boundaries
 * (。！？.!? newlines) whenever possible. Segments are trimmed.
 */
export function splitTextIntoSegments(text: string, maxChars: number): string[] {
  if (!text || !text.trim()) return [];
  const limit = Math.max(1, Math.floor(maxChars));
  const pieces = splitIntoSentencePieces(text).flatMap(piece =>
    piece.length > limit ? hardSplit(piece, limit) : [piece]
  );

  const segments: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > limit) {
      segments.push(current);
      current = '';
    }
    current += piece;
  }
  if (current) segments.push(current);

  return segments.map(segment => segment.trim()).filter(segment => segment.length > 0);
}

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/** Join two text fragments: no space between CJK text, a single space otherwise. */
export function joinTextFragments(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const last = Array.from(a).pop() || '';
  const first = Array.from(b)[0] || '';
  const separator = CJK_CHAR_RE.test(last) || CJK_CHAR_RE.test(first) ? '' : ' ';
  return a + separator + b;
}

/** Return a shallow copy of obj without keys whose value is undefined. */
export function stripUndefined<T extends object>(obj: T | undefined | null): Partial<T> {
  const out: Partial<T> = {};
  if (!obj) return out;
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) (out as any)[key] = value;
  }
  return out;
}
