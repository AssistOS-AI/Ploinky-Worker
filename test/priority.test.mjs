// Priority classes and duration caps of the core: background work runs only when nothing else waits and only within its share of
// the rate and plan limits (held, never refused); a request that exceeds its duration cap is cut, reported and falls back.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Limiter } from '../lib/limiter.mjs';
import { limitWait } from '../lib/plan.mjs';
import { createProxy } from '../lib/core.mjs';

test('limiter: background jobs wait behind normal and interactive ones and use only their share of the per-minute rate', async () => {
  const l = new Limiter({ maxConcurrent: 1, maxPerMinute: 10 });
  l.backgroundShare = 0.7;
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = l.schedule(async () => { await gate; order.push('first'); }, null, 1);
  const bg = l.schedule(async () => { order.push('background'); }, { background: true }, 2);
  const normal = l.schedule(async () => { order.push('normal'); }, null, 1);
  const inter = l.schedule(async () => { order.push('interactive'); }, null, 0);
  release();
  await Promise.all([first, bg, normal, inter]);
  assert.deepEqual(order, ['first', 'interactive', 'normal', 'background']);
  const full = new Limiter({ maxConcurrent: 5, maxPerMinute: 10 });
  full.backgroundShare = 0.7;
  full.seed(Array.from({ length: 7 }, () => Date.now()));
  assert.ok(full.estimateWait({ background: true }, 2).wait > 0, 'background is held at 7 of 10 per minute');
  assert.equal(full.estimateWait(null, 1).wait, 0, 'normal work still runs');
  assert.deepEqual(full.queued(), { interactive: 0, normal: 0, background: 0 });
});

test('plan gate: background work keeps the configured headroom of a credits window', () => {
  const now = Date.now();
  const limits = [{ name: 'per_5h', unit: 'credits', window: '5h', max: 10 }];
  const records = Array.from({ length: 7 }, (_, i) => ({ upstream: 'p', t: now - 1000 * (i + 1), status: 200, quota_cost: 1 }));
  assert.equal(limitWait({ upstream: 'p', limits, records, models: {}, now, job: { cost: 1 }, active: [] }).wait, 0);
  const held = limitWait({ upstream: 'p', limits, records, models: {}, now, job: { cost: 1 }, active: [], share: 0.7 });
  assert.ok(held.wait > 0); assert.match(held.reason, /per_5h/);
});

test('core: a request beyond its duration cap is cut (504, not cached) and falls back down its tier chain', async () => {
  const slow = http.createServer((req, res) => { req.resume(); setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"late"},"finish_reason":"stop"}]}'); }, 1500); });
  const fast = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"quick"},"finish_reason":"stop"}],"usage":{"completion_tokens":1}}'); });
  const lp = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  const [ps, pf] = [await lp(slow), await lp(fast)];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-to-'));
  const up = (port) => ({ baseUrl: `http://127.0.0.1:${port}`, noKey: true, limits: { maxConcurrent: 2 }, retry: { max: 0, max5xx: 0, baseMs: 10, maxWaitMs: 100 }, formats: { openai: '/v1/chat/completions' } });
  const config = { defaultUpstream: 'slow', upstreams: { slow: up(ps), fast: up(pf) }, tiers: { good: [{ upstream: 'slow', model: 'glm', timeoutMs: 300 }, { upstream: 'fast', model: 'ds' }], only: [{ upstream: 'slow', model: 'glm', timeoutMs: 300 }] }, cache: { defaultMode: 'use' } };
  const p = createProxy({ config, env: {}, dataDir });
  const port = await lp(p.server);
  const post = (model, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pworker-purpose': 'test:timeout', ...extra }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'q' }] }) });
  try {
    let r = await post('good');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-pworker-fallback-reason'), 'timeout');
    assert.equal((await r.json()).choices[0].message.content, 'quick');
    r = await post('only');
    assert.equal(r.status, 504); assert.equal((await r.json()).error.type, 'upstream_timeout');
    r = await post('only', { 'x-pworker-cache': 'strict' });
    assert.equal(r.status, 409, 'a cut answer was never cached');
    r = await post('good', { 'x-pworker-priority': 'background' });
    assert.equal(r.status, 200);
  } finally { for (const s of [p.server, slow, fast]) { s.close(); s.closeAllConnections?.(); } fs.rmSync(dataDir, { recursive: true, force: true }); }
});
