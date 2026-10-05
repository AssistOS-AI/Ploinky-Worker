// Persistent request metrics from the proxy's request log (<dataDir>/requests-YYYY-MM-DD.jsonl, one record per upstream attempt, cache hit
// or refusal; kept 31 days). `pworker stats` reads the files directly, so the numbers survive restarts and need no running proxy.
// Per provider/model (with the tiers it served) and per hour or day: attempts sent upstream, successes, 429s and the 429s that came while
// every configured rate was respected ("under limit": evidence that the provider throttles below its advertised limit), other errors,
// retries, timeouts, aborted attempts, fallbacks, cache hits, tokens, queue wait, the peak and average sending rate, and requests saved by
// batching.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const FILE = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const UNIT = { m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 };

/** "90m", "1h", "24h", "7d", "2w" -> milliseconds. */
export function parseSince(text) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`--since takes a duration such as 1h, 24h or 7d (got ${text})`);
  return Number(m[1]) * UNIT[m[2]];
}

/** The records of the request log since `since` (ms epoch), oldest first. */
export function readRecords(dataDir, since = 0) {
  if (!dataDir || !existsSync(dataDir)) return [];
  const firstDay = new Date(since - 86400_000).toISOString().slice(0, 10);
  const out = [];
  for (const f of readdirSync(dataDir).filter((n) => FILE.test(n) && FILE.exec(n)[1] >= firstDay).sort()) {
    for (const line of readFileSync(join(dataDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.t >= since) out.push(r); } catch { /* a bad line */ }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

const sentAt = (r) => r.t_sent ?? r.t;
const isSent = (r) => r.upstream !== 'cache' && r.upstream !== 'proxy' && !r.not_sent;

// Peak attempts within any 60 s, by send time.
function peakPerMinute(times) {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) { while (times[i] - times[j] >= 60_000) j++; best = Math.max(best, i - j + 1); }
  return best;
}

/**
 * Aggregates records. `limits`: {upstream: {maxPerMinute, maxPerSecond}} (the configuration, to classify 429s of records written before
 * under_limit was recorded); `provider`: only this upstream; `bucket`: 'hour' | 'day'.
 */
export function summarize(records, { since = 0, now = Date.now(), provider = null, limits = {}, bucket = null } = {}) {
  const recs = records.filter((r) => r.t >= since && r.t <= now);
  // A cache hit is attributed to the provider/model that produced the stored answer.
  const owner = (r) => {
    if (r.upstream === 'cache') { const [up, ...m] = String(r.served || 'cache/-').split('+')[0].split('/'); return { upstream: up, model: m.join('/') || r.model || '-' }; }
    return { upstream: r.upstream, model: r.model ?? '-' };
  };
  const mine = recs.filter((r) => r.upstream !== 'proxy' && (!provider || owner(r).upstream === provider));
  // Send times per upstream (for the under-limit check of older records and for the rate).
  const sends = {};
  for (const r of recs) if (isSent(r)) (sends[r.upstream] ??= []).push(sentAt(r));
  for (const a of Object.values(sends)) a.sort((x, y) => x - y);
  const within = (up, t, ms) => { const a = sends[up] || []; let n = 0; for (const x of a) if (x <= t && t - x < ms) n++; return n; };
  const underLimit = (r) => {
    if (r.under_limit != null) return r.under_limit === true;
    const l = limits[r.upstream] || {};
    if (!l.maxPerMinute && !l.maxPerSecond) return false;
    return (!l.maxPerMinute || within(r.upstream, sentAt(r), 60_000) <= l.maxPerMinute) && (!l.maxPerSecond || within(r.upstream, sentAt(r), 1000) <= l.maxPerSecond);
  };
  const empty = () => ({ sent: 0, ok: 0, r429: 0, r429_under_limit: 0, errors: 0, retries: 0, timeouts: 0, aborted: 0, fallbacks: 0, cache_hits: 0, in_tokens: 0, out_tokens: 0, queue_wait_ms_total: 0, queue_wait_ms_max: 0, batch_saved: 0, tiers: new Set(), times: [] });
  const add = (e, r) => {
    if (r.upstream === 'cache') { e.cache_hits += 1; if (r.tier) e.tiers.add(r.tier); return; }
    if (r.not_sent) { e.errors += 1; return; }
    e.sent += 1; e.times.push(sentAt(r));
    if (r.tier) e.tiers.add(r.tier);
    if (r.status < 400) e.ok += 1;
    else if (r.status === 429) { e.r429 += 1; if (underLimit(r)) e.r429_under_limit += 1; }
    else e.errors += 1;
    if (r.attempt > 1) e.retries += 1;
    if (r.status === 504 || r.timeout) e.timeouts += 1;
    if (r.status === 499 || r.aborted) e.aborted += 1;
    if (r.fallback_to) e.fallbacks += 1;
    e.in_tokens += r.in_tokens || 0; e.out_tokens += r.out_tokens || 0;
    e.queue_wait_ms_total += r.queue_wait_ms || 0; e.queue_wait_ms_max = Math.max(e.queue_wait_ms_max, r.queue_wait_ms || 0);
    if (r.status < 400 && r.batch_size > 1) e.batch_saved += r.batch_size - 1;
  };
  const finish = (e) => {
    const times = e.times.sort((a, b) => a - b);
    const minutes = new Set(times.map((t) => Math.floor(t / 60_000))).size;
    const { tiers, times: _t, queue_wait_ms_total, ...rest } = e;
    return { ...rest, tiers: [...tiers].sort(), queue_wait_ms_avg: e.sent ? Math.round(queue_wait_ms_total / e.sent) : 0, peak_per_minute: peakPerMinute(times), avg_per_active_minute: minutes ? +(e.sent / minutes).toFixed(2) : 0 };
  };
  const groups = new Map(), total = empty(), buckets = new Map();
  const size = bucket === 'day' ? 86400_000 : 3600_000;
  for (const r of mine) {
    const o = owner(r), key = `${o.upstream}/${o.model}`;
    if (!groups.has(key)) groups.set(key, { upstream: o.upstream, model: o.model, e: empty() });
    add(groups.get(key).e, r); add(total, r);
    if (bucket) { const b = Math.floor(r.t / size) * size; if (!buckets.has(b)) buckets.set(b, empty()); add(buckets.get(b), r); }
  }
  return {
    since: new Date(since).toISOString(), now: new Date(now).toISOString(), provider,
    groups: [...groups.values()].sort((a, b) => b.e.sent + b.e.cache_hits - (a.e.sent + a.e.cache_hits)).map((g) => ({ upstream: g.upstream, model: g.model, ...finish(g.e) })),
    total: finish(total),
    buckets: [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, e]) => ({ start: new Date(b).toISOString(), ...finish(e) })),
    bucket,
  };
}

