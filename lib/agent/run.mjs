// `pworker run`: a small coding-style agent for clear, simple, repetitive tasks in a work folder. It writes TaskLambdas (code with a
// typed parameter schema, a check and an effects declaration), keeps the ones that worked in a visible cache and calls them again.
//
//   1. Skills: the Agent Skills of the work folder (.agents/skills) and of `agent.skillDirs`; the planner sees names and descriptions.
//      Skills are instructions (and scripts) a TaskLambda may use; they are not TaskLambdas.
//   2. Fast match: BM25 over the cached TaskLambdas, then the cheap tier decides "same task, other parameters?" and extracts the values
//      (lib/agent/match.mjs). A match with valid values calls the cached TaskLambda directly: no planner, no new code.
//   3. Otherwise the planner tier writes a TaskLambda (lib/agent/lambda-code.mjs) against `tools.*`; it runs in the sandbox
//      (lib/sandbox.mjs runModule) with the tools served by the host over the message channel, confined to the work folder
//      (lib/agent/workspace.mjs) and to the effects it declares. A failure (load error, exception, failed check) goes back to the planner,
//      at most `agent.maxRounds` rounds.
//   4. A TaskLambda that ran and passed its own check is stored `verified` in the cache (lib/agent/lambda-cache.mjs) and reused; one
//      without a check is stored `draft` until a person confirms it (`pworker lambdas verify`).
// Every run is a TaskLambdaCall of the built-in TaskLambda `agent` (lib/lambda/calls.mjs; its folder holds decision.json, context.txt,
// errors.jsonl, the code of every planner round and the model calls of the planner and the match); every execution of a TaskLambda is
// a child call (lambda.mjs, tools.jsonl with every tool call, effects.jsonl, inputs.jsonl, models.jsonl, output.json). A `pure`
// TaskLambda called again with the same hash, parameters and unchanged input files returns its recorded output without running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModule } from '../sandbox.mjs';
import { validateParams } from '../lambda/registry.mjs';
import { CallStore, sha256, canonical, fileHash } from '../lambda/calls.mjs';
import { requireEffect, effectsProblems, isPure } from '../lambda/effects.mjs';
import { callStoreOf } from '../lambda/index.mjs';
import { jsonOf } from '../client.mjs';
import { createWorkspace } from './workspace.mjs';
import { discoverSkills, skillRoots, skillCatalog, skillBody, runSkillScript } from './agent-skills.mjs';
import { codeBlockOf, moduleScript, metaProblems, lambdaHash, hardcodedValues } from './lambda-code.mjs';
import { LambdaCache } from './lambda-cache.mjs';
import { matchLambda } from './match.mjs';

