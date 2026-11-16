/**
 * Domain-term correction for Chinese speech-to-text output (Đông y / 中医 lectures).
 *
 * Speech recognisers often write a domain term with homophone / near-homophone
 * characters (黄旗 -> 黄芪, 当规 -> 当归, 足三李 -> 足三里). An LLM (Alibaba Qwen, see
 * llm-client.ts) is asked to PROPOSE replacements as JSON only - it never rewrites the
 * text. Every proposal is then verified and applied deterministically by applyTermCorrections():
 *  - the original must occur in the text inside the quoted context (which must be
 *    longer than the original) and inside the segment the proposal came from,
 *  - the length may change by at most one character,
 *  - the corrected form must be (or create) a glossary or blackboard term, and the
 *    changed characters must lie inside that term (digits / units / Latin / punctuation
 *    never change),
 *  - a valid term (or a variant spelling of one) is never turned into another one,
 *  - at most ~3% of the characters may change overall,
 *  - edits are applied right-to-left by index so offsets never drift.
 * On any failure the original text is returned unchanged.
 */
import { generateText, isLlmBillingError, isLlmConfigured, llmModelFor, llmUnavailableReason } from './llm-client';
import dotenv from 'dotenv';
import { TCM_GLOSSARY, GlossaryTerm, scriptForLanguageCode } from './tcm-glossary';
import { splitTextIntoSegments } from './language-utils';

dotenv.config();

export interface TermCorrection {
  original: string;
  corrected: string;
  /** Snippet copied verbatim from the input text that locates the error. */
  context: string;
  reason?: string;
  source?: 'glossary' | 'board' | 'llm';
}

export interface TermCorrectionResult {
  text: string;
  /** One entry per applied replacement (a proposal whose context occurs twice yields two). */
  corrections: TermCorrection[];
  /** Number of replacements applied (= corrections.length). */
  applied: number;
  /** Number of proposals that were not applied at all. */
  rejected: number;
  /** Rejected proposals with the reason (diagnostics / logging). */
  rejectedProposals?: Array<TermCorrection & { rejectReason: string }>;
}

export interface ApplyTermCorrectionsOptions {
  /** Terms read from the blackboard: strongest evidence, applied first and labelled 'board'. */
  boardTerms?: Set<string>;
  /** Valid spellings that must never be "corrected" (e.g. variant / other-script forms). */
  protectedTerms?: Set<string>;
  /**
   * Per-proposal [start, end) UTF-16 range of the text the proposal was generated from
   * (parallel to `proposals`). A proposal only applies inside its range. Default: whole text.
   */
  proposalRanges?: Array<[number, number] | undefined>;
  /** Max share of (non-whitespace) characters that may change, default 0.03. */
  maxChangeRatio?: number;
}

const DEFAULT_MAX_CHANGE_RATIO = 0.03;
/** The quoted context must be at least this many characters longer than the original. */
const MIN_CONTEXT_EXTRA_CHARS = 4;
const MIN_TERM_CHARS = 2;
const MAX_TERM_CHARS = 16;
const SEGMENT_CHARS = 1200;
const SEGMENT_CONCURRENCY = 3;
const MAX_GLOSSARY_TERMS_PER_PROMPT = 300;
const MAX_BOARD_TERMS_PER_PROMPT = 120;

const HAN_RE = /\p{Script=Han}/u;
const SKIP_FOR_MATCH_RE = /[\s\p{P}\p{S}]/u;
/**
 * Common variant spellings of glossary terms that are valid as written and must not be
 * "corrected" to the glossary's preferred form (verbatim transcript).
 */
const VARIANT_FORMS = [
  '黃芪', '黄耆', '白术', '白朮', '神曲', '神麴', '神麯', '表裏', '表裡', '太冲', '太衝',
  '蒼朮', '苍术', '黨參', '党参', '甘艸', '當歸', '当归', '川芎', '芎藭'
];

const cpLength = (s: string): number => Array.from(s).length;
const normaliseForMatch = (s: string): string => Array.from(s).filter(ch => !SKIP_FOR_MATCH_RE.test(ch)).join('');

/**
 * Digits, Latin letters (g, mg) and punctuation of s, in order. Han unit characters
 * (克, 钱, 两) are guarded by the term-span check: a change outside the created term is rejected.
 */
function protectedChars(s: string): string {
  return Array.from(s).filter(ch => !HAN_RE.test(ch)).join('');
}

