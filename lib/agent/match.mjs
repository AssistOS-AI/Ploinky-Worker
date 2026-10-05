// The fast match before planning. A BM25 index over the cached TaskLambdas (task, LAMBDA.md description, parameter names, first request)
// gives the top candidates in milliseconds; a cheap tier (`tiny`) then decides only whether the new request is the same task as one of
// them with other parameter values, and extracts those values against the TaskLambda's parameter schema. The values are coerced to their declared
// types (a number written as text, true/false) and validated; a value the schema refuses, or a candidate the cheap tier did not name,
// sends the request to the planner. Optionally (agent.match.grounded, on by default) every string value must occur in the request (case,
// spaces and punctuation ignored) unless it is the parameter's default: a value the model made up is not a parameter of THIS request.
import fs from 'node:fs';
import { buildIndex } from './bm25.mjs';
import { jsonOf } from '../client.mjs';
import { validateParams } from '../lambda/registry.mjs';

/** The BM25 document of a TaskLambda. */
export const lambdaDoc = (p) => ({
  id: p.id,
  fields: [
    { text: p.meta?.task ?? '', weight: 2 },
    { text: p.description ?? '', weight: 2 },
    { text: Object.entries(p.meta?.params ?? {}).map(([k, d]) => `${k.replace(/_/g, ' ')} ${d.description ?? ''}`).join(' '), weight: 1 },
    { text: p.firstRequest ?? '', weight: 1 },
    { text: (p.meta?.name ?? '').replace(/-/g, ' '), weight: 1 },
  ],
});

/** Values coerced to their declared types where the reading is unambiguous (text "12" for an integer, "true" for a boolean). */
export function coerceToSchema(schema = {}, values = {}) {
  const out = {};
  for (const [k, v] of Object.entries(values && typeof values === 'object' ? values : {})) {
    const d = schema[k];
    if (!d || v === null || v === undefined) { out[k] = v; continue; }
    if ((d.type === 'integer' || d.type === 'number') && typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) out[k] = Number(v);
    else if (d.type === 'boolean' && (v === 'true' || v === 'false')) out[k] = v === 'true';
    else if (d.type === 'string[]' && typeof v === 'string') out[k] = [v];
    else out[k] = v;
  }
  return out;
}

const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
/** Values not found in the request (strings and numbers; defaults and empty strings excepted). */
export function ungrounded(schema, values, request) {
  const r = norm(request);
  const bad = [];
  for (const [k, v] of Object.entries(values)) {
    const d = schema[k] ?? {};
    if (d.default !== undefined && JSON.stringify(d.default) === JSON.stringify(v)) continue;
    const items = Array.isArray(v) ? v : [v];
    for (const x of items) {
      if (typeof x !== 'string' && typeof x !== 'number') continue;
      const n = norm(x);
      if (n && !r.includes(n)) { bad.push(k); break; }
    }
  }
  return bad;
}

const describe = (p, i) => [
  `[${i + 1}] id: ${p.id}`,
  `task: ${p.meta?.task ?? ''}`,
  ...(p.description && p.description !== p.meta?.task ? [`description: ${p.description.replace(/\s+/g, ' ').slice(0, 600)}`] : []),
  `parameters: ${JSON.stringify(Object.fromEntries(Object.entries(p.meta?.params ?? {}).map(([k, d]) => [k, { type: d.type, description: d.description, ...(d.enum ? { enum: d.enum } : {}), ...(d.default !== undefined ? { default: d.default } : {}) }])))}`,
  `example request: ${JSON.stringify(p.firstRequest ?? '')}`,
  `example values: ${JSON.stringify(p.meta?.example ?? {})}`,
].join('\n');

/**
 * Finds a cached TaskLambda for `request`. `lambdas`: the loaded cache (only `verified` and `edited` ones with a meta are candidates).
 * `ask(messages)` -> {ok, text, ...} is the cheap tier. Returns a decision record:
 * {decision: 'reuse' | 'plan', reason, candidates: [{id, score}], bm25Ms, chosen, values, matchCall: {ms, tier, credits, ...}}.
 */
export async function matchLambda({ request, lambdas, ask, promptFile, k = 3, minScore = 0, grounded = true }) {
  const usable = lambdas.filter((p) => p.meta && (p.status === 'verified' || p.status === 'edited'));
  const t0 = performance.now();
  const index = buildIndex(usable.map(lambdaDoc));
  const candidates = index.search(request, { k, minScore });
  const bm25Ms = Math.round((performance.now() - t0) * 1000) / 1000;
  const base = { candidates, bm25Ms, indexed: usable.length };
  if (!candidates.length) return { ...base, decision: 'plan', reason: usable.length ? 'no cached TaskLambda shares a term with the request' : 'the cache has no verified TaskLambda' };
  const shown = candidates.map((c) => usable.find((p) => p.id === c.id));
  const system = fs.readFileSync(promptFile, 'utf8');
  const user = `SAVED TASKLAMBDAS:\n${shown.map(describe).join('\n\n')}\n\nNEW REQUEST:\n${request}`;
  const r = await ask([{ role: 'system', content: system }, { role: 'user', content: user }]);
  const matchCall = { ok: r.ok, ms: r.ms ?? null, tier: r.tier ?? null, served: r.served ?? null, credits: r.credits ?? null, usage: r.usage ?? null, cached: r.cached ?? false, reason: r.ok ? null : r.reason };
  if (!r.ok) return { ...base, matchCall, decision: 'plan', reason: `the match tier failed: ${r.reason}` };
  const j = jsonOf(r.text);
  const answer = { raw: String(r.text).slice(0, 1500), json: j };
  // {"lambda": id} (a reply in the older form {"plan": id} is read the same way).
  const key = j && 'lambda' in j ? 'lambda' : j && 'plan' in j ? 'plan' : null;
  if (!key) return { ...base, matchCall, answer, decision: 'plan', reason: 'the match reply holds no {"lambda": ...} object' };
  const named = j[key];
  if (named === null || named === 'null' || named === '') return { ...base, matchCall, answer, decision: 'plan', reason: `not the same task: ${String(j.reason ?? '').slice(0, 300)}` };
  const chosen = shown.find((p) => p.id === named) ?? (Number.isInteger(named) ? shown[named - 1] : null);
  if (!chosen) return { ...base, matchCall, answer, decision: 'plan', reason: `the match named ${JSON.stringify(named)}, not a candidate` };
  const values = coerceToSchema(chosen.meta.params, j.values ?? {});
  const v = validateParams(chosen.meta.params, values);
  if (!v.ok) return { ...base, matchCall, answer, chosen: chosen.id, decision: 'plan', reason: `the values do not fit ${chosen.id}'s schema: ${v.problems.join('; ')}` };
  const missing = grounded ? ungrounded(chosen.meta.params, v.params, request) : [];
  if (missing.length) return { ...base, matchCall, answer, chosen: chosen.id, values: v.params, decision: 'plan', reason: `values not found in the request: ${missing.join(', ')}` };
  return { ...base, matchCall, answer, chosen: chosen.id, status: chosen.status, values: v.params, decision: 'reuse', reason: String(j.reason ?? 'same task').slice(0, 300) };
}