const PROMPTS = fileURLToPath(new URL('../../prompts/', import.meta.url));
/** The identity of the agent itself as a built-in TaskLambda (its hash is the hash of this module). */
export const AGENT_LAMBDA = Object.freeze({ name: 'agent', hash: lambdaHash(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')), origin: 'built-in', effects: ['model-calls', 'writes-workdir', 'runs-scripts'] });
export const AGENT_DEFAULTS = Object.freeze({
  lambdasDir: null, skillDirs: [], plannerTier: null, matchTier: 'tiny', askTiers: null, maxRounds: 3, maxAsks: 30, maxToolCalls: 2000,
  timeMs: 120000, heapMb: 128, maxCodeBytes: 40000, checkOnReuse: true, reusePure: true, budget: null,
  match: { k: 3, minScore: 0, grounded: true, extraBody: { chat_template_kwargs: { enable_thinking: false } }, maxTokens: 400 },
  planner: { maxTokens: 8000 },
});

/** The agent settings: AGENT_DEFAULTS under the configuration's `agent` section. */
export function agentSettings(config = {}) {
  const a = config.agent ?? {};
  return { ...AGENT_DEFAULTS, ...a, lambdasDir: a.lambdasDir ?? null, match: { ...AGENT_DEFAULTS.match, ...(a.match ?? {}) }, planner: { ...AGENT_DEFAULTS.planner, ...(a.planner ?? {}) },
    plannerTier: a.plannerTier ?? config.runner?.roles?.planner ?? 'good', askTiers: a.askTiers ?? config.sandbox?.tiers ?? ['nano', 'micro', 'tiny', 'small', 'medium'] };
}

/** The TaskLambda cache of a work folder: --lambdas, else agent.lambdasDir, else <workdir>/.pworker/lambdas. */
export const lambdasDirOf = (workdir, settings, explicit = null) => path.resolve(workdir, explicit ?? settings.lambdasDir ?? path.join('.pworker', 'lambdas'));
const clip = (v, n = 200) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (typeof x === 'string' && x.length > n ? `${x.slice(0, n)}… (${x.length} chars)` : x)));

/** Model-call accounting per role (planner, match, ask): calls, credits, tokens, ms, cache hits, what served. */
function createStats() {
  const roles = {};
  return {
    add(role, r) {
      const s = (roles[role] ??= { calls: 0, ok: 0, credits: 0, usd: 0, in: 0, out: 0, ms: 0, cached: 0, served: [] });
      s.calls += r.calls ?? 1; if (r.ok) s.ok += 1;
      s.credits += Number(r.credits) || 0; s.usd += Number(r.usd) || 0; s.in += r.usage?.in ?? 0; s.out += r.usage?.out ?? 0; s.ms += r.ms ?? 0;
      if (r.cached) s.cached += 1;
      const who = r.served ? `${r.tier ?? '?'}:${r.served}` : null;
      if (who && !s.served.includes(who)) s.served.push(who);
    },
    view: () => ({ roles, calls: Object.values(roles).reduce((n, s) => n + s.calls, 0), credits: Math.round(Object.values(roles).reduce((n, s) => n + s.credits, 0) * 1000) / 1000 }),
  };
}

/** The meta of a TaskLambda's text, read in the sandbox without running it: {meta} or {error}. */
export async function extractMeta(code, limits = {}) {
  const s = moduleScript(code);
  if (s.error) return { error: s.error };
  const r = await runModule(s.script, { mode: 'meta' }, {}, { timeMs: 10000, maxCodeBytes: limits.maxCodeBytes ?? 40000 });
  if (!r.ok) return { error: `${r.code}: ${r.message}` };
  const problems = metaProblems(r.value, validateParams, code);
  return problems.length ? { meta: r.value, error: problems.join('; ') } : { meta: r.value };
}

/**
 * Whether the inputs a call recorded still hold in `workspace`: every file read, listing and search gives the same hash now. A pure
 * TaskLambda's recorded output is reused only then.
 */
export function inputsHold(inputs, workspace) {
  for (const i of inputs ?? []) {
    if (i.op === 'read') { if (sha256(workspace.read(i.path)) !== i.sha) return false; }
    else if (i.op === 'list') { if (sha256(canonical(workspace.list(i.dir, { recursive: !!i.recursive }))) !== i.sha) return false; }
    else if (i.op === 'search') { if (sha256(canonical(workspace.search(i.text, { dir: i.dir, ignoreCase: i.ignoreCase, maxResults: i.maxResults }))) !== i.sha) return false; }
    else return false;
  }
  return true;
}

/**
 * Runs a TaskLambda's code in the sandbox with the tools of the work folder, within its declared `effects` (required). Returns {ok,
 * result, check, hasCheck, error, calls, ms}. With a `call` (a CallHandle), every tool call is appended to its tools.jsonl, every file
 * read, listing and search to its inputs, every write and move to its effects (before/after hashes), every model call to its models.
 */
export async function executeLambda({ code, params, effects, check = true, workspace, skills = new Map(), ta, settings, call = null, label = 'run', stats = null, log = () => {} }) {
  const S = settings ?? agentSettings({});
  const ep = effectsProblems(effects);
  if (ep.length) return { ok: false, error: { stage: 'load', code: 'effects_invalid', message: ep.join('; ') }, calls: [] };
  const s = moduleScript(code);
  if (s.error) return { ok: false, error: { stage: 'load', code: 'lambda_syntax', message: s.error }, calls: [] };
  const calls = [];
  let asks = 0;
  const record = (op, args, t0, outcome) => {
    const c = { i: calls.length + 1, label, op, args: clip(args), ms: Date.now() - t0, ...outcome };
    calls.push(c);
    if (call) fs.appendFileSync(call.file('tools.jsonl'), JSON.stringify(c) + '\n');
  };
  const wrap = (op, fn) => async (...args) => {
    const t0 = Date.now();
    try { const v = await fn(...args); record(op, args, t0, { ok: true, result: op === 'read' ? { chars: String(v).length } : clip(v, 300) }); return v; }
    catch (e) { record(op, args, t0, { ok: false, error: String(e?.message ?? e).slice(0, 300) }); throw e; }
  };
  const findScript = (skill, script) => {
    const sk = skills.get(skill);
    if (!sk) throw new Error(`no skill ${skill} (skills: ${[...skills.keys()].join(', ') || 'none'})`);
    const name = String(script ?? '').replace(/^\.\//, '');
    return [sk, sk.scripts.includes(name) ? name : sk.scripts.includes(`scripts/${name}`) ? `scripts/${name}` : name];
  };
  const rel = (p) => workspace.relOf(workspace.resolve(p));
  const tools = {
    read: wrap('read', (p) => { const v = workspace.read(p); call?.input({ op: 'read', path: rel(p), sha: sha256(v) }); return v; }),
    list: wrap('list', (dir = '.', o = {}) => { const d = dir ?? '.', recursive = !!o?.recursive; const v = workspace.list(d, { recursive }); call?.input({ op: 'list', dir: d, recursive, sha: sha256(canonical(v)) }); return v; }),
    search: wrap('search', (text, o = {}) => {
      const q = { dir: o?.dir ?? '.', ignoreCase: o?.ignoreCase !== false, maxResults: o?.maxResults };
      const v = workspace.search(text, q); call?.input({ op: 'search', text, ...q, sha: sha256(canonical(v)) }); return v;
    }),
    write: wrap('write', (p, text) => {
      requireEffect(effects, 'writes-workdir', 'tools.write');
      const before = fileHash(workspace.resolve(p, { write: true }));
      const v = workspace.write(p, text);
      call?.effect({ kind: 'write', path: v.path, before, after: sha256(text), bytes: v.bytes });
      return v;
    }),
    move: wrap('move', (a, b) => {
      requireEffect(effects, 'writes-workdir', 'tools.move');
      const h = fileHash(workspace.resolve(a, { write: true }));
      const v = workspace.move(a, b);
      call?.effect({ kind: 'move', from: v.from, to: v.to, path: v.to, before: h, after: h });
      return v;
    }),
    ask: wrap('ask', async (tier, prompt, o = {}) => {
      requireEffect(effects, 'model-calls', 'tools.ask');
      if (!S.askTiers.includes(tier)) throw new Error(`tier ${tier} is not allowed (tiers: ${S.askTiers.join(', ')})`);
      if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('ask needs a prompt (a string)');
      if (++asks > S.maxAsks) throw new Error(`the limit of ${S.maxAsks} model calls per run is reached`);
      const r = await ta.chat({ tier, prompt: prompt.slice(0, 60000), system: typeof o?.system === 'string' ? o.system.slice(0, 8000) : undefined, maxTokens: Math.min(Number(o?.maxTokens) || 2000, 8000), temperature: 0, retryCut: true });
      stats?.add('ask', r);
      call?.model(r, { role: 'ask', tier });
      if (!r.ok) throw new Error(`the model call failed: ${r.reason}`);
      return r.text;
    }),
    runSkillScript: wrap('runSkillScript', async (skill, script, args = []) => {
      requireEffect(effects, 'runs-scripts', 'tools.runSkillScript');
      const [sk, name] = findScript(skill, script);
      const r = await runSkillScript(sk, name, args ?? [], { cwd: workspace.root });
      call?.effect({ kind: 'script', skill, script: name, args: clip(args, 200), code: r.code, timedOut: r.timedOut });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr.slice(0, 4000), truncated: r.truncated, timedOut: r.timedOut };
    }),
    log: async (message) => { const line = `lambda: ${String(message).slice(0, 300)}`; log(line); call?.log(line); return true; },
  };
  const t0 = Date.now();
  const r = await runModule(s.script, { mode: 'run', params, check }, tools, { timeMs: S.timeMs, heapMb: S.heapMb, maxCodeBytes: S.maxCodeBytes, maxCalls: S.maxToolCalls, maxResultBytes: 500000 });
  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, error: { stage: 'run', code: r.code, message: r.message }, calls, ms };
  const { result, check: checked, hasCheck } = r.value ?? {};
  const checkOk = checked === true || (checked && typeof checked === 'object' && checked.ok === true);
  if (check && hasCheck && !checkOk) return { ok: false, result, check: checked, hasCheck, error: { stage: 'check', code: 'check_failed', message: `the check failed: ${typeof checked === 'object' ? JSON.stringify(checked).slice(0, 400) : String(checked)}` }, calls, ms };
  return { ok: true, result, check: checked, hasCheck: !!hasCheck, checkOk: hasCheck ? checkOk : null, calls, ms };
}