/**
 * Code-point range [start, end) of corrected that differs from original after removing
 * the common prefix and suffix.
 */
function changedRange(original: string, corrected: string): [number, number] {
  const o = Array.from(original);
  const c = Array.from(corrected);
  let prefix = 0;
  while (prefix < o.length && prefix < c.length && o[prefix] === c[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < o.length - prefix && suffix < c.length - prefix &&
    o[o.length - 1 - suffix] === c[c.length - 1 - suffix]
  ) suffix++;
  return [prefix, c.length - suffix];
}

/** Number of code points that differ between original and corrected (at least 1). */
function changedCharCount(original: string, corrected: string): number {
  const [start, end] = changedRange(original, corrected);
  const removed = cpLength(original) - (cpLength(corrected) - end) - start;
  return Math.max(1, end - start, removed);
}

/** True when some occurrence of term in corrected covers the code-point range [start, end). */
function termCoversRange(corrected: string, term: string, start: number, end: number): boolean {
  const c = Array.from(corrected);
  const t = Array.from(term);
  for (let i = 0; i + t.length <= c.length; i++) {
    if (c.slice(i, i + t.length).join('') !== term) continue;
    if (i <= start && end <= i + t.length) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deterministic application (pure, exported for tests)
// ---------------------------------------------------------------------------

interface Edit {
  start: number; // UTF-16 index into text
  end: number;
  replacement: string;
  cost: number; // characters touched (code points)
  proposalIndex: number;
  isBoard: boolean;
  correction: TermCorrection;
}

/** All indices where needle occurs in haystack (non-overlapping scan is not wanted: every start). */
function allIndexesOf(haystack: string, needle: string, from = 0, to = haystack.length): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle, from);
  while (i !== -1 && i + needle.length <= to) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

/**
 * Spans [start, end) of `context` in `text`. Exact match first; otherwise a match
 * that ignores whitespace / punctuation (the LLM sometimes normalises ， vs , or drops spaces).
 */
function findContextSpans(text: string, context: string): Array<[number, number]> {
  const exact = allIndexesOf(text, context).map(i => [i, i + context.length] as [number, number]);
  if (exact.length > 0) return exact;

  // Normalised search with an index map back into the original text
  const map: number[] = [];
  let normText = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (SKIP_FOR_MATCH_RE.test(ch)) continue;
    normText += ch;
    map.push(i);
  }
  const normContext = Array.from(context).filter(ch => !SKIP_FOR_MATCH_RE.test(ch)).join('');
  if (normContext.length < MIN_TERM_CHARS) return [];
  return allIndexesOf(normText, normContext).map(i => [map[i], map[i + normContext.length - 1] + 1] as [number, number]);
}

/**
 * The allowed term that the correction produces: corrected itself, or an allowed
 * term (>= 2 chars) contained in corrected; either way it must not already be in
 * original (a pure deletion such as 当归归 -> 当归 is not a term fix).
 */
function findCreatedTerm(original: string, corrected: string, allowedTerms: Set<string>): string | undefined {
  // The changed characters must lie inside the created term: a proposal may fix a term,
  // not rewrite the words around it.
  const [changeStart, changeEnd] = changedRange(original, corrected);
  if (allowedTerms.has(corrected) && !original.includes(corrected)) return corrected;
  const chars = Array.from(corrected);
  let best: string | undefined;
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + MIN_TERM_CHARS; j <= chars.length; j++) {
      const sub = chars.slice(i, j).join('');
      if (!allowedTerms.has(sub) || original.includes(sub)) continue;
      if (!termCoversRange(corrected, sub, changeStart, changeEnd)) continue;
      if (!best || cpLength(sub) > cpLength(best)) best = sub;
    }
  }
  return best;
}

/** A valid term (>= 2 chars) inside original that the correction would destroy. */
function findDestroyedTerm(original: string, corrected: string, allowedTerms: Set<string>): string | undefined {
  const chars = Array.from(original);
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + MIN_TERM_CHARS; j <= chars.length; j++) {
      const sub = chars.slice(i, j).join('');
      if (allowedTerms.has(sub) && !corrected.includes(sub)) return sub;
    }
  }
  return undefined;
}

/**
 * Verify LLM proposals and apply the acceptable ones. Pure and deterministic.
 * @param allowedTerms glossary terms (script-appropriate) plus blackboard terms
 */
