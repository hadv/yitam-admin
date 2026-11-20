#!/usr/bin/env ts-node

/**
 * Find - and optionally repair - points whose vector came from the old random-embedding fallback.
 *
 * Background: until the fallback was removed from services/embedding.ts, every failed Gemini call
 * (e.g. HTTP 402, prepaid credits depleted) silently returned Math.random() - 0.5 in 768 dims, and
 * that vector was stored in Qdrant. Such chunks look normal but can never be found by search.
 * The detector is explained in services/embedding-quality.ts.
 *
 * Usage (from server/):
 *   npm run repair-embeddings                                   # DRY RUN (read-only) on COLLECTION_NAME
 *   npm run repair-embeddings -- --collection <name>            # another collection
 *   npm run repair-embeddings -- --out ./reports/repair.json    # where to write the JSON report
 *   npm run repair-embeddings -- --apply                        # re-embed flagged points (needs a working GEMINI_API_KEY)
 *   npm run repair-embeddings -- --apply --limit 100            # repair at most 100 points this run
 *
 * Options:
 *   --collection <name>  collection to scan (default: COLLECTION_NAME from .env)
 *   --out <path>         JSON report path (default: <os tmpdir>/yitam-repair-embeddings/<collection>-<time>.json)
 *   --apply              re-embed flagged points and replace ONLY their vector (id and payload are kept)
 *   --limit <n>          with --apply: repair at most n points
 *   --batch <n>          with --apply: points per vector update request (default 16)
 *   --delay-ms <n>       with --apply: pause between embedding calls (default 250)
 *   --samples <n>        sample ids listed per source in the report / output (default 5)
 *
 * Dry run only reads (scroll / count / get collection). --apply:
 *   - checks that Gemini embeddings work before touching anything,
 *   - re-reads each flagged point and skips it when it is no longer flagged (safe to re-run / resume),
 *   - embeds the same text ingestion embedded (audio transcript chunks: enhancedContent || content,
 *     documents and YouTube captions: content),
 *   - writes with the vector-only update API (PUT /points/vectors), so payloads are never rewritten,
 *   - stops at the first billing / API-key error, after saving what was already re-embedded.
 *
 * Take a backup first (npm run backup export) before running --apply on production data.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertValidEmbedding,
  createEmbedding,
  embeddingTextForPayload,
  GEMINI_VECTOR_SIZE,
  isAudioTranscriptChunk,
  isEmbeddingError,
  isFatalEmbeddingError,
  TaskType
} from '../services/embedding';
import { classifyVector, RANDOM_FALLBACK_RULE, VectorStats, VectorVerdict } from '../services/embedding-quality';

dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'knowledge_base';

// Free-tier clusters are small: keep pages modest
const SCROLL_PAGE = 128;
const RETRIEVE_PAGE = 64;
const MAX_CONSECUTIVE_FAILURES = 5;

const client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function intArg(name: string, fallback: number, min: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    console.error(`--${name} must be an integer >= ${min}`);
    process.exit(2);
  }
  return n;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type PointId = string | number;

interface SourceSummary {
  key: string;
  kind: 'youtube' | 'youtube-audio' | 'document';
  documentName?: string;
  sourceFile?: string;
  domains?: string[];
  total: number;
  random: number;
  ambiguous: number;
  invalid: number;
  sampleIds: Array<{ pointId: PointId; chunkId?: string }>;
}

interface ScanResult {
  scanned: number;
  counts: Record<VectorVerdict, number>;
  flagged: PointId[];
  ambiguous: Array<{ pointId: PointId; chunkId?: string; reason?: string; stats?: VectorStats }>;
  invalid: Array<{ pointId: PointId; chunkId?: string; reason?: string }>;
  sources: Map<string, SourceSummary>;
  statsByVerdict: Record<VectorVerdict, VectorStats[]>;
}

function sourceOf(payload: any): Pick<SourceSummary, 'key' | 'kind'> {
  const chunkId = typeof payload?.id === 'string' ? payload.id : '';
  const yt = chunkId.match(/^youtube_(.+?)_chunk_\d+$/);
  if (yt) {
    const audio = isAudioTranscriptChunk(payload);
    return { key: `youtube_${yt[1]}${audio ? ' (audio)' : ''}`, kind: audio ? 'youtube-audio' : 'youtube' };
  }
  return { key: `doc: ${payload?.documentName ?? '(no documentName)'}`, kind: 'document' };
}

async function collectionVectorConfig(collection: string): Promise<{ size: number; distance: string }> {
  const info: any = await client.getCollection(collection);
  const vectors = info.config?.params?.vectors;
  if (!vectors || typeof vectors.size !== 'number') {
    throw new Error(
      `Collection '${collection}' uses named vectors (${JSON.stringify(Object.keys(vectors || {}))}); ` +
      'this script only handles the single unnamed vector the app writes.'
    );
  }
  return { size: vectors.size, distance: String(vectors.distance) };
}

async function scan(collection: string, dims: number, normalized: boolean, samples: number): Promise<ScanResult> {
  const total = (await client.count(collection, { exact: true })).count;
  const result: ScanResult = {
    scanned: 0,
    counts: { ok: 0, random: 0, ambiguous: 0, invalid: 0 },
    flagged: [],
    ambiguous: [],
    invalid: [],
    sources: new Map(),
    statsByVerdict: { ok: [], random: [], ambiguous: [], invalid: [] }
  };

  let offset: any = undefined;
  do {
    const page: any = await client.scroll(collection, {
      limit: SCROLL_PAGE,
      offset,
      with_payload: { include: ['id', 'documentName', 'title', 'sourceFile', 'domains'] },
      with_vector: true
    });

    for (const point of page.points) {
      const payload = point.payload || {};
      const { verdict, stats, reason } = classifyVector(point.vector, dims, normalized);
      result.scanned++;
      result.counts[verdict]++;
      if (stats) result.statsByVerdict[verdict].push(stats);

      const { key, kind } = sourceOf(payload);
      let src = result.sources.get(key);
      if (!src) {
        src = {
          key,
          kind,
          documentName: payload.documentName,
          sourceFile: payload.sourceFile,
          domains: payload.domains,
          total: 0,
          random: 0,
          ambiguous: 0,
          invalid: 0,
          sampleIds: []
        };
        result.sources.set(key, src);
      }
      src.total++;

      const ref = { pointId: point.id as PointId, chunkId: payload.id as string | undefined };
      if (verdict === 'random') {
        src.random++;
        result.flagged.push(point.id);
        if (src.sampleIds.length < samples) src.sampleIds.push(ref);
      } else if (verdict === 'ambiguous') {
        src.ambiguous++;
        result.ambiguous.push({ ...ref, reason, stats });
      } else if (verdict === 'invalid') {
        src.invalid++;
        result.invalid.push({ ...ref, reason });
      }
    }

    offset = page.next_page_offset;
    process.stdout.write(`\r  scanned ${result.scanned}/${total}`);
  } while (offset);
  process.stdout.write('\n');
  return result;
}

function histogram(values: number[], edges: number[]): Array<{ range: string; count: number }> {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], count: 0 }));
  let below = 0;
  let above = 0;
  for (const v of values) {
    if (v < edges[0]) below++;
    else if (v >= edges[edges.length - 1]) above++;
    else {
      const bin = bins.find(b => v >= b.lo && v < b.hi);
      if (bin) bin.count++;
    }
  }
  const fmt = (x: number) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));
  return [
    { range: `< ${fmt(edges[0])}`, count: below },
    ...bins.map(b => ({ range: `[${fmt(b.lo)}, ${fmt(b.hi)})`, count: b.count })),
    { range: `>= ${fmt(edges[edges.length - 1])}`, count: above }
  ];
}

function printHistogram(title: string, rows: Array<{ range: string; count: number }>): void {
  const max = Math.max(1, ...rows.map(r => r.count));
  console.log(`\n${title}`);
  for (const r of rows) {
    const bar = '#'.repeat(Math.round((r.count / max) * 50));
    console.log(`  ${r.range.padEnd(16)} ${String(r.count).padStart(7)}  ${bar}`);
  }
}

function range(values: number[]): string {
  if (values.length === 0) return '-';
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return `${lo.toFixed(3)} .. ${hi.toFixed(3)}`;
}

function allStats(scanResult: ScanResult): VectorStats[] {
  const s = scanResult.statsByVerdict;
  return [...s.ok, ...s.random, ...s.ambiguous, ...s.invalid];
}

function buildReport(collection: string, config: { size: number; distance: string }, scanResult: ScanResult, extra: Record<string, unknown> = {}) {
  const stats = allStats(scanResult);
  const sources = [...scanResult.sources.values()].sort((a, b) => b.random - a.random || b.total - a.total);
  const byVerdict = (v: VectorVerdict, key: keyof VectorStats) => range(scanResult.statsByVerdict[v].map(s => s[key] as number));
  return {
    collection,
    generatedAt: new Date().toISOString(),
    vectorConfig: config,
    storedNormalized: config.distance === 'Cosine',
    rule: RANDOM_FALLBACK_RULE,
    totals: { scanned: scanResult.scanned, ...scanResult.counts },
    statRanges: Object.fromEntries((['ok', 'random', 'ambiguous'] as VectorVerdict[]).map(v => [v, {
      count: scanResult.statsByVerdict[v].length,
      norm: byVerdict(v, 'norm'),
      maxAbs: byVerdict(v, 'maxAbs'),
      peak: byVerdict(v, 'peak'),
      kurtosis: byVerdict(v, 'kurtosis'),
      flatShare: byVerdict(v, 'flatShare')
    }])),
    histograms: {
      norm: histogram(stats.map(s => s.norm), [0, 0.5, 0.9, 0.99, 1.01, 1.1, 2, 4, 7, 9, 12]),
      peak: histogram(stats.map(s => s.peak), [1, 1.5, 2, 2.5, 3, 4, 6, 8, 10, 12, 16]),
      kurtosis: histogram(stats.map(s => s.kurtosis), [-1.5, -1, -0.6, 0, 1, 5, 10, 20, 30, 50, 80]),
      flatShare: histogram(stats.map(s => s.flatShare), [0, 0.1, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 1.01])
    },
    sources: sources.map(s => ({ ...s, sampleIds: s.sampleIds })),
    flaggedPointIds: scanResult.flagged,
    ambiguous: scanResult.ambiguous,
    invalid: scanResult.invalid,
    ...extra
  };
}

function printSummary(report: ReturnType<typeof buildReport>, samples: number): void {
  const t = report.totals;
  console.log(`\nVectors      : ${report.vectorConfig.size} dims, ${report.vectorConfig.distance}` +
    (report.storedNormalized ? ' (Qdrant stores them L2-normalised; detector is scale-invariant)' : ''));
  console.log(`Scanned      : ${t.scanned}`);
  console.log(`OK           : ${t.ok}`);
  console.log(`RANDOM       : ${t.random}   <- old fallback vectors, unsearchable`);
  console.log(`Ambiguous    : ${t.ambiguous}   (some checks matched; reported, never repaired)`);
  console.log(`Invalid      : ${t.invalid}   (wrong size / zero / non-finite; reported, never repaired)`);

  console.log('\nStatistic ranges per verdict (min .. max):');
  for (const [verdict, r] of Object.entries(report.statRanges)) {
    const row = r as any;
    if (!row.count) continue;
    console.log(`  ${verdict.padEnd(9)} n=${String(row.count).padEnd(6)} peak ${row.peak}   kurtosis ${row.kurtosis}   flatShare ${row.flatShare}   norm ${row.norm}`);
  }

  printHistogram('L2 norm (all points)', report.histograms.norm);
  printHistogram('peak = max|x| / rms  (uniform <= 1.73, real embeddings >> 3)', report.histograms.peak);
  printHistogram('excess kurtosis  (uniform -1.2, real embeddings >> 0)', report.histograms.kurtosis);
  printHistogram('share of |x| > 0.87*rms  (uniform ~0.5, real embeddings ~0.2)', report.histograms.flatShare);

  const affected = report.sources.filter(s => s.random > 0);
  console.log(`\nAffected sources: ${affected.length} of ${report.sources.length}`);
  const kinds: Record<string, { sources: number; points: number }> = {};
  for (const s of affected) {
    kinds[s.kind] = kinds[s.kind] || { sources: 0, points: 0 };
    kinds[s.kind].sources++;
    kinds[s.kind].points += s.random;
  }
  for (const [kind, k] of Object.entries(kinds)) {
    console.log(`  ${kind.padEnd(14)} ${String(k.points).padStart(6)} random points in ${k.sources} source(s)`);
  }
  console.log('\nTop affected sources (random / total):');
  for (const s of affected.slice(0, 25)) {
    const name = s.kind === 'document' ? s.key : `${s.key}  ${s.documentName ?? ''}`;
    const ids = s.sampleIds.slice(0, samples).map(x => x.chunkId ?? String(x.pointId)).join(', ');
    console.log(`  ${String(s.random).padStart(5)} / ${String(s.total).padEnd(5)} ${name.slice(0, 110)}`);
    if (ids) console.log(`                 e.g. ${ids.slice(0, 160)}`);
  }
  if (affected.length > 25) console.log(`  ... ${affected.length - 25} more in the JSON report`);
}

function writeReport(outPath: string, report: unknown): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${outPath}`);
}

async function applyRepair(
  collection: string,
  config: { size: number; distance: string },
  flagged: PointId[],
  options: { limit?: number; batch: number; delayMs: number }
): Promise<{ repaired: number; skippedNoLongerFlagged: number; skippedNoText: PointId[]; failed: Array<{ pointId: PointId; error: string }>; unsaved: PointId[]; stoppedReason?: string }> {
  const normalized = config.distance === 'Cosine';
  const targets = options.limit !== undefined ? flagged.slice(0, options.limit) : flagged;
  const outcome = {
    repaired: 0,
    skippedNoLongerFlagged: 0,
    skippedNoText: [] as PointId[],
    failed: [] as Array<{ pointId: PointId; error: string }>,
    /** Re-embedded, but the Qdrant write failed: these points still carry their old vector. */
    unsaved: [] as PointId[],
    stoppedReason: undefined as string | undefined
  };
  const stop = (reason: string) => {
    // Keep the first reason: it is what made the run stop
    if (!outcome.stoppedReason) outcome.stoppedReason = reason;
  };

  console.log(`\nRepairing ${targets.length} of ${flagged.length} flagged point(s) in '${collection}' ` +
    `(batch ${options.batch}, ${options.delayMs}ms between embedding calls)`);

  let pending: Array<{ id: PointId; vector: number[] }> = [];
  /** Write the pending vectors. Never throws: a failed write is recorded and returns false. */
  const flush = async (): Promise<boolean> => {
    if (pending.length === 0) return true;
    const batchToWrite = pending;
    pending = [];
    try {
      // Vector-only update: payload (and id) stay exactly as they are
      await client.updateVectors(collection, { wait: true, points: batchToWrite });
      outcome.repaired += batchToWrite.length;
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.unsaved.push(...batchToWrite.map(p => p.id));
      stop(`Qdrant updateVectors failed for ${batchToWrite.length} point(s): ${message}`);
      console.error(`

STOPPED: ${outcome.stoppedReason}
  not written: ${batchToWrite.map(p => p.id).join(', ')}`);
      return false;
    }
  };

  let consecutiveFailures = 0;
  let processed = 0;

  try {
    for (let i = 0; i < targets.length; i += RETRIEVE_PAGE) {
      const ids = targets.slice(i, i + RETRIEVE_PAGE);
      const points: any[] = await client.retrieve(collection, { ids, with_payload: true, with_vector: true });

      for (const point of points) {
        processed++;
        // Resume / race safety: only touch points that still carry a fallback vector
        if (classifyVector(point.vector, config.size, normalized).verdict !== 'random') {
          outcome.skippedNoLongerFlagged++;
          continue;
        }
        const payload = point.payload || {};
        const text = embeddingTextForPayload(payload);
        if (!text.trim()) {
          outcome.skippedNoText.push(point.id);
          continue;
        }

        try {
          const vector = await createEmbedding(text, TaskType.RETRIEVAL_DOCUMENT);
          assertValidEmbedding(vector, `Point ${point.id}`, config.size);
          // Never replace one bad vector with another
          if (classifyVector(vector, config.size, false).verdict === 'random') {
            throw new Error('new embedding still looks random; refusing to write it');
          }
          pending.push({ id: point.id, vector });
          consecutiveFailures = 0;
        } catch (error) {
          if (isFatalEmbeddingError(error)) {
            stop(error.message);
            console.error(`\n\nSTOPPED (billing / API key problem, further calls cannot succeed):\n  ${error.message}`);
            return outcome;
          }
          const message = error instanceof Error ? error.message : String(error);
          outcome.failed.push({ pointId: point.id, error: message });
          consecutiveFailures++;
          console.error(`\n  point ${point.id} (${payload.id ?? '?'}) failed: ${message}`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            stop(`${MAX_CONSECUTIVE_FAILURES} consecutive failures, last: ${message}`);
            console.error(`\n\nSTOPPED: ${outcome.stoppedReason}`);
            return outcome;
          }
        }

        if (pending.length >= options.batch && !(await flush())) return outcome;
        process.stdout.write(`\r  processed ${processed}/${targets.length}, repaired ${outcome.repaired + pending.length}`);
        if (options.delayMs > 0) await sleep(options.delayMs);
      }
    }
    return outcome;
  } catch (error) {
    // e.g. a Qdrant retrieve failure: keep the outcome so far instead of losing the report
    const message = error instanceof Error ? error.message : String(error);
    stop(`unexpected error: ${message}`);
    console.error(`\n\nSTOPPED: ${outcome.stoppedReason}`);
    return outcome;
  } finally {
    // Always save what was already re-embedded (also when stopping early); flush() never throws
    await flush();
    process.stdout.write('\n');
  }
}

