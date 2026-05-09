#!/usr/bin/env node
/**
 * gemini-eval.mjs — Gemini-powered Job Offer Evaluator for career-ops
 *
 * A free-tier alternative to the Claude-based pipeline.
 * Reads evaluation logic from modes/oferta.md + modes/_shared.md,
 * reads the user's resume from cv.md, and evaluates a Job Description
 * passed as a command-line argument.
 *
 * Usage:
 *   node gemini-eval.mjs "Paste full JD text here"
 *   node gemini-eval.mjs --file ./jds/my-job.txt
 *
 * Requires:
 *   GEMINI_API_KEY in .env (or environment variable)
 *
 * Free-tier model: gemini-2.0-flash (generous quota, no billing required)
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import yaml from 'js-yaml';
import { recordEvaluation } from './scripts/lib/audit.mjs';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv is optional — fall back to process.env if not installed
}

import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  // Primary evaluation logic lives in these two mode files
  shared:   join(ROOT, 'modes', '_shared.md'),
  oferta:   join(ROOT, 'modes', 'oferta.md'),
  // Canonical skill path referenced in Issue #344
  evaluate: join(ROOT, '.claude', 'skills', 'career-ops', 'SKILL.md'),
  cv:       join(ROOT, 'cv.md'),
  reports:  join(ROOT, 'reports'),
  tracker:  join(ROOT, 'data', 'applications.md'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           career-ops — Gemini Evaluator (free-tier)             ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using Google Gemini instead of Claude.

  USAGE
    node gemini-eval.mjs "<JD text>"
    node gemini-eval.mjs --file ./jds/my-job.txt
    node gemini-eval.mjs --model gemini-2.0-flash "<JD text>"

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Gemini model to use (default: gemini-2.0-flash)
    --no-save        Do not save report to reports/ directory
    --no-pii         Redact PII from CV before sending to Gemini
    --yes            Skip the data-transfer confirmation prompt
    --help           Show this help

  SETUP
    1. Get a free API key at https://aistudio.google.com/apikey
    2. Add GEMINI_API_KEY=<your-key> to .env
    3. Run: npm install   (installs @google/generative-ai + dotenv)

  EXAMPLES
    node gemini-eval.mjs "We are looking for a Senior AI Engineer..."
    node gemini-eval.mjs --file ./jds/openai-swe.txt
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let jdPath = null;
let modelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
let saveReport = true;
let noPii = false;
let autoYes = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdPath = filePath;
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--no-pii') {
    noPii = true;
  } else if (args[i] === '--yes') {
    autoYes = true;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// GDPR / data-transfer notice + PII redaction helper
// ---------------------------------------------------------------------------
function redactPII(text) {
  const profilePath = join(ROOT, 'config', 'profile.yml');
  if (!existsSync(profilePath)) return text;

  let profile;
  try {
    profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
  } catch {
    return text;
  }

  const candidate = profile.candidate || {};
  const compensation = profile.compensation || {};
  const location = profile.location || {};

  const replacements = [
    [candidate.full_name, 'NAME'],
    [candidate.email, 'EMAIL'],
    [candidate.phone, 'PHONE'],
    [candidate.location, 'LOCATION'],
    [candidate.linkedin, 'LINKEDIN'],
    [candidate.linkedin_url, 'LINKEDIN'],
    [candidate.portfolio_url, 'PORTFOLIO'],
    [candidate.github, 'GITHUB'],
    [candidate.github_url, 'GITHUB'],
    [candidate.twitter, 'TWITTER'],
    [candidate.twitter_url, 'TWITTER'],
    [compensation.target_range, 'SALARY'],
    [compensation.minimum, 'SALARY'],
    [location.city, 'CITY'],
    [location.country, 'COUNTRY'],
  ];

  let out = text;
  for (const [value, label] of replacements) {
    if (!value) continue;
    const v = String(value).trim();
    if (!v) continue;
    // Escape regex special chars
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), `[REDACTED:${label}]`);
  }
  return out;
}

async function dataTransferNotice() {
  const banner = `─────────────────────────────────────────────────────────────────────
⚠  GEMINI EVALUATION — DATA TRANSFER NOTICE
─────────────────────────────────────────────────────────────────────
This will send to Google (generativelanguage.googleapis.com):
  • Your full CV (cv.md)
  • The job description
  • Internal evaluation prompts

Free-tier API requests may be retained and used to improve Google's
models. For PII (résumé, contacts, salary expectations), this means
your data may be incorporated into training datasets.

GDPR: if you process third-party data (e.g., as a recruiter/coach),
this transfer requires a documented legal basis. Use a paid Vertex AI
project with EU data residency, or run with --no-pii.

Continue? (y/N) [auto-skipped with --yes]
─────────────────────────────────────────────────────────────────────`;
  console.log(banner);
  if (autoYes) {
    console.log('[--yes] auto-confirmed.');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('> ', resolve));
  rl.close();
  if (!/^y(es)?$/i.test(String(answer).trim())) {
    console.error('Aborted by user.');
    process.exit(1);
  }
}

if (!noPii) {
  await dataTransferNotice();
} else {
  console.log('[--no-pii] PII will be redacted from CV before sending to Gemini.');
}

// ---------------------------------------------------------------------------
// Validate environment
// ---------------------------------------------------------------------------
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(`
❌  GEMINI_API_KEY not found.

   1. Get a free key at https://aistudio.google.com/apikey
   2. Add it to .env:   GEMINI_API_KEY=your_key_here
   3. Or export it:     export GEMINI_API_KEY=your_key_here
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

// Lazy import — only used when saving
let readdirSync;
try {
  ({ readdirSync } = await import('fs'));
} catch { /* already imported above via named exports */ }
// Use named import fallback
if (!readdirSync) {
  readdirSync = (await import('fs')).readdirSync;
}

