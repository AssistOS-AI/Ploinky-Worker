// Audit store (config.audit): request/response pairs of the configured tiers or upstreams, kept for a later review by a cheap
// model in batch work (chat traffic is only logged). One JSONL file per day under <dir>; a day stops recording at maxBytesPerDay
// (counted, never truncating a line) and files older than maxDays are deleted.
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function createAudit(cfg, { dir, now = Date.now } = {}) {
  if (!cfg?.enabled) return null;
  mkdirSync(dir, { recursive: true });
  const tiers = new Set(cfg.tiers || []), ups = new Set(cfg.upstreams || []);
  const maxBytes = cfg.maxBytesPerDay ?? 200 * 1024 * 1024;
  const maxChars = cfg.maxCharsPerField ?? 200000;
  const counts = { recorded: 0, skipped_full: 0, by_purpose: {} };
  let pruned = '';

  const day = () => new Date(now()).toISOString().slice(0, 10);
  function prune(d) {
    if (pruned === d) return;
    pruned = d;
    const keep = new Date(now() - (cfg.maxDays ?? 14) * 86400000).toISOString().slice(0, 10);
    for (const f of readdirSync(dir)) if (/^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(6, 16) < keep) unlinkSync(join(dir, f));
  }
  const cut = (s) => (typeof s === 'string' && s.length > maxChars ? s.slice(0, maxChars) + `…[+${s.length - maxChars} chars]` : s);

  return {
    wants: (rec) => (rec.tier && tiers.has(rec.tier)) || ups.has(rec.upstream),
    record(rec, request, response) {
      const d = day(); prune(d);
      const file = join(dir, `audit-${d}.jsonl`);
      if (existsSync(file) && statSync(file).size > maxBytes) { counts.skipped_full += 1; return; }
      const line = JSON.stringify({ t: new Date(now()).toISOString(), id: rec.id, purpose: rec.purpose ?? null, run: rec.run ?? null, tier: rec.tier ?? null,
        upstream: rec.upstream, model: rec.model, status: rec.status, fallback_from: rec.fallback_from ?? null,
        request: { messages: request?.messages?.map((m) => ({ role: m.role, content: cut(typeof m.content === 'string' ? m.content : JSON.stringify(m.content)) })) ?? null, system: cut(typeof request?.system === 'string' ? request.system : undefined) },
        response: cut(response) });
      appendFileSync(file, line + '\n');
      counts.recorded += 1;
      const p = rec.purpose || 'untagged';
      counts.by_purpose[p] = (counts.by_purpose[p] || 0) + 1;
    },
    stats: () => ({ dir, ...counts }),
  };
}

// The text of a completion: OpenAI or Anthropic, whole JSON body or SSE lines.
export function responseText(format, isSse, raw) {
  if (!raw) return '';
  if (!isSse) {
    try { const j = JSON.parse(raw); return format === 'anthropic' ? (j.content || []).map((c) => c.text || '').join('') : (j.choices?.[0]?.message?.content ?? ''); } catch { return raw; }
  }
  let out = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try { const j = JSON.parse(d); out += format === 'anthropic' ? (j.delta?.text ?? '') : (j.choices?.[0]?.delta?.content ?? ''); } catch { /* ignore */ }
  }
  return out;
}
