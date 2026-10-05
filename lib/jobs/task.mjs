/**
 * Tasks: large inputs with user instructions (learn a handbook into a knowledge base, extract the prices of an attached file, ...).
 *
 *   1. A task gets its own folder `<dataDir>/tasks/<task-id>/` (created exclusively; removed by `pruneTasks` after `tasks.keepDays`):
 *      task.json, attachments/, plan.json, the run folder(s), result.json, summary.md.
 *   2. Planning: the planner role chooses a template and fills its parameters (planner.mjs); the plan is validated deterministically.
 *      A caller that already knows the template passes `template` + `params` and no model is asked.
 *   3. Execution: a "prompt" template runs as a job (chunked attachments, tier ladder, checks and repair, stages, audit); an "adapter"
 *      template calls its adapter with a tagged fetch (purpose `job:<template>`, run = the task id, budget registered with the endpoint).
 *   4. Results are stored by the job's sink plugin or by the adapter, against the task's target ({kind: memory|session|none, id}).
 *   5. A short summary (at most 10 lines) returns to the caller.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadTemplates, planTask, validatePlan} from './planner.mjs';
import {loadJob} from './spec.mjs';
import {runJob} from './runner.mjs';
import {RunStore} from './store.mjs';
import {makeCaller, ResponseCache, Ledger} from './client.mjs';
import {tierChains, liveTiers} from './config.mjs';
import {newRunId, sha256, writeJsonAtomic} from './util.mjs';
import {createPworkerClient} from '../client.mjs';


const safeName = n => String(n).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'attachment';

/** A fetch that tags every request with the task's purpose and run id (adapters use it for their own calls). */
export function taggedFetch(fetchImpl, {purpose, run}) {
  return (url, init = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has('x-pworker-purpose')) headers.set('x-pworker-purpose', purpose);
    headers.set('x-pworker-run', run);
    return fetchImpl(url, {...init, headers: Object.fromEntries(headers)});
  };
}

