// An operation of the server (a TaskLambda call, a job, a task, a planned `run-lambdas`, the TaskLambda list) runs in a worker thread
// of the server: its modules (the job runner, project TaskLambdas and the project code they import) are loaded fresh for every
// operation, a crash does not stop the server, and every model call goes back to the server's core over a message port (the same
// HTTP API as outside).
//
// Every operation but the list is a TaskLambdaCall (lib/lambda/calls.mjs): the server creates its folder and finishes it with the
// result; this worker resolves the TaskLambda (name, hash, origin, effects) into call.json, records every model call of the in-server
// client in models.jsonl, enforces the declared effects (model calls, job runs), returns the recorded output of a pure TaskLambda whose
// hash, parameters and inputs are unchanged, and makes the nested calls: one per step of `run-lambdas`, one per item of a job run, one
// per `ctx.invoke` of a TaskLambda.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parentPort, workerData} from 'node:worker_threads';
import {portFetch} from './inproc.mjs';
import {createPworkerClient} from './client.mjs';
import {loadLambdas, validateParams, catalogOf, lambdaView} from './lambda/registry.mjs';
import {CallStore, callStatus, modelRow} from './lambda/calls.mjs';
import {isPure, requireEffect} from './lambda/effects.mjs';
import {callSettings} from './lambda/index.mjs';
import {loadJob, runJob, RunStore, publishSummary, liveTiers, runTask, modelName} from './jobs/index.mjs';
import {HOME} from './settings.mjs';

const {args, tags, config, port, kind} = workerData;
const callDir = workerData.callDir ?? null;
export const INPROC_URL = 'http://pworker.local';
const fetchImpl = portFetch(port);
const log = line => parentPort.postMessage({type: 'log', line: String(line).slice(0, 2000)});
const ta = createPworkerClient({url: INPROC_URL, fetchImpl, purpose: tags.purpose, run: tags.run ?? null, autostart: false, env: {}});
const settings = callSettings(config);
const store = workerData.callsRoot ? new CallStore(workerData.callsRoot, {maxResultBytes: settings.maxResultBytes, maxInputs: settings.maxInputs}) : null;
const self = store && callDir ? store.openDir(callDir) : null;

/** The job runner's configuration from the Ploinky Workers configuration (runner section; the endpoint is the server itself). */
export function runnerConfig(c) {
  const r = c.runner ?? {};
  return {file: null, endpoint: INPROC_URL, dataDir: r.dataDir, roles: r.roles ?? {}, fallback: {}, limits: r.limits ?? {}, tasks: r.tasks ?? {keepDays: 7}, templatesDir: r.templatesDir ?? null};
}
const rc = runnerConfig(config);
const sha = data => createHash('sha256').update(data).digest('hex');

const attachmentsOf = list => (list ?? []).map(a => {
  const body = a.path ? fs.readFileSync(a.path) : Buffer.from(a.text ?? '');
  return {name: a.name ?? path.basename(a.path), path: a.path ?? null, text: a.text ?? null, bytes: body.length, sha256: sha(body)};
});
const attachmentIds = attachments => attachments.map(a => ({name: a.name, sha256: a.sha256, bytes: a.bytes}));

/**
 * A client that records every chat and JSON call in `call`'s models.jsonl and refuses model calls when the TaskLambda does not declare
 * `model-calls`. `noRecord: true` on a call skips the record (a caller that records it itself).
 */
function recordingClient(base, call, effects) {
  const wrap = fn => async (o = {}) => {
    if (effects) requireEffect(effects, 'model-calls', 'a model call');
    const {noRecord, ...rest} = o;
    const r = await fn(rest);
    if (call && !noRecord) call.model(r, {role: 'lambda', tier: rest.tier ?? null});
    return r;
  };
  const make = c => ({...c, chat: wrap(c.chat), json: wrap(c.json), with: o => make(c.with(o))});
  return make(base);
}

/** The tier of a job runner's chain entry (an entry without an upstream names a tier of the server). */
const tierOf = entry => entry?.tier ?? (entry && !entry.upstream ? entry.model : null);