export function applyTermCorrections(
  text: string,
  proposals: TermCorrection[],
  allowedTerms: Set<string>,
  options: ApplyTermCorrectionsOptions = {}
): TermCorrectionResult {
  const boardTerms = options.boardTerms || new Set<string>();
  const protectedTerms = new Set<string>([...allowedTerms, ...(options.protectedTerms || [])]);
  const maxChangeRatio = options.maxChangeRatio ?? DEFAULT_MAX_CHANGE_RATIO;
  const rejectedProposals: Array<TermCorrection & { rejectReason: string }> = [];
  const reject = (p: TermCorrection, rejectReason: string) => {
    rejectedProposals.push({ ...p, source: p.source || 'llm', rejectReason });
  };

  if (!text || !Array.isArray(proposals) || proposals.length === 0) {
    return { text: text || '', corrections: [], applied: 0, rejected: 0, rejectedProposals };
  }

  // 1. Validate each proposal and locate its occurrences
  const candidates: Edit[] = [];
  /** Occurrence positions already claimed by an earlier proposal for the same original -> corrected. */
  const claimedByKey = new Map<string, Set<number>>();
  proposals.forEach((raw, proposalIndex) => {
    const original = typeof raw?.original === 'string' ? raw.original.trim() : '';
    const corrected = typeof raw?.corrected === 'string' ? raw.corrected.trim() : '';
    const context = typeof raw?.context === 'string' ? raw.context.trim() : '';
    const proposal: TermCorrection = {
      original,
      corrected,
      context,
      ...(typeof raw?.reason === 'string' && raw.reason.trim() ? { reason: raw.reason.trim() } : {})
    };

    if (!original || !corrected || !context) return reject(proposal, 'missing field');
    if (original === corrected) return reject(proposal, 'no change');

    const origLen = cpLength(original);
    const corrLen = cpLength(corrected);
    if (origLen < MIN_TERM_CHARS || corrLen < MIN_TERM_CHARS) return reject(proposal, 'too short');
    if (origLen > MAX_TERM_CHARS || corrLen > MAX_TERM_CHARS) return reject(proposal, 'too long');
    if (Math.abs(corrLen - origLen) > 1) return reject(proposal, 'length change > 1');
    if (!HAN_RE.test(corrected)) return reject(proposal, 'corrected is not Chinese');
    if (/\s/.test(original) || /\s/.test(corrected)) return reject(proposal, 'contains whitespace');
    // Numbers, Latin units and punctuation are never part of a homophone fix (黄旗30克 -> 黄芪3克)
    if (protectedChars(original) !== protectedChars(corrected)) {
      return reject(proposal, 'digits / Latin / punctuation differ');
    }

    const createdTerm = findCreatedTerm(original, corrected, allowedTerms);
    if (!createdTerm) return reject(proposal, 'corrected is not a glossary/board term covering the change');
    const isBoard = boardTerms.has(createdTerm) || boardTerms.has(corrected);
    // Never turn a valid term (or a valid variant spelling) into another one - not even
    // for a board term: the board is one set for the whole video and may be misread.
    const destroyed = findDestroyedTerm(original, corrected, protectedTerms);
    if (destroyed) return reject(proposal, `original already contains valid term ${destroyed}`);

    // The context must actually locate the occurrence: longer than the original and containing it
    const normContext = normaliseForMatch(context);
    const normOriginal = normaliseForMatch(original);
    if (cpLength(normContext) < cpLength(normOriginal) + MIN_CONTEXT_EXTRA_CHARS) {
      return reject(proposal, 'context too short');
    }
    if (!normOriginal || !normContext.includes(normOriginal)) return reject(proposal, 'context does not contain original');

    const range = options.proposalRanges?.[proposalIndex];
    const rangeStart = range ? Math.max(0, range[0]) : 0;
    const rangeEnd = range ? Math.min(text.length, range[1]) : text.length;
    const spans = findContextSpans(text, context).filter(([a, b]) => a >= rangeStart && b <= rangeEnd);
    if (spans.length === 0) return reject(proposal, 'context not found in text');

    const positions: number[] = [];
    for (const [ctxStart, ctxEnd] of spans) {
      for (const p of allIndexesOf(text, original, ctxStart, ctxEnd)) {
        if (!positions.includes(p)) positions.push(p);
      }
    }
    positions.sort((a, b) => a - b);
    if (positions.length === 0) return reject(proposal, 'original not found inside context');

    // One occurrence per proposal: proposals for the same fix (same original -> corrected) each
    // take the next occurrence not yet claimed by another one, even when their contexts differ
    // but overlap ("讲黄旗，用黄旗30克" and "今天我们讲黄旗，用黄旗" both contain both occurrences;
    // keyed by context, both would pick the first one and the second fix would be dropped).
    const key = `${original}\u0000${corrected}`;
    const claimed = claimedByKey.get(key) || new Set<number>();
    claimedByKey.set(key, claimed);
    const start = positions.find(p => !claimed.has(p));
    if (start === undefined) return reject(proposal, 'duplicate proposal');
    claimed.add(start);

    const correction: TermCorrection = { ...proposal, source: isBoard ? 'board' : 'glossary' };
    candidates.push({
      start,
      end: start + original.length,
      replacement: corrected,
      // Budget counts the characters actually changed (黄旗 -> 黄芪 touches 1, not 2), so a
      // dense run of genuine one-character homophone fixes is not cut off by the 3% cap
      cost: changedCharCount(original, corrected),
      proposalIndex,
      isBoard,
      correction
    });
  });

  // 2. Priority: board evidence first, then proposal order, then position
  candidates.sort((a, b) =>
    (a.isBoard === b.isBoard ? 0 : a.isBoard ? -1 : 1) ||
    a.proposalIndex - b.proposalIndex ||
    a.start - b.start
  );

  // 3. Drop overlapping edits and enforce the overall change budget
  const countable = Array.from(text).filter(ch => !/\s/.test(ch)).length;
  const budget = Math.floor(countable * maxChangeRatio);
  let spent = 0;
  const accepted: Edit[] = [];
  const droppedForCap = new Set<number>();
  for (const edit of candidates) {
    if (accepted.some(a => edit.start < a.end && a.start < edit.end)) continue;
    if (spent + edit.cost > budget) {
      droppedForCap.add(edit.proposalIndex);
      continue;
    }
    accepted.push(edit);
    spent += edit.cost;
  }

  // 4. Apply right-to-left so earlier indices stay valid
  let result = text;
  for (const edit of [...accepted].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }

  const appliedProposals = new Set(accepted.map(e => e.proposalIndex));
  const candidateProposals = new Set(candidates.map(e => e.proposalIndex));
  for (const index of candidateProposals) {
    if (appliedProposals.has(index)) continue;
    const c = candidates.find(e => e.proposalIndex === index)!.correction;
    reject(c, droppedForCap.has(index) ? 'change budget exceeded' : 'overlaps another correction');
  }

  const corrections = [...accepted].sort((a, b) => a.start - b.start).map(e => ({ ...e.correction }));
  return {
    text: result,
    corrections,
    applied: corrections.length,
    rejected: rejectedProposals.length,
    rejectedProposals
  };
}

