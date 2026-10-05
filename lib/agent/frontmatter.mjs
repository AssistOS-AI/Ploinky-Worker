// The YAML frontmatter of a Markdown file (SKILL.md of the Agent Skills format, PLAN.md of the plan cache): the subset these files use.
// Supported: `key: value` scalars (plain, "double" or 'single' quoted; true/false/null and numbers typed), block scalars (`|`, `>`),
// lists (`key:` followed by `- item` lines, or `[a, b]` inline) and one level of nested `key:` maps (Agent Skills `metadata`). Anything
// else is kept as a plain string, never an error: a frontmatter is data, not code.

const scalar = (raw) => {
  const v = raw.trim();
  if (v === '') return '';
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((x) => scalar(x)).filter((x) => x !== '');
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/\s+#.*$/, '');
};

/** Splits a Markdown text into {data, body, hasFrontmatter}. */
export function parseFrontmatter(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m) return { data: {}, body: s, hasFrontmatter: false };
  return { data: parseYamlSubset(m[1]), body: s.slice(m[0].length), hasFrontmatter: true };
}

/** Parses the frontmatter subset described above. */
export function parseYamlSubset(src) {
  const lines = String(src).split(/\r?\n/);
  const data = {};
  const indentOf = (l) => /^ */.exec(l)[0].length;
  let i = 0;
  const block = (start, base, folded) => {
    const out = [];
    let j = start;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() && indentOf(l) <= base) break;
      out.push(l);
    }
    const ind = Math.min(...out.filter((l) => l.trim()).map(indentOf), Infinity);
    const body = out.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
    while (body.length && !body.at(-1).trim()) body.pop();
    return [folded ? body.join('\n').replace(/([^\n])\n(?!\n)/g, '$1 ') : body.join('\n'), j];
  };
  const mapAt = (target, base) => {
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }
      const ind = indentOf(line);
      if (ind < base) return;
      const m = /^\s*([A-Za-z0-9_.-]+)\s*:(?:\s+(.*))?$/.exec(line);
      if (!m) { i++; continue; }
      const key = m[1], rest = (m[2] ?? '').trim();
      i++;
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') { const [v, j] = block(i, ind, rest.startsWith('>')); target[key] = v; i = j; continue; }
      if (rest !== '') { target[key] = scalar(rest); continue; }
      // A list or a nested map follows (or nothing: an empty value).
      let j = i;
      while (j < lines.length && !lines[j].trim()) j++;
      if (j < lines.length && indentOf(lines[j]) > ind && /^\s*-\s/.test(lines[j])) {
        const list = [];
        i = j;
        while (i < lines.length && (!lines[i].trim() || (indentOf(lines[i]) > ind && /^\s*-\s/.test(lines[i])))) { if (lines[i].trim()) list.push(scalar(lines[i].replace(/^\s*-\s/, ''))); i++; }
        target[key] = list;
      } else if (j < lines.length && indentOf(lines[j]) > ind) {
        const nested = {};
        i = j;
        mapAt(nested, indentOf(lines[j]));
        target[key] = nested;
      } else target[key] = '';
    }
  };
  mapAt(data, 0);
  return data;
}

const plain = /^[A-Za-z0-9_./@:+-][A-Za-z0-9_ ./@:+-]*$/;
/** Writes flat key/value data (strings, numbers, booleans, null, lists of scalars) as a frontmatter block. */
export function writeFrontmatter(data) {
  const v = (x) => (x === null || x === undefined ? 'null' : typeof x === 'number' || typeof x === 'boolean' ? String(x)
    : plain.test(String(x)) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(String(x)) && !String(x).endsWith(' ') ? String(x) : JSON.stringify(String(x)));
  const lines = Object.entries(data).map(([k, x]) => (Array.isArray(x) ? `${k}: [${x.map(v).join(', ')}]` : `${k}: ${v(x)}`));
  return `---\n${lines.join('\n')}\n---\n`;
}
