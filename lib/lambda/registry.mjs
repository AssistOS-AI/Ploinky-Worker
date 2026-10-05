// The registry of the server's TaskLambdas: what the server can run for a client, a planner or another TaskLambda. A TaskLambda is a
// content-hashed executable unit: code, a typed parameter schema, an optional check, metadata (name, description, origin) and a REQUIRED
// effects declaration (lib/lambda/effects.mjs). A module exports `{name, description, params, effects, run(ctx)}` (`params`:
// {<name>: {type, enum?, min?, max?, required?, default?, description}}; types string, integer, number, boolean, string[], object), or
// `lambdas: [...]` for several. Sources, in this order (a later source cannot replace an earlier name):
//   1. built-in TaskLambdas (./lambdas/*.mjs: chat, json, job, task, write-lambda)               origin built-in
//   2. project TaskLambdas named by the configuration (`lambdas.project`: files or folders of .mjs modules)   origin project
//   3. one TaskLambda per job folder of `lambdas.jobs` ({name: dir | {dir, description}})                   origin job
//   4. one TaskLambda per task template of `runner.templatesDir` (the template's parameters are its params) origin template
// Model-written TaskLambdas (the agent's cached lambdas, programs of write-lambda) run in the sandbox and live in their own caches.
// The hash of a module TaskLambda is the sha256 of its module text and name; of a job folder or template, of its files. Modules are
// loaded inside a worker thread of the server for every operation, so a changed module is used at its next call.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { HOME } from '../settings.mjs';
import { loadTemplates } from '../jobs/planner.mjs';
import { effectsProblems, EFFECT_KINDS, REFUSED_EFFECTS } from './effects.mjs';

