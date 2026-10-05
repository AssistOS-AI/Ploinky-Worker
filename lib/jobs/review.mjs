/**
 * The two cheap supervisory steps of a run, both deterministic in what they may change:
 *
 *   audit    a sample of accepted items (rate, deterministic by hash) is reviewed in packed calls by the auditor tier; the reviewer writes
 *            only `{"id","problem","severity"}` lines for items with problems, then `{"done":true}`.
 *   decider  items that stayed rejected after the repair rounds, and audit findings at or above the job's severity, go in one packed call
 *            to the decider tier (role decider; for ChatSOP the good tier). Per item it answers one action: `retry` with a hint (one more
 *            worker attempt), `dismiss` (an audit false alarm), `drop` (the input cannot be processed; recorded, not escalated) or
 *            `escalate` (beyond this tier: goes to escalations.jsonl for the agentic controller, as a short record). A missing or
 *            invalid decision is an escalation.
 *
 * Prompts are data: the audit instructions are a file of the job folder; the audit output protocol and the decider's instructions are
 * ./prompts/audit-protocol.md and ./prompts/decider.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import {callChain} from './client.mjs';
import {jsonLines} from './outputs.mjs';
import {estimateTokens, unit, PROMPTS_DIR} from './util.mjs';

const RANK = {high: 3, medium: 2, low: 1};
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);
export const DECIDER_FILE = path.join(PROMPTS_DIR, 'decider.md');
export const AUDIT_PROTOCOL_FILE = path.join(PROMPTS_DIR, 'audit-protocol.md');

const itemBlock = it => `=== ITEM ${it.id} ===\nMATERIAL:\n${it.material}\nWORK:\n${it.work}\n`;

/** Packs audit items into batches of at most `budgetTokens` estimated tokens (an oversized item gets a batch of its own). */
export function packBatches(items, {budgetTokens = 20000, fixedTokens = 0} = {}) {
  const batches = [];
  let cur = null;
  for (const it of items) {
    const cost = estimateTokens(itemBlock(it));
    if (!cur || (cur.items.length && cur.tokens + cost > budgetTokens)) { cur = {items: [], tokens: fixedTokens}; batches.push(cur); }
    cur.items.push(it); cur.tokens += cost;
  }
  return batches.map((b, i) => ({index: i, items: b.items, text: [...b.items.map(itemBlock), `=== END OF ITEMS (${b.items.length}) ===`].join('\n')}));
}

/** Reviewer output: `{"id","problem","severity"}` lines, then `{"done":true}`. `malformed` without the end marker or with many bad lines. */
export function parseFindings(text, ids) {
  const known = new Set(ids.map(String));
  const {objects, bad: badJson} = jsonLines(text);
  const findings = [];
  let done = false, bad = badJson;
  for (const o of objects) {
    if (o.done === true && o.id == null) { done = true; continue; }
    const id = o.id == null ? null : String(o.id);
    if (!id || typeof o.problem !== 'string' || !o.problem.trim()) { bad += 1; continue; }
    if (!known.has(id)) continue;
    const sev = String(o.severity ?? '').toLowerCase();
    findings.push({id, problem: o.problem.trim(), severity: SEVERITIES.includes(sev) ? sev : 'medium'});
  }
  return {findings, done, bad, malformed: !done || bad > Math.max(1, (findings.length + bad) / 3)};
}
export const ACTIONS = Object.freeze({rejected: ['retry', 'drop', 'escalate'], audit: ['retry', 'dismiss', 'escalate']});

/** Ids of accepted items selected for the audit: unit(seed, id) < rate. */
export const auditSample = (ids, rate, seed) => ids.filter(id => unit(`audit:${seed}`, id) < rate);

/** Runs the audit over `items` ({id, material, work}); returns `{findings, failed}` (failed: ids whose batch was unusable twice). */
export async function runAudit({items, audit, instructions, call, budgetTokens = 20000}) {
  const protocol = fs.readFileSync(AUDIT_PROTOCOL_FILE, 'utf8').trim();
  const system = `${instructions}\n\n${protocol}`;
  const batches = packBatches(items, {budgetTokens: audit.budgetTokens ?? budgetTokens, fixedTokens: estimateTokens(system) + 200});
  const findings = [], failed = [];
  for (const b of batches) {
    const ids = b.items.map(i => i.id);
    let parsed = null;
    for (let attempt = 1; attempt <= 2 && (!parsed || parsed.malformed); attempt++) {
      const r = await callChain(call, audit.models, [{role: 'system', content: system}, {role: 'user', content: b.text}], 'audit');
      parsed = r.ok ? parseFindings(r.text, ids) : null;
      if (parsed && r.finish === 'length') parsed.malformed = true;
    }
    if (!parsed || parsed.malformed) { failed.push(...ids); continue; }
    findings.push(...parsed.findings);
  }
  return {findings, failed};
}

export const atLeast = (sev, min) => (RANK[sev] ?? 0) >= (RANK[min] ?? 2);

/** One packed call to the decider; returns a Map id -> {action, hint, reason} (invalid or missing -> escalate). */
export async function decide({cases, chain, call, jobDescription = ''}) {
  const out = new Map();
  if (!cases.length) return out;
  if (!chain?.length) { for (const c of cases) out.set(c.id, {action: 'escalate', reason: 'no decider configured'}); return out; }
  const system = fs.readFileSync(DECIDER_FILE, 'utf8').trim();
  const user = [`JOB: ${jobDescription}`, ...cases.map(c => [`=== CASE ${c.id} (${c.source}; allowed actions: ${ACTIONS[c.source].join(', ')}) ===`,
    `INPUT:\n${c.material}`, `OUTPUT:\n${c.work || '(none)'}`, `PROBLEMS:\n${c.problems.map(p => `- ${p}`).join('\n')}`].join('\n')), `=== END OF CASES (${cases.length}) ===`].join('\n\n');
  const r = await callChain(call, chain, [{role: 'system', content: system}, {role: 'user', content: user}], 'decider');
  const byId = new Map(cases.map(c => [c.id, c]));
  if (r.ok) {
    for (const o of jsonLines(r.text).objects) {
      const c = byId.get(String(o.id ?? ''));
      if (!c || out.has(c.id)) continue;
      const action = String(o.action ?? '');
      if (!ACTIONS[c.source].includes(action)) continue;
      if (action === 'retry' && !(typeof o.hint === 'string' && o.hint.trim())) continue;
      out.set(c.id, {action, hint: action === 'retry' ? o.hint.trim().slice(0, 1000) : null, reason: String(o.reason ?? '').slice(0, 300)});
    }
  }
  for (const c of cases) if (!out.has(c.id)) out.set(c.id, {action: 'escalate', reason: r.ok ? 'the decider gave no valid decision' : `decider call failed: ${r.error}`});
  return out;
}
