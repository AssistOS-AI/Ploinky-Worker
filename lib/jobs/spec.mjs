/**
 * Job specs: every LLM batch job is a declarative spec run by deterministic code (README.md "Job spec").
 *
 * A job folder holds `job.json`, `prompt.md` and optionally plugins loaded by path from the spec (`checks`, `sink`, `inputs.module`)
 * and an audit instruction file. `prompt.md` is split by marker lines into sections:
 *
 *   <<<system>>>   the system message
 *   <<<item>>>     one item, rendered with {{id}} and the item's `inputs.promptFields` only (never gold or other fields)
 *   <<<call>>>     optional wrapper of a packed call: {{items}} (the rendered items) and {{count}}
 *   <<<repair>>>   the repair message: {{problems}} (one line per problem) and {{hint}}
 *
 * `{{params.x}}` refers to a job parameter (templates); a missing variable is an error, never an empty string.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {sha256} from './util.mjs';
import {loadConfig, tierChains} from './config.mjs';

export const FORMATS = Object.freeze(['text', 'jsonl']);
export const SECTIONS = Object.freeze(['system', 'item', 'call', 'repair']);
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function parsePrompt(text) {
  const out = {};
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = /^<<<([a-z]+)>>>\s*$/.exec(line);
    if (m) {
      if (!SECTIONS.includes(m[1])) throw new Error(`prompt.md: unknown section <<<${m[1]}>>> (sections: ${SECTIONS.join(', ')})`);
      cur = m[1]; out[cur] = []; continue;
    }
    if (cur) out[cur].push(line);
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n').trim();
  if (!out.system || !out.item) throw new Error('prompt.md needs the sections <<<system>>> and <<<item>>>');
  return out;
}

const lookup = (vars, key) => key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), vars);

/** Replaces {{name}} and {{a.b}}; a missing variable throws. */
export function render(template, vars) {
  return String(template).replace(/\{\{\s*([A-Za-z_][\w.]*)\s*\}\}/g, (_, key) => {
    const v = lookup(vars, key);
    if (v === undefined) throw new Error(`template variable {{${key}}} is not defined`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

/** Substitutes {{params.x}} inside job.json values: a string that is exactly one variable keeps the value's type. */
export function substituteParams(value, params) {
  if (typeof value === 'string') {
    const exact = /^\{\{\s*(params\.[\w.]+)\s*\}\}$/.exec(value);
    if (exact) { const v = lookup({params}, exact[1]); if (v === undefined) throw new Error(`job.json: {{${exact[1]}}} is not defined`); return v; }
    return value.includes('{{params.') ? render(value, {params}) : value;
  }
  if (Array.isArray(value)) return value.map(v => substituteParams(v, params));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteParams(v, params)]));
  return value;
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);

/** Problems of a job spec (empty when valid). */
export function validateSpec(spec) {
  const p = [];
  if (!spec || typeof spec !== 'object') return ['job.json is not an object'];
  if (!NAME.test(spec.name ?? '')) p.push('name: lowercase letters, digits, - and _ (at most 64)');
  const inp = spec.inputs ?? {};
  const sources = ['path', 'command', 'items', 'module', 'attachments'].filter(k => inp[k] != null);
  if (sources.length !== 1) p.push('inputs: exactly one of path, command, items, module, attachments');
  if (inp.command != null && (!Array.isArray(inp.command) || !inp.command.every(s => typeof s === 'string'))) p.push('inputs.command: an array of strings');
  if (!Array.isArray(inp.promptFields) || !inp.promptFields.length) p.push('inputs.promptFields: the item fields the prompt may see (required; gold never goes here)');
  if (inp.select?.n != null && !(Number.isInteger(inp.select.n) && inp.select.n > 0)) p.push('inputs.select.n: a positive integer');
  const pk = spec.packing ?? {itemsPerCall: 1};
  if (pk.itemsPerCall != null && !(Number.isInteger(pk.itemsPerCall) && pk.itemsPerCall > 0)) p.push('packing.itemsPerCall: a positive integer');
  if (pk.tokenBudget != null && !(isNum(pk.tokenBudget) && pk.tokenBudget > 0)) p.push('packing.tokenBudget: a positive number');
  if (spec.ladder != null && (!Array.isArray(spec.ladderChains) || !spec.ladderChains.length)) p.push('ladder: a list of tier names, cheapest first');
  if (spec.ladder != null && !spec.kind) p.push('kind: a task kind is required with a ladder (tier stats are kept per kind)');
  if (spec.ladder != null && spec.fallbackOnFailure === false) p.push('fallbackOnFailure false and a ladder exclude each other (a ladder climbs on failure)');
  if (!Array.isArray(spec.models) || !spec.models.length) p.push('models: a tier ("tier:<name>" or "role:<name>"), a ladder, or a chain of {upstream, model}');
  else spec.models.forEach((m, i) => { if (!(m?.upstream || m?.viaProxyTier) || !m?.model) p.push(`models[${i}]: upstream and model are required`); });
  const fmt = spec.output?.format;
  if (!FORMATS.includes(fmt)) p.push(`output.format: one of ${FORMATS.join(', ')}`);
  const packed = (pk.itemsPerCall ?? 1) > 1 || pk.tokenBudget != null;
  if (packed && fmt !== 'jsonl') p.push('packing more than one item per call needs output.format jsonl (each line carries the item id)');
  if (spec.repairRounds != null && !(Number.isInteger(spec.repairRounds) && spec.repairRounds >= 0 && spec.repairRounds <= 5)) p.push('repairRounds: 0..5');
  if (spec.priority != null && !['interactive', 'normal', 'background'].includes(spec.priority)) p.push('priority: interactive, normal or background');
  if (spec.concurrency != null && !(Number.isInteger(spec.concurrency) && spec.concurrency >= 1 && spec.concurrency <= 16)) p.push('concurrency: 1..16');
  const b = spec.budget;
  if (!b || ![b.usd, b.credits, b.calls].some(isNum)) p.push('budget: at least one of usd, credits, calls (a job never runs without a budget)');
  if (!Array.isArray(spec.stages) || !spec.stages.length) p.push('stages: at least one {name, items, stop}');
  else {
    let last = 0;
    for (const [i, s] of spec.stages.entries()) {
      if (!NAME.test(s?.name ?? '')) p.push(`stages[${i}].name: required`);
      if (s.items != null && !(Number.isInteger(s.items) && s.items > last)) p.push(`stages[${i}].items: an integer above the previous stage (cumulative), or null for all`);
      if (s.items == null && i !== spec.stages.length - 1) p.push(`stages[${i}].items: only the last stage may be open (null)`);
      last = s.items ?? Infinity;
      for (const k of ['maxRejectRate', 'maxEmptyRate']) if (s.stop?.[k] != null && !(isNum(s.stop[k]) && s.stop[k] >= 0 && s.stop[k] <= 1)) p.push(`stages[${i}].stop.${k}: 0..1`);
    }
  }
  const a = spec.audit;
  if (a != null) {
    if (!(isNum(a.rate) && a.rate >= 0 && a.rate <= 1)) p.push('audit.rate: 0..1');
    if (!Array.isArray(a.models) || !a.models.length || !a.models.every(m => (m?.upstream || m?.viaProxyTier) && m?.model)) p.push('audit: a model chain (tier, role, or upstream and model) is required');
    if (!a.instructions) p.push('audit.instructions: the audit instruction file of the job folder');
  }
  if (spec.decider != null && (!Array.isArray(spec.decider) || !spec.decider.every(m => (m?.upstream || m?.viaProxyTier) && m?.model))) p.push('decider: a model chain (tier:decider by default) or null');
  return p;
}

/**
 * Resolves tiers and roles into model chains (jobs name only tiers or roles, never concrete models). `models` is
 * "tier:<name>" or "role:<role>" (the runner configuration's roles: planner, decider, auditor, worker, ...); `ladder` is a list of tiers; `audit.tier` or
 * `audit.role` (default role auditor); `decider` (default "role:decider"; null switches it off). `chains` is `{tier: chain}`
 * (config.tierChains); `roles` maps a role to a tier. An explicit chain of {upstream, model} is still accepted for tests.
 */
export function resolveTiers(spec, {chains = {}, roles = {}} = {}) {
  const chain = (v, where) => {
    if (v == null) return v;
    if (typeof v === 'string') {
      const m = /^(tier|role):([\w-]+)$/.exec(v);
      if (!m) throw new Error(`${where}: "tier:<name>", "role:<name>" or a chain of {upstream, model}`);
      const tier = m[1] === 'role' ? roles[m[2]] : m[2];
      if (!tier) throw new Error(`${where}: unknown role ${JSON.stringify(m[2])} (roles: ${Object.keys(roles).join(', ')})`);
      if (!Array.isArray(chains[tier]) || !chains[tier].length) throw new Error(`${where}: unknown model tier ${JSON.stringify(tier)} (tiers: ${Object.keys(chains).join(', ')})`);
      return chains[tier];
    }
    return Array.isArray(v) ? v : [v];
  };
  const out = {...spec, decider: spec.decider === null ? null : chain(spec.decider ?? 'role:decider', 'decider')};
  if (spec.ladder != null) {
    if (!Array.isArray(spec.ladder) || !spec.ladder.length) throw new Error('ladder: a non-empty list of tier names, cheapest first');
    out.ladderChains = spec.ladder.map(t => ({tier: t, chain: chain(`tier:${t}`, 'ladder')}));
  }
  out.models = spec.models != null ? chain(spec.models, 'models') : out.ladderChains?.[0]?.chain;
  if (spec.audit) {
    const a = spec.audit;
    out.audit = {...a, models: a.tier ? chain(`tier:${a.tier}`, 'audit.tier') : a.models ? chain(a.models, 'audit.models') : chain(`role:${a.role ?? 'auditor'}`, 'audit.role')};
  }
  return out;
}

/**
 * Loads a job folder. `params` substitutes {{params.x}} (templates); `config` is loadConfig() (found from the job folder by default);
 * `live` is the set of tiers the endpoint serves (config.liveTiers). Returns `{dir, spec, prompt, checks, sink, audit, hash, files,
 * config, params}`; `hash` covers every file and resolved chain that shapes the calls.
 */
export async function loadJob(dir, {params = null, config = null, live = new Set(), overrides = null, tiers = null} = {}) {
  dir = path.resolve(dir);
  const jobFile = path.join(dir, 'job.json');
  if (!fs.existsSync(jobFile)) throw new Error(`no job spec at ${jobFile}`);
  config ??= loadConfig({jobDir: dir});
  const raw = fs.readFileSync(jobFile, 'utf8');
  let spec = JSON.parse(raw);
  if (params) spec = substituteParams(spec, params);
  if (overrides) spec = {...spec, ...overrides};
  spec = resolveTiers(spec, {chains: tiers ?? tierChains(config, live), roles: config.roles});
  const problems = validateSpec(spec);
  if (problems.length) throw Object.assign(new Error(`invalid job spec ${spec.name ?? dir}:\n- ${problems.join('\n- ')}`), {code: 'invalid_job', problems});
  const files = {'job.json': raw};
  const promptText = fs.readFileSync(path.join(dir, spec.prompt ?? 'prompt.md'), 'utf8');
  files[spec.prompt ?? 'prompt.md'] = promptText;
  const prompt = parsePrompt(params ? renderParamsOnly(promptText, params) : promptText);
  const plugin = async (rel, what) => {
    const f = path.resolve(dir, rel);
    if (!fs.existsSync(f)) throw new Error(`${what} plugin ${rel} not found (${f})`);
    files[rel] = fs.readFileSync(f, 'utf8');
    return import(pathToFileURL(f).href);
  };
  const checks = spec.checks ? await plugin(spec.checks, 'checks') : {};
  const sinkMod = spec.sink ? await plugin(spec.sink, 'sink') : null;
  if (sinkMod && typeof sinkMod.sink !== 'function') throw new Error(`sink plugin ${spec.sink} exports no sink(results, ctx)`);
  let audit = null;
  if (spec.audit) {
    audit = fs.readFileSync(path.join(dir, spec.audit.instructions), 'utf8').trim();
    files[spec.audit.instructions] = audit;
  }
  const hash = sha256({files, params, overrides, models: spec.models, ladder: spec.ladderChains ?? null, decider: spec.decider, audit: spec.audit?.models ?? null});
  return {dir, spec, prompt, checks, sink: sinkMod?.sink ?? null, audit, hash, files, config, params};
}

/** Renders only {{params.x}} in a prompt file, leaving per-item variables for later. */
function renderParamsOnly(text, params) {
  return String(text).replace(/\{\{\s*(params\.[\w.]+)\s*\}\}/g, (_, key) => {
    const v = lookup({params}, key);
    if (v === undefined) throw new Error(`prompt: {{${key}}} is not defined`);
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
