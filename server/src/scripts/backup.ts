#!/usr/bin/env ts-node

/**
 * Version-agnostic collection backup / restore.
 *
 * Why this exists: Qdrant Cloud's managed Backups feature is not available on
 * free clusters, and a Qdrant *snapshot* can only be restored into a cluster
 * running the same minor version — so a snapshot taken on 1.13.5 cannot be
 * restored into anything but 1.13.x.
 *
 * This script instead dumps points as plain JSONL (id + vector + payload) and
 * re-inserts them through the ordinary upsert API. That data is not tied to any
 * storage format, so it can be restored into ANY Qdrant version. It is the only
 * rollback path that survives an upgrade you cannot undo.
 *
 * Usage:
 *   npm run backup export                        # dump the configured collection
 *   npm run backup export -- --out ./backups     # choose an output directory
 *   npm run backup restore -- --file <path.jsonl> --collection <name> --confirm
 *
 * Export is read-only. Restore refuses to touch an existing collection unless
 * --force is passed, and never runs without --confirm.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

dotenv.config();

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'knowledge_base';

// Free-tier clusters are 0.5 vCPU; keep batches small so export/restore does not
// starve the live service.
const SCROLL_BATCH = 100;
const UPSERT_BATCH = 100;

const client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function serverVersion(): Promise<string> {
  try {
    const res = await fetch(`${QDRANT_URL}/`, {
      headers: QDRANT_API_KEY ? { 'api-key': QDRANT_API_KEY } : {},
    });
    return ((await res.json()) as any).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function doExport() {
  const collection = arg('collection') || COLLECTION_NAME;
  const outDir = arg('out') || './backups';
  fs.mkdirSync(outDir, { recursive: true });

  const version = await serverVersion();
  const info: any = await client.getCollection(collection);
  const expected = (await client.count(collection, { exact: true })).count;

  // Timestamp comes from the filesystem clock, not a hardcoded value, so repeat
  // runs never overwrite each other.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(outDir, `${collection}-${stamp}`);
  const dataFile = `${base}.jsonl`;
  const metaFile = `${base}.meta.json`;

  console.log(`Source     : ${QDRANT_URL}`);
  console.log(`Collection : ${collection}`);
  console.log(`Server     : qdrant ${version}`);
  console.log(`Points     : ${expected}`);
  console.log(`Output     : ${dataFile}\n`);

  fs.writeFileSync(
    metaFile,
    JSON.stringify(
      {
        collection,
        exportedAt: new Date().toISOString(),
        qdrantVersion: version,
        sourceUrl: QDRANT_URL,
        pointCount: expected,
        vectors: info.config?.params?.vectors,
        payloadSchema: info.payload_schema,
      },
      null,
      2
    )
  );

  const out = fs.createWriteStream(dataFile);
  let offset: any = undefined;
  let written = 0;

  do {
    const res: any = await client.scroll(collection, {
      limit: SCROLL_BATCH,
      offset,
      with_payload: true,
      with_vector: true,
    });

    for (const p of res.points) {
      out.write(JSON.stringify({ id: p.id, vector: p.vector, payload: p.payload }) + '\n');
      written++;
    }

    offset = res.next_page_offset;
    process.stdout.write(`\r  exported ${written}/${expected}`);
  } while (offset);

  await new Promise<void>((r) => out.end(r));
  console.log('\n');

  // A silently short dump is worse than no dump, so fail loudly on a mismatch.
  if (written !== expected) {
    console.error(`MISMATCH: expected ${expected} points, wrote ${written}. Backup is INCOMPLETE.`);
    process.exit(1);
  }

  const bytes = fs.statSync(dataFile).size;
  console.log(`OK  ${written} points -> ${dataFile} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`OK  metadata          -> ${metaFile}`);
  console.log(`\nRestore with:\n  npm run backup restore -- --file ${dataFile} --collection ${collection}-restored --confirm`);
}

async function countLines(file: string): Promise<number> {
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) n++;
  return n;
}

async function doRestore() {
  const file = arg('file');
  const target = arg('collection');

  if (!file || !target) {
    console.error('Usage: npm run backup restore -- --file <path.jsonl> --collection <name> --confirm');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  const metaFile = file.replace(/\.jsonl$/, '.meta.json');
  if (!fs.existsSync(metaFile)) {
    console.error(`Missing metadata file: ${metaFile} (needed for the collection's vector config)`);
    process.exit(1);
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const total = await countLines(file);
  const version = await serverVersion();

  console.log(`Target     : ${QDRANT_URL}`);
  console.log(`Collection : ${target}`);
  console.log(`Server     : qdrant ${version}`);
  console.log(`From       : ${file}`);
  console.log(`Points     : ${total}  (dump taken on qdrant ${meta.qdrantVersion} from ${meta.sourceUrl})`);
  console.log(`Vectors    : ${JSON.stringify(meta.vectors)}\n`);

  if (!flag('confirm')) {
    console.error('Refusing to write without --confirm. Re-run with --confirm once the target above looks right.');
    process.exit(1);
  }

  const existing = await client.getCollections();
  const exists = existing.collections?.some((c) => c.name === target);
  if (exists && !flag('force')) {
    console.error(`Collection "${target}" already exists. Pass --force to delete and recreate it.`);
    process.exit(1);
  }
  if (exists) {
    console.log(`Deleting existing collection "${target}" (--force)`);
    await client.deleteCollection(target);
  }

  await client.createCollection(target, { vectors: meta.vectors });
  for (const field of Object.keys(meta.payloadSchema || {})) {
    await client.createPayloadIndex(target, {
      field_name: field,
      field_schema: meta.payloadSchema[field].data_type,
    });
  }

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let batch: any[] = [];
  let done = 0;

  const flush = async () => {
    if (!batch.length) return;
    await client.upsert(target, { wait: true, points: batch });
    done += batch.length;
    process.stdout.write(`\r  restored ${done}/${total}`);
    batch = [];
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    const p = JSON.parse(line);
    batch.push({ id: p.id, vector: p.vector, payload: p.payload });
    if (batch.length >= UPSERT_BATCH) await flush();
  }
  await flush();
  console.log('\n');

  const final = (await client.count(target, { exact: true })).count;
  if (final !== total) {
    console.error(`MISMATCH: restored ${final} points, expected ${total}.`);
    process.exit(1);
  }
  console.log(`OK  ${final} points restored into "${target}"`);
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'export':
      await doExport();
      break;
    case 'restore':
      await doRestore();
      break;
    default:
      console.log('Commands:');
      console.log('  export   [--collection <name>] [--out <dir>]');
      console.log('  restore   --file <path.jsonl> --collection <name> --confirm [--force]');
      process.exit(1);
  }
}

main().catch((e) => {
  console.error('\nFAILED:', e?.message ?? e);
  process.exit(1);
});
