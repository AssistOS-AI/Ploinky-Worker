// TaskLambdaCalls: every invocation of a TaskLambda owns a folder, so what each call was given, what it produced, what it changed and
// which models it asked can be read back. Together the folders are an auditable cache of past activity. A plain folder, visible and
// editable (default `~/.pworker/calls`, configuration `calls.dir`, option `--calls DIR`):
//
//   <root>/<YYYY-MM-DD>/index.jsonl                 one line per call event (started, finished, pruned) of the calls started that day
//   <root>/<YYYY-MM-DD>/<lambda-name>-<short-id>/   a top-level call
//       call.json      lambda (name, hash, origin, effects), params, attachments, caller, purpose, run tag, parent and root call ids,
//                      work folder, timestamps; at the end also the inputs read (paths with content hashes), status and ms
//       inputs.jsonl   the files read, listings and searches made, each with the sha256 of what the call saw
//       output.json    status ok | failed | stopped, result, error, reused_from (the call whose output was returned without running)
//       effects.jsonl  every write, move or delete (path, before/after sha256), recorded by the tools layer; scripts run
//       models.jsonl   every model call: role, tier, model, tokens, credits, USD, cache key, cached yes/no, ms
//       log.txt        progress lines
//       summary.json   the effect and model summaries and the number of child calls (written at the end; kept by prune)
//       calls/<lambda-name>-<short-id>/ ...           child calls (same layout), so the call tree is the folder tree
//   <root>/reuse/<k0k1>/<key>.json                  the last successful call of a pure TaskLambda for one reuse key
//
// Result reuse: a `pure` TaskLambda called with the same lambda hash, parameters, work folder and attachments, whose recorded inputs
// (the files it read, the listings and searches it made) still have the same hashes, returns the recorded output marked
// `reused_from: <call id>` without running. A call with effects is never replayed.
//
// Prune: after `calls.keepArtifactsDays` days a call folder keeps call.json, output.json and summary.json; everything else (logs, the
// effect and model line files, artifacts such as outputs and lambda code) is removed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { isPure } from './effects.mjs';

export const KEEP_ON_PRUNE = Object.freeze(['call.json', 'output.json', 'summary.json']);
export const CALL_DEFAULTS = Object.freeze({ dir: null, keepArtifactsDays: 30, jobItems: true, maxResultBytes: 1_000_000, maxInputs: 2000 });
const ID = /^\d{8}-\d{6}-[0-9a-f]{8}$/;

