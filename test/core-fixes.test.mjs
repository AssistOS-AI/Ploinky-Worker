// Regression tests of the proxy core: UTF-8 across chunks, credit-balance fallback before the answer is sent, providers whose OpenAI
// path is not /v1/chat/completions, the proxy token never reaching a provider, a duration cap mid-body, odd upstream statuses.
import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createCore } from '../lib/core.mjs';
import { inprocFetch } from '../lib/inproc.mjs';
import { httpFetch } from '../lib/http-fetch.mjs';
import { Readable } from 'node:stream';

const models = () => Response.json({ data: [{ id: 'A' }, { id: 'B' }] });
function core(config, fetchImpl, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-core-'));
  const c = createCore({ config: { defaultUpstream: 'a', ...config }, env: {}, dataDir, fetchImpl, ...extra });
  return { c, dataDir, fetch: inprocFetch(c.handle) };
}
const ask = (f, model = 'small', headers = {}) => f('http://pworker.local/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pworker-purpose': 'test:core', ...headers }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'q' }] }) });
const ups = (extra = {}) => ({ a: { baseUrl: 'http://a.test', noKey: true, limits: { maxConcurrent: 4 }, ...extra.a }, b: { baseUrl: 'http://b.test', noKey: true, limits: { maxConcurrent: 4 }, ...extra.b } });

test('a multibyte character split across chunks reaches the client and the cache intact', async () => {
  const body = Buffer.from(JSON.stringify({ choices: [{ message: { content: 'ăîșț — 漢字 🙂' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4 } }));
  const cut = body.indexOf(Buffer.from('漢')) + 1;
  let calls = 0;
  const t = core({ upstreams: ups(), tiers: { small: [{ upstream: 'a', model: 'A' }] }, cache: { defaultMode: 'use' } }, async (url) => {
    if (url.endsWith('/v1/models')) return models();
    calls += 1;
    return new Response(new ReadableStream({ start(c) { c.enqueue(body.subarray(0, cut)); c.enqueue(body.subarray(cut)); c.close(); } }), { headers: { 'content-type': 'application/json' } });
  });
  const first = await (await ask(t.fetch)).json();
  const second = await ask(t.fetch);
  assert.equal(second.headers.get('x-pworker-cache'), 'hit');
  assert.equal((await second.json()).choices[0].message.content, 'ăîșț — 漢字 🙂');
  assert.equal(first.choices[0].message.content, 'ăîșț — 漢字 🙂');
  assert.equal(calls, 1);
});

test('a credit-balance refusal falls back before anything is sent, so the client gets the fallback answer', async () => {
  const seen = [];
  const t = core({ upstreams: ups(), tiers: { small: [{ upstream: 'a', model: 'A' }, { upstream: 'b', model: 'B' }] } }, async (url) => {
    if (url.endsWith('/v1/models')) return models();
    seen.push(url);
    if (url.startsWith('http://a.test')) return Response.json({ error: 'This model is billed from your credit balance.' }, { status: 402 });
    return Response.json({ choices: [{ message: { content: 'from B' }, finish_reason: 'stop' }] });
  });
  const r = await ask(t.fetch);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, 'from B');
  assert.deepEqual(seen, ['http://a.test/v1/chat/completions', 'http://b.test/v1/chat/completions']);
});

test('a provider whose OpenAI format lives at /chat/completions serves tier requests for /v1/chat/completions', async () => {
  const seen = [];
  const t = core({ upstreams: ups({ a: { formats: { openai: '/chat/completions' } } }), tiers: { small: [{ upstream: 'a', model: 'A' }] } }, async (url) => {
    if (url.endsWith('/models')) return models();
    seen.push(url);
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  });
  const r = await ask(t.fetch);
  assert.equal(r.status, 200, await r.clone().text());
  assert.deepEqual(seen, ['http://a.test/chat/completions']);
});

test('the proxy token is never forwarded to a keyless provider', async () => {
  let auth = 'unset';
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-core-'));
  const c = createCore({ config: { defaultUpstream: 'a', upstreams: ups() }, env: {}, dataDir, proxyToken: 'proxy-secret-token', fetchImpl: async (url, init) => {
    if (url.endsWith('/v1/models')) return models();
    auth = new Headers(init.headers).get('authorization');
    return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
  } });
  const req = { method: 'POST', url: '/v1/chat/completions', headers: { host: '127.0.0.1:1', 'content-type': 'application/json', authorization: 'Bearer proxy-secret-token' } };
  const r = await new Promise((resolve) => {
    const stream = Object.assign(Readable.from([Buffer.from(JSON.stringify({ model: 'A', messages: [] }))]), req);
    const res = { headersSent: false, writableEnded: false, on() {}, writeHead(st) { this.status = st; this.headersSent = true; }, write() {}, end() { this.writableEnded = true; resolve(this); } };
    c.handle(stream, res);
  });
  assert.equal(r.status, 200);
  assert.equal(auth, null);
});

test('a duration cap that cuts the body mid-way fails the client response and logs a 504', async () => {
  const t = core({ upstreams: ups(), tiers: { small: [{ upstream: 'a', model: 'A', timeoutMs: 150 }] } }, async (url, init) => {
    if (url.endsWith('/v1/models')) return models();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"par')); init.signal.addEventListener('abort', () => c.error(init.signal.reason)); } }), { headers: { 'content-type': 'application/json' } });
  });
  const keep = setInterval(() => {}, 50); // AbortSignal.timeout does not hold the event loop open; a listening server does
  try {
    const r = await ask(t.fetch);
    await assert.rejects(r.text());
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { clearInterval(keep); }
  const rec = t.c.monitor.records.find((x) => x.upstream === 'a');
  assert.equal(rec.status, 504);
});

test('an upstream status outside 200-599 rejects the fetch instead of crashing the process', async () => {
  const server = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 999 Odd\r\ncontent-length: 0\r\n\r\n')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await assert.rejects(httpFetch(`http://127.0.0.1:${server.address().port}/`), /fetch failed/); }
  finally { server.close(); }
});