async function main() {
  const collection = arg('collection') || COLLECTION_NAME;
  const apply = flag('apply');
  const samples = intArg('samples', 5, 0);
  const limit = arg('limit') !== undefined ? intArg('limit', 0, 1) : undefined;
  const batch = intArg('batch', 16, 1);
  const delayMs = intArg('delay-ms', 250, 0);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.resolve(arg('out') || path.join(os.tmpdir(), 'yitam-repair-embeddings', `${collection}-${stamp}.json`));

  // The cluster URL is not printed (it is treated as a secret, like the API key)
  console.log(`Qdrant     : QDRANT_URL from .env${/cloud\.qdrant\.io/.test(QDRANT_URL) ? ' (Qdrant Cloud)' : ''}`);
  console.log(`Collection : ${collection}`);
  console.log(`Mode       : ${apply ? 'APPLY (re-embed flagged points, vector-only updates)' : 'DRY RUN (read-only)'}`);

  const config = await collectionVectorConfig(collection);
  if (config.size !== GEMINI_VECTOR_SIZE) {
    console.warn(`WARNING: collection has ${config.size} dims but GEMINI_VECTOR_SIZE is ${GEMINI_VECTOR_SIZE}.`);
    if (apply) {
      console.error('Refusing to --apply: new embeddings would not fit this collection.');
      process.exit(1);
    }
  }

  if (apply) {
    // Fail before scanning / writing anything when embeddings cannot be created at all
    try {
      await createEmbedding('embedding availability check', TaskType.RETRIEVAL_DOCUMENT);
    } catch (error) {
      console.error(`\nCannot --apply: Gemini embeddings are not working.\n  ${isEmbeddingError(error) ? error.message : error}`);
      process.exit(1);
    }
  }

  const scanResult = await scan(collection, config.size, config.distance === 'Cosine', samples);
  const report = buildReport(collection, config, scanResult, { mode: apply ? 'apply' : 'dry-run' });
  printSummary(report, samples);

  if (!apply) {
    writeReport(outPath, report);
    if (scanResult.flagged.length > 0) {
      console.log(`\nDry run only: nothing was changed. To repair (needs a GEMINI_API_KEY with credits; back up first):`);
      console.log(`  npm run backup export -- --collection ${collection}`);
      console.log(`  npm run repair-embeddings -- --collection ${collection} --apply`);
    }
    return;
  }

  if (scanResult.flagged.length === 0) {
    writeReport(outPath, report);
    console.log('\nNothing to repair.');
    return;
  }

  let outcome: Awaited<ReturnType<typeof applyRepair>>;
  try {
    outcome = await applyRepair(collection, config, scanResult.flagged, { limit, batch, delayMs });
  } catch (error) {
    // applyRepair records its own failures; this only guards against something unforeseen
    writeReport(outPath, { ...report, apply: { error: error instanceof Error ? error.message : String(error) } });
    throw error;
  }
  writeReport(outPath, { ...report, apply: outcome });
  console.log(`\nRepaired             : ${outcome.repaired}`);
  console.log(`No longer flagged    : ${outcome.skippedNoLongerFlagged}`);
  console.log(`Skipped (no text)    : ${outcome.skippedNoText.length}`);
  console.log(`Failed               : ${outcome.failed.length}`);
  if (outcome.unsaved.length > 0) console.log(`Not written (Qdrant) : ${outcome.unsaved.length}`);
  if (outcome.stoppedReason) {
    console.log(`Stopped early        : ${outcome.stoppedReason}`);
    console.log('Fix the problem and run the same command again; already repaired points are skipped.');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('\nrepair-embeddings failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