/** A compact text rendering of summarize() for the terminal. */
export function formatSummary(s, { limits = {} } = {}) {
  const table = (head, rows) => {
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (r) => r.map((c, i) => (i < 1 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  ');
    return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
  };
  const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : String(n));
  const cols = ['sent', 'ok', '429', '429<lim', 'err', 'retry', 'tmout', 'cache', 'saved', 'in tok', 'out tok', 'q avg s', 'peak/min', 'avg/min'];
  const vals = (e) => [e.sent, e.ok, e.r429, e.r429_under_limit, e.errors, e.retries, e.timeouts, e.cache_hits, e.batch_saved, k(e.in_tokens), k(e.out_tokens), (e.queue_wait_ms_avg / 1000).toFixed(1), e.peak_per_minute, e.avg_per_active_minute];
  const out = [`Ploinky Workers request metrics since ${s.since}${s.provider ? ` · provider ${s.provider}` : ''}`];
  if (!s.groups.length) { out.push('No requests in this period.'); return out.join('\n') + '\n'; }
  out.push('', table(['provider/model', ...cols, 'tiers'], [...s.groups.map((g) => [`${g.upstream}/${g.model}`, ...vals(g), g.tiers.join(',') || '-']), ['total', ...vals(s.total), '']]));
  if (s.buckets.length) out.push('', table([s.bucket === 'day' ? 'day' : 'hour (UTC)', ...cols], s.buckets.map((b) => [s.bucket === 'day' ? b.start.slice(0, 10) : b.start.slice(0, 13).replace('T', ' ') + 'h', ...vals(b)])));
  const lim = Object.entries(limits).filter(([n, l]) => l.maxPerMinute && (!s.provider || n === s.provider) && s.groups.some((g) => g.upstream === n));
  if (lim.length) out.push('', 'Configured limits: ' + lim.map(([n, l]) => `${n} ${l.maxPerMinute}/min${l.maxPerSecond ? `, ${l.maxPerSecond}/s` : ''}${l.pacing === 'even' ? ' (even pacing)' : ''}`).join('; '));
  if (s.total.r429_under_limit) out.push(`${s.total.r429_under_limit} of ${s.total.r429} 429 responses came while every configured rate was respected (429<lim): the provider throttled below its configured limit.`);
  out.push('Columns: sent = attempts sent upstream (retries included); 429<lim = 429 while within the configured rates; retry = attempts after the first; tmout = duration-cap timeouts; cache = cache hits; saved = requests saved by batching; q avg s = average local queue wait; peak/min = most attempts within 60 s; avg/min = attempts per active minute.');
  return out.join('\n') + '\n';
}
