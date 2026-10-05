// Subscription plan limits (calls, credits, tokens in rolling or fixed windows) and the value comparison.
// Pure functions over the request records written by the monitor.
import { planRequests } from './monitor.mjs';

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000, w: 7 * 86400_000 };
export function parseWindow(w) {
  if (typeof w === 'number') return w;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|[smhdw])$/.exec(String(w).trim());
  if (!m) throw new Error('bad window: ' + w);
  return Number(m[1]) * UNIT_MS[m[2]];
}

// Amount a recorded attempt consumes of a limit's unit. 429s and other failures cost no credits or tokens.
export function amountOf(unit, rec, model) {
  if (unit === 'calls') return 1;
  if (rec.status >= 400) return 0;
  if (unit === 'credits') return planRequests(model, rec);
  if (unit === 'tokens') return (rec.in_tokens || 0) + (rec.out_tokens || 0);
  return 0;
}

// Start of the window containing `now`: rolling = now - window; fixed = last boundary of anchor + k * window.
export function windowStart(limit, now) {
  const w = parseWindow(limit.window);
  if (limit.mode === 'fixed') {
    const anchor = limit.anchor ? Date.parse(limit.anchor) : 0;
    return anchor + Math.floor((now - anchor) / w) * w;
  }
  return now - w;
}

function inWindow(limit, now) {
  const start = windowStart(limit, now);
  return (r) => r.t > start && r.t <= now;
}

function sampleSeries(recs, header) {
  return recs.filter((r) => r.rate_headers?.[header] != null && Number.isFinite(Number(r.rate_headers[header]))).sort((a, b) => a.t - b.t);
}

export function limitReport({ upstream, limit, records, models, now }) {
  const w = parseWindow(limit.window);
  const mine = records.filter((r) => r.upstream === upstream);
  const inWin = mine.filter(inWindow(limit, now));
  const items = inWin.map((r) => [r, amountOf(limit.unit, r, models[r.model])]).filter(([, a]) => a > 0);
  const used = items.reduce((s, [, a]) => s + a, 0);
  const max = Number(limit.max);
  const pct = max > 0 ? used / max : 0;
  const out = {
    name: limit.name, unit: limit.unit, window: limit.window, mode: limit.mode || 'rolling', max,
    used: +used.toFixed(4), remaining: +(max - used).toFixed(4), pct: +pct.toFixed(4),
    warn: pct >= 0.8, exceeded: used >= max,
    next_relief_ms: null, next_reset_at: null, provider: null,
  };
  if (limit.mode === 'fixed') {
    const next = windowStart(limit, now) + w;
    out.next_reset_at = new Date(next).toISOString(); out.next_relief_ms = next - now;
  } else if (items.length) {
    out.next_relief_ms = Math.max(0, items[0][0].t + w - now); // the oldest counted attempt leaves the window
    out.next_reset_at = new Date(now + out.next_relief_ms).toISOString();
  }
  const p = limit.provider;
  if (p?.remainingHeader) {
    const h = p.remainingHeader.toLowerCase();
    const s = sampleSeries(mine, h);
    if (s.length) {
      const last = s[s.length - 1];
      const remaining = Number(last.rate_headers[h]);
      out.provider = { remaining, sampled_at: last.ts, age_s: Math.round((now - last.t) / 1000), our_remaining: out.remaining, diff_remaining: +(remaining - out.remaining).toFixed(4) };
      if (p.resetHeader && last.rate_headers[p.resetHeader.toLowerCase()] != null) {
        const at = Number(last.rate_headers[p.resetHeader.toLowerCase()]) * 1000;
        out.provider.reset_at = new Date(at).toISOString(); out.provider.reset_in_ms = Math.max(0, at - now);
        out.next_reset_at = out.provider.reset_at; out.next_relief_ms = out.provider.reset_in_ms;
      }
      // Agreement since the last window reset: what the provider says was consumed against what we counted.
      let base = 0;
      for (let i = 1; i < s.length; i++) if (Number(s[i].rate_headers[h]) > Number(s[i - 1].rate_headers[h]) + 1e-6) base = i;
      const costH = p.costHeader?.toLowerCase();
      const baseCost = costH && s[base].rate_headers[costH] != null ? Number(s[base].rate_headers[costH]) : 0;
      const providerUsed = Number(s[base].rate_headers[h]) + baseCost - remaining;
      const ours = mine.filter((r) => r.t >= s[base].t && r.t <= last.t).reduce((a, r) => a + amountOf(limit.unit, r, models[r.model]), 0);
      out.provider.agreement = { samples: s.length - base, provider_used: +providerUsed.toFixed(4), our_used: +ours.toFixed(4), diff: +(providerUsed - ours).toFixed(4) };
    }
  }
  return out;
}