// ---------------------------------------------------------------------------
// LLM proposals
// ---------------------------------------------------------------------------

function glossaryForm(term: GlossaryTerm, script: 'hans' | 'hant'): string {
  return script === 'hant' ? term.hant : term.hans;
}

/**
 * Characters that only occur in one script's glossary forms (e.g. 歸 only in hant, 归 only in hans).
 * Used to keep other-script board terms out of a transcript (no mixed-script output).
 */
let scriptOnlyChars: { hans: Set<string>; hant: Set<string> } | undefined;
function getScriptOnlyChars(): { hans: Set<string>; hant: Set<string> } {
  if (scriptOnlyChars) return scriptOnlyChars;
  const hans = new Set<string>();
  const hant = new Set<string>();
  for (const g of TCM_GLOSSARY) {
    const a = Array.from(g.hans);
    const b = Array.from(g.hant);
    if (a.length !== b.length) continue;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        hans.add(a[i]);
        hant.add(b[i]);
      }
    }
  }
  // A character used in both scripts is not evidence of either
  for (const g of TCM_GLOSSARY) {
    Array.from(g.hans).forEach(ch => hant.delete(ch));
    Array.from(g.hant).forEach(ch => hans.delete(ch));
  }
  scriptOnlyChars = { hans, hant };
  return scriptOnlyChars;
}

function isOtherScript(term: string, script: 'hans' | 'hant'): boolean {
  const other = getScriptOnlyChars()[script === 'hant' ? 'hans' : 'hant'];
  return Array.from(term).some(ch => other.has(ch));
}

/**
 * Board terms cleaned up. A board term that is a glossary entry is used only in the
 * transcript's script; any other board term written in the other script is dropped so
 * corrections never mix scripts.
 */
