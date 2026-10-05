// The library's run listing and the background form of a TaskLambda call (2026-10-03, for project TaskLambdas that report their spend):
// `jobs()` reads GET /jobs (registered runs with budget and spend); `skill(name, inputs, {wait: false})` returns the operation at once.
// A fake transport stands for the server: no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPworkerClient } from '../lib/client.mjs';

function fakeServer() {
  const seen = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url), method = (init.method ?? 'GET').toUpperCase();
    seen.push(`${method} ${u.pathname}`);
    if (method === 'GET' && u.pathname === '/jobs') return json({ runs: [{ run: 'r1', job: 'x', status: 'running', budget: { credits: 10 }, spent: { calls: 3, usd: 0, credits: 0.3 } }], by_job: {} });
    if (method === 'POST' && u.pathname === '/v1/lambdas/demo') return json({ id: 'op-1', status: 'running' }, 202);
    if (method === 'GET' && u.pathname === '/v1/ops/op-1') return json({ id: 'op-1', status: 'finished', result: { status: 'finished', summary: 'done' }, log: [] });
    return json({ error: { type: 'not_found', message: u.pathname } }, 404);
  };
  return { fetchImpl, seen };
}

test('jobs() lists the registered runs with their spend', async () => {
  const { fetchImpl, seen } = fakeServer();
  const ta = createPworkerClient({ purpose: 'test:client', fetchImpl, url: 'http://127.0.0.1:1' });
  const j = await ta.jobs();
  assert.deepEqual(j.runs[0].spent, { calls: 3, usd: 0, credits: 0.3 });
  assert.deepEqual(seen, ['GET /jobs']);
});

test('a TaskLambda call started with wait: false returns its operation without waiting; the default waits for the result', async () => {
  const { fetchImpl, seen } = fakeServer();
  const ta = createPworkerClient({ purpose: 'test:client', fetchImpl, url: 'http://127.0.0.1:1' });
  const op = await ta.call('demo', { a: 1 }, { wait: false });
  assert.deepEqual([op.id, op.status], ['op-1', 'running']);
  assert.deepEqual(seen, ['POST /v1/lambdas/demo']);
  const done = await ta.call('demo', { a: 1 });
  assert.equal(done.status, 'finished');
  assert.ok(seen.includes('GET /v1/ops/op-1'));
});

test('a call on a socket the server reset is sent once more instead of failing as unavailable', async () => {
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    n++;
    if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ta = createPworkerClient({ purpose: 'test:client', fetchImpl, url: 'http://127.0.0.1:1' });
  const r = await ta.chat({ tier: 'tiny', prompt: 'hi' });
  assert.deepEqual([r.ok, r.text, n], [true, 'ok', 2]);
  // A refused connection (no server) is still reported at once, not retried.
  const down = createPworkerClient({ purpose: 'test:client', fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, url: 'http://127.0.0.1:1' });
  const r2 = await down.chat({ tier: 'tiny', prompt: 'hi' });
  assert.equal(r2.ok, false);
});
