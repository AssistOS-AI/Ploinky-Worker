/**
 * Model calls: OpenAI format to the endpoint (`/v1/chat/completions` for a tier the endpoint serves, `/u/<upstream>/v1/...` for a
 * concrete upstream, as the Ploinky Workers server routes them), tagged with `x-pworker-purpose: job:<name>` and `x-pworker-run:
 * <run-id>` (headers only; an endpoint that ignores them still works), answered from a content-addressed cache when the same request
 * was paid before, and recorded in a ledger.
 */
import fs from 'node:fs';
import path from 'node:path';
import {sha256, writeJsonAtomic} from './util.mjs';

/** Content-addressed response cache: `<dir>/<k0k1>/<key>.json`, written once, never overwritten. */
export class ResponseCache {
  constructor(dir) { this.dir = dir; }
  /** The key covers the upstream, the model and the whole request body (prompt and input); `prompt`/`input` hashes are recorded for reading. */
  static key({upstream, body}) { return sha256({upstream, body}); }
  file(key) { return path.join(this.dir, key.slice(0, 2), `${key}.json`); }
  get(key) {
    const f = this.file(key);
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
  }
  put(key, entry) {
    const f = this.file(key);
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), {recursive: true});
    writeJsonAtomic(f, {key, created_at: new Date().toISOString(), ...entry});
  }
}

/** `upstream/model`, or `tier:<name>` for a tier the proxy serves. */
export const modelName = e => (e.upstream ? `${e.upstream}/${e.model}` : `tier:${e.model}`);

/** Calls, tokens, USD and plan credits per role and model, with cache hits apart. */
export class Ledger {
  constructor() { this.rows = {}; this.tiers = {}; }
  add(role, entry, r) {
    if (entry.tier && !r.failed && !r.cached) {
      const t = (this.tiers[entry.tier] ||= {usd: 0, credits: 0});
      t.usd += r.usd ?? 0; t.credits += r.credits ?? 0;
    }
    const k = `${role}\u0000${modelName(entry)}`;
    const row = (this.rows[k] ||= {role, model: modelName(entry), calls: 0, cache_hits: 0, failed: 0, in_tokens: 0, out_tokens: 0, usd: 0, credits: 0});
    if (r.failed) { row.failed += 1; return; }
    if (r.cached) { row.cache_hits += 1; return; }
    row.calls += 1;
    row.in_tokens += r.usage?.in ?? 0; row.out_tokens += r.usage?.out ?? 0;
    row.usd += r.usd ?? 0; row.credits += r.credits ?? 0;
  }
  total() {
    const t = {calls: 0, cache_hits: 0, failed: 0, in_tokens: 0, out_tokens: 0, usd: 0, credits: 0};
    for (const r of Object.values(this.rows)) for (const k of Object.keys(t)) t[k] += r[k];
    return t;
  }
  toJSON() { return {total: this.total(), rows: Object.values(this.rows), tiers: this.tiers}; }
}

/** A refusal by the proxy (budget exhausted, purpose not allowed): the run stops. */
export class RefusedError extends Error {
  constructor(status, body) { super(`the proxy refused the call (${status}): ${body?.error?.type ?? ''} ${body?.error?.message ?? ''}`.trim()); this.status = status; this.type = body?.error?.type ?? null; }
}
const REFUSALS = new Set(['budget_exceeded', 'purpose_not_allowed', 'untagged_limit', 'run_unknown', 'run_finished']);

