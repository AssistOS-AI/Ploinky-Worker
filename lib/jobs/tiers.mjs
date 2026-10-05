/**
 * Adaptive tiers (owner, 2026-10-02). A job (or template) declares its task `kind`, a tier `ladder` (cheapest first, e.g.
 * ["tiny", "small", "medium", "good"]) and a `quality` bar (`minPassRate` after checks and repairs, `maxAuditPer100`). Each item
 * starts at the run's start tier and climbs the ladder while it fails (checks, repair rounds, unavailable tier); the tier at which it
 * finally passed is recorded.
 *
 * The start tier is learned, deterministically: `state/llm-jobs/tier-stats.jsonl` is an append-only log with one row per run and
 * tier (items tried there, passed there, repair rounds, audit sampled/problems, USD, credits, latency). For a kind, the recent rows
 * (`adaptive.window` runs per tier) give each tier a pass rate and audit rate; tiers with at least `adaptive.minItems` tries that miss
 * the bar are skipped, the cheapest remaining tier (met the bar, or never tried) is the start. Every `adaptive.reprobeEvery` runs of
 * the kind, the first `adaptive.probeItems` items start one tier lower, so a cheaper tier that became good enough is noticed. No model
 * chooses the tier (the planner may set kind and ladder when it writes the spec).
 */
import fs from 'node:fs';
import path from 'node:path';
import {appendJsonl, readJsonl} from './util.mjs';

export const DEFAULT_ADAPTIVE = Object.freeze({window: 3, minItems: 5, reprobeEvery: 5, probeItems: 3});
export const DEFAULT_QUALITY = Object.freeze({minPassRate: 0.9, maxAuditPer100: 10});

export const statsFile = root => path.join(root, 'tier-stats.jsonl');
export const readTierStats = root => readJsonl(statsFile(root));

/** Per-tier aggregate of the most recent `window` runs of a kind: {tier: {runs, tried, passed, pass_rate, audit_per_100, ...}}. */
export function aggregate(rows, kind, {window = DEFAULT_ADAPTIVE.window} = {}) {
  const byTier = {};
  for (const r of rows.filter(r => r.kind === kind)) (byTier[r.tier] ||= []).push(r);
  const out = {};
  for (const [tier, list] of Object.entries(byTier)) {
    const recent = list.sort((a, b) => (a.t < b.t ? -1 : 1)).slice(-window);
    const sum = k => recent.reduce((s, r) => s + (r[k] || 0), 0);
    const tried = sum('tried'), passed = sum('passed'), sampled = sum('audit_sampled');
    out[tier] = {runs: recent.length, tried, passed, pass_rate: tried ? passed / tried : null, repair_rounds: sum('repair_rounds'),
      audit_sampled: sampled, audit_problems: sum('audit_problems'), audit_per_100: sampled ? (100 * sum('audit_problems')) / sampled : null,
      usd: sum('usd'), credits: sum('credits'), latency_ms_per_call: sum('calls') ? sum('latency_ms') / sum('calls') : null};
  }
  return out;
}

/** The start tier of a run: `{start (ladder index), reason, probe: {level, items} | null, stats}`. */
export function chooseStart({kind, ladder, quality = {}, adaptive = {}, rows = []}) {
  const q = {...DEFAULT_QUALITY, ...quality}, a = {...DEFAULT_ADAPTIVE, ...adaptive};
  const stats = aggregate(rows, kind, a);
  const meets = s => s.pass_rate >= q.minPassRate && (s.audit_per_100 == null || s.audit_per_100 <= q.maxAuditPer100);
  let start = ladder.length - 1, reason = 'every tier missed the quality bar recently: the top tier';
  for (const [i, tier] of ladder.entries()) {
    const s = stats[tier];
    if (!s || s.tried < a.minItems) { start = i; reason = `${tier} has too little data (${s?.tried ?? 0} items): explore from it`; break; }
    if (meets(s)) { start = i; reason = `${tier} met the bar (pass ${Math.round(100 * s.pass_rate)}% ≥ ${Math.round(100 * q.minPassRate)}% over ${s.runs} runs)`; break; }
  }
  const runsOfKind = new Set(rows.filter(r => r.kind === kind).map(r => r.run)).size;
  const probe = start > 0 && runsOfKind > 0 && runsOfKind % a.reprobeEvery === 0 ? {level: start - 1, items: a.probeItems} : null;
  return {start, reason, probe, stats};
}

/** Appends one row per tier of a finished run to the append-only stats log. */
export function recordTierStats(root, {kind, job, run, perTier}) {
  fs.mkdirSync(root, {recursive: true});
  const t = new Date().toISOString();
  for (const [tier, s] of Object.entries(perTier)) if (s.tried) appendJsonl(statsFile(root), {t, kind, job, run, tier, ...s});
}
