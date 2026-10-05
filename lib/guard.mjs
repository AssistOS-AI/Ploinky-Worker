// Job accounting and admission (owner, 2026-10-02): LLM batch work runs as registered jobs (the job runner) with a budget each;
// requests carry `x-pworker-purpose` (and `x-pworker-run` for a job run). The guard
//   - keeps run registrations (POST /jobs/register {job, run, purpose, budget: {usd?, credits?, calls?}}, POST /jobs/finish {run, status}),
//     persisted as an append-only log `<dataDir>/jobs/runs.jsonl` so a restart keeps them;
//   - refuses a registered run's requests once its spend (from the request log: USD and plan credits of its successful calls, calls)
//     reaches its budget (402 budget_exceeded), and every request of a finished run (403 run_finished);
//   - lets allowed purposes through (`jobs.allowedPurposes`: exact names or `prefix:*`), and counts every other request (no purpose, or
//     an unknown one) against a small daily allowance (`jobs.untaggedDailyMax`), refusing beyond it (403 untagged_limit). The proxy
//     marks admitted untagged requests `untagged: true` in its request log, so the count is rebuilt from the log after a restart;
//   - reports per-job and per-run spend for /stats.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_POLICY = Object.freeze({
  allowedPurposes: ['chat', 'formalize', 'answer-*', 'ingest', 'job:*', 'review:*', 'test:*'],
  untaggedDailyMax: 100,
  keepDays: 7,
});
const RUN_ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

export function purposeAllowed(purpose, allowed) {
  if (!purpose) return false;
  return allowed.some((p) => (p.endsWith('*') ? purpose.startsWith(p.slice(0, -1)) : purpose === p));
}

const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * `records()` returns the proxy's request records (monitor.records); `costOf(rec)` returns {usd, credits} of one record.
 */
