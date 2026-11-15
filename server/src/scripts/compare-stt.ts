/**
 * Compare speech-to-text engines on the same audio/video file.
 *
 *   npm run compare-stt -- <audio-or-video-path> [--lang cmn-Hans-CN] [--ref reference.txt]
 *                          [--engines v1,chirp,alibaba,alibaba:fun-asr,alibaba:<model>]
 *                          [--hints-file board.txt] [--context "video title ..."] [--out dir]
 *                          [--domain-hints tcm|none]
 *
 * --engines defaults to every available engine (v1, chirp, alibaba). `alibaba:<model>` runs
 * Alibaba Model Studio with that model (default model: ALIBABA_ASR_MODEL). Each transcript is
 * written to <out>/<name>.<engine>.txt (+ .json with segments). With --ref it prints the
 * character error rate (CER: whitespace and punctuation stripped, NFKC, Levenshtein distance over
 * characters / reference length) and TERM RECALL: of the TCM glossary terms that occur in the
 * reference, the fraction that also occurs in the hypothesis.
 * Without ts-node (production image): npm run build && node dist/scripts/compare-stt.js <args>
 */
import fs from 'fs';
import path from 'path';

/** Strip whitespace, punctuation and symbols; NFKC so full-width and half-width forms compare equal. */
export function normalizeForCer(text: string): string {
  return Array.from((text || '').normalize('NFKC').toLowerCase())
    .filter(ch => !/[\s\p{P}\p{S}]/u.test(ch))
    .join('');
}

/** Levenshtein distance over Unicode code points (O(n*m) time, O(m) memory). */
export function levenshtein(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  if (x.length === 0) return y.length;
  if (y.length === 0) return x.length;
  let previous = new Array(y.length + 1);
  let current = new Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) previous[j] = j;
  for (let i = 1; i <= x.length; i++) {
    current[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[y.length];
}

export interface CerResult {
  cer: number;
  distance: number;
  referenceChars: number;
  hypothesisChars: number;
}

export function computeCer(reference: string, hypothesis: string): CerResult {
  const ref = normalizeForCer(reference);
  const hyp = normalizeForCer(hypothesis);
  const distance = levenshtein(ref, hyp);
  const referenceChars = Array.from(ref).length;
  return {
    cer: referenceChars > 0 ? distance / referenceChars : (Array.from(hyp).length > 0 ? 1 : 0),
    distance,
    referenceChars,
    hypothesisChars: Array.from(hyp).length
  };
}

/** Hints file: one hint per line, or separated by commas / Chinese commas / 、 / ；. */
export function parseHintsFile(content: string): string[] {
  return content
    .split(/[\n\r,，、;；]+/)
    .map(hint => hint.trim())
    .filter(Boolean);
}

/**
 * Glossary terms (script of `languageCode`) that occur in the reference, and how many of them
 * also occur in the hypothesis (both normalised like the CER texts).
 */
export function computeTermRecall(
  reference: string,
  hypothesis: string,
  terms: string[]
): { recall: number; found: number; total: number; missed: string[] } {
  const ref = normalizeForCer(reference);
  const hyp = normalizeForCer(hypothesis);
  const seen = new Set<string>();
  let total = 0;
  let found = 0;
  const missed: string[] = [];
  for (const raw of terms) {
    const term = normalizeForCer(raw);
    if (Array.from(term).length < 2 || seen.has(term)) continue;
    seen.add(term);
    if (!ref.includes(term)) continue;
    total++;
    if (hyp.includes(term)) found++;
    else missed.push(term);
  }
  return { recall: total > 0 ? found / total : 1, found, total, missed };
}

interface EngineSpec {
  /** As given on the command line, e.g. 'alibaba:fun-asr'. */
  label: string;
  engine: 'v1' | 'chirp' | 'alibaba';
  alibabaModel?: string;
}

export function parseEngineList(value: string): EngineSpec[] {
  const out: EngineSpec[] = [];
  for (const raw of value.split(',').map(part => part.trim()).filter(Boolean)) {
    const [name, ...rest] = raw.split(':');
    const engine = name.toLowerCase();
    if (engine !== 'v1' && engine !== 'chirp' && engine !== 'alibaba') {
      throw new Error(`Unknown engine "${raw}" (use v1, chirp, alibaba or alibaba:<model>)`);
    }
    const model = rest.join(':').trim();
    if (model && engine !== 'alibaba') throw new Error(`Only alibaba takes a model (got "${raw}")`);
    out.push({ label: raw, engine, alibabaModel: model || undefined });
  }
  if (out.length === 0) throw new Error('--engines is empty');
  return out;
}

interface CliArgs {
  input: string;
  lang: string;
  ref?: string;
  hintsFile?: string;
  out?: string;
  domainHints: 'tcm' | 'none';
  engines?: string;
  context?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      // Split on the FIRST '=' only: values (paths, context text) may contain '='
      const eq = arg.indexOf('=');
      const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const value = inline ?? argv[i + 1];
      if (inline === undefined) i++;
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        throw new Error(`Missing value for --${key} (use --${key}=<value> for a value starting with '--')`);
      }
      flags[key] = value;
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new Error(
      'Usage: npm run compare-stt -- <audio-or-video-path> [--lang cmn-Hans-CN] [--ref reference.txt] ' +
      '[--engines v1,chirp,alibaba,alibaba:<model>] [--hints-file board.txt] [--context text] [--out dir] ' +
      '[--domain-hints tcm|none]'
    );
  }
  const domainHints = flags['domain-hints'] === 'none' ? 'none' : 'tcm';
  return {
    input: path.resolve(positional[0]),
    lang: flags.lang || 'cmn-Hans-CN',
    ref: flags.ref ? path.resolve(flags.ref) : undefined,
    hintsFile: flags['hints-file'] ? path.resolve(flags['hints-file']) : undefined,
    out: flags.out ? path.resolve(flags.out) : undefined,
    domainHints,
    engines: flags.engines,
    context: flags.context
  };
}

