#!/usr/bin/env node
/**
 * scripts/purge.mjs — retention / right-of-erasure helper for career-ops
 *
 * Removes stale evaluation artefacts (PDFs, reports, interview notes, batch
 * logs and tracker additions) older than --older-than Nd. Optionally narrowed
 * to a single slug.
 *
 * NEVER touches: cv.md, config/profile.yml, data/*, jds/*.
 *
 * Usage:
 *   node scripts/purge.mjs --older-than 90d
 *   node scripts/purge.mjs --older-than 0d --slug acme
 *   node scripts/purge.mjs --older-than 30d --dry-run
 */

import { readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Parse args
const args = process.argv.slice(2);
let olderThanDays = 90;
let slug = null;
let dryRun = false;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--older-than' && args[i + 1]) {
    const m = String(args[++i]).match(/^(\d+)d?$/);
    if (!m) {
      console.error(`Invalid --older-than value: must be like "90d" or "0".`);
      process.exit(1);
    }
    olderThanDays = parseInt(m[1], 10);
  } else if (a === '--slug' && args[i + 1]) {
    slug = String(args[++i]).toLowerCase();
  } else if (a === '--dry-run') {
    dryRun = true;
  } else if (a === '-h' || a === '--help') {
    console.log(`Usage: node scripts/purge.mjs [--older-than Nd] [--slug NAME] [--dry-run]

Targets (read-write):
  output/*.pdf
  reports/*.md
  interview-prep/*.md
  batch/logs/*.log
  batch/tracker-additions/*.tsv

Never touched:
  cv.md, config/profile.yml, data/*, jds/*
`);
    process.exit(0);
  } else {
    console.error(`Unknown arg: ${a}`);
    process.exit(1);
  }
}

const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

const TARGETS = [
  { dir: 'output', pattern: /\.pdf$/i },
  { dir: 'reports', pattern: /\.md$/i },
  { dir: 'interview-prep', pattern: /\.md$/i },
  { dir: 'batch/logs', pattern: /\.log$/i },
  { dir: 'batch/tracker-additions', pattern: /\.tsv$/i },
];

// Collect candidate files
const candidates = [];
for (const { dir, pattern } of TARGETS) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) continue;

  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    continue;
  }

  for (const name of entries) {
    if (!pattern.test(name)) continue;
    if (slug && !basename(name).toLowerCase().includes(slug)) continue;

    const full = join(abs, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs >= cutoffMs) continue;

    candidates.push({ path: full, rel: join(dir, name), size: st.size });
  }
}

if (candidates.length === 0) {
  console.log('No files matched the criteria. Nothing to purge.');
  process.exit(0);
}

const totalBytes = candidates.reduce((sum, c) => sum + c.size, 0);
const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);

console.log(`career-ops purge — ${candidates.length} file(s), ${totalMB} MB`);
console.log(`Older than: ${olderThanDays} day(s)${slug ? `, slug filter: "${slug}"` : ''}`);
console.log('');
for (const c of candidates) {
  console.log(`  ${c.rel}`);
}
console.log('');

if (dryRun) {
  console.log('[--dry-run] no files were deleted.');
  process.exit(0);
}

// Confirmation
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise(resolve => rl.question('Type "purge" to confirm: ', resolve));
rl.close();

if (String(answer).trim() !== 'purge') {
  console.error('Aborted: confirmation did not match.');
  process.exit(1);
}

let purgedCount = 0;
let purgedBytes = 0;
for (const c of candidates) {
  try {
    unlinkSync(c.path);
    purgedCount++;
    purgedBytes += c.size;
  } catch (err) {
    console.warn(`  failed: ${c.rel} — ${err.message}`);
  }
}

const purgedMB = (purgedBytes / (1024 * 1024)).toFixed(2);
console.log(`[purged] ${purgedCount} files, ${purgedMB} MB freed`);
