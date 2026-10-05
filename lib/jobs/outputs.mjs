/**
 * Parsing and the built-in checks of model outputs. Formats:
 *   text   the reply as is (code fences around the whole reply removed when `output.stripFences`): `{text}`
 *   jsonl  JSON lines: `{records: [...]}` per item; in a packed call every line carries the item id (`output.idField`, default "id")
 * The checks plugin (job spec `checks`) runs after the built-in checks: `parse(text, item)`, `check(item, output, ctx)`,
 * `repairHint(item, output, problems, ctx)` and `score(item, output)`, all pure (a domain validator is a check plugin).
 */

const stripFences = t => String(t ?? '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

/** Every JSON object of a reply (one per line, or a JSON array), prose and fences ignored; bad lines are counted. */
export function jsonLines(text) {
  const out = [];
  let bad = 0;
  const src = String(text ?? '').replace(/```[a-z]*\n?/gi, '');
  for (const raw of src.split('\n')) {
    const line = raw.trim().replace(/,$/, '');
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try { const v = JSON.parse(line); for (const o of Array.isArray(v) ? v : [v]) if (o && typeof o === 'object') out.push(o); } catch { bad += 1; }
  }
  if (!out.length) { try { const v = JSON.parse(src.trim()); for (const o of Array.isArray(v) ? v : [v]) if (o && typeof o === 'object') out.push(o); bad = 0; } catch { /* none */ } }
  return {objects: out, bad};
}

/** Splits one reply into raw per-item outputs: `{[id]: {text}|{records}|{sop}}`; an item with nothing is absent. */
export function splitReply(text, ids, output) {
  const fmt = output.format;
  if (fmt !== 'jsonl') return ids.length === 1 && String(text ?? '').trim() ? {[ids[0]]: {text: output.stripFences ? stripFences(text) : String(text).trim()}} : {};
  const idField = output.idField ?? 'id';
  const {objects} = jsonLines(text);
  const known = new Set(ids.map(String));
  const out = {};
  for (const o of objects) {
    if (o.done === true && Object.keys(o).length === 1) continue;
    const id = o[idField] != null ? String(o[idField]) : ids.length === 1 ? String(ids[0]) : null;
    if (id == null || !known.has(id)) continue;
    (out[id] ||= {records: []}).records.push(o);
  }
  return out;
}

const TYPES = {string: v => typeof v === 'string', number: v => typeof v === 'number' && Number.isFinite(v), boolean: v => typeof v === 'boolean', array: Array.isArray, object: v => v && typeof v === 'object' && !Array.isArray(v), any: () => true};

/** Built-in checks: empty output, jsonl field types and enums. Returns `{ok, empty, problems}`. */
export function builtinCheck(out, output) {
  if (!out) return {ok: false, empty: true, problems: ['no output for this item']};
  if (output.format === 'text') return out.text?.trim() ? {ok: true, problems: []} : {ok: false, empty: true, problems: ['empty output']};
  const all = out.records ?? [];
  if (!all.length) return {ok: false, empty: true, problems: ['no JSON line for this item']};
  const recs = all.filter(r => r.none !== true); // {"none": true} says the item has nothing to report
  if (output.minRecords != null && recs.length < output.minRecords) return {ok: false, problems: [`expected at least ${output.minRecords} lines, got ${recs.length}`]};
  const problems = [];
  for (const [i, r] of recs.entries()) {
    for (const [field, def] of Object.entries(output.fields ?? {})) {
      const d = typeof def === 'string' ? {type: def} : def;
      const v = r[field];
      if (v == null) { if (d.required !== false) problems.push(`line ${i + 1}: missing "${field}"`); continue; }
      if (!(TYPES[d.type ?? 'any'] ?? TYPES.any)(v)) problems.push(`line ${i + 1}: "${field}" must be ${d.type}`);
      else if (d.enum && !d.enum.includes(v)) problems.push(`line ${i + 1}: "${field}" must be one of ${d.enum.join(', ')}`);
    }
  }
  return {ok: !problems.length, problems};
}

/** Built-in then job checks; a throwing job check is a rejection with the error (never an acceptance). */
export function checkItem(item, out, {output, checks, params}) {
  const b = builtinCheck(out, output);
  if (!b.ok) return b;
  if (typeof checks.check !== 'function') return b;
  try {
    const r = checks.check(item, out, {params}) ?? {ok: true};
    if (r.ok) return {ok: true, problems: [], value: r.value};
    const problems = r.problems ?? ['rejected by the checks plugin'];
    let hint = r.hint ?? null;
    if (!hint && typeof checks.repairHint === 'function') { try { hint = checks.repairHint(item, out, problems, {params}) ?? null; } catch { /* no hint */ } }
    return {ok: false, empty: !!r.empty, problems, hint};
  } catch (e) { return {ok: false, problems: [`the checks plugin threw: ${e.message}`]}; }
}

/** The output as text for repair conversations and the audit. */
export function outputText(out, output) {
  if (!out) return '';
  if (output.format === 'jsonl') return (out.records ?? []).map(r => JSON.stringify(r)).join('\n');
  return out.text ?? '';
}