function fileTag(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);

  // Imported lazily so the pure helpers above can be tested without credentials / side effects
  const {
    transcribeVideoFile,
    isGoogleV1Available,
    isChirpAvailable,
    isAlibabaAsrAvailable
  } = await import('../services/audio-transcription');
  const { getTcmPhraseHints, scriptForLanguageCode } = await import('../services/tcm-glossary');

  const available = {
    v1: isGoogleV1Available(),
    chirp: isChirpAvailable(),
    alibaba: isAlibabaAsrAvailable()
  };
  const specs: EngineSpec[] = args.engines
    ? parseEngineList(args.engines)
    : (['v1', 'chirp', 'alibaba'] as const).filter(engine => available[engine]).map(engine => ({ label: engine, engine }));
  if (specs.length === 0) {
    throw new Error('No engine available (configure Google Speech-to-Text credentials and/or DASHSCOPE_API_KEY)');
  }
  for (const spec of specs) {
    if (!available[spec.engine]) {
      console.warn(`⚠️ ${spec.label}: engine not available; the run will fall back (or fail).`);
    }
  }

  const phraseHints = args.hintsFile ? parseHintsFile(fs.readFileSync(args.hintsFile, 'utf8')) : undefined;
  const reference = args.ref ? fs.readFileSync(args.ref, 'utf8') : undefined;
  const glossaryTerms = getTcmPhraseHints(scriptForLanguageCode(args.lang));
  const outDir = args.out || path.dirname(args.input);
  fs.mkdirSync(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(args.input, path.extname(args.input)));

  const summary: Array<Record<string, unknown>> = [];
  for (const spec of specs) {
    console.log(`\n===== ${spec.label.toUpperCase()} (${args.lang}, domain hints ${args.domainHints}) =====`);
    const started = Date.now();
    const tag = fileTag(spec.label);
    try {
      const result = await transcribeVideoFile(args.input, {
        languageCode: args.lang,
        engine: spec.engine,
        alibabaModel: spec.alibabaModel,
        domainHints: args.domainHints,
        phraseHints,
        contextText: args.context
      });
      const seconds = (Date.now() - started) / 1000;
      fs.writeFileSync(`${base}.${tag}.txt`, result.transcript + '\n', 'utf8');
      fs.writeFileSync(`${base}.${tag}.json`, JSON.stringify(result, null, 2), 'utf8');
      const row: Record<string, unknown> = {
        requested: spec.label,
        engine: result.engine,
        model: result.model,
        language: result.languageCode,
        chars: Array.from(normalizeForCer(result.transcript)).length,
        segments: result.segments?.length ?? 0,
        seconds: Number(seconds.toFixed(1)),
        output: `${base}.${tag}.txt`
      };
      if (reference !== undefined) {
        const cer = computeCer(reference, result.transcript);
        row.cer = Number((cer.cer * 100).toFixed(2));
        row.distance = cer.distance;
        row.referenceChars = cer.referenceChars;
        const recall = computeTermRecall(reference, result.transcript, glossaryTerms);
        row.termRecall = Number((recall.recall * 100).toFixed(1));
        row.terms = `${recall.found}/${recall.total}`;
        if (recall.missed.length) row.missedTerms = recall.missed.slice(0, 20).join(',');
      }
      if (result.engine !== spec.engine) row.note = `fell back to ${result.engine}`;
      else if (spec.alibabaModel && result.model !== spec.alibabaModel) row.note = `model ${result.model}`;
      summary.push(row);
    } catch (error: any) {
      summary.push({ requested: spec.label, error: error?.message || String(error) });
    }
  }

  console.log('\n===== SUMMARY =====');
  for (const row of summary) {
    console.log(JSON.stringify(row));
  }
  if (reference !== undefined) {
    console.log('(cer = character error rate in %, whitespace and punctuation ignored; termRecall = % of TCM glossary terms in the reference also found in the transcript)');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`❌ ${error?.message || error}`);
    process.exit(1);
  });
}