/** The hooks that record a job run as TaskLambdaCalls: one child call per item, the run's other model calls in `parent`. */
function jobHooks(parent, purpose) {
  if (!parent || !store) return null;
  return {
    item: settings.jobItems ? ({id, ok, record, item, models, via, job}) => {
      const c = parent.child({lambda: {name: `${job?.name ?? 'job'}.item`, hash: job?.hash ? job.hash.slice(0, 16) : null, origin: 'job', effects: ['model-calls']},
        params: {id, ...(via ? {via} : {}), prompt: item?.prompt ?? null}, caller: job?.name ?? 'job', purpose, run: parent.record.run ?? null});
      for (const m of models) c.model({...modelRow(m.result, {role: m.role, tier: tierOf(m.entry), model: m.entry ? modelName(m.entry) : null}), ...(m.shared > 1 ? {shared: m.shared} : {})});
      c.finish({status: ok ? 'ok' : 'failed', result: {output: record.output ?? null, value: record.value ?? null, tier: record.tier ?? null, score: record.score ?? null, repair_rounds: record.repair_rounds ?? 0},
        error: ok ? null : (record.problems ?? []).join('; ').slice(0, 2000)});
    } : null,
    model: (role, entry, r) => parent.model(modelRow(r, {role, tier: tierOf(entry), model: entry ? modelName(entry) : null})),
  };
}

async function runJobHere(dir, o = {}, parent = self) {
  const live = await liveTiers(INPROC_URL, {fetchImpl});
  const job = await loadJob(path.resolve(dir), {config: rc, live});
  parent?.update({job: {name: job.spec.name, spec_hash: job.hash, dir: path.resolve(dir)}});
  const r = await runJob(job, {endpoint: INPROC_URL, fetchImpl, store: new RunStore({root: rc.dataDir}), stage: o.stage ?? null, resume: o.resume ?? null, refresh: !!o.refresh, register: o.register !== false, priority: o.priority ?? null,
    hooks: jobHooks(parent, tags.purpose), log: m => log(`[${job.spec.name}] ${m}`)});
  const published = o.publish ? publishSummary(r.dir, o.publish, {job: job.spec.name, run: r.run}) : null;
  parent?.update({job_run: {run: r.run, dir: r.dir}});
  return {status: r.status, summary: r.summary, run: r.run, dir: r.dir, counts: r.counts, published};
}

async function runTaskHere(t, parent = self) {
  const r = await runTask({instructions: t.instructions ?? '', attachments: attachmentsOf(t.attachments).map(a => ({name: a.name, path: a.path ?? undefined, text: a.text ?? undefined})),
    target: t.target ?? {kind: 'none'}, template: t.template ?? null, params: t.params ?? null, config: rc, endpoint: INPROC_URL, fetchImpl, hooks: jobHooks(parent, tags.purpose), log: m => log(`[task] ${m}`)});
  parent?.update({task: {id: r.task, dir: r.dir}});
  return {status: r.status, summary: r.summary, task: r.task, dir: r.dir, result: r.result ?? null};
}

/** The context of a TaskLambda's run: its params, attachments, call folder and handle, a recording client, and nested calls. */
function contextFor(lambdas, lambda, params, attachments, call, dir) {
  const effects = lambda.effects;
  const jobsAllowed = what => requireEffect(effects, 'runs-jobs', what);
  return {
    ta: recordingClient(ta.with({purpose: `lambda:${lambda.name}`}), call, effects), params, attachments, dir, self: call,
    // The server writes every posted line into the operation's log.txt; a nested call keeps its own lines too.
    log: line => { log(line); if (call && call !== self) call.log(line); },
    config, runner: rc, home: HOME,
    readAttachment: async name => { const a = attachments.find(x => x.name === name); if (!a) throw new Error(`no attachment ${name}`); return a.text ?? fs.readFileSync(a.path, 'utf8'); },
    jobs: {runJob: (d, o) => { jobsAllowed('jobs.runJob'); return runJobHere(d, o, call); }, runTask: t => { jobsAllowed('jobs.runTask'); return runTaskHere(t, call); }},
    /** A nested TaskLambda call (a child of this one): {status, summary, ...}. */
    invoke: (name, p = {}, o = {}) => invokeChild(lambdas, call, name, p, o.attachments ? attachmentsOf(o.attachments) : attachments),
  };
}

