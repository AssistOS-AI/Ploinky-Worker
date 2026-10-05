// The run folders written before TaskLambdaCalls existed, wrapped as calls (decided 2026-10-03: wrapped, not moved), so the calls
// index covers past activity too. `pworker calls import [--yes]` creates one call folder per earlier
//   - job run (`<runner.dataDir>/<job>/<run-id>/run.json`): a call of `job` with one child call per item (accepted.jsonl, rejected.jsonl);
//   - task folder (`<runner.dataDir>/tasks/<id>/task.json`): a call of `task`;
//   - server operation (`<runner.dataDir>/ops/<id>/request.json`, result.json): a call of the TaskLambda it ran;
//   - agent run (`<workdir>/.pworker/runs/<id>/request.json`, result.json, with --workdir): a call of `agent`.
// Each call keeps the time of the original, says `migrated_from: <folder>` and links the folder; the original folder is not changed.
// `<calls root>/imported.jsonl` remembers what was wrapped, so a second import adds only new folders.
import fs from 'node:fs';
import path from 'node:path';
import { callStatus } from './calls.mjs';

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const dirs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)).sort() : []);
/** The time of an id such as 20261003T145613-... (a run or operation id), or null. */
const timeOfId = (id) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(path.basename(String(id))); return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };
const summaryOf = (dir) => { try { return fs.readFileSync(path.join(dir, 'summary.md'), 'utf8').trim().slice(0, 4000); } catch { return null; } };

/**
 * Wraps the earlier run folders of `dataDir` (and of `workdirs`' agent runs) as calls of `store`. Returns {calls, items, skipped,
 * sources: [{kind, from, id}]}; with `dryRun` nothing is written.
 */
