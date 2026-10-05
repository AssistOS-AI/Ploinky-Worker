/**
 * Job inputs: a JSONL `path` (relative to the job folder), a generator `command` whose stdout is JSONL (run in the job folder), inline
 * `items`, a `module` plugin exporting `inputs(ctx)` -> items (async allowed), or `attachments` (the task's attached text files cut into
 * chunks along blank lines: `{chunkChars}`; items `{id, name, chunk, of, start_line, end_line, text}`). Selection is deterministic: `where` filters, `ids`
 * keeps a list, `n` + `seed` takes the first n items by the hash rank of (seed, id). Stages run prefixes of the selected order.
 */
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {rank} from './util.mjs';

function readRows(file) {
  if (!fs.existsSync(file)) throw new Error(`inputs.path: ${file} does not exist`);
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${file}:${i + 1}: not JSON`); }
  });
}

/** Cuts a text into chunks of at most `max` characters at blank lines (a longer paragraph is cut at line ends). */
export function chunkText(text, max = 6000) {
  const lines = String(text).split('\n');
  const out = [];
  let cur = [], size = 0, start = 1;
  const flush = end => { if (cur.length && cur.join('\n').trim()) out.push({text: cur.join('\n'), start_line: start, end_line: end}); cur = []; size = 0; };
  lines.forEach((line, i) => {
    if (size + line.length + 1 > max && cur.length && (line.trim() === '' || size > max * 0.8 || size + line.length + 1 > max)) { flush(i); start = i + 1; }
    if (!cur.length) start = i + 1;
    cur.push(line); size += line.length + 1;
  });
  flush(lines.length);
  return out;
}

export async function rawInputs(inputs, {dir, ctx = {}} = {}) {
  if (inputs.items) return inputs.items;
  if (inputs.attachments) {
    const max = inputs.attachments.chunkChars ?? 6000;
    return (ctx.attachments ?? []).flatMap(a => {
      const chunks = chunkText(fs.readFileSync(a.path, 'utf8'), max);
      const slug = String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'doc';
      return chunks.map((c, i) => ({id: `${slug}-${String(i + 1).padStart(3, '0')}`, name: a.name, chunk: i + 1, of: chunks.length, ...c}));
    });
  }
  if (inputs.path) return readRows(path.resolve(dir, inputs.path));
  if (inputs.module) {
    const mod = await import(pathToFileURL(path.resolve(dir, inputs.module)).href);
    if (typeof mod.inputs !== 'function') throw new Error(`inputs.module ${inputs.module} exports no inputs(ctx)`);
    return await mod.inputs({...ctx, dir, options: inputs.options ?? {}});
  }
  const [cmd, ...args] = inputs.command;
  const r = spawnSync(cmd === 'node' ? process.execPath : cmd, args, {cwd: dir, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024});
  if (r.status !== 0) throw new Error(`inputs.command failed (${r.status}): ${(r.stderr || '').slice(0, 400)}`);
  return r.stdout.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/** Selected items `{id, data, prompt}` in run order; `prompt` holds only `promptFields`. */
export async function loadInputs(inputs, {dir, ctx = {}} = {}) {
  const idField = inputs.idField ?? 'id';
  const seen = new Set();
  let rows = (await rawInputs(inputs, {dir, ctx})).map((data, i) => {
    const id = data?.[idField];
    if (id == null || String(id).trim() === '') throw new Error(`input ${i + 1} has no ${idField}`);
    if (seen.has(String(id))) throw new Error(`duplicate input id ${id}`);
    seen.add(String(id));
    return {id: String(id), data};
  });
  const sel = inputs.select ?? {};
  for (const [field, want] of Object.entries(sel.where ?? {})) {
    const set = new Set([].concat(want).map(String));
    rows = rows.filter(r => set.has(String(r.data[field])));
  }
  if (sel.ids) { const set = new Set(sel.ids.map(String)); rows = rows.filter(r => set.has(r.id)); }
  if (sel.seed != null) rows = rows.map(r => ({r, k: rank(sel.seed, r.id)})).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)).map(x => x.r);
  if (sel.n != null) rows = rows.slice(0, sel.n);
  return rows.map(({id, data}) => {
    const prompt = {};
    for (const f of inputs.promptFields) {
      if (data[f] === undefined) throw new Error(`input ${id}: prompt field "${f}" is missing`);
      prompt[f] = data[f];
    }
    return {id, data, prompt};
  });
}
