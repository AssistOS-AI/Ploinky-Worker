/**
 * Run folders (no shared output file that runs can overwrite). Every run owns `<dataDir>/<job>/<run-id>/` (created exclusively; another run never writes there): accepted.jsonl, rejected.jsonl,
 * escalations.jsonl, audit.jsonl, decisions.jsonl, summary.md (at most 10 lines), cost.json and run.json (spec hash, models, git commit,
 * status). `<dataDir>/index.jsonl` is append-only (one line when a run starts and one when it ends). A run that reports into the
 * repository copies its summary to a dated path named after the run (`publishSummary`), never to a fixed shared name.
 */
import fs from 'node:fs';
import path from 'node:path';
import {appendJsonl, readJsonl, writeJsonAtomic} from './util.mjs';

export const RUN_FILES = Object.freeze(['accepted.jsonl', 'rejected.jsonl', 'escalations.jsonl', 'audit.jsonl', 'decisions.jsonl']);

export class RunStore {
  constructor({root}) { if (!root) throw new Error('RunStore needs a data dir'); this.root = path.resolve(root); }
  indexFile() { return path.join(this.root, 'index.jsonl'); }
  jobDir(job) { return path.join(this.root, job); }
  runDir(job, run) { return path.join(this.jobDir(job), run); }

  /** Creates the run folder; fails if it exists (a run id is never reused). */
  create(job, run, record) {
    fs.mkdirSync(this.jobDir(job), {recursive: true});
    const dir = this.runDir(job, run);
    fs.mkdirSync(dir); // throws EEXIST: never write into another run's folder
    for (const f of RUN_FILES) fs.writeFileSync(path.join(dir, f), '', {flag: 'wx'});
    writeJsonAtomic(path.join(dir, 'run.json'), record);
    this.index({event: 'started', job, run, spec_hash: record.spec_hash, stage: record.stage ?? null});
    return dir;
  }

  /** Reopens an interrupted run of this process's job for resumption; a finished or stopped run is immutable. */
  reopen(job, run) {
    const dir = this.runDir(job, run);
    const file = path.join(dir, 'run.json');
    if (!fs.existsSync(file)) throw new Error(`no run ${run} of job ${job}`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (rec.status !== 'running' && rec.status !== 'interrupted') throw new Error(`run ${run} is ${rec.status}; finished and stopped runs are immutable (start a new run: the cache makes repeated calls free)`);
    this.index({event: 'resumed', job, run});
    return {dir, record: rec};
  }

  index(row) { fs.mkdirSync(this.root, {recursive: true}); appendJsonl(this.indexFile(), {t: new Date().toISOString(), ...row}); }

  /** Item ids already settled in a run folder (resume). */
  settled(dir) {
    const ids = new Set();
    for (const f of ['accepted.jsonl', 'rejected.jsonl']) for (const r of readJsonl(path.join(dir, f))) ids.add(r.id);
    return ids;
  }

  runs(job = null) {
    return readJsonl(this.indexFile()).filter(r => !job || r.job === job);
  }
}

/** Copies a run's summary into the repository at `<destDir>/<YYYY-MM-DD>-<job>-<run>.md` (never a fixed shared name). */
export function publishSummary(runDir, destDir, {job, run}) {
  const day = run.slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  fs.mkdirSync(destDir, {recursive: true});
  const dest = path.join(destDir, `${day}-${job}-${run}.md`);
  fs.copyFileSync(path.join(runDir, 'summary.md'), dest, fs.constants.COPYFILE_EXCL);
  return dest;
}
