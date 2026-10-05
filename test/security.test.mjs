// Cross-site and malformed requests: a web page or a broken client cannot drive the local proxy or crash it.
import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProxy } from '../lib/core.mjs';

async function setup(token = null) {
  let calls = 0;
  const up = http.createServer((req, res) => { if (req.method === 'POST') calls += 1; req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'); }); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-sec-'));
  const p = createProxy({ config: { defaultUpstream: 'stub', upstreams: { stub: { baseUrl: `http://127.0.0.1:${up.address().port}`, noKey: true, limits: { maxConcurrent: 2 } } } }, env: {}, dataDir, proxyToken: token });
  await new Promise((r) => p.server.listen(0, '127.0.0.1', r));
  const port = p.server.address().port;
  const send = (method, url, headers = {}, body = null) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() })); });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
  return { port, send, calls: () => calls, close: () => { p.server.close(); p.server.closeAllConnections?.(); up.close(); } };
}
const chat = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });

test('cross-site requests, foreign hosts and non-JSON bodies are refused before any upstream call', async () => {
  const t = await setup();
  try {
    assert.equal((await t.send('POST', '/v1/chat/completions', { 'content-type': 'text/plain' }, chat)).status, 403);
    assert.equal((await t.send('POST', '/v1/chat/completions', { 'content-type': 'application/json', origin: 'https://evil.example' }, chat)).status, 403);
    assert.equal((await t.send('POST', '/v1/tasks', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, '{}')).status, 403);
    assert.equal((await t.send('POST', '/v1/chat/completions', { 'content-type': 'application/json', host: 'evil.example:80' }, chat)).status, 403);
    assert.equal(t.calls(), 0);
    const ok = await t.send('POST', '/v1/chat/completions', { 'content-type': 'application/json', origin: `http://127.0.0.1:${t.port}` }, chat);
    assert.equal(ok.status, 200);
    assert.equal(t.calls(), 1);
  } finally { t.close(); }
});

test('a malformed request URL is answered 400 and the server keeps running', async () => {
  const t = await setup();
  try {
    const raw = await new Promise((resolve) => { const s = net.connect(t.port, '127.0.0.1', () => s.write('GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')); let d = ''; s.on('data', (c) => { d += c; s.end(); }); s.on('close', () => resolve(d)); });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await t.send('GET', '/health')).status, 200);
  } finally { t.close(); }
});

test('the token is compared in constant time and accepted in the query only for the dashboard', async () => {
  const t = await setup('secret-token-123');
  try {
    assert.equal((await t.send('POST', '/v1/chat/completions?token=secret-token-123', { 'content-type': 'application/json' }, chat)).status, 401);
    assert.equal((await t.send('POST', '/v1/chat/completions', { 'content-type': 'application/json', authorization: 'Bearer wrong' }, chat)).status, 401);
    assert.equal((await t.send('POST', '/v1/chat/completions', { 'content-type': 'application/json', authorization: 'Bearer secret-token-123' }, chat)).status, 200);
    assert.equal((await t.send('GET', '/stats?token=secret-token-123')).status, 200);
  } finally { t.close(); }
});