function normaliseBoardTerms(boardTerms: string[] | undefined, script: 'hans' | 'hant'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const raw of boardTerms || []) {
    if (typeof raw !== 'string') continue;
    const term = raw.trim().replace(/\s+/g, '');
    const len = cpLength(term);
    if (len < MIN_TERM_CHARS || len > MAX_TERM_CHARS || !HAN_RE.test(term)) continue;
    const entry = TCM_GLOSSARY.find(g => g.hans === term || g.hant === term);
    if (entry) {
      add(glossaryForm(entry, script));
      continue;
    }
    if (isOtherScript(term, script)) continue;
    add(term);
  }
  return out;
}

/** Glossary terms that share characters with the segment, most relevant first. */
function selectRelevantTerms(segment: string, terms: string[], limit: number): string[] {
  const segChars = new Set(Array.from(segment).filter(ch => HAN_RE.test(ch)));
  const scored: Array<{ term: string; ratio: number; shared: number; order: number }> = [];
  terms.forEach((term, order) => {
    const chars = Array.from(new Set(Array.from(term)));
    const shared = chars.filter(ch => segChars.has(ch)).length;
    if (shared === 0) return;
    scored.push({ term, ratio: shared / chars.length, shared, order });
  });
  scored.sort((a, b) => b.ratio - a.ratio || b.shared - a.shared || a.order - b.order);
  return scored.slice(0, limit).map(s => s.term);
}

function buildPrompt(segment: string, script: 'hans' | 'hant', boardTerms: string[], glossaryTerms: string[], label: string): string {
  const scriptName = script === 'hant' ? 'Traditional Chinese' : 'Simplified Chinese';
  return `You are proofreading a Chinese speech-to-text transcript of a Traditional Chinese Medicine (中医) lecture${label}.
The recogniser often writes a DOMAIN TERM with wrong homophone or near-homophone characters, e.g.
黄旗 -> 黄芪, 当规 -> 当归, 足三李 -> 足三里, 伤寒轮 -> 伤寒论, 脾需 -> 脾虚, 六位地黄丸 -> 六味地黄丸.

TASK: list ONLY such mis-recognised domain terms (herbs, formulas, acupoints, meridians, classics, theory / diagnosis terms).
Do NOT rewrite the text. Do NOT fix grammar, filler words, punctuation, everyday words or anything that is not a domain term.
Do NOT change a term that is already a correct term into a different term. When unsure, leave it out.
The corrected form must be a real TCM term, written in ${scriptName}, and normally has the same number of characters.
${boardTerms.length > 0 ? `
TERMS WRITTEN ON THE TEACHER'S BLACKBOARD (strongest evidence - the lecture is about these):
${boardTerms.join('、')}
` : ''}
REFERENCE GLOSSARY (subset):
${glossaryTerms.join('、') || '(none)'}

For each error return:
- "original": the wrong characters exactly as they appear in the transcript
- "corrected": the correct term
- "context": 8-20 consecutive characters copied VERBATIM from the transcript that contain "original" plus at least ${MIN_CONTEXT_EXTRA_CHARS} characters around it
- "reason": a few words (e.g. "homophone of 黄芪 (huángqí)")
If the same error occurs several times, list each occurrence with its own context.
Return JSON {"corrections": [...]}; return {"corrections": []} when there is nothing to fix.

TRANSCRIPT:
${segment}`;
}

/** Parse {"corrections": [...]} (or a bare array), tolerating code fences / surrounding prose. */
export function parseProposalJson(raw: string): TermCorrection[] {
  if (!raw) return [];
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const attempts = [cleaned];
  const objStart = cleaned.indexOf('{');
  const objEnd = cleaned.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) attempts.push(cleaned.slice(objStart, objEnd + 1));
  const arrStart = cleaned.indexOf('[');
  const arrEnd = cleaned.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) attempts.push(cleaned.slice(arrStart, arrEnd + 1));
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.corrections) ? parsed.corrections : null;
      if (!list) continue;
      return list
        .filter((p: any) => p && typeof p === 'object')
        .map((p: any) => ({
          original: String(p.original ?? ''),
          corrected: String(p.corrected ?? ''),
          context: String(p.context ?? ''),
          ...(p.reason ? { reason: String(p.reason) } : {})
        }));
    } catch {
      // try the next candidate
    }
  }
  return [];
}

/**
 * One proposal request. llm-client retries rate limits / 5xx / network errors with backoff and
 * never retries billing errors (LlmError.billing), which the caller uses to stop early.
 */
