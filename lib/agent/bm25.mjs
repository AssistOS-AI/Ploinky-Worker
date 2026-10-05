// BM25 (Okapi) over a few hundred short documents, built in memory in milliseconds: the fast candidate search of the plan cache. A
// document is a list of fields ({text, weight}); a field's weight repeats its terms. Terms: lowercase letters and digits of any script,
// at least two characters, with a light suffix fold (plural -s, -es, -ies) so "files" finds "file". No stop-word list: the inverse
// document frequency already gives words that every plan shares little weight.

const TOKEN = /[\p{L}\p{N}]+/gu;

/** The terms of a text. */
export function terms(text) {
  const out = [];
  for (const m of String(text ?? '').toLowerCase().matchAll(TOKEN)) {
    let t = m[0];
    if (t.length < 2) continue;
    if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
    else if (t.length > 4 && /(?:ss|x|ch|sh)es$/.test(t)) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

/**
 * Builds an index over `docs` ([{id, fields: [{text, weight?}]}]). `k1` and `b` are the usual BM25 constants.
 * Returns {size, search(query, {k, minScore}) -> [{id, score}] best first}.
 */
export function buildIndex(docs, { k1 = 1.2, b = 0.75 } = {}) {
  const rows = docs.map((d) => {
    const tf = new Map();
    let len = 0;
    for (const f of d.fields ?? []) {
      const w = Math.max(1, Math.round(f.weight ?? 1));
      for (const t of terms(f.text)) { tf.set(t, (tf.get(t) ?? 0) + w); len += w; }
    }
    return { id: d.id, tf, len };
  });
  const df = new Map();
  for (const r of rows) for (const t of r.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = rows.length;
  const avg = N ? rows.reduce((s, r) => s + r.len, 0) / N : 0;
  const idf = (t) => { const n = df.get(t) ?? 0; return Math.log(1 + (N - n + 0.5) / (n + 0.5)); };
  return {
    size: N,
    search(query, { k = 3, minScore = 0 } = {}) {
      const q = [...new Set(terms(query))];
      const scored = [];
      for (const r of rows) {
        let s = 0;
        for (const t of q) {
          const f = r.tf.get(t);
          if (!f) continue;
          s += idf(t) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (r.len / (avg || 1))));
        }
        if (s > minScore) scored.push({ id: r.id, score: Math.round(s * 1000) / 1000 });
      }
      return scored.sort((x, y) => y.score - x.score || String(x.id).localeCompare(String(y.id))).slice(0, k);
    },
  };
}