export const sha256 = (data) => createHash('sha256').update(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data)).digest('hex');
/** JSON with object keys sorted (a stable text for hashing parameters). */
export const canonical = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));
const safeName = (n) => String(n ?? 'call').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 48) || 'call';
const writeJson = (file, data) => { const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`; fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n'); fs.renameSync(tmp, file); };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const readLines = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const clip = (v, n = 300) => { const s = typeof v === 'string' ? v : JSON.stringify(v ?? null); return s.length > n ? `${s.slice(0, n)}…` : s; };

/** The status of a call from a lambda's own result status (finished, ok, planned -> ok; stopped -> stopped; anything else -> failed). */
export const callStatus = (s) => (['finished', 'ok', 'planned', 'no_plan'].includes(s) ? 'ok' : s === 'stopped' ? 'stopped' : 'failed');

/** Model-call row of models.jsonl from a Ploinky Workers client result (lib/client.mjs chat/json) or a job runner call result. */
export function modelRow(r, { role = null, tier = null, model = null } = {}) {
  return { at: new Date().toISOString(), role, tier: r?.tier ?? tier, model: r?.served ?? model ?? null, ok: r?.ok !== false, in: r?.usage?.in ?? 0, out: r?.usage?.out ?? 0,
    credits: Number(r?.credits) || 0, usd: Number(r?.usd) || 0, cache_key: r?.cacheKey ?? r?.key ?? null, cached: !!r?.cached, ms: r?.ms ?? null, ...(r?.calls > 1 ? { calls: r.calls } : {}), ...(r?.ok === false ? { reason: clip(r.reason ?? r.error, 200) } : {}) };
}

/** Summaries of a call folder's effects.jsonl and models.jsonl. */
export function summarize(dir) {
  const effects = readLines(path.join(dir, 'effects.jsonl')), models = readLines(path.join(dir, 'models.jsonl'));
  const byKind = {}, byTier = {};
  for (const e of effects) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
  const m = { calls: 0, cached: 0, failed: 0, credits: 0, usd: 0, in: 0, out: 0 };
  for (const r of models) {
    m.calls += 1; if (r.cached) m.cached += 1; if (r.ok === false) m.failed += 1;
    m.credits += r.credits ?? 0; m.usd += r.usd ?? 0; m.in += r.in ?? 0; m.out += r.out ?? 0;
    const t = (byTier[r.tier ?? '?'] ??= { calls: 0, credits: 0, cached: 0 }); t.calls += 1; t.credits += r.credits ?? 0; if (r.cached) t.cached += 1;
  }
  m.credits = Math.round(m.credits * 1000) / 1000; m.usd = Math.round(m.usd * 1e6) / 1e6;
  const children = fs.existsSync(path.join(dir, 'calls')) ? fs.readdirSync(path.join(dir, 'calls')).length : 0;
  return { effects: { count: effects.length, by_kind: byKind, paths: [...new Set(effects.map((e) => e.path ?? e.to ?? e.script).filter(Boolean))].slice(0, 20) }, models: { ...m, by_tier: byTier }, children };
}

/** One call folder while it runs (or reopened): append its lines, add children, finish it. */
export class CallHandle {
  constructor(store, dir, record) { this.store = store; this.dir = dir; this.record = record; this.id = record.id; }
  get path() { return this.record.path; }
  file(name) { return path.join(this.dir, name); }
  log(line) { fs.appendFileSync(this.file('log.txt'), `${String(line).slice(0, 4000)}\n`); }
  /** An effect: {kind: write|move|delete|script, path, from, to, before, after, bytes, ...}. */
  effect(e) { fs.appendFileSync(this.file('effects.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...e }) + '\n'); }
  /** A model call: a client result (see modelRow) or a ready row. */
  model(r, o = {}) { fs.appendFileSync(this.file('models.jsonl'), JSON.stringify(r?.at && 'cache_key' in r ? r : modelRow(r, o)) + '\n'); }
  /**
   * An input the call read (a file, a listing, a search) with the hash of what it saw: one line of inputs.jsonl (so another thread may
   * record them too), folded into call.json when the call ends. Beyond `maxInputs` the inputs are marked incomplete (never reused).
   */
  input(i) {
    const k = canonical(i);
    if (this.seen?.has(k)) return;
    (this.seen ??= new Set()).add(k);
    fs.appendFileSync(this.file('inputs.jsonl'), (this.seen.size > this.store.maxInputs ? JSON.stringify({ truncated: true }) : k) + '\n');
  }
  /** Rewrites call.json with a patch (for example the lambda once resolved), over what is on disk (another thread may have written it). */
  update(patch) { this.record = { ...(readJson(this.file('call.json')) ?? this.record), ...patch }; writeJson(this.file('call.json'), this.record); return this; }
  /** A child call, in `calls/` of this folder. */
  child(o) { return this.store.start({ ...o, parent: this }); }

  /** Ends the call: output.json, summary.json, call.json (status, ms, inputs), the index, and the reuse pointer of a pure call. */
  finish({ status = 'ok', result = null, error = null, reused_from = null, reuseKey = null, at: when = null } = {}) {
    this.record = readJson(this.file('call.json')) ?? this.record;
    // `at`: the end time of a call wrapped after the fact (an imported run folder); otherwise now.
    const at = when && !Number.isNaN(Date.parse(when)) ? new Date(when).toISOString() : new Date().toISOString();
    const ms = Date.parse(at) - Date.parse(this.record.started_at);
    let text = JSON.stringify(result ?? null);
    const out = { id: this.id, status, result: result ?? null, error: error ? clip(error, 4000) : null, ...(reused_from ? { reused_from } : {}), finished_at: at };
    if (text.length > this.store.maxResultBytes) { fs.writeFileSync(this.file('result.json'), text); out.result = null; out.result_truncated = true; out.result_file = 'result.json'; out.preview = text.slice(0, 2000); }
    writeJson(this.file('output.json'), out);
    const summary = { ...summarize(this.dir), ms };
    writeJson(this.file('summary.json'), summary);
    const lines = readLines(this.file('inputs.jsonl'));
    const inputs = lines.filter((x) => !x.truncated).slice(0, this.store.maxInputs), complete = !lines.some((x) => x.truncated);
    this.update({ status, finished_at: at, ms, ...(inputs.length ? { inputs } : {}), inputs_complete: complete, ...(reused_from ? { reused_from } : {}) });
    this.store.index(this.record.started_at, { event: 'finished', id: this.id, status, ms, at, ...(reused_from ? { reused_from } : {}), credits: summary.models.credits, effects: summary.effects.count, children: summary.children });
    const key = reuseKey ?? this.record.reuse_key ?? null;
    if (key && status === 'ok' && !reused_from && !out.result_truncated && complete && isPure(this.record.lambda?.effects)) this.store.pointReuse(key, this);
    return out;
  }
}

export class CallStore {
  /** `root`: the calls folder (absolute). Options: maxResultBytes (larger results go to result.json), maxInputs (recorded per call). */
  constructor(root, { maxResultBytes = CALL_DEFAULTS.maxResultBytes, maxInputs = CALL_DEFAULTS.maxInputs } = {}) {
    if (!root) throw new Error('a calls folder is required');
    this.root = path.resolve(root); this.maxResultBytes = maxResultBytes; this.maxInputs = maxInputs;
  }
  ensure() { fs.mkdirSync(this.root, { recursive: true }); return this; }
  dayOf(iso) { return String(iso).slice(0, 10); }
  index(startedAt, row) { const d = path.join(this.root, this.dayOf(startedAt)); fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, 'index.jsonl'), JSON.stringify(row) + '\n'); }

  /**
   * Starts a call: creates its folder (under its parent's `calls/` when `parent` is a handle) and writes call.json and the index line.
   * `lambda`: {name, hash, origin, effects, status?}; `params`; `attachments`: [{name, sha256, bytes}]; `caller`, `purpose`, `run`,
   * `workdir`, `reuseKey`, `extra` (more call.json fields). Returns a CallHandle.
   */
  start({ lambda, params = {}, attachments = [], caller = null, purpose = null, run = null, parent = null, workdir = null, reuseKey = null, extra = {}, now = new Date() } = {}) {
    if (!lambda?.name) throw new Error('a call needs lambda.name');
    const at = now.toISOString();
    const hex = randomBytes(4).toString('hex');
    const id = `${at.slice(0, 10).replace(/-/g, '')}-${at.slice(11, 19).replace(/:/g, '')}-${hex}`;
    const folder = `${safeName(lambda.name)}-${hex}`;
    const parentDir = parent?.dir ?? null;
    const dir = parentDir ? path.join(parentDir, 'calls', folder) : path.join(this.root, this.dayOf(at), folder);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.relative(this.root, dir).split(path.sep).join('/');
    const record = { id, path: rel, lambda: { name: lambda.name, hash: lambda.hash ?? null, origin: lambda.origin ?? null, effects: lambda.effects ?? null, ...(lambda.status ? { status: lambda.status } : {}), ...(lambda.source ? { source: lambda.source } : {}) },
      params, ...(attachments.length ? { attachments } : {}), caller, purpose, run, parent: parent?.id ?? (typeof parent === 'string' ? parent : null), root: parent?.record?.root ?? parent?.id ?? id,
      ...(workdir ? { workdir } : {}), ...(reuseKey ? { reuse_key: reuseKey } : {}), ...extra, started_at: at, pid: process.pid, status: 'running' };
    writeJson(path.join(dir, 'call.json'), record);
    this.index(at, { event: 'started', id, path: rel, lambda: lambda.name, hash: lambda.hash ?? null, origin: lambda.origin ?? null, parent: record.parent, root: record.root, caller, purpose, run, params: clip(params, 300), at });
    return new CallHandle(this, dir, record);
  }

  /** A handle on an existing call folder (another thread or process continues writing its lines). */
  openDir(dir) { const rec = readJson(path.join(dir, 'call.json')); if (!rec) throw new Error(`no call.json in ${dir}`); return new CallHandle(this, dir, rec); }

  /** The days with calls, newest first. */
  days() { return fs.existsSync(this.root) ? fs.readdirSync(this.root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse() : []; }

  /** The calls of the index, one record per id (events folded), newest first. */
  entries({ days = null } = {}) {
    const out = [];
    for (const day of days ?? this.days()) {
      const byId = new Map();
      for (const e of readLines(path.join(this.root, day, 'index.jsonl'))) {
        const cur = byId.get(e.id) ?? { status: 'running' };
        const { event, at, ...rest } = e;
        byId.set(e.id, event === 'started' ? { ...cur, ...rest, started_at: at } : event === 'finished' ? { ...cur, ...rest, finished_at: at } : { ...cur, [`${event}_at`]: at });
      }
      out.push(...[...byId.values()].filter((e) => e.path).reverse());
    }
    return out;
  }

  /** Searches the index: `lambda` (a name), `status`, `parent` (a call id), `root`, `date` (YYYY-MM-DD), `since`, `until`, `text` (in the
   * parameters, lambda name, purpose or run tag), `topLevel` (only calls without a parent), `limit` (default 50). */
  search({ lambda = null, status = null, parent = null, root = null, date = null, since = null, until = null, text = null, topLevel = false, limit = 50 } = {}) {
    const days = this.days().filter((d) => (!date || d === date) && (!since || d >= since.slice(0, 10)) && (!until || d <= until.slice(0, 10)));
    const needle = text ? String(text).toLowerCase() : null;
    const hits = [];
    for (const e of this.entries({ days })) {
      if (lambda && e.lambda !== lambda) continue;
      if (status && e.status !== status) continue;
      if (parent && e.parent !== parent) continue;
      if (root && e.root !== root) continue;
      if (topLevel && e.parent) continue;
      if (needle && ![e.params, e.lambda, e.purpose, e.run, e.id].some((x) => String(x ?? '').toLowerCase().includes(needle))) continue;
      hits.push(e);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** The folder of a call id ({id, dir}) or null. The id names its day; a child started after midnight is found by a wider scan. */
  find(id) {
    if (!ID.test(String(id))) throw new Error(`invalid call id ${id}`);
    const day = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
    const e = this.entries({ days: [day] }).find((x) => x.id === id) ?? this.entries().find((x) => x.id === id);
    return e ? { id, dir: path.join(this.root, e.path), entry: e } : null;
  }

  /** call.json, output.json and summary.json of a call, with its folder. */
  show(id) {
    const f = this.find(id);
    if (!f) return null;
    return { dir: f.dir, call: readJson(path.join(f.dir, 'call.json')), output: readJson(path.join(f.dir, 'output.json')), summary: readJson(path.join(f.dir, 'summary.json')),
      files: fs.readdirSync(f.dir).sort() };
  }

  /** The call tree under a call (from its folders): {id, lambda, status, ms, reused_from, children: [...], more}. */
  tree(id, { maxChildren = 50, depth = 6 } = {}) {
    const f = this.find(id);
    if (!f) return null;
    const node = (dir, d) => {
      const c = readJson(path.join(dir, 'call.json')) ?? {}, o = readJson(path.join(dir, 'output.json'));
      const sub = path.join(dir, 'calls');
      const kids = d < depth && fs.existsSync(sub) ? fs.readdirSync(sub).map((n) => path.join(sub, n)).filter((p) => fs.existsSync(path.join(p, 'call.json'))) : [];
      const sorted = kids.map((p) => [p, readJson(path.join(p, 'call.json'))?.started_at ?? '']).sort((a, b) => a[1].localeCompare(b[1])).map(([p]) => p);
      return { id: c.id, lambda: c.lambda?.name, hash: c.lambda?.hash ?? null, status: o?.status ?? c.status ?? 'running', ms: c.ms ?? null, ...(o?.reused_from ? { reused_from: o.reused_from } : {}),
        params: clip(c.params, 160), children: sorted.slice(0, maxChildren).map((p) => node(p, d + 1)), more: Math.max(0, sorted.length - maxChildren) };
    };
    return node(f.dir, 0);
  }

  /** The reuse key of a call: the lambda hash, the parameters, the work folder and the attachments' hashes. */
  static reuseKey({ hash, params = {}, workdir = null, attachments = [] }) {
    return sha256(canonical({ hash, params, workdir, attachments: attachments.map((a) => ({ name: a.name, sha256: a.sha256 })) }));
  }
  reuseFile(key) { return path.join(this.root, 'reuse', key.slice(0, 2), `${key}.json`); }
  pointReuse(key, handle) { const f = this.reuseFile(key); fs.mkdirSync(path.dirname(f), { recursive: true }); writeJson(f, { key, id: handle.id, path: handle.path, lambda: handle.record.lambda?.name, at: new Date().toISOString() }); }

  /**
   * The recorded output for a reuse key, or null: the last successful call for the key whose recorded inputs still hold
   * (`verify(inputs)` -> true; for example the files it read still have the same hashes). Returns {id, dir, output, call}.
   */
  findReusable(key, verify = () => true) {
    const p = readJson(this.reuseFile(key));
    if (!p?.path) return null;
    const dir = path.join(this.root, p.path);
    const call = readJson(path.join(dir, 'call.json')), output = readJson(path.join(dir, 'output.json'));
    if (!call || !output || output.status !== 'ok' || output.result_truncated || call.inputs_complete === false || !isPure(call.lambda?.effects)) return null;
    let ok = false;
    try { ok = verify(call.inputs ?? []) === true; } catch { ok = false; }
    return ok ? { id: call.id, dir, output, call } : null;
  }

  /**
   * Prunes the artifacts of calls started more than `days` days before `now`: every call folder (children included) keeps
   * call.json, output.json and summary.json. A call still running is left as it is. Returns {calls, files, bytes, days: [...]}.
   */
  prune({ days = CALL_DEFAULTS.keepArtifactsDays, now = Date.now(), dryRun = false } = {}) {
    const cutoff = new Date(now - days * 86400_000).toISOString().slice(0, 10);
    const stats = { calls: 0, files: 0, bytes: 0, days: [] };
    const sizeOf = (p) => { const st = fs.lstatSync(p); if (!st.isDirectory()) return st.size; return fs.readdirSync(p).reduce((s, n) => s + sizeOf(path.join(p, n)), 0); };
    const countOf = (p) => { const st = fs.lstatSync(p); if (!st.isDirectory()) return 1; return fs.readdirSync(p).reduce((s, n) => s + countOf(path.join(p, n)), 0); };
    const pruneCall = (dir) => {
      if (!fs.existsSync(path.join(dir, 'output.json'))) return;
      let touched = false;
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        if (KEEP_ON_PRUNE.includes(n)) continue;
        if (n === 'calls' && fs.statSync(p).isDirectory()) { for (const c of fs.readdirSync(p)) pruneCall(path.join(p, c)); continue; }
        stats.files += countOf(p); stats.bytes += sizeOf(p); touched = true;
        if (!dryRun) fs.rmSync(p, { recursive: true, force: true });
      }
      if (touched) { stats.calls += 1; if (!dryRun) { const s = readJson(path.join(dir, 'summary.json')) ?? {}; writeJson(path.join(dir, 'summary.json'), { ...s, pruned_at: new Date(now).toISOString() }); } }
    };
    for (const day of this.days().filter((d) => d < cutoff)) {
      stats.days.push(day);
      for (const n of fs.readdirSync(path.join(this.root, day))) { const p = path.join(this.root, day, n); if (fs.statSync(p).isDirectory()) pruneCall(p); }
      if (!dryRun) this.index(`${day}T00:00:00Z`, { event: 'pruned', id: `day-${day}`, at: new Date(now).toISOString() });
    }
    return stats;
  }
}

/** The sha256 of a file's bytes, or null when it does not exist. */
export function fileHash(file) { try { return sha256(fs.readFileSync(file)); } catch { return null; } }
