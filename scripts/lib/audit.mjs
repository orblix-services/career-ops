import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const sha256 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export function recordEvaluation({ mode, cli, model, modelVersion, sourceFiles = [], reportPath = null, score = null, extra = {} }) {
  const entry = {
    ts: new Date().toISOString(),
    mode, cli, model, model_version: modelVersion,
    sources: Object.fromEntries(sourceFiles.filter(p => existsSync(p)).map(p => [p, sha256(readFileSync(p, 'utf8'))])),
    report: reportPath,
    score,
    ...extra,
  };
  const logPath = join(process.cwd(), 'data', 'audit-log.jsonl');
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  return entry;
}