// ---------------------------------------------------------------------------
// Load context files
// ---------------------------------------------------------------------------
console.log('\n📂  Loading context files...');

const sharedContext  = readFile(PATHS.shared,   'modes/_shared.md');
const ofertaLogic    = readFile(PATHS.oferta,   'modes/oferta.md');
let   cvContent      = readFile(PATHS.cv,       'cv.md');

if (noPii) {
  cvContent = redactPII(cvContent);
}

// ---------------------------------------------------------------------------
// Build the system prompt (mirrors the Claude skill router logic)
// ---------------------------------------------------------------------------
const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS CLI SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates based on your training data, clearly noted as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. Generate Blocks A through G in full, in English, unless the JD is in another language.
3. At the very end, output a machine-readable summary block in this exact format:

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ---------------------------------------------------------------------------
// Call Gemini API
// ---------------------------------------------------------------------------
console.log(`🤖  Calling Gemini (${modelName})... this may take 30-60 seconds.\n`);

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({
  model: modelName,
  generationConfig: {
    temperature: 0.4,      // deterministic enough for structured evaluation
    maxOutputTokens: 8192, // full 7-block evaluation
  },
});

let evaluationText;
try {
  const result = await model.generateContent([
    { text: systemPrompt },
    { text: `\n\nJOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
  ]);
  evaluationText = result.response.text();
} catch (err) {
  console.error('❌  Gemini API error:', err.message);
  if (err.message?.includes('API_KEY')) {
    console.error('    Check your GEMINI_API_KEY in .env');
  } else if (err.message?.includes('quota') || err.message?.includes('rate')) {
    console.error('    You may have hit the free-tier rate limit. Wait 60s and retry.');
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log('  CAREER-OPS EVALUATION — powered by Google Gemini');
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse score summary
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    const m = block.match(new RegExp(`${key}:\\s*(.+)`));
    return m ? m[1].trim() : 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport) {
  try {
    if (!existsSync(PATHS.reports)) {
      mkdirSync(PATHS.reports, { recursive: true });
    }

    const num         = nextReportNumber();
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const modeLine = noPii ? '\n**Mode:** --no-pii (PII redacted)' : '';
    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Gemini (${modelName})${modeLine}

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);

    // Audit log
    try {
      const parsedScore = parseFloat(score);
      recordEvaluation({
        mode: 'oferta',
        cli: 'gemini-eval',
        model: modelName,
        modelVersion: 'unknown',
        sourceFiles: [PATHS.cv, PATHS.shared, PATHS.oferta, ...(jdPath ? [jdPath] : [])],
        reportPath,
        score: Number.isFinite(parsedScore) ? parsedScore : null,
        extra: { redacted: noPii, company, role, archetype, legitimacy },
      });
    } catch (auditErr) {
      console.warn(`⚠️   Audit log skipped: ${auditErr.message}`);
    }

    // Append tracker entry reminder
    console.log(`\n📊  Tracker entry (add to data/applications.md):`);
    console.log(`    | ${num} | ${today} | ${company} | ${role} | ${score} | Evaluada | ❌ | [${num}](reports/${filename}) |`);
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  }
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