async function proposeForSegment(prompt: string): Promise<TermCorrection[]> {
  const text = await generateText({
    task: 'quality',
    prompt,
    json: true,
    temperature: 0,
    maxOutputTokens: 4096
  });
  return parseProposalJson(text);
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
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
 * Find and fix mis-recognised TCM terms in a Chinese transcript. The LLM proposes,
 * applyTermCorrections verifies and applies. Never throws: on failure the text is
 * returned unchanged.
 */
export async function correctDomainTerms(
  text: string,
  opts: { languageCode: string; domain: 'tcm'; boardTerms?: string[] }
): Promise<TermCorrectionResult> {
  const unchanged: TermCorrectionResult = { text: text || '', corrections: [], applied: 0, rejected: 0 };
  if (!text || !text.trim()) return unchanged;
  if (!isLlmConfigured('quality')) {
    console.warn(`⚠️ Domain-term correction skipped: LLM not configured (${llmUnavailableReason() ?? 'DASHSCOPE_API_KEY is not set'})`);
    return unchanged;
  }

  try {
    const script = scriptForLanguageCode(opts.languageCode);
    const glossaryTerms = Array.from(new Set(TCM_GLOSSARY.map(t => glossaryForm(t, script))));
    const boardTerms = normaliseBoardTerms(opts.boardTerms, script);
    const allowedTerms = new Set<string>([...glossaryTerms, ...boardTerms]);
    const boardSet = new Set(boardTerms);
    // Both scripts' glossary forms and common variants are valid as written: never "correct" them
    const protectedTerms = new Set<string>([
      ...TCM_GLOSSARY.map(t => t.hans),
      ...TCM_GLOSSARY.map(t => t.hant),
      ...VARIANT_FORMS
    ]);

    const segments = splitTextIntoSegments(text, SEGMENT_CHARS);
    // Where each segment sits in the text, so a proposal only applies inside its own segment
    const segmentRanges: Array<[number, number] | undefined> = [];
    let cursor = 0;
    for (const segment of segments) {
      const at = text.indexOf(segment, cursor);
      if (at === -1) {
        segmentRanges.push(undefined);
      } else {
        segmentRanges.push([at, at + segment.length]);
        cursor = at + segment.length;
      }
    }
    console.log(`🩺 Domain-term correction (${opts.domain}, ${script}, ${llmModelFor('quality')}): ${segments.length} segment(s), ${boardTerms.length} board term(s)`);

    let failed = 0;
    let billingError: string | undefined;
    const perSegment = await mapWithConcurrency(segments, SEGMENT_CONCURRENCY, async (segment, index) => {
      if (billingError) {
        failed++;
        return [] as TermCorrection[];
      }
      const label = segments.length > 1 ? ` (segment ${index + 1} of ${segments.length})` : '';
      const prompt = buildPrompt(
        segment,
        script,
        boardTerms.slice(0, MAX_BOARD_TERMS_PER_PROMPT),
        selectRelevantTerms(segment, glossaryTerms, MAX_GLOSSARY_TERMS_PER_PROMPT),
        label
      );
      try {
        return await proposeForSegment(prompt);
      } catch (error: any) {
        failed++;
        if (isLlmBillingError(error)) billingError = String(error?.message || error);
        console.error(`❌ Term correction segment ${index + 1}/${segments.length} failed, leaving it unchanged: ${error.message}`);
        return [] as TermCorrection[];
      }
    });

    const proposals = perSegment.flat();
    const proposalRanges = perSegment.flatMap((list, index) => list.map(() => segmentRanges[index]));
    const result = applyTermCorrections(text, proposals, allowedTerms, { boardTerms: boardSet, protectedTerms, proposalRanges });
    console.log(
      `✅ Domain-term correction: ${proposals.length} proposal(s), ${result.applied} applied, ${result.rejected} rejected` +
      (failed ? `, ${failed}/${segments.length} segment(s) failed` : '')
    );
    for (const c of result.corrections) console.log(`   ✏️ ${c.original} → ${c.corrected} [${c.source}] «${c.context}»`);
    for (const r of result.rejectedProposals || []) console.log(`   🚫 ${r.original} → ${r.corrected}: ${r.rejectReason}`);
    return result;
  } catch (error: any) {
    console.error('❌ Domain-term correction failed, keeping the transcript unchanged:', error?.message || error);
    return unchanged;
  }
}
