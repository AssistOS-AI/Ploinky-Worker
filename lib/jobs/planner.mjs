/**
 * Planning a task from user instructions: one call to the planner role (a capable but cheap tier) chooses a job template from a library
 * and fills its parameters. The plan is then validated deterministically: a known template, the task's target allowed by the template,
 * parameters inside the template's schema (types, enums, ranges, required, no unknown names), a tier ladder inside the template's
 * allowed tiers, and a budget inside both the template's and the configuration's limits. An invalid plan gets one repair round with the
 * problems; a plan still invalid is refused. The model never writes code or prompts: templates hold every prompt.
 *
 * A template is a folder `<templatesDir>/<name>/` with `template.json`:
 *   {name, description, kind: "prompt" | "adapter", targets: ["memory", "session", "none"], taskKind, params: {<name>: {type, enum?,
 *    min?, max?, required?, default?, description}}, budget: {usd?, credits?, calls?}, ladder?: [tiers], ladderAllowed?: [tiers]}
 * A "prompt" template is also a job folder (job.json, prompt.md, plugins) whose job.json uses {{params.x}}; an "adapter" template names
 * `adapter` (a module exporting `run(ctx)`) for work an existing pipeline already does.
 */
import fs from 'node:fs';
import path from 'node:path';
import {callChain} from './client.mjs';
import {jsonLines} from './outputs.mjs';
import {PROMPTS_DIR} from './util.mjs';

export const PLANNER_FILE = path.join(PROMPTS_DIR, 'planner.md');
const TYPES = {string: v => typeof v === 'string', integer: Number.isInteger, number: v => typeof v === 'number' && Number.isFinite(v), boolean: v => typeof v === 'boolean',
  'string[]': v => Array.isArray(v) && v.every(x => typeof x === 'string')};

export function loadTemplates(dir) {
  if (!dir || !fs.existsSync(dir)) return {};
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, name, 'template.json');
    if (!fs.existsSync(f)) continue;
    const t = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (t.name !== name) throw new Error(`template ${name}: template.json name must be "${name}"`);
    out[name] = {...t, dir: path.join(dir, name)};
  }
  return out;
}

/** The catalog the planner sees: name, description, targets, task kind, parameters (no file contents). */
export function catalogText(templates) {
  return Object.values(templates).map(t => JSON.stringify({template: t.name, description: t.description, targets: t.targets ?? ['none'], task_kind: t.taskKind ?? null,
    params: t.params ?? {}, ladder: t.ladder ?? null, ladder_allowed: t.ladderAllowed ?? null, default_budget: t.budget ?? null})).join('\n');
}

/** Deterministic validation; returns `{ok, plan (normalised, defaults applied), problems}`. */
export function validatePlan(raw, {templates, target = 'none', limits = {}, tiers = null}) {
  const problems = [];
  const t = templates[raw?.template];
  if (!t) return {ok: false, problems: [`template: one of ${Object.keys(templates).join(', ')}`]};
  if (!(t.targets ?? ['none']).includes(target)) problems.push(`template ${t.name} cannot write to a ${target} target (targets: ${(t.targets ?? ['none']).join(', ')})`);
  const params = {};
  const given = raw.params && typeof raw.params === 'object' ? raw.params : {};
  for (const k of Object.keys(given)) if (!t.params?.[k]) problems.push(`params.${k}: not a parameter of ${t.name}`);
  for (const [k, d] of Object.entries(t.params ?? {})) {
    let v = given[k];
    if (v === undefined || v === null) {
      if (d.default !== undefined) v = d.default;
      else if (d.required !== false) { problems.push(`params.${k}: required`); continue; }
      else continue;
    }
    if (!(TYPES[d.type] ?? (() => true))(v)) { problems.push(`params.${k}: must be ${d.type}`); continue; }
    if (d.enum && ![].concat(v).every(x => d.enum.includes(x))) { problems.push(`params.${k}: one of ${d.enum.join(', ')}`); continue; }
    if (d.min != null && (typeof v === 'number' ? v : v.length) < d.min) { problems.push(`params.${k}: at least ${d.min}`); continue; }
    if (d.max != null && (typeof v === 'number' ? v : v.length) > d.max) { problems.push(`params.${k}: at most ${d.max}`); continue; }
    params[k] = v;
  }
  let ladder = t.ladder ?? null;
  if (raw.ladder != null) {
    const allowed = t.ladderAllowed ?? t.ladder ?? [];
    if (!Array.isArray(raw.ladder) || !raw.ladder.length || !raw.ladder.every(x => allowed.includes(x))) problems.push(`ladder: a non-empty list of tiers from ${allowed.join(', ') || '(none allowed)'}`);
    else if (tiers && !raw.ladder.every(x => tiers.includes(x))) problems.push(`ladder: unknown tier (known: ${tiers.join(', ')})`);
    else ladder = raw.ladder;
  }
  const budget = {...(t.budget ?? {})};
  for (const k of ['usd', 'credits', 'calls']) {
    if (raw.budget?.[k] != null) {
      if (!(typeof raw.budget[k] === 'number' && raw.budget[k] >= 0)) { problems.push(`budget.${k}: a non-negative number`); continue; }
      budget[k] = raw.budget[k];
    }
    const cap = {usd: limits.maxTaskUsd, credits: limits.maxTaskCredits, calls: limits.maxTaskCalls}[k];
    if (budget[k] != null && cap != null && budget[k] > cap) problems.push(`budget.${k}: ${budget[k]} is above the limit ${cap}`);
  }
  if (!['usd', 'credits', 'calls'].some(k => budget[k] != null)) problems.push('budget: the template defines none and the plan gives none');
  const plan = {template: t.name, kind: t.kind, taskKind: raw.task_kind && typeof raw.task_kind === 'string' ? raw.task_kind.slice(0, 64) : t.taskKind ?? t.name, params, ladder, budget, reason: String(raw.reason ?? '').slice(0, 300)};
  return {ok: !problems.length, plan, problems};
}

/**
 * One planning call (plus one repair round). `attachments` are described by metadata and a short preview only. Returns
 * `{ok, plan, problems, calls}`.
 */
export async function planTask({instructions, attachments = [], target = 'none', templates, limits = {}, tiers = null, chain, call}) {
  const system = `${fs.readFileSync(PLANNER_FILE, 'utf8').trim()}\n\nTEMPLATES (one JSON object per line):\n${catalogText(templates)}`;
  const user = [`TARGET: ${target}`, `INSTRUCTIONS:\n${instructions}`, `ATTACHMENTS:\n${attachments.map(a => `- ${a.name} (${a.bytes} bytes): ${JSON.stringify(String(a.preview ?? '').slice(0, 300))}`).join('\n') || '(none)'}`].join('\n\n');
  const messages = [{role: 'system', content: system}, {role: 'user', content: user}];
  let last = null;
  for (let round = 0; round < 2; round++) {
    const r = await callChain(call, chain, messages, 'planner');
    if (!r.ok) return {ok: false, problems: [`planner call failed: ${r.error}`]};
    const obj = jsonLines(r.text).objects.find(o => o.template);
    last = obj ? validatePlan(obj, {templates, target, limits, tiers}) : {ok: false, problems: ['no JSON object with "template"']};
    if (last.ok) return last;
    messages.push({role: 'assistant', content: r.text}, {role: 'user', content: `The plan is invalid:\n${last.problems.map(p => `- ${p}`).join('\n')}\nWrite the corrected JSON object only.`});
  }
  return {ok: false, plan: last.plan ?? null, problems: last.problems};
}
