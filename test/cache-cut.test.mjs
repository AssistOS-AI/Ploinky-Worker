// Cut and interrupted answers are never cached or replayed; a fallback model gets its chain entry's own request fields (reasoning off,
// a token floor); the library's cache setting works per client and per call (use, strict, record, off).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../lib/core.mjs';
import { createCache, answerComplete } from '../lib/cache.mjs';
import { createPworkerClient } from '../lib/client.mjs';

const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return JSON.parse(Buffer.concat(c).toString() || '{}'); };
const answer = (res, content, finish = 'stop', usage = { prompt_tokens: 5, completion_tokens: 3 }) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], ...(usage ? { usage } : {}) })); };

async function setup(stub, tiers) {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    const b = await body(req);
    if (!b.messages) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); } // the model list
    seen.push(b); stub(b, res, seen);
  });
  const port = await listen(s);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-cut-'));
  const up = { baseUrl: `http://127.0.0.1:${port}`, noKey: true, limits: { maxConcurrent: 4 }, retry: { max: 0, max5xx: 0, baseMs: 5, maxWaitMs: 50 }, formats: { openai: '/v1/chat/completions' } };
  const config = { defaultUpstream: 'a', upstreams: { a: up, b: { ...up } }, tiers, cache: { defaultMode: 'use' } };
  const p = createProxy({ config, env: {}, dataDir });
  const url = `http://127.0.0.1:${await listen(p.server)}`;
  const ta = createPworkerClient({ url, purpose: 'test:cut', autostart: false, env: {} });
  return { seen, dataDir, p, url, ta, close: () => { for (const x of [p.server, s]) { x.close(); x.closeAllConnections?.(); } fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(dataDir + '-cache', { recursive: true, force: true }); } };
}

test('answerComplete: cut, empty, thinking-only and usage-less answers are incomplete', () => {
  const j = (content, finish = 'stop', usage = { completion_tokens: 2 }) => JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], ...(usage ? { usage } : {}) });
  assert.equal(answerComplete(j('4')), true);
  assert.equal(answerComplete(j('4', 'length')), false);
  assert.equal(answerComplete(j(null, 'length')), false);
  assert.equal(answerComplete(j('<think>still thinking')), false);
  assert.equal(answerComplete(j('<think>x</think>  ')), false);
  assert.equal(answerComplete(j('4', 'stop', null)), false, 'no usage: ended early upstream');
  assert.equal(answerComplete(JSON.stringify({ object: 'fol', results: [] }), { chat: false }), true);
  assert.equal(answerComplete(JSON.stringify({ error: { message: 'x' } }), { chat: false }), false);
});

test('a cut answer is not cached, an interrupted one is not cached, and an old bad entry is never replayed', async () => {
  let n = 0;
  const t = await setup((b, res) => { n += 1; if (b.messages[0].content === 'cut') return answer(res, 'par', 'length'); if (b.messages[0].content === 'nousage') return answer(res, 'half', 'stop', null); answer(res, `ok ${n}`); }, { tiny: [{ upstream: 'a', model: 'm' }] });
  try {
    for (const q of ['cut', 'nousage']) {
      const r1 = await t.ta.chat({ tier: 'tiny', prompt: q, maxTokens: 50 });
      assert.equal(r1.cached, false);
      const strict = await t.ta.chat({ tier: 'tiny', prompt: q, maxTokens: 50, cache: 'strict' });
      assert.equal(strict.status, 409, `${q} must not be stored`);
    }
    const r = await t.ta.chat({ tier: 'tiny', prompt: 'fine', maxTokens: 50 });
    assert.equal((await t.ta.chat({ tier: 'tiny', prompt: 'fine', maxTokens: 50 })).cached, true);
    // An entry written under older rules (a cut answer) is a miss, never a replay.
    const cache = createCache({ dir: t.dataDir + '-cache' });
    cache.put(r.cacheKey, { body: JSON.stringify({ choices: [{ message: { content: 'p' }, finish_reason: 'length' }], usage: { completion_tokens: 8 } }), content_type: 'application/json' });
    const again = await t.ta.chat({ tier: 'tiny', prompt: 'fine', maxTokens: 50 });
    assert.equal(again.cached, false); assert.match(again.text, /^ok /);
  } finally { t.close(); }
});

test('a fallback model gets its chain entry fields: reasoning off by default and a token floor; the caller still wins', async () => {
  const t = await setup((b, res) => (b.model === 'primary' ? (res.writeHead(503), res.end('{}')) : answer(res, JSON.stringify({ reasoning: b.reasoning ?? null, max_tokens: b.max_tokens }))),
    { small: [{ upstream: 'a', model: 'primary' }, { upstream: 'b', model: 'reasoner', extraBody: { reasoning: { enabled: false } }, minTokens: 64 }] });
  try {
    let r = await t.ta.chat({ tier: 'small', prompt: 'q', maxTokens: 8, cache: 'off' });
    assert.equal(r.fallback, 'b/reasoner');
    assert.deepEqual(JSON.parse(r.text), { reasoning: { enabled: false }, max_tokens: 64 });
    r = await t.ta.chat({ tier: 'small', prompt: 'q', maxTokens: 8, cache: 'off', extraBody: { reasoning: { effort: 'medium' } } });
    assert.deepEqual(JSON.parse(r.text).reasoning, { effort: 'medium' }, "the caller's own field wins");
  } finally { t.close(); }
});

test('the cache setting per client and per call: off calls the model every time, record refreshes, strict refuses a miss', async () => {
  let n = 0;
  const t = await setup((b, res) => { n += 1; answer(res, `v${n}`); }, { tiny: [{ upstream: 'a', model: 'm' }] });
  try {
    const off = createPworkerClient({ url: t.url, purpose: 'test:cut', cache: 'off', autostart: false, env: {} });
    assert.equal((await off.chat({ tier: 'tiny', prompt: 'x' })).text, 'v1');
    assert.equal((await off.chat({ tier: 'tiny', prompt: 'x' })).text, 'v2', 'off: no replay');
    assert.equal((await t.ta.chat({ tier: 'tiny', prompt: 'x', cache: 'strict' })).status, 409, 'off stored nothing');
    assert.equal((await t.ta.chat({ tier: 'tiny', prompt: 'x' })).text, 'v3');
    assert.equal((await t.ta.chat({ tier: 'tiny', prompt: 'x' })).cached, true);
    assert.equal((await t.ta.chat({ tier: 'tiny', prompt: 'x', cache: 'record' })).text, 'v4');
    const s = await t.ta.chat({ tier: 'tiny', prompt: 'x', cache: 'strict' });
    assert.equal(s.cached, true); assert.equal(s.text, 'v4');
    assert.throws(() => createPworkerClient({ url: t.url, purpose: 'test:cut', cache: 'sometimes', autostart: false, env: {} }), /cache mode/);
    await assert.rejects(t.ta.chat({ tier: 'tiny', prompt: 'x', cache: 'never' }), /cache mode/);
  } finally { t.close(); }
});