/**
 * Calls a TaskLambda of the agent as a child call of `parent`: reuses the recorded output of a pure one when its inputs still hold
 * (`reuse`), otherwise runs it (executeLambda) and finishes the call. `lambda`: {name, hash, code, effects, origin, status}. Returns the
 * executeLambda record plus {callId, callDir, reused_from}.
 */
export async function callLambda({ lambda, params, parent, store, workspace, reuse = true, check = true, ...exec }) {
  const pure = isPure(lambda.effects);
  const reuseKey = pure ? CallStore.reuseKey({ hash: lambda.hash, params, workdir: workspace.root }) : null;
  const call = parent.child({ lambda: { name: lambda.name, hash: lambda.hash, origin: lambda.origin ?? 'model-written', effects: lambda.effects, status: lambda.status },
    params, workdir: workspace.root, caller: parent.record.lambda?.name ?? null, purpose: parent.record.purpose, run: parent.record.run, reuseKey });
  fs.writeFileSync(call.file('lambda.mjs'), lambda.code.endsWith('\n') ? lambda.code : `${lambda.code}\n`);
  if (reuseKey && reuse) {
    const found = store.findReusable(reuseKey, (inputs) => inputsHold(inputs, workspace));
    if (found) {
      call.log(`reused the output of call ${found.id} (pure; same hash, parameters and inputs)`);
      call.finish({ status: 'ok', result: found.output.result, reused_from: found.id });
      return { ok: true, result: found.output.result?.result ?? null, check: found.output.result?.check ?? null, hasCheck: found.output.result?.hasCheck ?? false, checkOk: found.output.result?.checkOk ?? null, calls: [], ms: 0, reused_from: found.id, callId: call.id, callDir: call.dir };
    }
  }
  const r = await executeLambda({ ...exec, code: lambda.code, params, effects: lambda.effects, check, workspace, call });
  call.finish({ status: r.ok ? 'ok' : 'failed', result: r.ok ? { result: r.result ?? null, check: r.check ?? null, hasCheck: r.hasCheck, checkOk: r.checkOk } : null, error: r.ok ? null : `${r.error.stage}: ${r.error.code}: ${r.error.message}` });
  return { ...r, callId: call.id, callDir: call.dir };
}

