// A TaskLambda of the agent is a small JavaScript module (lambda.mjs) a person can read, edit and check with `node --check`:
//
//   export const meta = {name, task, params: {<name>: {type, description, default?, enum?}}, example: {<values>}, effects: [...], skills: [...]};
//   export default async function run(tools, params) { ...; return {answer, outputs}; }
//   export async function check(tools, params, result) { ...; return {ok, reason}; }      // optional: the TaskLambda's own check
//
// `meta.effects` is required: ['pure'], or the kinds it uses (writes-workdir for tools.write/move, model-calls for tools.ask,
// runs-scripts for tools.runSkillScript); the tools refuse an undeclared effect, and only a pure TaskLambda's result is reused.
// It never imports anything: the sandbox has no module loader. For the sandbox, `moduleScript` turns the `export` keywords into plain
// declarations (line numbers are kept, so an error's "lambda.js:12" is line 12 of lambda.mjs).
import { createHash } from 'node:crypto';
import { effectsProblems, effectsUsedBy } from '../lambda/effects.mjs';

export const PARAM_TYPES = Object.freeze(['string', 'integer', 'number', 'boolean', 'string[]', 'object']);

/** The sha256 (hex, first 16 characters) of a TaskLambda's text, line endings normalised: its content hash. */
export const lambdaHash = (code) => createHash('sha256').update(String(code).replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);

/** The code of a model reply: the first ```js / ```javascript / ```mjs block, else null. */
export function codeBlockOf(text) {
  const m = /```(?:js|javascript|mjs)[ \t]*\r?\n([\s\S]*?)```/i.exec(String(text ?? '')) ?? /```[ \t]*\r?\n([\s\S]*?)```/.exec(String(text ?? ''));
  return m ? m[1].trim() : null;
}

/** The module text as a sandbox script, or {error}. */
export function moduleScript(code) {
  const src = String(code ?? '');
  if (/^\s*import\s[\s\S]*?from\s|^\s*import\s*['"]|\bimport\s*\(/m.test(src)) return { error: 'a TaskLambda never imports anything: use only tools.* and plain JavaScript' };
  if (/\brequire\s*\(/.test(src)) return { error: 'a TaskLambda never calls require: use only tools.* and plain JavaScript' };
  let out = src.replace(/^export\s+default\s+(async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*\(/m, (_, a, name) => `${a ?? ''}function run(`);
  if (/^export\s+default\b/m.test(out)) return { error: 'the default export must be a function declaration: export default async function run(tools, params) { ... }' };
  out = out.replace(/^export\s+(?=(?:const|let|var|async\s+function|function|class)\b)/gm, '');
  if (/^export\b/m.test(out)) return { error: 'unsupported export: use export const meta, export default async function run and export async function check' };
  return { script: out };
}

/**
 * Problems of a TaskLambda's meta: [] when it is usable (name, task, a typed parameter schema, example values that fit it, an effects
 * declaration that covers what `code` uses).
 */
export function metaProblems(meta, validate, code = null) {
  const p = [];
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return ['the TaskLambda must export const meta = {name, task, params, example, effects, skills}'];
  if (typeof meta.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(meta.name)) p.push('meta.name: a short lowercase-hyphenated name, for example "sum-csv-column"');
  if (typeof meta.task !== 'string' || meta.task.trim().length < 10) p.push('meta.task: one sentence that says what the TaskLambda does in general');
  if (!meta.params || typeof meta.params !== 'object' || Array.isArray(meta.params)) p.push('meta.params: an object {<name>: {type, description}}');
  else for (const [k, d] of Object.entries(meta.params)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)) p.push(`meta.params.${k}: a parameter name is letters, digits and _`);
    if (!d || !PARAM_TYPES.includes(d.type)) p.push(`meta.params.${k}.type: one of ${PARAM_TYPES.join(', ')}`);
    if (!d || typeof d.description !== 'string' || !d.description.trim()) p.push(`meta.params.${k}.description: say what the value is`);
  }
  if (!p.length && validate) {
    const v = validate(meta.params, meta.example ?? {});
    for (const x of v.problems) p.push(`meta.example: ${x}`);
  }
  if (meta.skills !== undefined && (!Array.isArray(meta.skills) || meta.skills.some((s) => typeof s !== 'string'))) p.push('meta.skills: a list of skill names');
  const ep = effectsProblems(meta.effects);
  if (ep.length) p.push(`meta.${ep[0]}`);
  else if (code != null) {
    const missing = effectsUsedBy(code).filter((k) => !meta.effects.includes(k));
    if (missing.length) p.push(`meta.effects: the code uses ${missing.join(', ')} but declares ${JSON.stringify(meta.effects)} (tools.write/move: writes-workdir; tools.ask: model-calls; tools.runSkillScript: runs-scripts)`);
  }
  return p;
}

/** The string literals of a code text (quotes and backticks without ${...}), with the spans of the `export const meta = {...}` block left out. */
export function codeLiterals(code) {
  const src = String(code ?? '');
  const out = [];
  let i = 0, metaEnd = -1;
  const metaAt = src.search(/export\s+const\s+meta\s*=\s*\{/);
  if (metaAt >= 0) {
    let depth = 0, j = src.indexOf('{', metaAt), q = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === '`') q = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) break;
    }
    metaEnd = j;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i += 2; continue; }
    // A regular expression literal (a / where an expression starts) is skipped whole: its quotes are not strings.
    if (c === '/' && /[(,=:[!&|?{};+\-*%<>~^]$|^$/.test(src.slice(0, i).trimEnd().slice(-1))) {
      let j = i + 1, cls = false;
      for (; j < src.length && src[j] !== '\n'; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; else if (src[j] === '/' && !cls) break; }
      i = j + 1; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1, s = '';
      for (; j < src.length && src[j] !== c; j++) { if (src[j] === '\\') { s += src[j + 1] ?? ''; j++; } else s += src[j]; }
      if (!(metaAt >= 0 && i > metaAt && i < metaEnd) && !(c === '`' && s.includes('${'))) out.push(s);
      i = j + 1; continue;
    }
    i++;
  }
  return out;
}

/**
 * Values of THIS request written into the TaskLambda's code, so it would not work with other values. A string literal of the code
 * (outside meta) is flagged when it occurs in the request as a whole (not inside a longer word) and either holds a character other than
 * letters (".txt", "2026-", "old_", "sales.csv", "3") or equals one of the example values. A plain word of the request in the code ("file",
 * "total") is common vocabulary, not flagged unless it is a parameter's value. `allowed`: names that are tools, not values (the skills
 * and their declared scripts: "Use the text-stats skill" names a tool).
 */
export function hardcodedValues(code, request, example = {}, { allowed = [] } = {}) {
  const r = String(request ?? '');
  const tools = new Set(allowed);
  const values = new Set(Object.values(example ?? {}).flat().filter((v) => typeof v === 'string').map((v) => v.trim()));
  const hits = new Set();
  for (const lit of codeLiterals(code)) {
    const s = lit.trim();
    // A one-character literal is skipped (separators, quotes), except a digit: "the 3 most frequent words" written as '3' is a value.
    if ((s.length < 2 && !/^\d$/.test(s)) || !/[\p{L}\p{N}]/u.test(s) || s.length > 200 || tools.has(s)) continue;
    if (/^\p{L}+$/u.test(s) && !values.has(s)) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u');
    if (re.test(r)) hits.add(s);
  }
  return [...hits];
}