const TYPES = {
  string: (v) => typeof v === 'string', integer: Number.isInteger, number: (v) => typeof v === 'number' && Number.isFinite(v), boolean: (v) => typeof v === 'boolean',
  'string[]': (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'), object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};
const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const hash16 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(String(p)).update('\0'); return h.digest('hex').slice(0, 16); };
/** The effects a project module without a declaration is loaded with during the migration (everything but the refused kinds). */
export const UNDECLARED_EFFECTS = Object.freeze(EFFECT_KINDS.filter((k) => !REFUSED_EFFECTS.includes(k)));

/** Validates parameters against a schema: {ok, params (defaults applied), problems}. */
export function validateParams(schema = {}, given = {}) {
  const problems = [], params = {};
  const g = given && typeof given === 'object' ? given : {};
  for (const k of Object.keys(g)) if (!schema[k]) problems.push(`params.${k}: not a parameter (parameters: ${Object.keys(schema).join(', ') || 'none'})`);
  for (const [k, d] of Object.entries(schema)) {
    let v = g[k];
    if (v === undefined || v === null) {
      if (d.default !== undefined) v = d.default;
      else if (d.required !== false) { problems.push(`params.${k}: required`); continue; }
      else continue;
    }
    if (!(TYPES[d.type] ?? (() => true))(v)) { problems.push(`params.${k}: must be ${d.type}`); continue; }
    if (d.enum && ![].concat(v).every((x) => d.enum.includes(x))) { problems.push(`params.${k}: one of ${d.enum.join(', ')}`); continue; }
    const size = typeof v === 'number' ? v : v?.length;
    if (d.min != null && size < d.min) { problems.push(`params.${k}: at least ${d.min}`); continue; }
    if (d.max != null && size > d.max) { problems.push(`params.${k}: at most ${d.max}`); continue; }
    params[k] = v;
  }
  return { ok: !problems.length, params, problems };
}

const modulesOf = (p) => {
  if (!existsSync(p)) return [];
  if (statSync(p).isDirectory()) return readdirSync(p).filter((f) => f.endsWith('.mjs') && !f.startsWith('_') && !f.endsWith('.test.mjs')).sort().map((f) => join(p, f));
  return [p];
};
/** The hash of a folder's regular files (names and contents, sorted): a job folder or a template. */
export function dirHash(dir) {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort() : [];
  return hash16(...files.flatMap((f) => [f, readFileSync(join(dir, f))]));
}

/** Imports a module fresh (a query string with the file's modification time defeats the module cache of a long-running process). */
export const freshImport = (file) => import(`${pathToFileURL(file).href}?v=${Math.round(statSync(file).mtimeMs)}`);

/** A TaskLambda record from a module export: {name, description, params, effects, origin, source, hash, run, attachments, problems}. */
function checkLambda(s, { origin, source, text }) {
  if (!s || typeof s !== 'object' || typeof s.run !== 'function') throw new Error(`${source}: a TaskLambda exports {name, description, params, effects, run(ctx)}`);
  if (!NAME.test(s.name ?? '')) throw new Error(`${source}: TaskLambda name ${JSON.stringify(s.name)} must be lowercase letters, digits, . _ -`);
  if (typeof s.description !== 'string' || !s.description.trim()) throw new Error(`${source}: TaskLambda ${s.name} needs a description`);
  const warnings = [];
  let effects = s.effects;
  if (effects === undefined && origin === 'project') {
    warnings.push(`${source}: TaskLambda ${s.name} declares no effects (required); loaded with every allowed effect until it does`);
    effects = [...UNDECLARED_EFFECTS];
  } else {
    const p = effectsProblems(effects);
    if (p.length) throw new Error(`${source}: TaskLambda ${s.name}: ${p.join('; ')}`);
  }
  return { name: s.name, description: s.description.trim(), params: s.params ?? {}, effects, effectsDeclared: s.effects !== undefined, origin, source,
    hash: hash16(text, s.name), run: s.run, check: typeof s.check === 'function' ? s.check : null, attachments: s.attachments ?? 'optional', warnings };
}

/**
 * Loads every TaskLambda: {lambdas: Map name -> record, problems, warnings}. Problems (a broken module, a name defined twice) and
 * warnings (a project module of before the rename: no effects declared, an old configuration key) are collected, not thrown.
 */
export async function loadLambdas(config) {
  const lambdas = new Map(), problems = [], warnings = [];
  const add = (s) => { warnings.push(...(s.warnings ?? [])); if (lambdas.has(s.name)) problems.push(`TaskLambda ${s.name} of ${s.source} is already defined by ${lambdas.get(s.name).source}`); else lambdas.set(s.name, s); };
  const src = { project: config.lambdas?.project ?? [], jobs: config.lambdas?.jobs ?? {} };
  const sources = [...modulesOf(join(HOME, 'lambdas')).map((f) => ['built-in', f]), ...src.project.flatMap((p) => modulesOf(resolve(p)).map((f) => ['project', f]))];
  for (const [origin, file] of sources) {
    try {
      const m = await freshImport(file);
      const text = readFileSync(file, 'utf8');
      const list = Array.isArray(m.lambdas) ? m.lambdas : [];
      for (const s of [m.default, ...list].filter(Boolean)) add(checkLambda(s, { origin, source: `${origin}:${file}`, text }));
    } catch (e) { problems.push(`${file}: ${e.message}`); }
  }
  for (const [name, v] of Object.entries(src.jobs)) {
    const dir = typeof v === 'string' ? v : v?.dir;
    if (!dir || !existsSync(join(dir, 'job.json'))) { problems.push(`lambdas.jobs.${name}: no job.json in ${dir}`); continue; }
    let spec = {};
    try { spec = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8')); } catch (e) { problems.push(`${dir}/job.json: ${e.message}`); continue; }
    add({ name, source: `job:${dir}`, origin: 'job', hash: dirHash(dir), effects: ['runs-jobs', 'writes-external'], effectsDeclared: true, check: null, attachments: 'optional',
      description: (typeof v === 'object' && v.description) || spec.description || `the job ${spec.name ?? name}`,
      params: { stage: { type: 'string', required: false, description: `run through this stage only (${(spec.stages ?? []).map((s) => s.name).join(', ') || 'all'})` } },
      run: (ctx) => ctx.jobs.runJob(dir, { stage: ctx.params.stage ?? null }) });
  }
  try {
    for (const t of Object.values(loadTemplates(config.runner?.templatesDir))) {
      add({ name: t.name, source: `template:${t.dir}`, origin: 'template', hash: dirHash(t.dir), effects: ['runs-jobs', 'writes-external'], effectsDeclared: true, check: null, attachments: 'optional',
        description: t.description,
        params: { ...(t.params ?? {}), target: { type: 'string', required: false, description: `where results go: ${(t.targets ?? ['none']).map((k) => (k === 'none' ? 'none' : `${k}:<id>`)).join(' | ')}` } },
        run: (ctx) => {
          const { target = 'none', ...params } = ctx.params;
          const [kind, ...id] = String(target).split(':');
          return ctx.jobs.runTask({ template: t.name, params, attachments: ctx.attachments, target: { kind, id: id.join(':') || null } });
        } });
    }
  } catch (e) { problems.push(`templates: ${e.message}`); }
  return { lambdas, problems, warnings };
}

/** The catalog a planner sees (one JSON object per line; no code). */
export const catalogOf = (lambdas) => [...lambdas.values()].map((s) => JSON.stringify({ lambda: s.name, description: s.description, params: s.params, effects: s.effects })).join('\n');

/** The public view of a TaskLambda (no code): for listings. */
export const lambdaView = ({ name, description, params, effects, effectsDeclared, origin, source, hash }) => ({ name, description, params, effects, effectsDeclared, origin, source, hash });
