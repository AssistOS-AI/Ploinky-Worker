// Ploinky Workers core: routing by tier, forwarding (JSON and SSE), rate and plan limits, 429/5xx retry and fallback, usage extraction,
// the request log, the response cache, the audit store, job budgets and the purpose policy, local model servers and prompted JSON
// tiers. `createCore` builds the request handler (`handle(req, res)`, node:http shaped); the server (server.mjs) mounts it on a port
// and the in-process transport (inproc.mjs) calls it without a socket, so both paths have exactly the same semantics.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Limiter } from './limiter.mjs';
import { Monitor, pickRateHeaders, redact, RATE_HEADER } from './monitor.mjs';
import { DASHBOARD_HTML } from './dashboard.mjs';
import { resolveUpstream } from './settings.mjs';
import { planReport, valueReport, limitWait } from './plan.mjs';
import { planRequests } from './monitor.mjs';
import { createLocalStarter, stopPeers } from './local.mjs';
import { createAudit, responseText } from './audit.mjs';
import { createCache, localIdentity, CACHE_MODES, answerComplete } from './cache.mjs';
import { expandHome } from './settings.mjs';
import { isAbsolute } from 'node:path';
import { createJobGuard } from './guard.mjs';
import { httpFetch } from './http-fetch.mjs';
import { loadTemplate, serveprompted } from './prompted.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const FORWARD_REQ = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta'];
const MAX_BODY = 512 * 1024 * 1024;

export function extractUsage(fmt, obj) {
  // Returns {in, out, cached} from an OpenAI or Anthropic usage object (or a stream event), or null.
  const u = obj?.usage || obj?.message?.usage;
  if (!u) return null;
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0;
  const inT = u.prompt_tokens ?? u.input_tokens;
  const out = u.completion_tokens ?? u.output_tokens;
  return { in: inT, out, cached, creation: u.cache_creation_input_tokens, usd: u.cost ?? null };
}

function mergeUsage(acc, u) {
  if (!u) return acc;
  const r = acc || {};
  if (u.in != null) r.in = u.in;
  if (u.out != null) r.out = u.out;
  if (u.cached) r.cached = u.cached;
  if (u.usd != null) r.usd = u.usd;
  return r;
}

/** The core plus a node:http server around it (the proxy of earlier versions; tests and `pworker serve` use it). */
export function createProxy(options) {
  const core = createCore(options);
  core.boot();
  const server = http.createServer(core.handle);
  server.requestTimeout = 0; server.headersTimeout = 30_000; server.keepAliveTimeout = 5_000;
  return { ...core, server };
}

/**
 * `config`: the Ploinky Workers configuration (providers, tiers, limits, cache, audit, policy, interactive); `configDir`: the folder relative
 * paths of the configuration resolve against (baseDir, promptsDir); `env`: where secrets are read when the env files lack them.
 */