export function planReport({ upstream, plan, records, models, now }) {
  const limits = (plan.limits || []).map((limit) => limitReport({ upstream, limit, records, models, now }));
  return {
    price_usd_per_month: plan.priceUsdPerMonth ?? null, limits,
    warnings: limits.filter((l) => l.warn).map((l) => `${l.name}: ${(l.pct * 100).toFixed(0)}% of ${l.max} ${l.unit} per ${l.window}${l.exceeded ? ' (limit reached)' : ''}`),
  };
}

// Milliseconds the head job must wait so that no declared limit is exceeded. `active` are the metas of jobs in flight
// (not yet logged); `job.cost` is the estimated credit cost. Never drops: the caller waits.
// `share` (0..1] lowers every limit to that share of its maximum (background work keeps the rest free for interactive and normal work).
export function limitWait({ upstream, limits, records, models, now, job, active, share = 1 }) {
  let wait = 0, reason = null;
  const mine = records.filter((r) => r.upstream === upstream);
  for (const limit of limits || []) {
    const w = parseWindow(limit.window);
    const own = limit.unit === 'calls' ? 1 : limit.unit === 'credits' ? (job?.cost ?? 0) : 0;
    const inflight = active.reduce((s, a) => s + (limit.unit === 'calls' ? 1 : limit.unit === 'credits' ? (a?.cost ?? 0) : 0), 0);
    const full = Number(limit.max);
    if (own > full) continue; // a single call larger than the limit would wait forever
    // The background share never lowers a limit below one job: max 1 per minute with share 0.7 still admits one call, never all of them.
    const max = Math.max(full * share, Math.min(own, full));
    const items = mine.filter(inWindow(limit, now)).map((r) => [r, amountOf(limit.unit, r, models[r.model])]).filter(([, a]) => a > 0);
    const used = items.reduce((s, [, a]) => s + a, 0) + inflight;
    const over = used + own - max;
    if (own > 0 ? over <= 1e-9 : used < max) continue;
    const need = Math.max(over, 1e-9);
    let freed = 0, wl = 500;
    if (limit.mode === 'fixed') wl = windowStart(limit, now) + w - now;
    else for (const [r, a] of items) { freed += a; if (freed >= need) { wl = r.t + w - now; break; } }
    if (wl > wait) { wait = wl; reason = `${limit.name} (${limit.unit}) would exceed ${max} per ${limit.window}`; }
  }
  return { wait: Math.max(0, Math.ceil(wait)), reason };
}

// ---- value comparison ----
const PERIODS = { day: 1, week: 7, month: 30 };
const M = 1e6;

function tokensOf(rec) {
  const inT = rec.in_tokens || 0, cached = rec.cached_tokens || 0;
  const fresh = rec.format === 'anthropic' ? inT : Math.max(0, inT - cached);
  return { fresh, cached, out: rec.out_tokens || 0 };
}
function costAt(p, t) {
  return (t.fresh * p.inputUsdPerM + t.cached * (p.cachedInputUsdPerM ?? p.inputUsdPerM) + t.out * p.outputUsdPerM) / M;
}
function listCost(model, t) {
  const p = model?.pricing;
  if (!p) return 0;
  return t.fresh * Number(p.prompt) + t.cached * Number(p.cache_read ?? p.prompt) + t.out * Number(p.completion);
}

