/**
 * Detect vectors written by the old random-embedding fallback.
 *
 * Until the fallback was removed, createEmbedding() returned
 *   Array.from({ length: 768 }, () => Math.random() - 0.5)
 * whenever the Gemini call failed. Those vectors are i.i.d. uniform(-0.5, 0.5) and carry no meaning.
 *
 * The statistics below are SCALE-INVARIANT (they compare each value with the vector's own RMS), so
 * they work whether the collection stores raw vectors or, with Cosine distance, Qdrant's L2-normalised
 * copies (a normalised uniform vector keeps its flat, bounded value distribution):
 *
 *   statistic                          uniform(-0.5,0.5)          gemini-embedding-001 @768
 *   peak = max|x| / rms                <= sqrt(3) ~ 1.73          >= ~8 (a few dominant dims)
 *   excess kurtosis                    -1.2                        >> 0 (~20 - 55)
 *   share of |x| > (sqrt(3)/2)*rms     ~0.50                       ~0.14 - 0.27
 *   (= share of |x| > 0.25 for a raw uniform vector)
 *
 * Measured on the production collection (7206 points, Cosine, 768 dims, 2026-11-17):
 *   fallback cluster  peak 1.62 - 1.84, kurtosis -1.34 - -1.05, share 0.46 - 0.54
 *   real embeddings   peak 8.49 - 12.2, kurtosis 19.7 - 53.5,   share 0.14 - 0.27
 *
 * A vector is flagged only when ALL three statistics agree (thresholds sit far outside both clusters),
 * and, for collections that store raw vectors, its norm / max |x| also match a raw uniform draw.
 * Vectors where only some statistics match are reported as "ambiguous" and never repaired automatically.
 */

export interface VectorStats {
  dims: number;
  norm: number;
  mean: number;
  maxAbs: number;
  /** max|x| / rms */
  peak: number;
  /** excess kurtosis (0 for a Gaussian, -1.2 for a uniform distribution) */
  kurtosis: number;
  /** share of components with |x| > (sqrt(3)/2) * rms */
  flatShare: number;
}

export type VectorVerdict = 'ok' | 'random' | 'ambiguous' | 'invalid';

export const RANDOM_FALLBACK_RULE = {
  /** uniform: <= 1.73 (observed <= 1.84); real: >= 8.5 */
  maxPeak: 2.5,
  /** uniform: -1.2 (observed <= -1.05); real: >= 19.7 */
  maxKurtosis: -0.6,
  /** uniform: ~0.50 (observed 0.46 - 0.54); real: <= 0.27 */
  minFlatShare: 0.4,
  maxFlatShare: 0.6,
  /** raw (not normalised) uniform(-0.5,0.5) in 768 dims: norm ~ 8.0, |x| <= 0.5 */
  rawMinNorm: 7.0,
  rawMaxNorm: 9.0,
  rawMaxAbs: 0.5 + 1e-6
} as const;

const FLAT_SHARE_CUTOFF = Math.sqrt(3) / 2;

export function vectorStats(vector: number[]): VectorStats {
  const n = vector.length;
  let sum = 0;
  let sumSquares = 0;
  for (const x of vector) {
    sum += x;
    sumSquares += x * x;
  }
  const mean = n > 0 ? sum / n : 0;
  const rms = n > 0 ? Math.sqrt(sumSquares / n) : 0;

  let m2 = 0;
  let m4 = 0;
  let maxAbs = 0;
  let flat = 0;
  for (const x of vector) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
    const a = Math.abs(x);
    if (a > maxAbs) maxAbs = a;
    if (rms > 0 && a / rms > FLAT_SHARE_CUTOFF) flat++;
  }
  m2 = n > 0 ? m2 / n : 0;
  m4 = n > 0 ? m4 / n : 0;

  return {
    dims: n,
    norm: Math.sqrt(sumSquares),
    mean,
    maxAbs,
    peak: rms > 0 ? maxAbs / rms : 0,
    kurtosis: m2 > 0 ? m4 / (m2 * m2) - 3 : 0,
    flatShare: n > 0 ? flat / n : 0
  };
}

/**
 * Classify one stored vector.
 * @param normalized true when the collection uses Cosine distance (Qdrant stores L2-normalised vectors)
 */
export function classifyVector(
  vector: unknown,
  expectedDims: number,
  normalized: boolean
): { verdict: VectorVerdict; stats?: VectorStats; reason?: string } {
  if (!Array.isArray(vector) || vector.length === 0) {
    return { verdict: 'invalid', reason: 'missing vector' };
  }
  if (vector.length !== expectedDims) {
    return { verdict: 'invalid', reason: `has ${vector.length} dims, expected ${expectedDims}` };
  }
  if (!vector.every(x => typeof x === 'number' && Number.isFinite(x))) {
    return { verdict: 'invalid', reason: 'non-finite values' };
  }
  const stats = vectorStats(vector as number[]);
  if (stats.norm === 0) {
    return { verdict: 'invalid', stats, reason: 'all-zero vector' };
  }

  const r = RANDOM_FALLBACK_RULE;
  const checks = [
    stats.peak < r.maxPeak,
    stats.kurtosis < r.maxKurtosis,
    stats.flatShare >= r.minFlatShare && stats.flatShare <= r.maxFlatShare
  ];
  if (!normalized) {
    checks.push(stats.norm >= r.rawMinNorm && stats.norm <= r.rawMaxNorm && stats.maxAbs <= r.rawMaxAbs);
  }
  const matched = checks.filter(Boolean).length;
  if (matched === checks.length) return { verdict: 'random', stats };
  if (matched > 0) return { verdict: 'ambiguous', stats, reason: `${matched}/${checks.length} random-fallback checks matched` };
  return { verdict: 'ok', stats };
}