export function createCore({ config, configDir = HERE, env = process.env, dataDir, proxyToken = null, fetchImpl = httpFetch, auditDir = null, cacheDir = null, starterOptions = {}, routes = null }) {
  config = normalizeConfig(config);
  const upstreams = {};
  const limiters = {};
  const starters = {}; // local model servers (llama-server or a script service), started on demand or at boot
  const baseDir = resolve(configDir, config.baseDir || '.');
  for (const [name, up] of Object.entries(config.upstreams)) {
    upstreams[name] = resolveUpstream(name, up, env);
    limiters[name] = new Limiter(up.limits);
    if (up.start) starters[name] = createLocalStarter(upstreams[name], { fetchImpl, baseDir, ...(config.logDir ? { logDir: resolve(configDir, expandHome(config.logDir)) } : {}), beforeStart: () => stopPeers(name, starters, config.upstreams), ...starterOptions });
  }
  const audit = createAudit(config.audit, { dir: auditDir || (config.auditDir ? resolve(configDir, expandHome(config.auditDir)) : dataDir.replace(/\/+$/, '') + '-audit') });
  const cache = createCache({ dir: cacheDir || (config.cacheDir ? resolve(configDir, expandHome(config.cacheDir)) : dataDir.replace(/\/+$/, '') + '-cache') });
  // What serves a target: a tier's first chain entry (and a local GGUF's size and mtime); an upstream and the requested model.
  const identityOf = (upstreamName, model) => {
    const u = config.upstreams[upstreamName];
    const file = (p) => { const e = expandHome(p); return isAbsolute(e) ? e : join(baseDir, e); };
    // A local GGUF, or the weight files a script upstream names in start.identity (the small-model service's ONNX graphs).
    const files = [u?.start?.gguf, ...(u?.start?.identity || [])].filter(Boolean).map(file);
    return `${upstreamName}/${model}${files.length ? '@' + files.map(localIdentity).join(',') : ''}`;
  };
  const secrets = [...Object.values(upstreams).map((u) => u.key), proxyToken].filter(Boolean);
  const monitor = new Monitor({ dataDir, secrets });
  const modelCache = {}; // upstream -> {at, list, byId}
  const allModels = () => Object.assign({}, ...Object.values(modelCache).map((c) => c.byId));
  const creditBalanceModels = (up) => new Set([...(up.creditBalanceModels ?? []), ...monitor.creditModels()]);
  // Job budgets and the purpose policy (jobs.mjs): money is the provider-reported USD, plan use is credits of plan upstreams.
  const guard = createJobGuard({ config: config.policy, dataDir, records: () => monitor.records,
    costOf: (r) => ({ usd: r.usd ?? 0, credits: upstreams[r.upstream]?.plan ? planRequests(allModels()[r.model], r) : 0 }) });

  const backgroundShare = config.background?.share ?? 0.7;
  for (const l of Object.values(limiters)) l.backgroundShare = backgroundShare;
  // Rebuild what the queue needs from the logs (the monitor has already reloaded the records) and gate on plan limits.
  const since = Date.now() - 3600_000;
  for (const [name, up] of Object.entries(upstreams)) {
    limiters[name].seed(monitor.records.filter((r) => r.upstream === name && r.t > since).map((r) => r.t));
    if (up.plan?.limits?.length) {
      limiters[name].gate = (job, active) => limitWait({ upstream: name, limits: up.plan.limits, records: monitor.records, models: allModels(), now: Date.now(), job: job?.meta, active,
        share: job?.meta?.background ? backgroundShare : 1 });
    }
  }

  async function getModels(up) {
    const c = modelCache[up.name];
    const ttl = (config.modelsCacheSeconds ?? 600) * 1000;
    if (c && Date.now() - c.at < ttl) return c;
    try {
      const r = await fetchImpl(up.baseUrl + (up.modelsPath || '/v1/models'), { headers: { accept: 'application/json', ...(up.key ? { authorization: `Bearer ${up.key}` } : {}) }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error('models status ' + r.status);
      const list = await r.json();
      const byId = Object.fromEntries((list.data || []).map((m) => [m.id, m]));
      return (modelCache[up.name] = { at: Date.now(), list, byId });
    } catch (e) {
      if (c) return c; // stale beats nothing
      throw e;
    }
  }
  function pickUpstream(url) {
    const m = /^\/u\/([^/]+)(\/.*)$/.exec(url.pathname);
    if (m && upstreams[m[1]]) return { up: upstreams[m[1]], path: m[2] };
    return { up: upstreams[config.defaultUpstream], path: url.pathname };
  }

  function authorized(req, url) {
    if (!proxyToken || req.trusted === true) return true; // the in-process transport is the server itself
    const h = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || url.searchParams.get('token');
    return h === proxyToken;
  }

  const sendJson = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  };

  async function readBody(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new Error('body too large'); chunks.push(c); }
    return Buffer.concat(chunks);
  }

  // Fallback (config.fallback): when the default upstream is unavailable, a request for a mapped model goes to another
  // upstream and model. Unavailable: unreachable or 5xx after retry.max5xx retries, 429 after retry.max retries or with a
  // retry-after beyond fallback.maxWaitMs, or a queue/plan-gate wait beyond fallback.maxWaitMs. A client opts out with the
  // header `x-pworker-no-fallback: 1` (runs that must stay on one model, e.g. calibrations).
  const fb = config.fallback || null;
  const noFallback = (req) => { const v = String(req.headers['x-pworker-no-fallback'] || '').toLowerCase(); return !!v && v !== '0' && v !== 'false'; };
  function fallbackFor(up, path, model, req, ctx) {
    if (ctx.tier) { // a tier request falls back down its own chain
      const next = ctx.chain?.[0];
      if (!next || noFallback(req)) return null;
      return { up: upstreams[next.upstream], model: next.model, entry: next, rest: ctx.chain.slice(1), maxWaitMs: config.tiers?.maxWaitMs, timeoutMs: next.timeoutMs ?? null };
    }
    if (!fb?.upstream || ctx.fallback || !model) return null;
    if (up.name !== (fb.from || config.defaultUpstream)) return null;
    if (noFallback(req)) return null;
    const target = fb.models?.[model];
    const fup = upstreams[fb.upstream];
    if (!target || !fup || !fup.key) return null;
    if (!Object.values(fup.formats || { openai: '/v1/chat/completions' }).includes(path)) return null;
    return { up: fup, model: target };
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /**
   * The request body for one chain entry: the entry's `extraBody` fills fields the caller did not set (a model's own switches, e.g.
   * reasoning off for a reasoning model that falls back for a non-reasoning one), and `minTokens` raises a smaller max_tokens, so a
   * fallback model never spends a short question's budget thinking (the cut answers of 2026-10-03).
   */
  function entryBody(body, entry) {
    if (!entry || !body || typeof body !== 'object') return body;
    const out = { ...(entry.extraBody || {}), ...body };
    if (entry.minTokens && out.max_tokens != null && out.max_tokens < entry.minTokens) out.max_tokens = entry.minTokens;
    return out;
  }
  const matches = (list, purpose) => (list || []).some((p) => (p.endsWith('*') ? String(purpose || '').startsWith(p.slice(0, -1)) : purpose === p));
  /** 0 interactive, 1 normal, 2 background: the header x-pworker-priority first, else the purpose lists of the configuration. */
  function priorityOf(req, purpose) {
    const h = String(req.headers['x-pworker-priority'] || '').toLowerCase();
    if (h === 'background') return 2;
    if (h === 'interactive') return 0;
    if (h === 'normal') return 1;
    if (matches(config.background?.purposes, purpose)) return 2;
    return config.interactive && matches(config.interactive.purposes, purpose) ? 0 : 1;
  }

  // Tiers (config.tiers): a client asks for `model: "<tier>"` (tiny, small, medium, good, best) on the default path and never for
  // a concrete model. A tier is a chain of {upstream, model} (or the name of another tier); the first entry whose upstream is
  // configured (with a key, unless it needs none) serves the request and the rest is its fallback chain. A tier with no usable
  // entry is an error that names the tier; nothing is substituted silently.
  const TIER_NAMES = ['tiny', 'small', 'medium', 'good', 'best'];
  const tierDefs = Object.fromEntries(Object.entries(config.tiers || {}).filter(([k]) => !k.startsWith('_') && k !== 'maxWaitMs'));
  const usable = (e) => upstreams[e.upstream] && (upstreams[e.upstream].key || upstreams[e.upstream].noKey);
  function tierChain(name, seen = new Set()) {
    const def = tierDefs[name];
    if (def == null || seen.has(name)) return null;
    seen.add(name);
    if (typeof def === 'string') return tierChain(def, seen);
    return Array.isArray(def) ? def : null;
  }
  function resolveTier(name) {
    const chain = tierChain(name);
    if (!chain || !chain.length) return { error: `tier "${name}" is not configured` };
    const ok = chain.filter(usable);
    if (!ok.length) return { error: `tier "${name}" has no usable upstream (configured: ${chain.map((e) => `${e.upstream}/${e.model}`).join(', ')})` };
    return { first: ok[0], rest: ok.slice(1), skipped: chain.slice(0, chain.indexOf(ok[0])) };
  }
  const isTier = (m) => typeof m === 'string' && (TIER_NAMES.includes(m) || Object.hasOwn(tierDefs, m));
  function tierList() {
    return [...new Set([...TIER_NAMES, ...Object.keys(tierDefs)])].map((id) => {
      const t = resolveTier(id);
      const name = (e) => `${e.upstream}/${e.model}${e.prompt ? `+${e.prompt}` : ''}`;
      return { id, object: 'model', x_tier: t.error ? { error: t.error } : { serves: name(t.first), fallback: t.rest.map(name) } };
    });
  }

  async function forward(req, res, up, path, body, ctx = {}) {
    const limiter = limiters[up.name];
    const retry = up.retry || { max: 3, baseMs: 1000, maxWaitMs: 60000 };
    const max5xx = retry.max5xx ?? 0;
    const format = path === (up.formats?.anthropic || '/v1/messages') ? 'anthropic' : 'openai';
    const client = (req.headers['x-client-name'] || (req.headers['user-agent'] || 'unknown').split(/[\s/]/)[0]).toString().slice(0, 40);
    const tag = (h) => (req.headers[h] ? String(req.headers[h]).slice(0, 120) : undefined);
    const purpose = tag('x-pworker-purpose'), run = tag('x-pworker-run');

    let parsed = null;
    try { parsed = JSON.parse(body.toString('utf8')); } catch { /* not JSON: forwarded as is */ }
    const stream = !!parsed?.stream;
    const model = parsed?.model ?? null;
    let outBody = body;
    if (parsed && stream && format === 'openai' && config.injectStreamUsage !== false && !parsed.stream_options?.include_usage) {
      parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
      outBody = Buffer.from(JSON.stringify(parsed));
    }
    const est = parsed ? Math.round(JSON.stringify(parsed.messages ?? '').length / 4) : null;
    const abort = ctx.abort || new AbortController();
    if (!ctx.abort) res.on('close', () => { if (!res.writableEnded) abort.abort(); });
    const fbk = fallbackFor(up, path, model, req, ctx);
    // Interactive purposes (config.interactive: chat, formalize, answer-*) go to the front of the queue and fall back after a
    // short wait, so a person is not kept waiting behind batch jobs.
    // Background work (header x-pworker-priority: background, or a purpose in config.background.purposes) runs only when nothing
    // else waits and, on a plan upstream, only while the plan keeps its headroom (config.background.share); it is held, never refused,
    // and never falls back because of a wait.
    const inter = config.interactive || null;
    const priority = priorityOf(req, purpose);
    const interactive = priority === 0;
    const background = priority === 2;
    const fbWait = background ? Infinity : (interactive && inter?.maxWaitMs != null) ? inter.maxWaitMs : ((fbk && 'rest' in fbk ? fbk.maxWaitMs : fb?.maxWaitMs) ?? retry.maxWaitMs);
    // A request duration cap (per tier entry `timeoutMs`, else per upstream `timeoutMs`): a model that ignores its token budget is cut
    // off, the cut is reported (504 upstream_timeout, never cached) and the request falls back down its chain when it has one.
    const timeoutMs = ctx.timeoutMs ?? up.timeoutMs ?? null;
    const fallBack = (reason, kind) => forward(req, res, fbk.up, path, Buffer.from(JSON.stringify(entryBody({ ...parsed, model: fbk.model }, fbk.entry))),
      { abort, fallback: { from: up.name, model: ctx.fallback?.model && ctx.tier ? ctx.fallback.model : model, reason, kind }, tier: ctx.tier, chain: fbk.rest, timeoutMs: fbk.timeoutMs ?? null });
    const extraHeaders = {
      ...(ctx.fallback ? { 'x-pworker-fallback': `${up.name}/${model}`, 'x-pworker-fallback-reason': ctx.fallback.kind } : {}),
      ...(ctx.tier ? { 'x-pworker-tier': ctx.tier, 'x-pworker-model': `${up.name}/${model}` } : {}),
    };
    const fbFields = {
      ...(ctx.fallback ? { fallback_from: ctx.fallback.from, fallback_model: ctx.fallback.model, fallback_reason: ctx.fallback.reason, fallback_kind: ctx.fallback.kind } : {}),
      ...(ctx.tier ? { tier: ctx.tier } : {}),
      ...(purpose ? { purpose } : {}), ...(run ? { run } : {}), ...(req.untaggedRequest ? { untagged: true } : {}),
    };
    const auditing = !!audit && audit.wants({ tier: ctx.tier, upstream: up.name });
    if (model && creditBalanceModels(up).has(model)) {
      const reason = `model ${model} requires a provider credit balance and is excluded from plan-backed tiers`;
      const rec = { id: randomUUID().slice(0, 8), upstream: up.name, client, endpoint: path, format, model, stream, attempt: 1, status: 402, error: reason, credit_billed: true, ...fbFields };
      if (fbk) {
        rec.fallback_to = `${fbk.up.name}/${fbk.model}`;
        monitor.log(rec);
        return fallBack(reason, 'credit_balance');
      }
      monitor.log(rec);
      return sendJson(res, 402, { error: { type: 'credit_balance_required', message: reason } }, extraHeaders);
    }
    if (starters[up.name] && !(await starters[up.name].ensure())) {
      const why = `local server unavailable: ${starters[up.name].status().last_refusal?.reason ?? 'not healthy'}`;
      monitor.log({ id: randomUUID().slice(0, 8), upstream: up.name, client, endpoint: path, format, model, stream, attempt: 1, status: 503, error: why, ...fbFields, ...(fbk ? { fallback_to: `${fbk.up.name}/${fbk.model}` } : {}) });
      if (fbk) return fallBack(why, 'unavailable');
      return sendJson(res, 503, { error: { type: 'local_unavailable', message: why } }, extraHeaders);
    }

    let n5xx = 0, n429 = 0;
    for (let attempt = 1; ; attempt++) {
      const mEntry = allModels()[model];
      const cost = monitor.creditModels().has(model) ? 0 : mEntry ? planRequests(mEntry, { status: 200, in_tokens: est || 0, format }) : 1;
      if (fbk) {
        const w = limiter.estimateWait({ cost, background }, priority);
        if (w.wait > fbWait) return fallBack(`wait ${w.wait} ms > ${fbWait} ms: ${w.reason}`, 'wait');
      }
      const outcome = await limiter.schedule(async ({ queueWaitMs }) => {
        const t0 = Date.now();
        const rec = { id: randomUUID().slice(0, 8), upstream: up.name, client, endpoint: path, format, model, stream, attempt, queue_wait_ms: queueWaitMs, req_bytes: Buffer.byteLength(outBody), est_in_tokens: est, ...fbFields };
        const headers = {};
        for (const h of FORWARD_REQ) if (req.headers[h]) headers[h] = req.headers[h];
        headers['content-type'] ||= 'application/json';
        const auth = up.key || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (auth) headers.authorization = 'Bearer ' + auth;
        let r;
        try {
          const upstreamPath = path === '/v1/chat/completions' ? (up.formats?.openai ?? path) : path;
          r = await fetchImpl(up.baseUrl + upstreamPath, { method: 'POST', headers, body: outBody, signal: timeoutMs ? AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]) : abort.signal });
        } catch (e) {
          Object.assign(rec, { status: 502, latency_ms: Date.now() - t0, error: 'upstream unreachable: ' + (e.cause?.code || e.message) });
          if (abort.signal.aborted) { monitor.log(rec); return { done: true }; }
          if (timeoutMs && e?.name === 'TimeoutError') {
            Object.assign(rec, { status: 504, error: `upstream timeout: no answer within ${timeoutMs} ms (cut by the duration cap; not cached)` });
            if (fbk) { rec.fallback_to = `${fbk.up.name}/${fbk.model}`; monitor.log(rec); return { fallback: rec.error, kind: 'timeout' }; }
            monitor.log(rec);
            if (!res.headersSent) sendJson(res, 504, { error: { type: 'upstream_timeout', message: rec.error } }, extraHeaders);
            return { done: true };
          }
          if (n5xx < max5xx) { rec.will_retry = true; monitor.log(rec); return { retry5xx: true }; }
          if (fbk) { rec.fallback_to = `${fbk.up.name}/${fbk.model}`; monitor.log(rec); return { fallback: rec.error, kind: 'unreachable' }; }
          monitor.log(rec);
          if (!res.headersSent) sendJson(res, 502, { error: { type: 'proxy_error', message: rec.error } }, extraHeaders);
          return { done: true };
        }
        rec.rate_headers = pickRateHeaders(r.headers);
        rec.status = r.status;
        const ctype = r.headers.get('content-type') || '';

        if (r.status === 429) {
          const ra = Number(r.headers.get('retry-after'));
          const want = Number.isFinite(ra) && ra > 0 ? ra * 1000 : retry.baseMs * 2 ** n429;
          const canRetry = n429 < retry.max;
          const fbNow = fbk && !abort.signal.aborted && (!canRetry || want > fbWait);
          if (canRetry || fbNow) {
            const text = await r.text().catch(() => '');
            Object.assign(rec, { latency_ms: Date.now() - t0, res_bytes: text.length, error: text, will_retry: !fbNow });
            if (fbNow) rec.fallback_to = `${fbk.up.name}/${fbk.model}`;
            monitor.log(rec);
            limiter.pause(Math.min(retry.maxWaitMs, want));
            return fbNow ? { fallback: `429 (wait ${Math.round(want)} ms, after ${n429} retries)`, kind: '429' } : { retry: true };
          }
        }
        if (r.status >= 500 && !abort.signal.aborted && (n5xx < max5xx || fbk)) {
          const text = await r.text().catch(() => '');
          Object.assign(rec, { latency_ms: Date.now() - t0, res_bytes: text.length, error: text || 'status ' + r.status });
          if (n5xx < max5xx) { rec.will_retry = true; monitor.log(rec); return { retry5xx: true }; }
          rec.fallback_to = `${fbk.up.name}/${fbk.model}`;
          monitor.log(rec);
          return { fallback: `status ${r.status} after ${n5xx} retries`, kind: '5xx' };
        }

        const out = { 'content-type': ctype || 'application/json', 'cache-control': 'no-store', ...extraHeaders, ...(ctx.cacheKey ? { 'x-pworker-cache-key': ctx.cacheKey } : {}) };
        for (const [k, v] of r.headers) if (RATE_HEADER.test(k)) out[k] = v;
        res.writeHead(r.status, out);
        let usage = null, bytes = 0, ttft = null, errText = '', buf = '', tail = '';
        const isSse = ctype.includes('text/event-stream');
        const onLine = (line) => {
          if (!line.startsWith('data:')) return;
          const d = line.slice(5).trim();
          if (!d || d === '[DONE]') return;
          try { usage = mergeUsage(usage, extractUsage(format, JSON.parse(d))); } catch { /* ignore */ }
        };
        try {
          for await (const chunk of r.body ?? []) {
            if (ttft == null) ttft = Date.now() - t0;
            bytes += chunk.length;
            res.write(chunk);
            const s = Buffer.from(chunk).toString('utf8');
            if (isSse) {
              if (auditing && tail.length < 16 * 1024 * 1024) tail += s;
              buf += s; let i;
              while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
            } else if (bytes <= 16 * 1024 * 1024) tail += s;
          }
          if (isSse && buf) onLine(buf);
        } catch (e) {
          rec.error = 'stream interrupted: ' + (e.message || e);
        }
        res.end();
        if (!isSse) {
          try { usage = extractUsage(format, JSON.parse(tail)); } catch { /* not JSON */ }
          if (r.status >= 400) errText = tail;
        } else if (r.status >= 400) errText = buf;
        Object.assign(rec, {
          latency_ms: Date.now() - t0, ttft_ms: stream ? ttft : null, res_bytes: bytes,
          in_tokens: usage?.in ?? null, out_tokens: usage?.out ?? null, cached_tokens: usage?.cached ?? 0, usd: usage?.usd ?? null,
        });
        if (r.status >= 400) rec.error = errText || rec.error;
        const num = (h) => { const v = Number(r.headers.get(h)); return r.headers.get(h) != null && Number.isFinite(v) ? v : null; };
        rec.quota_remaining = num('x-quota-remaining'); rec.quota_cost = num('x-quota-cost'); rec.credit_cost = num('x-credit-cost');
        if (r.status >= 400 && /billed from your credit balance|credit balance/i.test(errText)) rec.credit_billed = true;
        if (rec.credit_billed && fbk) {
          rec.fallback_to = `${fbk.up.name}/${fbk.model}`;
          monitor.log(rec);
          return { fallback: rec.error || 'provider credit balance required', kind: 'credit_balance' };
        }
        monitor.log(rec);
        if (auditing) { try { audit.record(rec, parsed, responseText(format, isSse, tail)); } catch { /* the audit never breaks a request */ } }
        // A cut or empty answer is never cached (finish_reason length / max_tokens, or no content): a retry with a larger budget must reach the model.
        // A JSON endpoint that is not a chat format (the structure and formalizer tiers) is complete when it is JSON without an error.
        const chatPath = Object.entries(up.formats || { openai: '/v1/chat/completions' }).some(([k, v]) => (k === 'openai' || k === 'anthropic') && v === path);
        const complete = answerComplete(tail, { chat: chatPath, format });
        if (ctx.cacheKey && !isSse && r.status === 200 && !rec.error && complete) { try { cache.put(ctx.cacheKey, { body: tail, content_type: ctype || 'application/json', served: `${up.name}/${model}`, tier: ctx.tier ?? null }); } catch { /* the cache never breaks a request */ } }
        return { done: true };
      }, { cost, background }, priority);
      if (outcome.fallback) return fallBack(outcome.fallback, outcome.kind);
      if (outcome.retry5xx) { n5xx += 1; await sleep(retry.baseMs * 2 ** (n5xx - 1)); continue; }
      if (!outcome.retry) return;
      n429 += 1;
    }
  }

  // Prompted JSON tiers (prompted.mjs): a tier entry with `prompt` serves /v1/structure or /v1/fol with a chat upstream and a template
  // from promptsDir; every chat call goes through forward() (queued, logged, tagged with the tier), the JSON answer is cached as usual.
  const promptsDir = resolve(configDir, config.promptsDir || 'prompts');
  async function servePromptedTier(req, res, { tier, entry, up, path, body, cacheKey }) {
    if (!body || (path === '/v1/structure' && (typeof body.text !== 'string' || !body.text.trim())) || (path === '/v1/fol' && (!Array.isArray(body.inputs) || !body.inputs.length || !body.inputs.every((x) => typeof x === 'string'))))
      return sendJson(res, 400, { error: { type: 'invalid_request', message: path === '/v1/fol' ? 'inputs must be a non-empty list of sentences' : 'text must be a non-empty string' } });
    let template;
    try { template = loadTemplate(promptsDir, entry.prompt); } catch (e) { return sendJson(res, 500, { error: { type: 'tier_unavailable', message: e.message } }); }
    const chat = async (messages, { temperature, maxTokens }) => {
      const cap = { status: 0, chunks: [], headersSent: false, writableEnded: false, on() {}, writeHead(st) { this.status = st; this.headersSent = true; }, write(c) { this.chunks.push(Buffer.from(c)); }, end(c) { if (c) this.chunks.push(Buffer.from(c)); this.writableEnded = true; } };
      const b = Buffer.from(JSON.stringify({ model: entry.model, messages, temperature, max_tokens: maxTokens, ...(entry.extraBody || {}) }));
      await forward(req, cap, up, '/v1/chat/completions', b, { tier, chain: [], abort: new AbortController() });
      const raw = Buffer.concat(cap.chunks).toString('utf8');
      try {
        const j = JSON.parse(raw);
        if (cap.status !== 200) return { ok: false, status: cap.status, error: j.error?.message || raw.slice(0, 200) };
        const u = j.usage || {}, m = j.choices?.[0]?.message || {};
        return { ok: true, text: m.content ?? '', finish: j.choices?.[0]?.finish_reason ?? null,
          usage: { output_tokens: u.completion_tokens ?? 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? null, reasoning_chars: (m.reasoning_content || '').length, content_chars: String(m.content ?? '').length } };
      }
      catch { return { ok: false, status: cap.status || 502, error: raw.slice(0, 200) }; }
    };
    const r = await serveprompted({ path, body, entry, template, chat });
    const served = `${up.name}/${entry.model}+${entry.prompt}`;
    if (r.status === 200 && cacheKey) { try { cache.put(cacheKey, { body: JSON.stringify(r.body), content_type: 'application/json', served, tier }); } catch { /* the cache never breaks a request */ } }
    return sendJson(res, r.status, r.body, { 'x-pworker-tier': tier, 'x-pworker-model': served });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, uptime_s: Math.round(process.uptime()), fallback: fb ? { from: fb.from || config.defaultUpstream, upstream: fb.upstream, models: fb.models, maxWaitMs: fb.maxWaitMs ?? null } : null, tiers: tierList(), upstreams: Object.fromEntries(Object.values(upstreams).map((u) => [u.name, { base_url: u.baseUrl, key_configured: !!u.key, on_demand: !!u.start, queue_depth: limiters[u.name].depth }])) });
      }
      if (!authorized(req, url)) return sendJson(res, 401, { error: { type: 'authentication_error', message: 'invalid token' } });
      if (req.method === 'GET' && url.pathname === '/v1/local') return sendJson(res, 200, await localStatus());
      const lm = /^\/v1\/local\/([^/]+)\/(start|stop)$/.exec(url.pathname);
      if (req.method === 'POST' && lm) { const r = await localAction(decodeURIComponent(lm[1]), lm[2]); return sendJson(res, r.error ? 404 : 200, r.error ? { error: { type: 'not_found', message: r.error } } : r); }
      // The server's own endpoints (TaskLambdas, jobs, tasks, run-lambdas, operations, calls): server.mjs.
      if (routes && (await routes(req, res, url, { sendJson, readJson: async (r) => { try { return JSON.parse((await readBody(r)).toString('utf8')); } catch { return null; } } })) !== false) return;
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(DASHBOARD_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        const info = Object.fromEntries(Object.entries(limiters).map(([n, l]) => [n, { depth: l.depth, queued: l.queued(), held_reason: l.queue.length ? l.gateReason : null, active: l.active, pausedUntil: l.pausedUntil, gateReason: l.gateReason, limits: { maxConcurrent: l.maxConcurrent, maxPerSecond: l.maxPerSecond, maxPerMinute: l.maxPerMinute, maxPerHour: l.maxPerHour } }]));
        for (const u of Object.values(upstreams)) await getModels(u).catch(() => {});
        const models = allModels(), now = Date.now();
        const st = monitor.stats(info, models);
        st.plan = {}; st.value = {};
        for (const u of Object.values(upstreams)) {
          if (!u.plan?.limits) continue;
          st.plan[u.name] = planReport({ upstream: u.name, plan: u.plan, records: monitor.records, models, now });
          st.value[u.name] = valueReport({ upstream: u.name, plan: u.plan, compare: config.compare, records: monitor.records, models, creditModels: monitor.creditModels(), now });
        }
        const day = monitor.records.filter((r) => r.t > now - 86400000);
        const group = (key) => { const g = {}; for (const r of day) { const k = r[key] || '-'; const e = (g[k] ??= { calls: 0, errors: 0, fallbacks: 0, in_tokens: 0, out_tokens: 0, usd: 0 }); e.calls += 1; if (r.status >= 400) e.errors += 1; if (r.fallback_from) e.fallbacks += 1; e.in_tokens += r.in_tokens || 0; e.out_tokens += r.out_tokens || 0; e.usd += r.usd || 0; } return g; };
        st.last24h = { by_tier: group('tier'), by_purpose: group('purpose'), by_upstream: group('upstream') };
        st.tiers = tierList();
        st.audit = audit ? audit.stats() : null;
        st.cache = cache.stats();
        st.local = Object.fromEntries(Object.entries(starters).map(([n, s]) => [n, s.status()]));
        st.jobs = guard.stats();
        return sendJson(res, 200, st);
      }
      if (url.pathname.startsWith('/jobs')) {
        if (req.method === 'GET' && url.pathname === '/jobs') return sendJson(res, 200, guard.stats());
        if (req.method === 'POST' && (url.pathname === '/jobs/register' || url.pathname === '/jobs/finish')) {
          let b = null;
          try { b = JSON.parse((await readBody(req)).toString('utf8')); } catch { /* reported below */ }
          const r = url.pathname === '/jobs/register' ? guard.register(b) : guard.finish(b);
          return sendJson(res, r.error ? 400 : 200, r.error ? { error: { type: 'invalid_request', message: r.error } } : r);
        }
      }
      const { up, path } = pickUpstream(url);
      if (req.method === 'GET' && path === '/v1/models') {
        try {
          const list = (await getModels(up)).list;
          const credit = creditBalanceModels(up);
          const tiers = up.name === config.defaultUpstream && !url.pathname.startsWith('/u/') ? tierList() : [];
          return sendJson(res, 200, { ...list, data: [...(list.data || []).map((m) => ({ ...m, x_billing: credit.has(m.id) ? 'credit' : 'plan_or_unknown' })), ...tiers] });
        }
        catch (e) { return sendJson(res, 502, { error: { type: 'proxy_error', message: 'model list unavailable: ' + redact(e.message, secrets) } }); }
      }
      if (req.method === 'POST' && path.startsWith('/v1/')) {
        const tagOf = (h) => (req.headers[h] ? String(req.headers[h]).slice(0, 120) : null);
        const refusal = guard.admit({ purpose: tagOf('x-pworker-purpose'), run: tagOf('x-pworker-run') });
        if (refusal?.error) {
          // Refusals are logged with the caller's identity, so a misbehaving script is found in the log and in /stats.
          const client = (req.headers['x-client-name'] || (req.headers['user-agent'] || 'unknown').split(/[\s/]/)[0]).toString().slice(0, 40);
          monitor.log({ id: randomUUID().slice(0, 8), upstream: 'proxy', client, endpoint: path, status: refusal.status, refused: refusal.error.type, purpose: tagOf('x-pworker-purpose'), run: tagOf('x-pworker-run'), error: refusal.error.message });
          return sendJson(res, refusal.status, { error: refusal.error });
        }
        if (refusal?.untagged) req.untaggedRequest = true; // logged as `untagged: true`, so the allowance survives a restart
        const raw = await readBody(req);
        let model = null, parsedBody = null;
        try { parsedBody = JSON.parse(raw.toString('utf8')); model = parsedBody.model; } catch { /* not JSON */ }
        // Default mode from config.cache.defaultMode (owner, 2026-10-02: `use`, the chat too); a request opts out with `off`.
        const cacheMode = String(req.headers['x-pworker-cache'] || config.cache?.defaultMode || '').toLowerCase();
        let cacheKey = null;
        if (CACHE_MODES.includes(cacheMode) && parsedBody && !parsedBody.stream) {
          const tierTarget = up.name === config.defaultUpstream && !url.pathname.startsWith('/u/') && isTier(model) ? resolveTier(model) : null;
          const target = tierTarget && !tierTarget.error ? `tier:${model}` : up.name;
          let identity = tierTarget && !tierTarget.error ? identityOf(tierTarget.first.upstream, tierTarget.first.model) : identityOf(up.name, model);
          // A prompted entry's template is part of what serves the request: an edited template is a new key.
          if (tierTarget?.first?.prompt) { try { identity += `#${tierTarget.first.prompt}@${loadTemplate(promptsDir, tierTarget.first.prompt).hash}`; } catch { /* reported when served */ } }
          cacheKey = cache.key({ path, target, identity, body: parsedBody });
          if (cacheMode !== 'record') {
            // An entry stored before the completeness rules of answerComplete (a cut or interrupted answer) is never replayed.
            const hit = cache.get(cacheKey, { valid: (e) => answerComplete(e.body, { chat: path === '/v1/chat/completions' || path === '/v1/messages', format: path === '/v1/messages' ? 'anthropic' : 'openai' }) });
            if (hit) {
              monitor.log({ id: randomUUID().slice(0, 8), upstream: 'cache', client: String(req.headers['x-client-name'] || 'unknown').slice(0, 40), endpoint: path, model, status: 200, cache: 'hit', served: hit.served, purpose: tagOf('x-pworker-purpose'), run: tagOf('x-pworker-run'), usd: 0 });
              res.writeHead(200, { 'content-type': hit.content_type, 'cache-control': 'no-store', 'x-pworker-cache': 'hit', 'x-pworker-cache-key': cacheKey, ...(hit.served ? { 'x-pworker-model': hit.served } : {}) });
              return res.end(hit.body);
            }
            if (cacheMode === 'strict') {
              cache.refused();
              return sendJson(res, 409, { error: { type: 'cache_miss', message: 'strict cache: no stored answer for this request; no model was called', key: cacheKey } }, { 'x-pworker-cache': 'miss', 'x-pworker-cache-key': cacheKey });
            }
          }
        }
        if (up.name === config.defaultUpstream && !url.pathname.startsWith('/u/') && isTier(model)) {
          const t = resolveTier(model);
          if (t.error) return sendJson(res, 400, { error: { type: 'tier_unavailable', message: t.error } });
          const tup = upstreams[t.first.upstream];
          if (t.first.prompt && path !== '/v1/chat/completions') return await servePromptedTier(req, res, { tier: model, entry: t.first, up: tup, path, body: parsedBody, cacheKey });
          if (!Object.values(tup.formats || { openai: '/v1/chat/completions' }).includes(path)) return sendJson(res, 400, { error: { type: 'tier_unavailable', message: `tier "${model}" serves ${t.first.upstream}, which has no endpoint ${path}` } });
          if (!modelCache[tup.name] && !tup.start) getModels(tup).catch(() => {});
          const body = Buffer.from(JSON.stringify(entryBody({ ...JSON.parse(raw.toString('utf8')), model: t.first.model }, t.first)));
          return await forward(req, res, tup, path, body, { tier: model, chain: t.rest, cacheKey, timeoutMs: t.first.timeoutMs ?? null });
        }
        if (!modelCache[up.name] && !up.start) getModels(up).catch(() => {}); // warm pricing for stats
        return await forward(req, res, up, path, raw, { cacheKey });
      }
      return sendJson(res, 404, { error: { type: 'not_found', message: `${req.method} ${url.pathname}` } });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: { type: 'proxy_error', message: redact(e.message, secrets) } });
      else res.end();
    }
  }

  // Local model servers: status, explicit start and stop (`pworker models`); slots and idle stop come from `start` in the config.
  async function localStatus() {
    const healthy = async (u) => { try { return (await fetchImpl(u + '/health', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
    const up = Object.fromEntries(await Promise.all(Object.keys(starters).map(async (n) => [n, await healthy(upstreams[n].baseUrl)])));
    return Object.fromEntries(Object.entries(starters).map(([n, st]) => {
      const s = config.upstreams[n].start, l = limiters[n];
      return [n, { ...st.status(), running: up[n], base_url: upstreams[n].baseUrl, model: s.alias ?? null, slots: s.slots ?? null, always_on: !!s.startAtBoot, idle_stop_ms: s.idleStopMs ?? 0,
        exclusive_group: s.exclusiveGroup ?? null, active: l.active, queued: l.depth, max_concurrent: l.maxConcurrent }];
    }));
  }
  async function localAction(name, action) {
    const st = starters[name];
    if (!st) return { error: `no local model server ${name} (local: ${Object.keys(starters).join(', ') || 'none'})` };
    if (action === 'start') return { ok: await st.ensure(), status: st.status() };
    if (action === 'stop') { await st.stop(); return { ok: true, status: st.status() }; }
    return { error: `unknown action ${action}` };
  }
  // Always-on local models (start.startAtBoot): started with the core; a server already on the port is reused.
  const boot = () => { for (const [name, st] of Object.entries(starters)) if (config.upstreams[name].start.startAtBoot) st.ensure().catch(() => {}); };
  return { handle, boot, monitor, limiters, upstreams, guard, starters, cache, audit, config, tierList, resolveTier, localStatus, localAction, promptsDir };
}

/**
 * Accepts the easy provider form: `providers` is a synonym of `upstreams`; `policy` (the purpose allowance and run budgets) may still be called
 * `jobs`; a local `start.slots` sets llama-server's `--parallel` (and `-c slots*ctxPerSlot`) and the upstream's
 * `limits.maxConcurrent`, so the slot count is written once.
 */
export function normalizeConfig(raw) {
  const config = { ...raw };
  config.upstreams = Object.fromEntries(Object.entries(config.providers ?? config.upstreams ?? {}).filter(([k]) => !k.startsWith('_')));
  config.policy ??= config.jobs ?? {};
  for (const [name, up] of Object.entries(config.upstreams)) {
    const s = up.start;
    if (!s?.slots) continue;
    const args = [...(s.args || [])];
    const set = (flag, value) => { const i = args.indexOf(flag); if (i >= 0) args[i + 1] = String(value); else args.push(flag, String(value)); };
    set('--parallel', s.slots);
    if (s.ctxPerSlot) set('-c', s.slots * s.ctxPerSlot);
    config.upstreams[name] = { ...up, start: { ...s, args }, limits: { ...(up.limits || {}), maxConcurrent: up.limits?.maxConcurrent ?? s.slots } };
  }
  return config;
}