async function registerRun(endpoint, fetchImpl, body) {
  try {
    const r = await fetchImpl(`${String(endpoint).replace(/\/+$/, '')}/jobs/register`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    return r.ok ? 'registered' : `not registered (status ${r.status})`;
  } catch (e) { return `not registered (${e.message})`; }
}

/**
 * Runs a task. `attachments`: [{name, path} | {name, text}]; `target`: {kind: 'memory'|'session'|'none', id}; `template` + `params`
 * skip planning; `sinkContext` is handed to the sink plugin or adapter (for example the stores a ChatSOP sink writes into); `hooks`: the
 * TaskLambdaCall hooks of a prompt template's job run (lib/jobs/runner.mjs).
 * Returns `{task, dir, status, summary, plan, result}`.
 */
export async function runTask({instructions = '', attachments = [], target = {kind: 'none'}, template = null, params = null, config, endpoint = config.endpoint,
  fetchImpl = fetch, log = () => {}, sinkContext = {}, live = null, templatesDir = config.templatesDir, hooks = null} = {}) {
  const tasksRoot = path.join(config.dataDir, 'tasks');
  fs.mkdirSync(tasksRoot, {recursive: true});
  const id = newRunId(`task:${instructions}`);
  const dir = path.join(tasksRoot, id);
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'attachments'));
  const files = attachments.map(a => {
    const text = a.text ?? fs.readFileSync(a.path, 'utf8');
    const file = path.join(dir, 'attachments', safeName(a.name ?? path.basename(a.path ?? 'attachment')));
    fs.writeFileSync(file, text, {flag: 'wx'});
    return {name: path.basename(file), path: file, bytes: Buffer.byteLength(text), sha256: sha256(text), preview: text.slice(0, 300), meta: a.meta ?? null};
  });
  const task = {id, created_at: new Date().toISOString(), instructions, target, attachments: files.map(({path: _p, preview: _v, ...m}) => m), status: 'planning'};
  writeJsonAtomic(path.join(dir, 'task.json'), task);
  const save = patch => { Object.assign(task, patch); writeJsonAtomic(path.join(dir, 'task.json'), task); };
  const finish = (status, lines, extra = {}) => {
    const summary = lines.filter(Boolean).slice(0, 10).join('\n');
    fs.writeFileSync(path.join(dir, 'summary.md'), summary + '\n');
    save({status, finished_at: new Date().toISOString(), ...extra});
    return {task: id, dir, status, summary, ...extra};
  };

  const templates = loadTemplates(templatesDir);
  live ??= await liveTiers(endpoint, {fetchImpl});
  const chains = tierChains(config, live);
  const plannerTier = config.roles.planner;
  const ledger = new Ledger();
  let planned;
  if (template) planned = validatePlan({template, params: params ?? {}}, {templates, target: target.kind, limits: config.limits, tiers: Object.keys(chains)});
  else {
    if (!chains[plannerTier]?.length) return finish('plan_refused', [`# task ${id}: no planner tier "${plannerTier}" is configured`]);
    const call = makeCaller({proxy: endpoint, job: 'planner', run: id, cache: new ResponseCache(path.join(config.dataDir, 'cache')), ledger, fetchImpl, purpose: 'job:planner'});
    planned = await planTask({instructions, attachments: files, target: target.kind, templates, limits: config.limits, tiers: Object.keys(chains), chain: chains[plannerTier], call});
  }
  writeJsonAtomic(path.join(dir, 'plan.json'), {...planned, planner_cost: ledger.total()});
  if (!planned.ok) return finish('plan_refused', [`# task ${id}: plan refused`, ...planned.problems.slice(0, 8).map(p => `- ${p}`)], {plan: planned.plan ?? null});
  const plan = planned.plan;
  const tpl = templates[plan.template];
  save({status: 'running', plan: {template: plan.template, taskKind: plan.taskKind, ladder: plan.ladder, budget: plan.budget}});
  log(`task ${id}: template ${plan.template} (${plan.reason || 'explicit'})`);

  if (tpl.kind === 'adapter') {
    const mod = await import(pathToFileURL(path.resolve(tpl.dir, tpl.adapter ?? 'adapter.mjs')).href);
    const purpose = `job:${plan.template}`;
    const registration = await registerRun(endpoint, fetchImpl, {job: plan.template, run: id, purpose, budget: plan.budget});
    let result;
    try {
      // `ta`: the Ploinky Workers library tagged with the task's purpose and run (adapters call models only through it); `endpoint` and
      // `fetchImpl` stay for adapters written before it.
      const ta = createPworkerClient({url: endpoint, fetchImpl: taggedFetch(fetchImpl, {purpose, run: id}), purpose, run: id, autostart: false, env: {}});
      result = await mod.run({params: plan.params, attachments: files, target, taskDir: dir, config, endpoint, chains, ladder: plan.ladder, ta,
        fetchImpl: taggedFetch(fetchImpl, {purpose, run: id}), budget: plan.budget, log, context: sinkContext});
    } catch (e) { result = {status: 'failed', error: e.message}; }
    writeJsonAtomic(path.join(dir, 'result.json'), result ?? {});
    return finish(result?.status === 'failed' ? 'failed' : 'finished', [`# task ${id}: ${plan.template} (adapter) ${result?.status ?? 'finished'}; endpoint ${registration}`,
      ...(result?.summary ? String(result.summary).split('\n') : []), result?.error ? `error: ${result.error}` : null], {plan, result});
  }

  const job = await loadJob(tpl.dir, {params: plan.params, config, live, overrides: {budget: plan.budget, kind: plan.taskKind, ...(plan.ladder ? {ladder: plan.ladder} : {})}});
  const r = await runJob(job, {endpoint, fetchImpl, log, store: new RunStore({root: dir}), cacheDir: path.join(config.dataDir, 'cache'), tierStatsDir: config.dataDir, hooks,
    sinkContext: {...sinkContext, target}, inputContext: {attachments: files}});
  writeJsonAtomic(path.join(dir, 'result.json'), {run: r.run, run_dir: path.relative(dir, r.dir), status: r.status, counts: r.counts, sink: r.sink, cost: r.cost.total});
  return finish(r.status, [`# task ${id}: ${plan.template}`, ...r.summary.split('\n').slice(1)], {plan, result: {run: r.run, status: r.status, sink: r.sink}});
}

/** Removes task folders older than `tasks.keepDays` (by task.json created_at). Returns the removed ids. */
export function pruneTasks(config, {now = Date.now()} = {}) {
  const root = path.join(config.dataDir, 'tasks');
  if (!fs.existsSync(root)) return [];
  const keep = (config.tasks?.keepDays ?? 7) * 86400_000;
  const removed = [];
  for (const id of fs.readdirSync(root)) {
    const f = path.join(root, id, 'task.json');
    let created = null;
    try { created = Date.parse(JSON.parse(fs.readFileSync(f, 'utf8')).created_at); } catch { /* unreadable: by folder time */ }
    if (!Number.isFinite(created)) created = fs.statSync(path.join(root, id)).mtimeMs;
    if (now - created > keep) { fs.rmSync(path.join(root, id), {recursive: true, force: true}); removed.push(id); }
  }
  return removed;
}
