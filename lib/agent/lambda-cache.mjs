// The TaskLambda cache of the agent: the model-written TaskLambdas that worked, in a plain folder a person or a coding agent can read and
// edit. One directory per TaskLambda:
//
//   <lambdas>/<id>/lambda.mjs   the TaskLambda (lib/agent/lambda-code.mjs); edit it freely
//   <lambdas>/<id>/LAMBDA.md    frontmatter (id, origin, status, verified_hash, effects, created, updated, calls) and sections:
//                               Description (edit it to improve matching), Parameters, Effects, Skills, First request, Check, Last calls
//   <lambdas>/<id>/calls.jsonl  one line per call of the TaskLambda (time, call id, how it was chosen, parameters, outcome, ms,
//                               reused_from); the call folders themselves are in the calls folder (lib/lambda/calls.mjs)
//   <lambdas>/index.json        derived: the `meta` of every lambda.mjs by its hash (rebuilt when a lambda changes; safe to delete)
//
// Status: `draft` (stored, never reused), `verified` (passed its own check, or confirmed with `pworker lambdas verify`; reused). A
// TaskLambda whose lambda.mjs no longer has the hash it was verified with is `edited`: it is re-verified (its check runs) before reuse.
//
// Migration (2026-10-03): the folder of earlier versions, `<workdir>/.pworker/plans` with plan.mjs, PLAN.md and runs.jsonl, is moved
// to `.pworker/lambdas` and its entries renamed on first use; a plan without `meta.effects` gets the effects its code shows (inserted
// on its meta line, so line numbers stay), and a plan verified before keeps its verification under the new hash.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, writeFrontmatter } from './frontmatter.mjs';
import { lambdaHash } from './lambda-code.mjs';
import { inferredEffects } from '../lambda/effects.mjs';

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const now = () => new Date().toISOString();
const sectionsOf = (body) => {
  const out = new Map();
  const parts = String(body).split(/^## /m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    out.set((nl < 0 ? part : part.slice(0, nl)).trim(), nl < 0 ? '' : part.slice(nl + 1).trim());
  }
  return { title: parts[0].trim(), sections: out };
};

/** Effective status of a TaskLambda: verified only when its current hash is the hash it was verified with. */
export const effectiveStatus = (front, hash) => (front.status === 'verified' ? (front.verified_hash === hash ? 'verified' : 'edited') : 'draft');