export function valueReport({ upstream, plan, compare: rawCompare = {}, records, models, creditModels = new Set(), now }) {
  if (!plan?.priceUsdPerMonth) return null;
  const compare = Object.fromEntries(Object.entries(rawCompare || {}).filter(([, p]) => p && typeof p === 'object'));
  const price = Number(plan.priceUsdPerMonth);
  const mine = records.filter((r) => r.upstream === upstream && r.status < 400 && r.model && !creditModels.has(r.model));
  const first = mine.length ? mine[0].t : now;
  const firstAll = records.filter((r) => r.upstream === upstream).reduce((m, r) => Math.min(m, r.t), now);
  const periods = {};
  const tally = (recs) => {
    const tok = { in: 0, cached: 0, out: 0, calls: recs.length }, byModel = {};
    const total = { fresh: 0, cached: 0, out: 0 };
    let list = 0;
    const alt = Object.fromEntries(Object.keys(compare).map((k) => [k, 0]));
    for (const r of recs) {
      const t = tokensOf(r);
      total.fresh += t.fresh; total.cached += t.cached; total.out += t.out;
      list += listCost(models[r.model], t);
      for (const [k, p] of Object.entries(compare)) alt[k] += costAt(p, t);
      const b = (byModel[r.model] ||= { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0 });
      b.calls++; b.input_tokens += t.fresh; b.cached_tokens += t.cached; b.output_tokens += t.out;
    }
    tok.in = total.fresh; tok.cached = total.cached; tok.out = total.out;
    return { tokens: tok, by_model: byModel, openference_list_usd: +list.toFixed(6), compare_usd: Object.fromEntries(Object.entries(alt).map(([k, v]) => [k, +v.toFixed(6)])) };
  };
  for (const [name, days] of Object.entries(PERIODS)) {
    const recs = mine.filter((r) => now - r.t < days * 86400_000);
    const sub = +(price * days / 30).toFixed(4);
    const t = tally(recs);
    const alts = { 'openference-list': t.openference_list_usd, ...t.compare_usd };
    periods[name] = { days, subscription_prorated_usd: sub, ...t, saving_vs_usd: Object.fromEntries(Object.entries(alts).map(([k, v]) => [k, +(v - sub).toFixed(4)])) };
  }
  // Projection: the traffic of the observed span (at least one day, at most 30) scaled to 30 days.
  const spanDays = Math.min(30, Math.max(1, (now - Math.min(first, firstAll)) / 86400_000));
  const base = tally(mine.filter((r) => now - r.t < spanDays * 86400_000));
  const k = 30 / spanDays;
  const proj = { 'openference-list': base.openference_list_usd * k };
  for (const [key, v] of Object.entries(base.compare_usd)) proj[key] = v * k;
  const projection = { span_days: +spanDays.toFixed(2), scale_to_30_days: +k.toFixed(3), monthly_usd: Object.fromEntries(Object.entries(proj).map(([a, v]) => [a, +v.toFixed(4)])) };
  const entries = Object.entries(projection.monthly_usd);
  let verdict = 'no traffic yet: nothing to compare';
  if (mine.length && entries.length) {
    const [bestKey, best] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
    const d = best - price;
    verdict = d >= 0
      ? `subscription saves ${d.toFixed(2)} USD this month at the current rate (the last ${projection.span_days} days of traffic would cost ${best.toFixed(2)} USD per 30 days at ${bestKey} against ${price} USD)`
      : `subscription costs ${(-d).toFixed(2)} USD more this month at the current rate (the last ${projection.span_days} days of traffic would cost ${best.toFixed(2)} USD per 30 days at ${bestKey} against ${price} USD)`;
  }
  return { subscription_usd_per_month: price, compare_prices: compare, periods, projection, verdict, note: 'plan-billed models only; alternatives assume equal quality; DeepSeek prices are those configured in compare' };
}
