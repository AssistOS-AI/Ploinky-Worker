/**
 * The deterministic job runner: no LLM or agent controls the loop; a caller writes a job spec and reads the run's summary and
 * escalations only.
 *
 * Loop: select inputs -> pack them into calls -> call the worker chain through the proxy (cache first) -> split the reply per item ->
 * built-in and plugin checks -> repair rounds (one conversation per item, with the problems) -> the next tier of the ladder (or the
 * next model of the chain when `escalation.nextModel`) -> stop rules after every settled item and at each stage end -> the decider tier on items still rejected
 * -> the audit sample -> the decider on audit findings -> tier stats -> the sink plugin -> summary, cost and the run record.
 *
 * Results: accepted.jsonl and rejected.jsonl are append-only logs; an id in accepted.jsonl wins over rejected.jsonl and the last
 * accepted line of an id wins (a decider retry or an audit revision appends). `finalRecords(dir)` reads them that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import {loadInputs} from './inputs.mjs';
import {render} from './spec.mjs';
import {makeCaller, callChain, ResponseCache, Ledger, RefusedError, modelName} from './client.mjs';
import {splitReply, checkItem, outputText} from './outputs.mjs';
import {RunStore} from './store.mjs';
import {auditSample, runAudit, decide, atLeast} from './review.mjs';
import {appendJsonl, readJsonl, writeJsonAtomic, newRunId, gitCommit, estimateTokens} from './util.mjs';
import {chooseStart, readTierStats, recordTierStats} from './tiers.mjs';

/** Groups items into calls: `itemsPerCall`, or a token budget with an item cap. */
export function packCalls(items, packing = {}, size = () => 0) {
  const calls = [];
  if (packing.tokenBudget == null) {
    const k = packing.itemsPerCall ?? 1;
    for (let i = 0; i < items.length; i += k) calls.push(items.slice(i, i + k));
    return calls;
  }
  const max = packing.maxItems ?? 50;
  let cur = [], tokens = 0;
  for (const it of items) {
    const t = size(it);
    if (cur.length && (tokens + t > packing.tokenBudget || cur.length >= max)) { calls.push(cur); cur = []; tokens = 0; }
    cur.push(it); tokens += t;
  }
  if (cur.length) calls.push(cur);
  return calls;
}

/** Final records of a run folder: `{accepted: Map id -> record, rejected: Map id -> record}` (accepted wins, last line wins). */
export function finalRecords(dir) {
  const accepted = new Map(), rejected = new Map();
  for (const r of readJsonl(path.join(dir, 'accepted.jsonl'))) accepted.set(r.id, r);
  for (const r of readJsonl(path.join(dir, 'rejected.jsonl'))) if (!accepted.has(r.id)) rejected.set(r.id, r);
  return {accepted, rejected};
}

const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
/** The roles of model calls made for one item (the others, decider and audit, serve the run). */
const ITEM_ROLES = new Set(['work', 'repair', 'next_tier', 'next_model']);
const short = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/**
 * Runs a loaded job (spec.loadJob). Options: `stage` (run through this stage only), `resume` (run id of an interrupted run),
 * `endpoint`, `fetchImpl`, `priority` (interactive | normal | background; default the spec's `priority`), `store` (default: the config's data dir), `refresh` (ignore the cache), `register` (register the run's budget
 * with the endpoint: POST /jobs/register), `log`, `backoffMs`, `purpose`, `sinkContext` (passed to the sink plugin, e.g. a target),
 * `hooks` (the TaskLambdaCall of the run: `item({id, ok, record, item, models, via})` when an item settles or a decider retry accepts it,
 * with the model calls made for it; `model(role, entry, result)` for every model call that serves no single item: decider, audit).
 * Returns `{run, dir, status, summary, counts, cost, scores, tiers, sink}`.
 */