/** Runs a TaskLambda in the call `call` (a handle, or null for a server without call folders); returns its result object. */
async function runLambda(lambdas, name, given, attachments, call, dir) {
  const lambda = lambdas.get(name);
  if (!lambda) return {status: 'failed', summary: `no TaskLambda ${name} (TaskLambdas: ${[...lambdas.keys()].join(', ')})`};
  const v = validateParams(lambda.params, given);
  call?.update({lambda: {name: lambda.name, hash: lambda.hash, origin: lambda.origin, effects: lambda.effects, source: lambda.source}, params: v.params, ...(attachments.length ? {attachments: attachmentIds(attachments)} : {})});
  if (!v.ok) return {status: 'failed', summary: `invalid params for ${name}: ${v.problems.join('; ')}`};
  if (call && isPure(lambda.effects)) {
    const key = CallStore.reuseKey({hash: lambda.hash, params: v.params, workdir: v.params.workdir ?? null, attachments});
    call.update({reuse_key: key});
    const {inputsHold, createWorkspace} = await import('./agent/index.mjs');
    const found = store.findReusable(key, inputs => !inputs.length || (typeof v.params.workdir === 'string' && inputsHold(inputs, createWorkspace(v.params.workdir))));
    if (found) { log(`TaskLambda ${name}: the recorded output of call ${found.id} (pure; same hash, params and inputs)`); return {...(found.output.result ?? {}), reused_from: found.id}; }
  }
  log(`TaskLambda ${name} (${lambda.source})`);
  const r = await lambda.run(contextFor(lambdas, lambda, v.params, attachments, call, dir ?? call?.dir ?? callDir));
  return r && typeof r === 'object' ? {status: r.status ?? 'finished', ...r} : {status: 'finished', summary: String(r ?? '')};
}

/** A nested call: a child call folder of `parent`, run and finished here. */
async function invokeChild(lambdas, parent, name, params, attachments) {
  const child = parent && store ? parent.child({lambda: {name}, params, caller: parent.record.lambda?.name ?? null, purpose: parent.record.purpose ?? tags.purpose, run: parent.record.run ?? tags.run ?? null}) : null;
  let r;
  try { r = await runLambda(lambdas, name, params, attachments, child, child?.dir ?? null); }
  catch (e) { r = {status: 'failed', summary: String(e?.message ?? e).slice(0, 2000)}; }
  child?.finish({status: callStatus(r.status), result: r, error: callStatus(r.status) === 'failed' ? r.summary ?? null : null, reused_from: r.reused_from ?? null});
  return {...r, call: child?.id ?? null, callDir: child?.dir ?? null};
}

async function plan(lambdas, request, attachments, planTa) {
  const maxSteps = config.run?.maxSteps ?? 5;
  const tier = rc.roles?.planner ?? 'good';
  const catalog = catalogOf(new Map([...lambdas].filter(([, s]) => s.name !== 'job')));
  const system = fs.readFileSync(path.join(HOME, 'prompts', 'run-planner.md'), 'utf8').replace('{{maxSteps}}', String(maxSteps)).replace('{{catalog}}', catalog);
  const user = `REQUEST:\n${request}\n\nATTACHMENTS:\n${attachments.map(a => `- ${a.name} (${a.bytes} bytes): ${JSON.stringify((a.text ?? (a.path ? fs.readFileSync(a.path, 'utf8') : '')).slice(0, 300))}`).join('\n') || '(none)'}`;
  const messages = [{role: 'system', content: system}, {role: 'user', content: user}];
  let problems = [];
  for (let round = 0; round < 2; round++) {
    const r = await planTa.json({tier, messages, maxTokens: 4000, temperature: 0, retryCut: true});
    if (!r.ok && !r.text) return {ok: false, problems: [`planner call failed: ${r.reason}`]};
    problems = [];
    // A step is {lambda, params}.
    const steps = Array.isArray(r.json?.steps) ? r.json.steps.map(s => ({lambda: s?.lambda, params: s?.params ?? {}})) : null;
    if (!steps) problems.push('no "steps" list');
    else {
      if (steps.length > maxSteps) problems.push(`at most ${maxSteps} steps`);
      for (const [i, s] of steps.entries()) {
        const l = lambdas.get(s.lambda);
        if (!l) { problems.push(`steps[${i}].lambda: one of ${[...lambdas.keys()].join(', ')}`); continue; }
        const v = validateParams(l.params, s.params);
        problems.push(...v.problems.map(p => `steps[${i}] (${s.lambda}): ${p}`));
      }
    }
    if (!problems.length) return {ok: true, steps, reason: String(r.json.reason ?? '').slice(0, 300), tier};
    messages.push({role: 'assistant', content: r.text}, {role: 'user', content: `The plan is invalid:\n${problems.map(p => `- ${p}`).join('\n')}\nWrite the corrected JSON object only.`});
  }
  return {ok: false, problems};
}

