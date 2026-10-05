/** Small helpers: hashing, JSONL files, atomic writes, run ids, deterministic ranks. Node built-ins only. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

/** The Ploinky Workers folder (its prompts/ hold the runner's own instructions to the decider, the auditor and the planner). */
export const HOME = fileURLToPath(new URL('../../', import.meta.url));
export const PROMPTS_DIR = path.join(HOME, 'prompts');
export const DEFAULT_ENDPOINT = 'http://127.0.0.1:18080';

export const sha256 = data => createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');

export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export const appendJsonl = (file, row) => fs.appendFileSync(file, JSON.stringify(row) + '\n');

export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

/** `20261002T163012-<6 hex>`: sortable, unique per run. */
export function newRunId(salt = '', now = new Date()) {
  const t = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '');
  return `${t}-${sha256(`${salt}:${now.getTime()}:${randomBytes(8).toString('hex')}`).slice(0, 6)}`;
}

/** The git commit of the folder (with "+dirty" when the tree has changes), or null outside a repository. */
export function gitCommit(dir) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: dir, encoding: 'utf8'});
  if (head.status !== 0) return null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {cwd: dir, encoding: 'utf8'});
  return head.stdout.trim() + (dirty.stdout?.trim() ? '+dirty' : '');
}

/** A rough, conservative token estimate (characters / 3.5). */
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 3.5);

/** Deterministic rank of an id under a seed (sampling, audit selection). */
export const rank = (seed, id) => sha256(`${seed}\u0000${id}`);
/** A deterministic number in [0, 1) for (seed, id). */
export const unit = (seed, id) => parseInt(rank(seed, id).slice(0, 12), 16) / 2 ** 48;
