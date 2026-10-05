// Request log (JSONL, one file per day) and statistics computed from the records.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KEEP_DAYS = 31; // the value comparison needs a month; plan limits need up to a week
const MAX_RECORDS = 200_000;

export const RATE_HEADER = /ratelimit|rate-limit|retry-after|quota|remaining|reset|limit|x-request-id|cf-ray|usage/i;

export function pickRateHeaders(headers) {
  const out = {};
  for (const [k, v] of headers) if (RATE_HEADER.test(k)) out[k.toLowerCase()] = v;
  return out;
}

export function redact(text, secrets) {
  let s = String(text ?? '');
  for (const sec of secrets) if (sec && sec.length >= 6) s = s.split(sec).join('***');
  return s;
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
const sum = (a, f) => a.reduce((s, r) => s + (f(r) || 0), 0);

export function priceOf(model, rec) {
  if (rec.usd != null) return rec.usd; // cost reported by the provider (OpenRouter usage.cost)
  const p = model?.pricing;
  if (!p) return null;
  const pr = Number(p.prompt), co = Number(p.completion), cr = Number(p.cache_read ?? p.prompt);
  const inT = rec.in_tokens || 0, cached = rec.cached_tokens || 0, out = rec.out_tokens || 0;
  const fresh = rec.format === 'anthropic' ? inT : Math.max(0, inT - cached);
  return fresh * pr + cached * cr + out * co;
}

export function planRequests(model, rec) {
  if (rec.status >= 400) return 0;
  if (rec.quota_cost != null) return rec.quota_cost;
  if (!model) return 0;
  let m = Number(model.quota_multiplier ?? 1);
  const s = model.quota_context_surcharge;
  const total = (rec.in_tokens || 0) + (rec.format === 'anthropic' ? rec.cached_tokens || 0 : 0);
  if (s && total > s.threshold_input_tokens) m *= s.factor;
  return m;
}

export class Monitor {
  constructor({ dataDir, secrets = [] }) {
    this.dir = dataDir;
    this.secrets = secrets;
    this.records = [];
    this.headersSeen = {};
    this.startedAt = Date.now();
    mkdirSync(dataDir, { recursive: true });
    this.#load();
  }

  #load() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of readdirSync(this.dir).filter((n) => /^requests-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.t >= cutoff) this.#remember(r); } catch { /* skip bad line */ }
      }
    }
  }

  #remember(r) {
    this.records.push(r);
    if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
    for (const [k, v] of Object.entries(r.rate_headers || {})) {
      const e = (this.headersSeen[k] ||= { count: 0, last: null, first_seen: r.t });
      e.count += 1; e.last = v;
    }
  }

  log(rec) {
    rec.t ??= Date.now();
    rec.ts = new Date(rec.t).toISOString();
    if (rec.error) rec.error = redact(rec.error, this.secrets).slice(0, 400);
    this.#remember(rec);
    const file = join(this.dir, `requests-${rec.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, JSON.stringify(rec) + '\n');
  }

  creditModels() {
    return new Set(this.records.filter((r) => r.credit_billed && r.model).map((r) => r.model));
  }

  // limiterInfo: {upstream: {depth, active, pausedUntil, limits}}; models: {id: modelEntry}
  stats(limiterInfo = {}, models = {}) {
    const now = Date.now();
    const recs = this.records;
    const within = (ms) => recs.filter((r) => now - r.t < ms);
    const modelOf = (r) => models[r.model];
    const credit = this.creditModels();
    const summarize = (a) => ({
      calls: a.length,
      request_bytes: sum(a, (r) => r.req_bytes),
      response_bytes: sum(a, (r) => r.res_bytes),
      ok: a.filter((r) => r.status < 400).length,
      errors: a.filter((r) => r.status >= 400).length,
      r429: a.filter((r) => r.status === 429).length,
      in_tokens: sum(a, (r) => r.in_tokens),
      out_tokens: sum(a, (r) => r.out_tokens),
      cached_tokens: sum(a, (r) => r.cached_tokens),
      cost_usd: sum(a, (r) => priceOf(modelOf(r), r)),
      credit_cost_usd: sum(a.filter((r) => credit.has(r.model)), (r) => priceOf(modelOf(r), r)),
      plan_requests: sum(a, (r) => planRequests(modelOf(r), r)),
      fallbacks: a.filter((r) => r.fallback_from && r.attempt === 1).length,
    });
    const windows = { minute: summarize(within(60_000)), hour: summarize(within(3600_000)), day: summarize(within(86400_000)), week: summarize(within(7 * 86400_000)), month: summarize(within(30 * 86400_000)) };

    const names = [...new Set(recs.map((r) => r.model).filter(Boolean))];
    const by_model = {};
    for (const m of names) {
      const a = recs.filter((r) => r.model === m);
      const ok = a.filter((r) => r.status < 400);
      const lat = ok.map((r) => r.latency_ms).filter(Number.isFinite).sort((x, y) => x - y);
      const ttft = ok.map((r) => r.ttft_ms).filter(Number.isFinite).sort((x, y) => x - y);
      const calls = (ms) => a.filter((r) => now - r.t < ms).length;
      by_model[m] = {
        ...summarize(a), calls_minute: calls(60_000), calls_hour: calls(3600_000), calls_day: calls(86400_000),
        quota_multiplier: models[m]?.quota_multiplier ?? null,
        billing: credit.has(m) ? 'credit' : 'plan',
        quota_cost_seen: [...new Set(a.map((r) => r.quota_cost).filter((x) => x != null))],
        latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) },
        ttft_ms: { p50: pct(ttft, 50), p95: pct(ttft, 95) },
      };
    }

    const perMinute = new Array(60).fill(0);
    for (const r of within(3600_000)) perMinute[59 - Math.min(59, Math.floor((now - r.t) / 60_000))] += 1;

    const lat = recs.filter((r) => r.status < 400).map((r) => r.latency_ms).filter(Number.isFinite).sort((x, y) => x - y);
    const limited = recs.filter((r) => r.status === 429);
    const startsOf = (r, ms) => recs.filter((x) => x.upstream === r.upstream && x.t <= r.t && r.t - x.t < ms).length;
    const at429 = limited.map((r) => ({ t: r.ts, retry_after: r.rate_headers?.['retry-after'] ?? null, calls_prev_second: startsOf(r, 1000), calls_prev_minute: startsOf(r, 60_000), calls_prev_hour: startsOf(r, 3600_000) }));
    const nums = (k) => at429.map((x) => x[k]).sort((a, b) => a - b);
    const inferred = {
      r429_count: limited.length,
      note: limited.length ? 'calls (attempts) in the window ending at each 429; the minimum is the best upper bound for the limit' : 'no 429 observed yet',
      min_calls_prev_second: nums('calls_prev_second')[0] ?? null,
      min_calls_prev_minute: nums('calls_prev_minute')[0] ?? null,
      min_calls_prev_hour: nums('calls_prev_hour')[0] ?? null,
      max_success_calls_per_second: maxPerWindow(recs.filter((r) => r.status < 400), 1000),
      max_success_calls_per_minute: maxPerWindow(recs.filter((r) => r.status < 400), 60_000),
      last_429: at429.slice(-10),
      headers_seen: this.headersSeen,
    };

    // Honesty check: tokens the provider reports vs a local estimate of the prompt size.
    const token_check = {};
    for (const m of names) {
      const a = recs.filter((r) => r.model === m && r.status < 400 && r.est_in_tokens > 50 && r.in_tokens > 0 && r.format === 'openai');
      if (a.length) token_check[m] = { samples: a.length, reported_over_estimated_input: +(sum(a, (r) => r.in_tokens) / sum(a, (r) => r.est_in_tokens)).toFixed(3) };
    }

    // Quota window: x-quota-remaining over time; a rise means the window reset.
    const qs = recs.filter((r) => r.quota_remaining != null).sort((a, b) => a.t - b.t);
    const resets = [];
    for (let i = 1; i < qs.length; i++) if (qs[i].quota_remaining > qs[i - 1].quota_remaining + 1e-6) resets.push({ t: qs[i].ts, from: qs[i - 1].quota_remaining, to: qs[i].quota_remaining });
    const gaps = resets.slice(1).map((x, i) => new Date(x.t) - new Date(resets[i].t)).sort((a, b) => a - b);
    const quota = {
      samples: qs.length,
      remaining_now: qs.length ? qs[qs.length - 1].quota_remaining : null,
      first_seen: qs.length ? { t: qs[0].ts, remaining: qs[0].quota_remaining } : null,
      used_since_first: qs.length ? +(qs[0].quota_remaining - qs[qs.length - 1].quota_remaining).toFixed(4) : null,
      resets: resets.slice(-10),
      window_estimate_ms: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      series: qs.slice(-120).map((r) => [r.ts, r.quota_remaining]),
      note: 'window length is inferred from rises of x-quota-remaining; needs at least two resets',
    };

    // Fallbacks: requests served by the fallback upstream (first attempt there), by reason kind and route.
    const fbRecs = recs.filter((r) => r.fallback_from && r.attempt === 1);
    const countBy = (a, f) => a.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o; }, {});
    const fallback = {
      total: fbRecs.length, hour: fbRecs.filter((r) => now - r.t < 3600_000).length, day: fbRecs.filter((r) => now - r.t < 86400_000).length,
      by_kind: countBy(fbRecs, (r) => r.fallback_kind || 'unknown'),
      by_route: countBy(fbRecs, (r) => `${r.fallback_from}/${r.fallback_model} -> ${r.upstream}/${r.model}`),
      last: fbRecs.slice(-10).reverse().map(({ ts, fallback_from, fallback_model, upstream, model, fallback_kind, fallback_reason, status, client }) => ({ ts, from: `${fallback_from}/${fallback_model}`, to: `${upstream}/${model}`, kind: fallback_kind, reason: fallback_reason, status, client })),
    };

    const upstreams = {};
    for (const [n, l] of Object.entries(limiterInfo)) upstreams[n] = { ...l, paused_ms: Math.max(0, l.pausedUntil - now) };
    return {
      now: new Date(now).toISOString(), uptime_s: Math.round((now - this.startedAt) / 1000), records_in_memory: recs.length,
      upstreams, windows, by_model, calls_per_minute_last_hour: perMinute,
      latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99) },
      error_rate: recs.length ? +(recs.filter((r) => r.status >= 400).length / recs.length).toFixed(4) : 0,
      rate429: recs.length ? +(limited.length / recs.length).toFixed(4) : 0,
      inferred_limits: inferred, quota, token_check, fallback,
      recent: recs.slice(-15).reverse().map(({ ts, upstream, model, status, in_tokens, out_tokens, latency_ms, ttft_ms, attempt, error, stream, fallback_from, fallback_to }) => ({ ts, upstream, model, status, in_tokens, out_tokens, latency_ms, ttft_ms, attempt, stream, error, fallback_from, fallback_to })),
    };
  }
}

function maxPerWindow(a, ms) {
  let best = 0, j = 0;
  for (let i = 0; i < a.length; i++) {
    while (a[i].t - a[j].t >= ms) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

export function dataDirExists(p) { return existsSync(p); }