async function main() {
  if (kind === 'lambdas') {
    const {lambdas, problems, warnings} = await loadLambdas(config);
    const list = [...lambdas.values()].map(lambdaView);
    return {status: 'finished', lambdas: list, problems, warnings};
  }
  if (kind === 'job') {
    if (self) {
      const {lambdas} = await loadLambdas(config);
      const j = lambdas.get('job');
      self.update({lambda: {name: 'job', hash: j?.hash ?? null, origin: 'built-in', effects: j?.effects ?? ['runs-jobs', 'writes-external'], source: j?.source ?? null}});
    }
    return runJobHere(args.dir, args);
  }
  if (kind === 'task') {
    if (self) {
      const {lambdas} = await loadLambdas(config);
      const t = lambdas.get('task');
      self.update({lambda: {name: 'task', hash: t?.hash ?? null, origin: 'built-in', effects: t?.effects ?? ['runs-jobs', 'writes-external'], source: t?.source ?? null}});
    }
    return runTaskHere(args);
  }
  const {lambdas, problems} = await loadLambdas(config);
  for (const p of problems) log(`TaskLambda problem: ${p}`);
  // (warnings, such as a project module without an effects declaration, are shown by the TaskLambda list: GET /v1/lambdas)
  const attachments = attachmentsOf(args.attachments);
  if (kind === 'lambda') return runLambda(lambdas, args.name, args.params ?? {}, attachments, self, callDir);
  if (kind === 'run') {
    // A planned run spends from one registered budget (config.run.budget): the server refuses its calls beyond it.
    self?.update({lambda: {name: 'run-lambdas', hash: null, origin: 'built-in', effects: ['model-calls', 'runs-jobs', 'writes-external']}});
    try { await ta.registerRun({job: 'run', run: tags.run, purpose: tags.purpose, budget: config.run?.budget ?? {usd: 0.5}}); } catch (e) { log(`budget not registered: ${e.message}`); }
    const p = await plan(lambdas, args.request, attachments, recordingClient(ta.with({purpose: 'run:planner'}), self, null));
    if (callDir) fs.writeFileSync(path.join(callDir, 'plan.json'), JSON.stringify(p, null, 1) + '\n');
    if (!p.ok) return {status: 'plan_refused', summary: `plan refused: ${p.problems.slice(0, 5).join('; ')}`, plan: p};
    if (args.planOnly || !p.steps.length) return {status: p.steps.length ? 'planned' : 'no_plan', summary: p.steps.length ? p.steps.map(s => `${s.lambda} ${JSON.stringify(s.params ?? {})}`).join('\n') : `no TaskLambda fits: ${p.reason}`, plan: p};
    const results = [];
    for (const s of p.steps) {
      const r = await invokeChild(lambdas, self, s.lambda, s.params ?? {}, attachments);
      results.push({lambda: s.lambda, params: s.params ?? {}, ...r});
      if (!['finished', 'ok'].includes(r.status)) break;
    }
    try { await ta.finishRun({run: tags.run, status: 'finished'}); } catch { /* the registration expires */ }
    const failed = results.find(r => !['finished', 'ok'].includes(r.status));
    return {status: failed ? 'failed' : 'finished', plan: p, results,
      summary: [`plan (${p.tier}): ${p.steps.map(s => s.lambda).join(' -> ')}: ${p.reason}`, ...results.map((r, i) => `${i + 1}. ${r.lambda}: ${r.status}: ${String(r.summary ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 400)}`)].join('\n')};
  }
  throw new Error(`unknown operation ${kind}`);
}

main().then(result => parentPort.postMessage({type: 'result', result}), e => parentPort.postMessage({type: 'error', error: String(e?.stack ?? e).slice(0, 3000)}));