/** The OpenAI-format body of one call. */
export function requestBody(entry, messages) {
  const body = {model: entry.model, messages, temperature: entry.temperature ?? 0, max_tokens: entry.maxTokens ?? 4000};
  if (entry.reasoning === 'off') body.reasoning = {enabled: false};
  else if (entry.reasoning && entry.reasoning !== 'default') body.reasoning = {effort: entry.reasoning};
  return {...body, ...(entry.extraBody ?? {})};
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Returns `call({entry, messages, role})` -> `{ok, text, finish, usage, usd, credits, cached, ms, error}`. Transient failures (network,
 * 5xx, 429) are retried `retries` times; a proxy refusal throws RefusedError. `onResult(role, entry, result)` sees every result (the
 * models.jsonl of the job's TaskLambdaCall).
 */
export function makeCaller({proxy, job, run, cache = null, ledger = new Ledger(), fetchImpl = fetch, refresh = false, retries = 2, backoffMs = 2000, timeoutMs = 600_000, purpose = null, proxyFallback = true, priority = null, onResult = null}) {
  const base = String(proxy).replace(/\/+$/, '');
  const common = {'content-type': 'application/json', 'x-client-name': `job-${job}`.slice(0, 40), 'x-pworker-purpose': purpose ?? `job:${job}`, 'x-pworker-run': run, ...(priority ? {'x-pworker-priority': priority} : {})};
  return async function call({entry, messages, role = 'work'}) {
    // A concrete chain is walked here, so the proxy must not substitute; a proxy tier walks its own chain unless the job forbids it.
    const headers = entry.viaProxyTier && proxyFallback ? common : {...common, 'x-pworker-no-fallback': '1'};
    const body = requestBody(entry, messages);
    const key = ResponseCache.key({upstream: entry.upstream ?? 'tier', body});
    if (cache && !refresh) {
      const hit = cache.get(key);
      if (hit?.response) { const r = {...hit.response, ok: true, cached: true, ms: 0, key}; ledger.add(role, entry, r); onResult?.(role, entry, r); return r; }
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await sleep(backoffMs * 4 ** (attempt - 1));
      const t0 = Date.now();
      let res, text;
      try {
        res = await fetchImpl(`${base}${entry.upstream ? `/u/${encodeURIComponent(entry.upstream)}` : ''}/v1/chat/completions`, {method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(entry.timeoutMs ?? timeoutMs)});
        text = await res.text();
      } catch (e) { lastErr = `unreachable: ${e.message}`; continue; }
      let j = null;
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      if (res.status === 402 || res.status === 403) {
        if (REFUSALS.has(j?.error?.type)) throw new RefusedError(res.status, j);
      }
      if (res.status === 429 || res.status >= 500) { lastErr = `status ${res.status}: ${text.slice(0, 200)}`; continue; }
      const choice = j?.choices?.[0];
      if (!res.ok || !choice) { lastErr = `status ${res.status}: ${text.slice(0, 200)}`; break; }
      const credits = Number(res.headers.get('x-quota-cost'));
      const served = res.headers.get('x-pworker-model') ?? res.headers.get('x-pworker-fallback') ?? null;
      const r = {ok: true, cached: false, key, served, text: String(choice.message?.content ?? ''), finish: choice.finish_reason ?? null, ms: Date.now() - t0,
        usage: {in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0, reasoning: j.usage?.completion_tokens_details?.reasoning_tokens ?? 0},
        usd: j.usage?.cost ?? null, credits: Number.isFinite(credits) && res.headers.get('x-quota-cost') != null ? credits : null};
      ledger.add(role, entry, r);
      onResult?.(role, entry, r);
      if (cache) cache.put(key, {upstream: entry.upstream, model: entry.model, prompt_hash: sha256(messages.filter(m => m.role === 'system')), input_hash: sha256(messages.filter(m => m.role !== 'system')),
        response: {text: r.text, finish: r.finish, usage: r.usage, usd: r.usd, credits: r.credits, served}});
      return r;
    }
    const r = {ok: false, failed: true, error: lastErr, text: '', cached: false};
    ledger.add(role, entry, r);
    onResult?.(role, entry, r);
    return r;
  };
}

/** Tries a model chain in order on call failure; returns the first answer with the entry that gave it. */
export async function callChain(call, chain, messages, role) {
  const errors = [];
  for (const entry of chain) {
    const r = await call({entry, messages, role});
    if (r.ok) return {...r, entry, chain_errors: errors};
    errors.push(`${modelName(entry)}: ${r.error}`);
  }
  return {ok: false, failed: true, error: errors.join(' | '), entry: null, chain_errors: errors};
}