const answerOf = (result) => { const a = result?.answer ?? result; return typeof a === 'string' ? a : JSON.stringify(a); };
const callsDigest = (calls) => calls.slice(-12).map((c) => `${c.op}(${JSON.stringify(c.args).slice(1, -1).slice(0, 160)}) -> ${c.ok ? JSON.stringify(c.result).slice(0, 160) : `ERROR ${c.error}`}`).join('\n');
/** A client whose chat calls are also recorded in a call's models.jsonl under a role. */
const recording = (ta, call, role, stats) => ({ ...ta, chat: async (o) => { const r = await ta.chat(o); stats.add(role, r); call.model(r, { role, tier: o.tier }); return r; } });

/**
 * Runs a request in a work folder. Options: `request`, `workdir` (default the current folder), `lambdasDir` (--lambdas), `calls` (a
 * CallStore) or `callsDir` (--calls), `parent` (a CallHandle: the run becomes its child), `ta` (a Ploinky Workers client; its purpose and run
 * are replaced by the run's), `config` (the merged configuration), `planOnly` (show the TaskLambda, run nothing), `useCache` (false: skip
 * the match and do not reuse), `log`. Returns the result record (also the call's output.json).
 */
export async function runAgent({ request, workdir = process.cwd(), lambdasDir = null, calls = null, callsDir = null, parent = null, ta, config = {}, planOnly = false, useCache = true, log = () => {}, caller = null }) {
  if (typeof request !== 'string' || !request.trim()) throw new Error('a request is required');
  const S = agentSettings(config);
  const t0 = Date.now();
  const workspace = createWorkspace(path.resolve(workdir));
  const store = calls ?? callStoreOf(config, callsDir);
  const cache = new LambdaCache(lambdasDirOf(workspace.root, S, lambdasDir)).ensure();
  const top = parent ? parent.child({ lambda: AGENT_LAMBDA, params: { request, planOnly, useCache }, workdir: workspace.root, caller: caller ?? 'agent' })
    : store.start({ lambda: AGENT_LAMBDA, params: { request, planOnly, useCache }, workdir: workspace.root, caller: caller ?? 'agent' });
  const id = top.id;
  const purpose = `run:${id}`.slice(0, 120);
  top.update({ purpose, run: id, lambdas: cache.dir });
  const say = (l) => { log(l); top.log(l); };
  const agentTa = ta.with ? ta.with({ purpose, run: id }) : ta;
  const stats = createStats();
  const errors = [];
  const err = (e) => { errors.push(e); fs.appendFileSync(top.file('errors.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); };
  say(`lambdas: ${cache.dir}`);
  say(`call: ${top.dir}`);
  if (!planOnly && agentTa.registerRun) {
    try { await agentTa.registerRun({ job: 'agent', run: id, purpose, budget: S.budget ?? config.run?.budget ?? { usd: 0.5, credits: 60, calls: 300 } }); } catch (e) { say(`budget not registered: ${e.message}`); }
  }
  const finish = async (rec) => {
    const out = { id, callId: id, request, workdir: workspace.root, lambdas: cache.dir, callDir: top.dir, callsRoot: store.root, ...rec, errors: errors.length, stats: stats.view(), ms: Date.now() - t0 };
    top.finish({ status: ['finished', 'planned'].includes(rec.status) ? 'ok' : 'failed', result: out, error: rec.status === 'failed' ? rec.summary : null });
    if (!planOnly && agentTa.finishRun) { try { await agentTa.finishRun({ run: id, status: rec.status === 'finished' ? 'finished' : 'failed' }); } catch { /* the registration expires */ } }
    return out;
  };

  const { skills, problems: skillProblems } = discoverSkills(skillRoots(workspace.root, S.skillDirs));
  for (const p of skillProblems) say(`skill problem: ${p}`);
  const lambdas = await cache.load({ extractMeta: (code) => extractMeta(code, S) });
  const exec = { workspace, skills, ta: agentTa, settings: S, stats, log: say };

  // 1. The fast match.
  let decision = { decision: 'plan', reason: useCache ? 'no match attempted' : 'the cache is off for this run (--no-cache)' };
  if (useCache) {
    const norm = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();
    const exact = lambdas.find((p) => p.status === 'verified' && p.meta && norm(p.firstRequest) === norm(request));
    if (exact) decision = { decision: 'reuse', how: 'exact', chosen: exact.id, status: exact.status, values: exact.meta.example ?? {}, reason: 'the same request as the TaskLambda\'s first request', candidates: [], bm25Ms: 0 };
    else {
      const matchTa = recording(agentTa, top, 'match', stats);
      decision = await matchLambda({ request, lambdas, promptFile: path.join(PROMPTS, 'agent-match.md'), k: S.match.k, minScore: S.match.minScore, grounded: S.match.grounded,
        ask: (messages) => matchTa.chat({ tier: S.matchTier, messages, maxTokens: S.match.maxTokens, temperature: 0, extraBody: S.match.extraBody ?? undefined, purpose: `${purpose}:match`.slice(0, 120) }) });
      if (decision.decision === 'reuse') decision.how = 'match';
    }
  }
  fs.writeFileSync(top.file('decision.json'), JSON.stringify(decision, null, 1) + '\n');
  say(`decision: ${decision.decision}${decision.chosen ? ` ${decision.chosen}` : ''} (${decision.reason})`);

  if (decision.decision === 'reuse') {
    const entry = cache.read(decision.chosen);
    const meta = lambdas.find((p) => p.id === entry.id)?.meta ?? {};
    if (planOnly) return finish({ status: 'planned', how: decision.how, lambda: entry.id, params: decision.values, code: entry.code, decision, summary: `cached TaskLambda ${entry.id} (${entry.status}) with ${JSON.stringify(decision.values)}` });
    const reverify = entry.status === 'edited';
    const r = await callLambda({ ...exec, lambda: { name: entry.id, hash: entry.hash, code: entry.code, effects: meta.effects, origin: 'model-written', status: entry.status }, params: decision.values,
      parent: top, store, reuse: S.reusePure && !reverify, check: reverify || S.checkOnReuse, label: 'cached' });
    const ok = r.ok && (r.reused_from || !reverify || (r.hasCheck && r.checkOk));
    const how = r.reused_from ? `${decision.how}+reused-output` : reverify ? `${decision.how}+reverify` : decision.how;
    cache.recordCall(entry.id, { call: r.callId, how, params: decision.values, ok, ms: r.ms ?? null, error: r.error?.message ?? null, ...(r.reused_from ? { reused_from: r.reused_from } : {}) });
    if (ok) {
      if (reverify) { cache.setStatus(entry.id, 'verified', entry.hash); say(`TaskLambda ${entry.id} re-verified by its check (hash ${entry.hash})`); }
      return finish({ status: 'finished', how: reverify ? 'reuse-reverified' : r.reused_from ? 'reuse-output' : 'reuse', lambda: entry.id, lambdaCall: r.callId, reused_from: r.reused_from ?? null, params: decision.values,
        answer: answerOf(r.result), result: r.result, check: r.check ?? null, rounds: 0, decision, summary: answerOf(r.result) });
    }
    err({ stage: 'cached', lambda: entry.id, call: r.callId, ...(r.error ?? { message: reverify ? 'an edited TaskLambda without a passing check is not reused' : 'failed' }) });
    say(`cached TaskLambda ${entry.id} failed (${r.error?.message ?? 'not re-verified'}); planning`);
    decision.fallback = { lambda: entry.id, call: r.callId, error: r.error ?? null };
  }

  // 2. The planner. Its first message holds the request, the folder's first entries and the first lines of the files the request names.
  const entries = workspace.list('.', { recursive: true });
  const listing = entries.slice(0, 80).map((e) => `${e.path}${e.type === 'dir' ? '/' : e.type === 'file' ? ` (${e.bytes} bytes)` : ' (link)'}`).join('\n') || '(empty)';
  const shown = new Set();
  const head = (f) => { shown.add(f); try { return `FILE ${f} (first lines):\n${workspace.read(f).split('\n').slice(0, 20).join('\n').slice(0, 2500)}`; } catch (e) { return `FILE ${f}: ${e.message}`; } };
  const named = entries.filter((e) => e.type === 'file' && namedIn(request, e.path)).slice(0, 3).map((e) => head(e.path));
  const system = fs.readFileSync(path.join(PROMPTS, 'agent-planner.md'), 'utf8').replace('{{tiers}}', S.askTiers.join(', ')).replace('{{maxAsks}}', String(S.maxAsks)).replace('{{skills}}', skillCatalog(skills) || '(none)');
  let first = `REQUEST:\n${request}\n\nWORK FOLDER (first entries):\n${listing}`;
  if (named.length) first += `\n\nFILES NAMED IN THE REQUEST:\n${named.join('\n\n')}`;
  if (decision.fallback) first += `\n\nNOTE: a saved TaskLambda (${decision.fallback.lambda}) was tried for this request and failed: ${decision.fallback.error?.message ?? 'its check did not pass'}. Write a new one.`;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: first }];
  const plannerTa = recording(agentTa.with ? agentTa.with({ purpose: `${purpose}:planner`.slice(0, 120), run: id }) : agentTa, top, 'planner', stats);
  const loaded = new Set();
  const loadSkill = (n) => { loaded.add(n); const sk = skills.get(n); return sk ? `SKILL ${n} (folder ${path.relative(workspace.root, sk.dir) || sk.dir}; scripts: ${sk.scripts.join(', ') || 'none'}):\n${skillBody(sk)}` : `SKILL ${n}: no such skill`; };
  const ask = async (round) => {
    const reply = await plannerTa.chat({ tier: S.plannerTier, messages, maxTokens: S.planner.maxTokens, temperature: 0, retryCut: true });
    if (!reply.ok) err({ stage: 'planner', round, message: reply.reason });
    return reply;
  };
  const context = (parts, reply, why) => {
    fs.appendFileSync(top.file('context.txt'), parts.join('\n\n') + '\n');
    messages.push({ role: 'assistant', content: reply.text }, { role: 'user', content: `${parts.join('\n\n')}\n\n${why}` });
  };
  let contextGiven = false, last = null, lastCode = null;
  for (let round = 1; round <= S.maxRounds; round++) {
    let reply = await ask(round);
    if (!reply.ok) return finish({ status: 'failed', how: 'plan', rounds: round, decision, summary: `the planner (${S.plannerTier}) failed: ${reply.reason}` });
    let code = codeBlockOf(reply.text);
    // Context the planner asks for (once), and the instructions of a skill its TaskLambda uses but it has not loaded (progressive
    // disclosure: the body is loaded when the skill is chosen). Neither counts as a round.
    for (let extra = 0; extra < 2; extra++) {
      let parts = [], why = '';
      const want = !code && !contextGiven ? jsonOf(reply.text) : null;
      if (want && (Array.isArray(want.load_skills) || Array.isArray(want.peek))) {
        contextGiven = true;
        parts = [...(want.load_skills ?? []).slice(0, 5).map(loadSkill), ...(want.peek ?? []).slice(0, 5).map(head)];
        why = 'Now write the TaskLambda, in one js code block.';
        say(`planner asked for context: skills ${JSON.stringify(want.load_skills ?? [])}, files ${JSON.stringify(want.peek ?? [])}`);
      } else if (code) {
        const used = skillsUsedBy(code).filter((n) => skills.has(n) && !loaded.has(n));
        if (!used.length) break;
        parts = used.map(loadSkill);
        why = `Your TaskLambda uses ${used.join(', ')} without its instructions; here they are. Write the whole TaskLambda again, following them, in one js code block.`;
        say(`TaskLambda uses skill(s) not loaded: ${used.join(', ')}; their instructions are given`);
      } else break;
      context(parts, reply, why);
      reply = await ask(round);
      if (!reply.ok) return finish({ status: 'failed', how: 'plan', rounds: round, decision, summary: `the planner (${S.plannerTier}) failed: ${reply.reason}` });
      code = codeBlockOf(reply.text);
    }
    messages.push({ role: 'assistant', content: reply.text });
    const retry = (error, text) => { last = error; err({ round, ...error }); say(`TaskLambda ${round} refused: ${error.stage}: ${error.message}`); messages.push({ role: 'user', content: text }); };
    if (!code) { retry({ stage: 'planner', code: 'no_code', message: 'the reply holds no js code block' }, 'Your reply holds no TaskLambda. Write the whole TaskLambda in one ```js code block.'); continue; }
    lastCode = code;
    fs.writeFileSync(top.file(`lambda-${round}.mjs`), code + '\n');
    const m = await extractMeta(code, S);
    if (m.error) { retry({ stage: 'load', code: 'lambda_invalid', message: m.error }, `The TaskLambda cannot be used: ${m.error}\nWrite the whole corrected TaskLambda in one js code block.`); continue; }
    const hard = hardcodedValues(code, request, m.meta.example, { allowed: [...skills.values()].flatMap((sk) => [sk.name, ...sk.scripts, ...sk.scripts.map((x) => x.replace(/^scripts\//, ''))]) });
    if (hard.length) {
      retry({ stage: 'load', code: 'hardcoded_value', message: `values of this request are written in the code: ${hard.map((h) => JSON.stringify(h)).join(', ')}` },
        `The TaskLambda writes values of this request into its code: ${hard.map((h) => JSON.stringify(h)).join(', ')}. It must work for other values too: make each one a parameter in meta.params (its value in meta.example) and read it from params. Write the whole corrected TaskLambda in one js code block.`);
      continue;
    }
    const params = validateParams(m.meta.params, m.meta.example ?? {}).params;
    if (planOnly) return finish({ status: 'planned', how: 'plan', rounds: round, params, meta: m.meta, code, decision, summary: `TaskLambda ${m.meta.name} (${top.file(`lambda-${round}.mjs`)}) with ${JSON.stringify(params)}` });
    say(`TaskLambda ${round}: ${m.meta.name} ${JSON.stringify(params)} effects ${JSON.stringify(m.meta.effects)}`);
    const r = await callLambda({ ...exec, lambda: { name: m.meta.name, hash: lambdaHash(code), code, effects: m.meta.effects, origin: 'model-written', status: 'candidate' }, params,
      parent: top, store, reuse: false, check: true, label: `round-${round}` });
    if (r.ok) {
      const verified = r.hasCheck && r.checkOk === true;
      const lambdaId = cache.save({ code, meta: m.meta, request, verified, check: r.hasCheck ? `check() in lambda.mjs; at the first call: ${JSON.stringify(r.check).slice(0, 300)}` : 'none: confirm the TaskLambda with `pworker lambdas verify <id>`' });
      cache.recordCall(lambdaId, { call: r.callId, how: 'plan', params, ok: true, ms: r.ms, rounds: round });
      say(`stored ${verified ? 'verified' : 'draft'} TaskLambda ${lambdaId}`);
      return finish({ status: 'finished', how: 'plan', rounds: round, lambda: lambdaId, lambdaCall: r.callId, lambdaStatus: verified ? 'verified' : 'draft', params, answer: answerOf(r.result), result: r.result, check: r.check ?? null, decision, summary: answerOf(r.result) });
    }
    // The error, the last tool calls and the first lines of the files the TaskLambda read (not shown before) go back to the planner.
    const read = [...new Set(r.calls.filter((c) => c.op === 'read' && c.ok).map((c) => c.args[0]))].filter((f) => !shown.has(f)).slice(0, 2);
    retry({ lambda: `lambda-${round}.mjs`, call: r.callId, ...r.error },
      `The TaskLambda failed (${r.error.stage}, ${r.error.code}): ${r.error.message}\n\nLast tool calls:\n${callsDigest(r.calls) || '(none)'}${read.length ? `\n\n${read.map(head).join('\n\n')}` : ''}\n\nWrite the whole corrected TaskLambda in one js code block.`);
  }
  return finish({ status: 'failed', how: 'plan', rounds: S.maxRounds, decision, lastCode: lastCode ? top.file('lambda-*.mjs') : null, summary: `no TaskLambda succeeded in ${S.maxRounds} rounds; last error: ${last?.stage}: ${last?.message}` });
}

/** A path the request names (as a whole, not inside a longer name). */
const namedIn = (request, p) => new RegExp(`(^|[\\s"'\`(])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[\\s"'\`),;:!?]|\\.(\\s|$))`).test(request);
/** The skills a TaskLambda's code uses: names in meta.skills and the first argument of runSkillScript calls. */
const skillsUsedBy = (code) => [...new Set([...String(code).matchAll(/runSkillScript\(\s*['"]([a-z0-9][a-z0-9-]*)['"]/g)].map((m) => m[1]).concat(
  [...(/skills\s*:\s*\[([^\]]*)\]/.exec(String(code))?.[1] ?? '').matchAll(/['"]([a-z0-9][a-z0-9-]*)['"]/g)].map((m) => m[1])))];

/** The module of a project TaskLambda promoted from a verified cached one (written by `pworker lambdas promote`). */
export function promotedLambdaSource({ name, entry, meta, toDir }) {
  const lib = path.relative(toDir, fileURLToPath(new URL('./index.mjs', import.meta.url))).split(path.sep).join('/');
  const params = { ...meta.params, workdir: { type: 'string', description: 'the work folder the TaskLambda acts in (an absolute path)' } };
  return `// Project TaskLambda promoted from the cached TaskLambda ${entry.id} (hash ${entry.hash}) on ${new Date().toISOString().slice(0, 10)}.
// Its code runs in the sandbox with the tools confined to params.workdir and to its effects; edit it in its cache folder and promote it
// again.
import {runPromotedLambda} from '${lib.startsWith('.') ? lib : `./${lib}`}';

const CODE = ${JSON.stringify(entry.code)};

export default {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(meta.task)},
  effects: ${JSON.stringify(meta.effects)},
  params: ${JSON.stringify(params, null, 2).replace(/\n/g, '\n  ')},
  run: (ctx) => runPromotedLambda({code: CODE, effects: ${JSON.stringify(meta.effects)}, ctx}),
};
`;
}

/**
 * The run of a promoted TaskLambda inside the server: tools confined to params.workdir, model calls through ctx.ta, everything recorded
 * in the call (`ctx.self`: inputs, effects, tools.jsonl).
 */
export async function runPromotedLambda({ code, effects, ctx }) {
  const { workdir, ...params } = ctx.params;
  const S = agentSettings(ctx.config ?? {});
  const workspace = createWorkspace(path.resolve(workdir));
  const { skills } = discoverSkills(skillRoots(workspace.root, S.skillDirs));
  // The server's client already records every model call in the call's models.jsonl; executeLambda records them too, so it is told not to.
  const ta = ctx.self ? { ...ctx.ta, chat: (o) => ctx.ta.chat({ ...o, noRecord: true }) } : ctx.ta;
  const r = await executeLambda({ code, params, effects, check: true, workspace, skills, ta, settings: S, call: ctx.self ?? null, label: 'promoted', log: ctx.log ?? (() => {}) });
  return r.ok ? { status: 'finished', summary: answerOf(r.result).slice(0, 1500), value: r.result, check: r.check ?? null } : { status: 'failed', summary: `${r.error.stage}: ${r.error.message}` };
}

export { lambdaHash };