export async function runJob(job, {stage = null, resume = null, endpoint = job.config?.endpoint, fetchImpl = fetch, store = new RunStore({root: job.config.dataDir}), refresh = false,
  register = true, log = () => {}, backoffMs = 2000, purpose = null, runId = null, sinkContext = {}, inputContext = {}, cacheDir = null, tierStatsDir = null, priority = null, hooks = null} = {}) {
  const proxy = endpoint;
  const {spec, prompt, checks} = job;
  const params = job.params ?? null;
  const output = spec.output;
  const packed = (spec.packing?.itemsPerCall ?? 1) > 1 || spec.packing?.tokenBudget != null;
  if (packed && !prompt.item.includes('{{id}}')) throw new Error('a packed job renders {{id}} in its <<<item>>> section');
  if ((spec.repairRounds ?? 1) > 0 && !prompt.repair) throw new Error('repairRounds > 0 needs a <<<repair>>> section in prompt.md');

  const items = await loadInputs(spec.inputs, {dir: job.dir, ctx: {params, ...inputContext}});
  const statsRoot = tierStatsDir ?? store.root;
  const stages = spec.stages.map(s => ({...s, target: Math.min(items.length, s.items ?? items.length)}));
  const last = stage == null ? stages.length - 1 : stages.findIndex(s => s.name === stage);
  if (last < 0) throw new Error(`unknown stage ${JSON.stringify(stage)} (stages: ${stages.map(s => s.name).join(', ')})`);

  let dir, record;
  if (resume) ({dir, record} = store.reopen(spec.name, resume));
  else {
    const run = runId ?? newRunId(job.hash);
    record = {job: spec.name, run_id: run, spec_hash: job.hash, params, stage: stages[last].name, items_selected: items.length, target: stages[last].target,
      models: spec.models.map(modelName), decider: spec.decider?.map(modelName) ?? null,
      auditor: spec.audit?.models?.map(modelName) ?? null, budget: spec.budget, kind: spec.kind ?? null, ladder: spec.ladder ?? null, git_commit: gitCommit(job.dir), started_at: new Date().toISOString(), pid: process.pid, status: 'running'};
    dir = store.create(spec.name, run, record);
  }
  const run = record.run_id;
  const file = name => path.join(dir, name);
  const save = patch => { record = {...record, ...patch}; writeJsonAtomic(file('run.json'), record); };
  save({status: 'running', pid: process.pid});

  // Run registration: the server refuses calls of this run beyond its budget (lib/guard.mjs).
  const jobPurpose = purpose ?? `job:${spec.name}`;
  let registration = 'skipped';
  if (register) {
    try {
      const r = await fetchImpl(`${String(proxy).replace(/\/+$/, '')}/jobs/register`, {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({job: spec.name, run, purpose: jobPurpose, budget: spec.budget, spec_hash: job.hash}), signal: AbortSignal.timeout(5000)});
      registration = r.ok ? 'registered' : resume && r.status === 400 ? 'registered (earlier)' : `not registered (status ${r.status})`;
    } catch (e) { registration = `not registered (${e.message})`; }
  }
  save({proxy_registration: registration});

  const ledger = new Ledger();
  const prior = fs.existsSync(file('cost.json')) ? JSON.parse(fs.readFileSync(file('cost.json'), 'utf8')).total ?? null : null;
  const cache = new ResponseCache(cacheDir ?? path.join(store.root, 'cache'));
  const call = makeCaller({proxy, job: spec.name, run, cache, ledger, fetchImpl, refresh, backoffMs, purpose: jobPurpose, proxyFallback: spec.fallbackOnFailure !== false,
    // `priority: "background"` (job spec or caller): the server runs the job's calls only in quiet periods, within the plan's headroom.
    priority: priority ?? spec.priority ?? null,
    onResult: hooks?.model ? (role, entry, r) => { if (!ITEM_ROLES.has(role)) hooks.model(role, entry, r); } : null});
  // The model calls made for each item (a packed call serves several: it is noted for each, with `shared`), for the item's call.
  const itemModels = new Map();
  const noteModels = (ids, ans, role) => {
    if (!hooks?.item || !ans) return;
    for (const id of ids) (itemModels.get(id) ?? itemModels.set(id, []).get(id)).push({role, entry: ans.entry ?? null, result: ans, shared: ids.length});
  };
  const itemDone = (it, ok, record, via = null) => {
    if (!hooks?.item) return;
    const models = itemModels.get(it.id) ?? [];
    itemModels.delete(it.id);
    try { hooks.item({id: it.id, ok, record, item: it, models, via, job: {name: spec.name, hash: job.hash}}); } catch (e) { log(`item call of ${it.id} not recorded: ${e.message}`); }
  };

  const system = render(prompt.system, {params});
  const renderOne = it => render(prompt.item, {...it.prompt, id: it.id, params});
  const userText = list => (prompt.call ? render(prompt.call, {items: list.map(renderOne).join('\n\n'), count: list.length, params}) : list.map(renderOne).join('\n\n'));
  const parseOut = (it, raw) => {
    if (typeof checks.parse === 'function' && output.format === 'text' && raw?.text != null) {
      try { return {text: raw.text, ...checks.parse(raw.text, it.data)}; } catch { return raw; }
    }
    return raw;
  };
  const verify = (it, out) => checkItem(it.data, out, {output, checks, params});

  // Adaptive tiers: the ladder's chains (spec.ladderChains, resolved at load), the learned start tier and an optional probe one tier lower.
  const levels = spec.ladderChains ?? null;
  const plan = levels ? (record.tier_plan ?? chooseStart({kind: spec.kind, ladder: levels.map(l => l.tier), quality: spec.quality, adaptive: spec.adaptive, rows: readTierStats(statsRoot)})) : null;
  if (plan && !record.tier_plan) save({tier_plan: {start: plan.start, reason: plan.reason, probe: plan.probe}});
  const perTier = Object.fromEntries((levels ?? []).map(l => [l.tier, {tried: 0, passed: 0, repair_rounds: 0, calls: 0, latency_ms: 0, usd: 0, credits: 0, audit_sampled: 0, audit_problems: 0}]));
  const passedAt = {};

  // Counters (rebuilt from the files on resume).
  const settled = resume ? store.settled(dir) : new Set();
  const c = {processed: 0, accepted: 0, rejected: 0, empty: 0, repaired: 0, next_model: 0, call_failed: 0};
  if (resume) {
    const {accepted, rejected} = finalRecords(dir);
    c.accepted = accepted.size; c.rejected = rejected.size; c.processed = accepted.size + rejected.size;
    c.empty = [...rejected.values()].filter(r => r.empty).length;
  }
  const spent = () => { const t = ledger.total(); return {usd: t.usd + (prior?.usd ?? 0), credits: t.credits + (prior?.credits ?? 0), calls: t.calls + (prior?.calls ?? 0)}; };
  // cost.json is rewritten after every settled item, so an interrupted run resumes with its spend (prior + this process).
  const writeCost = () => { const t = spent(); const cost = {total: {...ledger.total(), usd: t.usd, credits: t.credits, calls: t.calls}, this_process: ledger.toJSON(), budget: spec.budget}; writeJsonAtomic(file('cost.json'), cost); return cost; };
  const overBudget = () => {
    const s = spent(), b = spec.budget;
    if (b.usd != null && s.usd >= b.usd) return `budget: ${s.usd.toFixed(4)} USD of ${b.usd}`;
    if (b.credits != null && s.credits >= b.credits) return `budget: ${s.credits.toFixed(2)} credits of ${b.credits}`;
    if (b.calls != null && s.calls >= b.calls) return `budget: ${s.calls} calls of ${b.calls}`;
    return null;
  };
  let stopped = null;
  const stopRule = (st, force = false) => {
    const minItems = st.stop?.minItems ?? Math.min(st.target, 10);
    if (!st.stop || (!force && c.processed < minItems) || !c.processed) return null;
    const rej = c.rejected / c.processed, emp = c.empty / c.processed;
    if (st.stop.maxEmptyRate != null && emp > st.stop.maxEmptyRate) return `stop rule (stage ${st.name}): ${c.empty}/${c.processed} empty > ${pct(st.stop.maxEmptyRate * 100, 100)}%`;
    if (st.stop.maxRejectRate != null && rej > st.stop.maxRejectRate) return `stop rule (stage ${st.name}): ${c.rejected}/${c.processed} rejected > ${pct(st.stop.maxRejectRate * 100, 100)}%`;
    return null;
  };

  const settle = (it, res, st) => {
    c.processed += 1;
    if (res.ok) {
      c.accepted += 1;
      if (res.rounds) c.repaired += 1;
      let score = null;
      if (typeof checks.score === 'function') { try { score = checks.score(it.data, res.out) ?? null; } catch (e) { score = {label: 'score_error', reason: e.message}; } }
      if (res.tier) passedAt[res.tier] = (passedAt[res.tier] ?? 0) + 1;
      const row = {id: it.id, model: res.model, ...(res.tier ? {tier: res.tier, tiers_tried: res.tried} : {}), output: res.out, value: res.value ?? null, score, repair_rounds: res.rounds, cached: res.cached, at: new Date().toISOString()};
      appendJsonl(file('accepted.jsonl'), row);
      itemDone(it, true, row);
    } else {
      c.rejected += 1;
      if (res.empty) c.empty += 1;
      if (res.callFailed) c.call_failed += 1;
      const row = {id: it.id, model: res.model, ...(res.tier ? {tiers_tried: res.tried} : {}), output: res.out ?? null, problems: res.problems, empty: !!res.empty, call_failed: !!res.callFailed, repair_rounds: res.rounds, at: new Date().toISOString()};
      appendJsonl(file('rejected.jsonl'), row);
      itemDone(it, false, row);
    }
    stopped ??= stopRule(st);
    writeCost();
  };

  /** Repairs one item in its own conversation; returns the final verdict. */
  const repairLoop = async (it, entryChain, out, verdict, model, extraHint = null, rounds = spec.repairRounds ?? 1) => {
    let r = 0;
    while (!verdict.ok && r < rounds && !stopped) {
      if (overBudget()) break;
      r += 1;
      const messages = [{role: 'system', content: system}, {role: 'user', content: userText([it])}, {role: 'assistant', content: outputText(out, output) || '(no output)'},
        {role: 'user', content: render(prompt.repair, {problems: verdict.problems.map(p => `- ${p}`).join('\n'), hint: [verdict.hint, extraHint].filter(Boolean).join('\n') || '-', params})}];
      const ans = await callChain(call, entryChain, messages, 'repair');
      noteModels([it.id], ans, 'repair');
      if (!ans.ok) break;
      model = modelName(ans.entry);
      out = parseOut(it, splitReply(ans.text, [it.id], output)[it.id]);
      verdict = verify(it, out);
    }
    return {verdict, out, model, rounds: r};
  };

  /** One fresh single-item attempt plus repairs on a chain: `{verdict, out, model, rounds, ok}`. */
  const attempt = async (it, chain, role) => {
    const a = await callChain(call, chain, [{role: 'system', content: system}, {role: 'user', content: userText([it])}], role);
    noteModels([it.id], a, role);
    if (!a.ok) return {verdict: {ok: false, empty: true, problems: [`call failed: ${short(a.error, 200)}`]}, out: null, model: null, rounds: 0, ms: 0};
    const o = parseOut(it, splitReply(a.text, [it.id], output)[it.id]);
    const r = await repairLoop(it, chain, o, verify(it, o), modelName(a.entry));
    return {...r, ms: a.ms ?? 0, cached: a.cached};
  };
  const tierNote = (lvl, r, ms = 0) => {
    const s = perTier[levels[lvl].tier];
    s.tried += 1; s.repair_rounds += r.rounds; if (r.verdict.ok) s.passed += 1;
    s.calls += 1 + r.rounds; s.latency_ms += ms;
  };

  const processCall = async (list, st, level = null) => {
    if (stopped) return;
    const why = overBudget();
    if (why) { stopped = why; return; }
    // `fallbackOnFailure: false` keeps a run on its first model (calibrations, A/B arms): a failed call is a failure, not a switch.
    let chain = levels ? levels[level].chain : spec.fallbackOnFailure === false ? spec.models.slice(0, 1) : spec.models;
    const ans = await callChain(call, chain, [{role: 'system', content: system}, {role: 'user', content: userText(list)}], 'work');
    noteModels(list.map(i => i.id), ans, 'work');
    if (!ans.ok && !levels) {
      for (const it of list) settle(it, {ok: false, empty: true, callFailed: true, problems: [`call failed: ${short(ans.error, 300)}`], rounds: 0}, st);
      return;
    }
    const outs = ans.ok ? splitReply(ans.text, list.map(i => i.id), output) : {};
    if (ans.finish === 'length') log(`call cut by max_tokens (${list.length} items)`);
    for (const it of list) {
      let res;
      if (ans.ok) {
        const out = parseOut(it, outs[it.id]);
        const model = ans.served ? `${modelName(ans.entry)} (${ans.served})` : modelName(ans.entry);
        if (!levels) chain = spec.fallbackOnFailure === false ? [ans.entry] : spec.models.slice(spec.models.indexOf(ans.entry));
        res = await repairLoop(it, chain, out, verify(it, out), model);
      } else res = {verdict: {ok: false, empty: true, problems: [`call failed: ${short(ans.error, 200)}`]}, out: null, model: null, rounds: 0};
      let tier = null, tried = [];
      if (levels) {
        // The per-item cascade: climb the ladder while the item fails.
        tierNote(level, res, ans.ok ? Math.round((ans.ms ?? 0) / list.length) : 0);
        tried.push(levels[level].tier);
        let k = level;
        while (!res.verdict.ok && k + 1 < levels.length && !stopped && !overBudget()) {
          k += 1;
          c.next_model += 1;
          res = await attempt(it, levels[k].chain, 'next_tier');
          tierNote(k, res, res.ms);
          tried.push(levels[k].tier);
        }
        tier = res.verdict.ok ? levels[k].tier : null;
      } else {
        // Escalation to the next model of the chain (fresh attempt plus its own repair rounds).
        const usedIdx = spec.models.indexOf(ans.entry);
        for (let k = usedIdx + 1; !res.verdict.ok && spec.escalation?.nextModel && k < spec.models.length && !stopped && !overBudget(); k++) {
          c.next_model += 1;
          const r2 = await attempt(it, [spec.models[k]], 'next_model');
          if (r2.model) res = r2;
        }
      }
      settle(it, {ok: res.verdict.ok, out: res.out, value: res.verdict.value, problems: res.verdict.problems, empty: res.verdict.empty, model: res.model, rounds: res.rounds, cached: ans.cached, tier, tried}, st);
    }
  };

  // Stages: each runs the next prefix of the selected items, `concurrency` calls at a time.
  const width = spec.concurrency ?? 2;
  for (let si = 0; si <= last && !stopped; si++) {
    const st = stages[si];
    const pending = items.slice(0, st.target).filter(it => !settled.has(it.id));
    pending.forEach(it => settled.add(it.id));
    // With a ladder, the first probe items of the run start one tier lower; the rest at the learned start tier.
    const groups = [];
    if (plan) {
      const probeIds = new Set(plan.probe && si === 0 && !resume ? pending.slice(0, plan.probe.items).map(it => it.id) : []);
      if (probeIds.size) groups.push({level: plan.probe.level, items: pending.filter(it => probeIds.has(it.id))});
      groups.push({level: plan.start, items: pending.filter(it => !probeIds.has(it.id))});
    } else groups.push({level: null, items: pending});
    const calls = groups.flatMap(g => packCalls(g.items, spec.packing, it => estimateTokens(renderOne(it))).map(list => ({list, level: g.level})));
    log(`stage ${st.name}: ${pending.length} items in ${calls.length} calls${plan ? ` (start tier ${levels[plan.start].tier}${plan.probe && si === 0 ? `, probe ${levels[plan.probe.level].tier}` : ''})` : ''}`);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(width, calls.length)}, async () => {
      while (next < calls.length && !stopped) {
        const {list, level} = calls[next++];
        try { await processCall(list, st, level); }
        catch (e) { if (e instanceof RefusedError) stopped = `refused by the proxy: ${e.message}`; else throw e; }
      }
    }));
    stopped ??= stopRule(st, true);
    save({stage_done: st.name, counts: {...c}});
  }

  // The decider on items still rejected by checks (not on infrastructure failures), once per id.
  const decided = new Set(readJsonl(file('decisions.jsonl')).map(d => `${d.source}:${d.id}`));
  const byId = new Map(items.map(it => [it.id, it]));
  const escalate = row => appendJsonl(file('escalations.jsonl'), {...row, at: new Date().toISOString()});
  const retryWithHint = async (it, prevOut, problems, hint) => {
    const out0 = prevOut ?? null;
    const res = await repairLoop(it, spec.fallbackOnFailure === false ? spec.models.slice(0, 1) : spec.models, out0, {ok: false, problems}, null, hint, 1);
    return res;
  };
  const counts = {decider: {retry_ok: 0, retry_failed: 0, dropped: 0, dismissed: 0, escalated: 0}, audit: {sampled: 0, flagged: 0, failed: 0}};
  try {
    if (!stopped || !/^refused|^budget/.test(stopped)) {
      const {rejected} = finalRecords(dir);
      const cases = [...rejected.values()].filter(r => !r.call_failed && !decided.has(`rejected:${r.id}`) && byId.has(r.id))
        .map(r => ({id: r.id, source: 'rejected', material: renderOne(byId.get(r.id)), work: outputText(r.output, output), problems: r.problems ?? [], prev: r.output}));
      if (cases.length && !overBudget()) {
        const decisions = await decide({cases, chain: spec.decider, call, jobDescription: spec.description ?? spec.name});
        for (const cs of cases) {
          const d = decisions.get(cs.id);
          appendJsonl(file('decisions.jsonl'), {id: cs.id, source: 'rejected', ...d});
          if (d.action === 'retry') {
            const r = await retryWithHint(byId.get(cs.id), cs.prev, cs.problems, d.hint);
            if (r.verdict.ok) {
              counts.decider.retry_ok += 1; c.accepted += 1; c.rejected -= 1;
              const row = {id: cs.id, model: r.model, output: r.out, value: r.verdict.value ?? null, score: typeof checks.score === 'function' ? checks.score(byId.get(cs.id).data, r.out) : null, decider: 'retry', at: new Date().toISOString()};
              appendJsonl(file('accepted.jsonl'), row);
              itemDone(byId.get(cs.id), true, row, 'decider');
            }
            else { counts.decider.retry_failed += 1; escalate({id: cs.id, source: 'rejected', reason: 'retry_failed', problem: short(r.verdict.problems.join(' | '), 300)}); }
          } else if (d.action === 'drop') counts.decider.dropped += 1;
          else { counts.decider.escalated += 1; escalate({id: cs.id, source: 'rejected', reason: d.reason || 'escalated by the decider', problem: short(cs.problems.join(' | '), 300)}); }
        }
      } else for (const cs of cases) escalate({id: cs.id, source: 'rejected', reason: 'no decider call (budget)', problem: short(cs.problems.join(' | '), 300)});
    }

    // The audit sample over accepted items, then the decider on its findings.
    if (spec.audit && spec.audit.rate > 0 && !overBudget() && !(stopped && /^refused/.test(stopped))) {
      const {accepted} = finalRecords(dir);
      const audited = new Set(readJsonl(file('audit.jsonl')).map(a => a.id));
      const ids = auditSample([...accepted.keys()], spec.audit.rate, spec.audit.seed ?? spec.name).filter(id => !audited.has(id) && byId.has(id));
      counts.audit.sampled = ids.length;
      if (ids.length) {
        const auditItems = ids.map(id => ({id, material: renderOne(byId.get(id)), work: outputText(accepted.get(id).output, output) || '(empty)'}));
        const {findings, failed} = await runAudit({items: auditItems, audit: spec.audit, instructions: job.audit, call});
        const flagged = new Map();
        for (const f of findings) (flagged.get(f.id) ?? flagged.set(f.id, []).get(f.id)).push(f);
        for (const id of ids) appendJsonl(file('audit.jsonl'), {id, findings: flagged.get(id) ?? [], failed: failed.includes(id)});
        counts.audit.failed = failed.length;
        const min = spec.audit.severity ?? 'medium';
        const serious = [...flagged.entries()].filter(([, fs]) => fs.some(f => atLeast(f.severity, min)));
        counts.audit.flagged = serious.length;
        if (levels) for (const id of ids) {
          const t = perTier[accepted.get(id).tier];
          if (!t) continue;
          t.audit_sampled += 1;
          if (serious.some(([sid]) => sid === id)) t.audit_problems += 1;
        }
        const cases = serious.map(([id, fs]) => ({id, source: 'audit', material: renderOne(byId.get(id)), work: outputText(accepted.get(id).output, output), problems: fs.map(f => `[${f.severity}] ${f.problem}`), prev: accepted.get(id).output}));
        const decisions = await decide({cases, chain: spec.decider, call, jobDescription: spec.description ?? spec.name});
        for (const cs of cases) {
          const d = decisions.get(cs.id);
          appendJsonl(file('decisions.jsonl'), {id: cs.id, source: 'audit', ...d});
          if (d.action === 'dismiss') counts.decider.dismissed += 1;
          else if (d.action === 'retry') {
            const r = await retryWithHint(byId.get(cs.id), cs.prev, cs.problems, d.hint);
            if (r.verdict.ok) {
              counts.decider.retry_ok += 1;
              const row = {id: cs.id, model: r.model, output: r.out, value: r.verdict.value ?? null, score: typeof checks.score === 'function' ? checks.score(byId.get(cs.id).data, r.out) : null, decider: 'retry_after_audit', at: new Date().toISOString()};
              appendJsonl(file('accepted.jsonl'), row);
              itemDone(byId.get(cs.id), true, row, 'audit');
            }
            else { counts.decider.retry_failed += 1; escalate({id: cs.id, source: 'audit', reason: 'retry_failed', problem: short(cs.problems.join(' | '), 300)}); }
          } else { counts.decider.escalated += 1; escalate({id: cs.id, source: 'audit', reason: d.reason || 'escalated by the decider', problem: short(cs.problems.join(' | '), 300)}); }
        }
      }
    }
  } catch (e) {
    if (e instanceof RefusedError) stopped ??= `refused by the proxy: ${e.message}`; else throw e;
  }

  // Tier stats (append-only, per kind), then the sink plugin over the final records.
  if (levels) {
    for (const [tier, t] of Object.entries(ledger.tiers)) if (perTier[tier]) { perTier[tier].usd += t.usd; perTier[tier].credits += t.credits; }
    recordTierStats(statsRoot, {kind: spec.kind, job: spec.name, run, perTier});
  }
  let sinkResult = null;
  if (job.sink) {
    const fin0 = finalRecords(dir);
    try {
      sinkResult = (await job.sink({accepted: [...fin0.accepted.values()], rejected: [...fin0.rejected.values()], items: byId, run, dir, params, spec},
        {...sinkContext, log, status: stopped ? 'stopped' : 'finished'})) ?? {};
    } catch (e) { sinkResult = {error: e.message}; }
    writeJsonAtomic(file('sink.json'), sinkResult);
  }

  // Cost, summary, run record, index.
  const total = spent();
  const cost = writeCost();
  const fin = finalRecords(dir);
  const escalations = readJsonl(file('escalations.jsonl'));
  const scores = {};
  for (const r of fin.accepted.values()) if (r.score?.label) scores[r.score.label] = (scores[r.score.label] ?? 0) + 1;
  const status = stopped ? 'stopped' : 'finished';
  const lt = ledger.total();
  // Audit and decider counts from the run's files, so a resumed run reports what earlier processes did too.
  const auditRows = readJsonl(file('audit.jsonl')), decisionRows = readJsonl(file('decisions.jsonl'));
  counts.audit = {sampled: auditRows.length, flagged: decisionRows.filter(d => d.source === 'audit').length, failed: auditRows.filter(a => a.failed).length};
  const act = a => decisionRows.filter(d => d.action === a).length;
  counts.decider = {...counts.decider, dropped: act('drop'), dismissed: act('dismiss'), escalated: escalations.length};
  const summary = [
    `# ${spec.name} run ${run} (stage ${stages[last].name}): ${status}${stopped ? ` — ${stopped}` : ''}`,
    `items ${fin.accepted.size + fin.rejected.size}/${stages[last].target} settled: accepted ${fin.accepted.size}, rejected ${fin.rejected.size} (empty ${c.empty}, call failures ${c.call_failed}); repaired ${c.repaired}, next model ${c.next_model}`,
    Object.keys(scores).length ? `score (checks.mjs): ${Object.entries(scores).map(([k, v]) => `${k} ${v}`).join(', ')}` : null,
    `decider: retry ok ${counts.decider.retry_ok}, retry failed ${counts.decider.retry_failed}, dropped ${counts.decider.dropped}, dismissed ${counts.decider.dismissed}, escalated ${counts.decider.escalated}; audit: sampled ${counts.audit.sampled}, flagged ${counts.audit.flagged}${counts.audit.failed ? `, unusable ${counts.audit.failed}` : ''}`,
    `calls ${lt.calls} paid + ${lt.cache_hits} from cache (${lt.failed} failed); ${lt.in_tokens} in / ${lt.out_tokens} out tokens; cost ${total.usd.toFixed(4)} USD, ${total.credits.toFixed(2)} credits (budget ${['usd', 'credits', 'calls'].filter(k => spec.budget[k] != null).map(k => `${spec.budget[k]} ${k}`).join(', ')})`,
    levels ? `tiers: start ${levels[plan.start].tier} (${short(plan.reason, 90)})${plan.probe ? `, probe ${levels[plan.probe.level].tier} on ${plan.probe.items}` : ''}; passed at ${Object.entries(passedAt).map(([t, n]) => `${t} ${n} (${pct(n, fin.accepted.size)}%)`).join(', ') || 'none'}` : null,
    sinkResult ? `sink: ${sinkResult.error ? `failed: ${short(sinkResult.error, 120)}` : short(sinkResult.summary ?? JSON.stringify(sinkResult), 160)}` : null,
    `endpoint: ${registration}; files: ${path.relative(store.root, dir)}/{accepted,rejected,escalations}.jsonl`,
    ...escalations.slice(0, 3).map(e => `- escalated ${e.id} (${e.source}): ${short(e.reason, 60)}: ${short(e.problem, 120)}`),
    escalations.length > 3 ? `- … ${escalations.length - 3} more in escalations.jsonl` : null,
  ].filter(Boolean).slice(0, 10);
  writeJsonAtomic(file('summary.md'), summary.join('\n') + '\n');
  save({status, stopped: stopped ?? null, finished_at: new Date().toISOString(), tiers_passed: levels ? passedAt : undefined, sink: sinkResult ?? undefined, counts: {...c, accepted: fin.accepted.size, rejected: fin.rejected.size, escalated: escalations.length}, decider: counts.decider, audit: counts.audit, scores});
  store.index({event: 'finished', job: spec.name, run, status, stopped: stopped ?? null, accepted: fin.accepted.size, rejected: fin.rejected.size, escalated: escalations.length, usd: Number(total.usd.toFixed(6)), credits: Number(total.credits.toFixed(3)), cache_hits: lt.cache_hits});
  if (register && registration.startsWith('registered')) {
    try { await fetchImpl(`${String(proxy).replace(/\/+$/, '')}/jobs/finish`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({run, status}), signal: AbortSignal.timeout(5000)}); } catch { /* the registration expires */ }
  }
  return {run, dir, status, stopped, summary: summary.join('\n'), counts: record.counts, cost, scores, tiers: levels ? {plan, passed: passedAt, perTier} : null, sink: sinkResult};
}