export function importRunFolders(store, { dataDir, workdirs = [], dryRun = false } = {}) {
  const marker = path.join(store.root, 'imported.jsonl');
  const done = new Set(readLines(marker).map((r) => r.from));
  const out = { calls: 0, items: 0, skipped: 0, sources: [] };
  const wrap = (kind, from, make) => {
    if (done.has(from)) { out.skipped += 1; return; }
    if (dryRun) { out.calls += 1; out.sources.push({ kind, from, id: null }); return; }
    const call = make();
    if (!call) return;
    fs.appendFileSync(marker, JSON.stringify({ kind, from, id: call.id, at: new Date().toISOString() }) + '\n');
    done.add(from);
    out.calls += 1;
    out.sources.push({ kind, from, id: call.id });
  };

  if (dataDir) {
    // Job runs (the task folders hold their own job runs and are wrapped as tasks below).
    for (const jobDir of dirs(dataDir).filter((d) => !['ops', 'tasks', 'cache'].includes(path.basename(d)))) {
      for (const runDir of dirs(jobDir)) {
        const rec = readJson(path.join(runDir, 'run.json'));
        if (!rec?.run_id) continue;
        wrap('job-run', runDir, () => {
          const now = new Date(rec.started_at ?? timeOfId(rec.run_id) ?? Date.now());
          const call = store.start({ lambda: { name: 'job', origin: 'built-in', effects: ['runs-jobs', 'writes-external'] }, params: { job: rec.job, stage: rec.stage ?? null }, caller: 'import',
            purpose: `job:${rec.job}`, run: rec.run_id, now, extra: { migrated_from: runDir, job: { name: rec.job, spec_hash: rec.spec_hash ?? null }, job_run: { run: rec.run_id, dir: runDir } } });
          const items = new Map();
          for (const r of readLines(path.join(runDir, 'rejected.jsonl'))) items.set(r.id, { ok: false, r });
          for (const r of readLines(path.join(runDir, 'accepted.jsonl'))) items.set(r.id, { ok: true, r });
          for (const [id, { ok, r }] of items) {
            const c = call.child({ lambda: { name: `${rec.job}.item`, hash: rec.spec_hash ? String(rec.spec_hash).slice(0, 16) : null, origin: 'job', effects: ['model-calls'] }, params: { id },
              caller: rec.job, purpose: `job:${rec.job}`, run: rec.run_id, now: r.at ? new Date(r.at) : now, extra: { migrated_from: runDir } });
            c.finish({ status: ok ? 'ok' : 'failed', result: { output: r.output ?? null, value: r.value ?? null, tier: r.tier ?? null, model: r.model ?? null, score: r.score ?? null }, error: ok ? null : (r.problems ?? []).join('; '), at: r.at ?? null });
            out.items += 1;
          }
          call.finish({ status: rec.status === 'finished' ? 'ok' : rec.status === 'stopped' ? 'stopped' : 'failed', result: { status: rec.status, counts: rec.counts ?? null, summary: summaryOf(runDir) },
            error: rec.stopped ?? null, at: rec.finished_at ?? null });
          return call;
        });
      }
    }
    // Task folders.
    for (const taskDir of dirs(path.join(dataDir, 'tasks'))) {
      const t = readJson(path.join(taskDir, 'task.json'));
      if (!t?.id) continue;
      wrap('task', taskDir, () => {
        const call = store.start({ lambda: { name: 'task', origin: 'built-in', effects: ['runs-jobs', 'writes-external'] }, params: { instructions: t.instructions, target: t.target ?? null, template: t.plan?.template ?? null },
          attachments: (t.attachments ?? []).map((a) => ({ name: a.name, sha256: a.sha256 ?? null, bytes: a.bytes ?? null })), caller: 'import', run: t.id,
          now: new Date(t.created_at ?? timeOfId(t.id) ?? Date.now()), extra: { migrated_from: taskDir, task: { id: t.id, dir: taskDir } } });
        call.finish({ status: callStatus(t.status), result: { status: t.status, plan: t.plan ?? null, summary: summaryOf(taskDir) }, at: t.finished_at ?? null });
        return call;
      });
    }
    // Server operations.
    for (const opDir of dirs(path.join(dataDir, 'ops'))) {
      const req = readJson(path.join(opDir, 'request.json'));
      if (!req?.kind || req.kind === 'skills') continue;
      wrap('operation', opDir, () => {
        const res = readJson(path.join(opDir, 'result.json'));
        const name = req.kind === 'skill' ? req.args?.name : req.kind === 'run' ? 'run-lambdas' : req.kind;
        const { attachments = [], ...args } = req.args ?? {};
        const call = store.start({ lambda: { name, origin: req.kind === 'skill' ? null : 'built-in' }, params: req.kind === 'skill' ? args.inputs ?? {} : args, caller: 'import', purpose: req.purpose ?? null,
          run: req.run ?? null, now: timeOfId(req.id) ?? new Date(fs.statSync(opDir).mtimeMs), extra: { migrated_from: opDir, kind: req.kind, attachment_files: attachments.map((a) => a.path ?? a.name) } });
        call.finish({ status: res?.error ? 'failed' : callStatus(res?.result?.status ?? res?.status), result: res?.result ?? null, error: res?.error ?? null, at: fs.existsSync(path.join(opDir, 'result.json')) ? new Date(fs.statSync(path.join(opDir, 'result.json')).mtimeMs).toISOString() : null });
        return call;
      });
    }
  }
  // Agent runs of the work folders (the run folders of `pworker run` before its runs were calls).
  for (const wd of workdirs) {
    for (const runDir of dirs(path.join(wd, '.pworker', 'runs'))) {
      const req = readJson(path.join(runDir, 'request.json'));
      if (!req?.request) continue;
      wrap('agent-run', runDir, () => {
        const res = readJson(path.join(runDir, 'result.json'));
        const call = store.start({ lambda: { name: 'agent', origin: 'built-in', effects: ['model-calls', 'writes-workdir', 'runs-scripts'] }, params: { request: req.request, planOnly: !!req.planOnly, useCache: req.useCache !== false },
          workdir: req.workdir ?? wd, caller: 'import', run: req.id ?? null, now: new Date(req.at ?? Date.now()), extra: { migrated_from: runDir } });
        call.finish({ status: callStatus(res?.status), result: res ?? null, error: res && res.status === 'failed' ? res.summary ?? null : null, at: req.at && res?.ms != null ? new Date(Date.parse(req.at) + res.ms).toISOString() : null });
        return call;
      });
    }
  }
  return out;
}