export function createJobGuard({ config = {}, dataDir, records = () => [], costOf = () => ({ usd: 0, credits: 0 }), now = Date.now }) {
  const policy = { ...DEFAULT_POLICY, ...Object.fromEntries(Object.entries(config || {}).filter(([k]) => !k.startsWith('_'))) };
  const dir = join(dataDir, 'jobs'); // created on the first registration
  const runsFile = join(dir, 'runs.jsonl');
  const runs = new Map();
  const refused = {};
  const cutoff = now() - policy.keepDays * 86400_000;
  if (existsSync(runsFile)) {
    for (const line of readFileSync(runsFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.t < cutoff) continue;
        if (e.event === 'register') runs.set(e.run, { job: e.job, run: e.run, purpose: e.purpose, budget: e.budget, registered_at: e.t, status: 'running' });
        else if (e.event === 'finish' && runs.has(e.run)) Object.assign(runs.get(e.run), { status: e.status || 'finished', finished_at: e.t });
      } catch { /* skip a bad line */ }
    }
  }
  const log = (e) => { mkdirSync(dir, { recursive: true }); appendFileSync(runsFile, JSON.stringify({ t: now(), ...e }) + '\n'); };

  // The untagged allowance of the current local day: rebuilt from the request log (first attempts marked `untagged`), then counted here.
  let untagged = { day: null, used: 0 };
  const loadUntagged = () => {
    const day = localDay(now());
    if (untagged.day === day) return;
    untagged = { day, used: records().filter((r) => r.untagged && r.attempt === 1 && !r.fallback_from && localDay(r.t) === day).length };
  };

  function spent(run) {
    const s = { calls: 0, usd: 0, credits: 0 };
    for (const r of records()) {
      if (r.run !== run || r.status >= 400) continue;
      const c = costOf(r);
      s.calls += 1; s.usd += c.usd || 0; s.credits += c.credits || 0;
    }
    return s;
  }

  function register(body) {
    const { job, run, purpose = null, budget = {} } = body || {};
    if (typeof run !== 'string' || !RUN_ID.test(run)) return { error: 'run: an id of letters, digits and . : _ - (at most 80)' };
    if (typeof job !== 'string' || !job.trim()) return { error: 'job: required' };
    const b = {};
    for (const k of ['usd', 'credits', 'calls']) if (budget?.[k] != null) { if (!isNum(budget[k])) return { error: `budget.${k}: a non-negative number` }; b[k] = budget[k]; }
    if (!Object.keys(b).length) return { error: 'budget: at least one of usd, credits, calls' };
    if (runs.has(run)) return { error: `run ${run} is already registered` };
    const rec = { job: job.slice(0, 80), run, purpose: purpose ? String(purpose).slice(0, 120) : `job:${job}`, budget: b, registered_at: now(), status: 'running' };
    runs.set(run, rec);
    log({ event: 'register', job: rec.job, run, purpose: rec.purpose, budget: b });
    return { ok: true, run: rec };
  }

  function finish(body) {
    const rec = runs.get(body?.run);
    if (!rec) return { error: `unknown run ${body?.run}` };
    Object.assign(rec, { status: String(body.status || 'finished').slice(0, 40), finished_at: now() });
    log({ event: 'finish', run: rec.run, status: rec.status });
    return { ok: true, run: rec };
  }

  const refuse = (status, type, message) => { refused[type] = (refused[type] || 0) + 1; return { status, error: { type, message } }; };

  /** Admission of one client request: null (go ahead), {untagged: true} (go ahead, counted) or {status, error} (refused). */
  function admit({ purpose = null, run = null } = {}) {
    if (run && runs.has(run)) {
      const rec = runs.get(run);
      if (rec.status !== 'running') return refuse(403, 'run_finished', `run ${run} is ${rec.status}; start a new run`);
      const s = spent(run), b = rec.budget;
      for (const k of ['usd', 'credits', 'calls']) {
        if (b[k] != null && s[k] >= b[k]) return refuse(402, 'budget_exceeded', `run ${run} of job ${rec.job} spent ${k === 'usd' ? s[k].toFixed(4) : s[k]} ${k} of its budget ${b[k]}`);
      }
    }
    if (purposeAllowed(purpose, policy.allowedPurposes)) return null;
    loadUntagged();
    if (untagged.used >= policy.untaggedDailyMax) {
      return refuse(403, 'untagged_limit', `the daily allowance of ${policy.untaggedDailyMax} requests without an allowed x-pworker-purpose is used up${purpose ? ` (purpose "${purpose}" is not allowed)` : ''}; allowed: ${policy.allowedPurposes.join(', ')}. Tag the call with an allowed x-pworker-purpose.`);
    }
    untagged.used += 1;
    return { untagged: true };
  }

  function stats() {
    loadUntagged();
    const byJob = {}, byRun = [];
    const recs = records();
    const perRun = {};
    for (const r of recs) {
      if (!r.run || r.status >= 400) continue;
      const c = costOf(r);
      const e = (perRun[r.run] ||= { calls: 0, usd: 0, credits: 0, purpose: r.purpose || null });
      e.calls += 1; e.usd += c.usd || 0; e.credits += c.credits || 0;
    }
    for (const [run, s] of Object.entries(perRun)) {
      const reg = runs.get(run);
      const job = reg?.job ?? (s.purpose?.startsWith('job:') ? s.purpose.slice(4) : s.purpose || '-');
      const j = (byJob[job] ||= { runs: 0, calls: 0, usd: 0, credits: 0 });
      j.runs += 1; j.calls += s.calls; j.usd += s.usd; j.credits += s.credits;
    }
    for (const reg of [...runs.values()].sort((a, b) => b.registered_at - a.registered_at).slice(0, 30)) {
      byRun.push({ run: reg.run, job: reg.job, status: reg.status, budget: reg.budget, spent: perRun[reg.run] ? { calls: perRun[reg.run].calls, usd: perRun[reg.run].usd, credits: perRun[reg.run].credits } : { calls: 0, usd: 0, credits: 0 }, registered_at: new Date(reg.registered_at).toISOString() });
    }
    // Who sent untagged or refused requests today (client = x-client-name, else the user agent's first word).
    const byClient = {};
    for (const r of recs) {
      if (localDay(r.t) !== untagged.day || (!r.untagged && !r.refused)) continue;
      const e = (byClient[r.client || 'unknown'] ||= { untagged: 0, refused: 0, last_purpose: null, last_at: null });
      if (r.untagged && r.attempt === 1 && !r.fallback_from) e.untagged += 1;
      if (r.refused) e.refused += 1;
      e.last_purpose = r.purpose ?? e.last_purpose; e.last_at = new Date(r.t).toISOString();
    }
    return { policy: { allowedPurposes: policy.allowedPurposes, untaggedDailyMax: policy.untaggedDailyMax }, untagged: { day: untagged.day, used: untagged.used, max: policy.untaggedDailyMax, by_client: byClient }, refused: { ...refused }, by_job: byJob, runs: byRun };
  }

  return { register, finish, admit, stats, spent, runs, policy };
}