/** Moves an old plan folder (plan.mjs, PLAN.md, runs.jsonl) to the TaskLambda names in place; returns true when it migrated. */
export function migrateEntry(dir) {
  const old = path.join(dir, 'plan.mjs');
  if (!fs.existsSync(old) || fs.existsSync(path.join(dir, 'lambda.mjs'))) return false;
  let code = fs.readFileSync(old, 'utf8');
  const oldHash = lambdaHash(code);
  if (!/\beffects\s*:/.test(code)) code = code.replace(/export\s+const\s+meta\s*=\s*\{/, (m) => `${m}effects: ${JSON.stringify(inferredEffects(code)).replace(/"/g, "'")}, `);
  fs.writeFileSync(path.join(dir, 'lambda.mjs'), code);
  fs.rmSync(old);
  if (fs.existsSync(path.join(dir, 'runs.jsonl'))) fs.renameSync(path.join(dir, 'runs.jsonl'), path.join(dir, 'calls.jsonl'));
  const mdOld = path.join(dir, 'PLAN.md');
  if (fs.existsSync(mdOld)) {
    const { data, body } = parseFrontmatter(fs.readFileSync(mdOld, 'utf8'));
    const front = { ...data, origin: 'model-written', calls: data.runs ?? data.calls ?? 0, migrated: now().slice(0, 10) };
    delete front.runs;
    if (front.status === 'verified' && front.verified_hash === oldHash) front.verified_hash = lambdaHash(code);
    fs.writeFileSync(path.join(dir, 'LAMBDA.md'), writeFrontmatter(front) + body.replace(/^## Last runs$/m, '## Last calls'));
    fs.rmSync(mdOld);
  }
  return true;
}

export class LambdaCache {
  constructor(dir) { this.dir = path.resolve(dir); }

  /** Creates the folder; the first time, moves an old `plans` sibling folder here (the folder of earlier versions). */
  ensure() {
    const old = path.join(path.dirname(this.dir), 'plans');
    if (!fs.existsSync(this.dir) && path.basename(this.dir) === 'lambdas' && fs.existsSync(old) && fs.statSync(old).isDirectory()) fs.renameSync(old, this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) if (e.isDirectory() && ID.test(e.name)) migrateEntry(path.join(this.dir, e.name));
    return this;
  }
  lambdaDir(id) { if (!ID.test(String(id))) throw new Error(`invalid TaskLambda id ${id}`); return path.join(this.dir, id); }
  ids() { return fs.existsSync(this.dir) ? fs.readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && ID.test(e.name) && fs.existsSync(path.join(this.dir, e.name, 'lambda.mjs'))).map((e) => e.name).sort() : []; }
  readIndex() { try { const j = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); return { version: 2, lambdas: j.lambdas ?? {} }; } catch { return { version: 2, lambdas: {} }; } }
  writeIndex(index) { fs.mkdirSync(this.dir, { recursive: true }); const f = path.join(this.dir, 'index.json'); fs.writeFileSync(`${f}.tmp`, JSON.stringify(index, null, 1) + '\n'); fs.renameSync(`${f}.tmp`, f); }

  /** One TaskLambda as stored now: {id, dir, code, hash, front, status, description, firstRequest, md}. Meta comes from `load`. */
  read(id) {
    const dir = this.lambdaDir(id);
    if (!fs.existsSync(path.join(dir, 'lambda.mjs'))) throw new Error(`no TaskLambda ${id} in ${this.dir}`);
    const code = fs.readFileSync(path.join(dir, 'lambda.mjs'), 'utf8');
    const md = fs.existsSync(path.join(dir, 'LAMBDA.md')) ? fs.readFileSync(path.join(dir, 'LAMBDA.md'), 'utf8') : '';
    const { data: front, body } = parseFrontmatter(md);
    const { sections } = sectionsOf(body);
    const hash = lambdaHash(code);
    return { id, dir, code, hash, front, status: effectiveStatus(front, hash), description: sections.get('Description') ?? '', firstRequest: sections.get('First request') ?? '', md };
  }

  /**
   * Every TaskLambda with its meta. `extractMeta(code)` -> {meta} | {error} runs the meta in the sandbox; it is called only for
   * TaskLambdas whose hash is not in index.json (new or edited ones). Returns [{...read(id), meta, metaError}].
   */
  async load({ extractMeta } = {}) {
    const index = this.readIndex();
    let changed = false;
    const out = [];
    for (const id of this.ids()) {
      let p;
      try { p = this.read(id); } catch { continue; }
      let entry = index.lambdas[id];
      if ((!entry || entry.hash !== p.hash) && extractMeta) {
        const r = await extractMeta(p.code);
        entry = { hash: p.hash, meta: r.meta ?? null, error: r.error ?? null };
        index.lambdas[id] = entry; changed = true;
      }
      out.push({ ...p, meta: entry?.hash === p.hash ? entry.meta : null, metaError: entry?.hash === p.hash ? entry.error : 'meta not read' });
    }
    for (const id of Object.keys(index.lambdas)) if (!out.some((p) => p.id === id)) { delete index.lambdas[id]; changed = true; }
    if (changed) this.writeIndex(index);
    return out;
  }

  /** Stores a new TaskLambda (or finds the same code already stored). Returns its id. */
  save({ code, meta, request, verified, check, description = null }) {
    this.ensure();
    const hash = lambdaHash(code);
    // The id names the TaskLambda and its first hash; a folder of that name whose lambda.mjs was edited since is never overwritten.
    let id = `${String(meta.name).slice(0, 48)}-${hash.slice(0, 6)}`;
    for (let n = 2; fs.existsSync(path.join(this.lambdaDir(id), 'lambda.mjs')); n++) {
      if (lambdaHash(fs.readFileSync(path.join(this.lambdaDir(id), 'lambda.mjs'), 'utf8')) === hash) {
        if (verified) this.setStatus(id, 'verified', hash);
        return id;
      }
      id = `${String(meta.name).slice(0, 48)}-${hash.slice(0, 6)}-${n}`;
    }
    const dir = this.lambdaDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lambda.mjs'), code.endsWith('\n') ? code : `${code}\n`);
    const front = { id, origin: 'model-written', status: verified ? 'verified' : 'draft', verified_hash: verified ? hash : null, effects: meta.effects ?? null, created: now(), updated: now(), calls: 0 };
    fs.writeFileSync(path.join(dir, 'LAMBDA.md'), renderLambdaMd({ front, meta, description: description ?? meta.description ?? meta.task, request, check, lastCalls: [] }));
    const index = this.readIndex();
    index.lambdas[id] = { hash, meta, error: null };
    this.writeIndex(index);
    return id;
  }

  /** Rewrites LAMBDA.md's frontmatter and derived sections, keeping the Description a person may have edited. */
  rewrite(id, { front: patch = {}, meta = null, lastCalls = null } = {}) {
    const p = this.read(id);
    const { body } = parseFrontmatter(p.md);
    const { sections } = sectionsOf(body);
    const front = { ...p.front, ...patch, id, updated: now() };
    const m = meta ?? this.readIndex().lambdas[id]?.meta ?? {};
    const text = renderLambdaMd({ front, meta: m, description: sections.get('Description') ?? m.task ?? '', request: sections.get('First request') ?? '',
      check: sections.get('Check') ?? null, lastCalls: lastCalls ?? (sections.get('Last calls') ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) });
    fs.writeFileSync(path.join(p.dir, 'LAMBDA.md'), text);
  }

  setStatus(id, status, hash = null) {
    const p = this.read(id);
    this.rewrite(id, { front: { status, verified_hash: status === 'verified' ? hash ?? p.hash : null } });
  }

  /** `pworker lambdas verify`: a person confirms the TaskLambda as it is now. */
  verify(id) { const p = this.read(id); this.setStatus(id, 'verified', p.hash); return this.read(id); }

  /** Appends a call to calls.jsonl and to LAMBDA.md's last calls (at most 5 kept there). */
  recordCall(id, call) {
    const p = this.read(id);
    const line = { at: now(), ...call, hash: p.hash };
    fs.appendFileSync(path.join(p.dir, 'calls.jsonl'), JSON.stringify(line) + '\n');
    const { sections } = sectionsOf(parseFrontmatter(p.md).body);
    const last = (sections.get('Last calls') ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
    const entry = `${line.at.slice(0, 19)}Z ${call.ok ? 'ok' : 'failed'} ${call.how ?? ''}${call.reused_from ? ` reused ${call.reused_from}` : ''} ${call.ms ?? '?'} ms ${JSON.stringify(call.params ?? {}).slice(0, 160)}${call.call ? ` (call ${call.call})` : ''}`;
    this.rewrite(id, { front: { calls: Number(p.front.calls ?? 0) + 1, last_used: line.at }, lastCalls: [entry, ...last].slice(0, 5) });
  }

  calls(id) {
    const f = path.join(this.lambdaDir(id), 'calls.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  }

  remove(id) {
    const dir = this.lambdaDir(id);
    if (!fs.existsSync(dir)) throw new Error(`no TaskLambda ${id}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const index = this.readIndex();
    delete index.lambdas[id];
    this.writeIndex(index);
  }
}

/** LAMBDA.md of a TaskLambda. */
export function renderLambdaMd({ front, meta, description, request, check, lastCalls }) {
  const params = Object.entries(meta?.params ?? {});
  return `${writeFrontmatter(front)}# ${meta?.name ?? front.id}

## Description
${String(description ?? '').trim() || '(none)'}

## Parameters
${params.length ? params.map(([k, d]) => `- \`${k}\` (${d.type}${d.default !== undefined ? `, default ${JSON.stringify(d.default)}` : ''}): ${d.description ?? ''}`).join('\n') : '(none)'}

## Effects
${(meta?.effects ?? []).join(', ') || '(not declared)'}

## Skills
${(meta?.skills ?? []).length ? meta.skills.join(', ') : '(none)'}

## First request
${String(request ?? '').trim() || '(unknown)'}

## Check
${check ?? '(none)'}

## Last calls
${(lastCalls ?? []).map((l) => `- ${l}`).join('\n') || '(none)'}
`;
}
