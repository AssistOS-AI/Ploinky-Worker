// The sandbox of model-written task phases (programs written on the fly): the allow-listed API works; escape attempts, code generation, unknown operations, endless
// loops and memory bombs are refused or stopped.
import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgram } from '../lib/sandbox.mjs';

const api = (log = []) => ({
  chat: async (o) => { log.push(['chat', o]); return { ok: true, text: `echo ${o.prompt}` }; },
  listInputs: async () => [{ name: 'a.txt', bytes: 3 }],
  readInput: async ({ name }) => { if (name !== 'a.txt') throw new Error('no such input'); return 'abc'; },
  writeOutput: async ({ name, text }) => { log.push(['write', name, text]); return { written: name }; },
  log: async ({ message }) => { log.push(['log', message]); return true; },
});

test('a program uses the allow-listed API and returns JSON', async () => {
  const log = [];
  const r = await runProgram(`async function run(api, input) {
    const files = await api.listInputs();
    const text = await api.readInput(files[0].name);
    const a = await api.chat({tier: 'tiny', prompt: text + input.x});
    await api.writeOutput('out.txt', a.text);
    await api.log('done');
    return {files: files.length, reply: a.text};
  }`, { x: '!' }, api(log));
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.value, { files: 1, reply: 'echo abc!' });
  assert.equal(r.calls, 5);
  assert.deepEqual(log.find((l) => l[0] === 'write'), ['write', 'out.txt', 'echo abc!']);
});

test('escape attempts find no host object: constructors, process, require, import, globals', async () => {
  const probes = {
    ctor: `async function run(api) { return (function(){ return this; }).constructor.constructor('return process')(); }`,
    apiCtor: `async function run(api) { return api.chat.constructor('return process')(); }`,
    globals: `async function run() { return [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, typeof console, typeof WebAssembly, typeof globalThis.hostCall, typeof hostDone].join(','); }`,
    importExpr: `async function run() { const m = await import('node:fs'); return typeof m; }`,
    evalFn: `async function run() { return eval('1+1'); }`,
    promiseCtor: `async function run(api) { const p = api.log('x'); return p.constructor.constructor('return process')(); }`,
    thenHook: `async function run(api) { let leaked = null; const orig = Promise.prototype.then; Promise.prototype.then = function (a, b) { leaked = leaked || a; return orig.call(this, a, b); }; await api.log('x'); Promise.prototype.then = orig; return typeof leaked === 'function' ? String(leaked.constructor === Function) : 'none'; }`,
    errorCtor: `async function run(api) { try { await api.readInput('nope'); } catch (e) { return e.constructor.constructor('return process')(); } }`,
  };
  for (const [name, code] of Object.entries(probes)) {
    const r = await runProgram(code, null, api());
    if (name === 'globals') { assert.equal(r.ok, true, r.message); assert.equal(r.value, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined'); continue; }
    if (name === 'thenHook') { assert.equal(r.ok, true, r.message); assert.ok(r.value === 'true' || r.value === 'none', `a leaked callback must be a context function: ${r.value}`); continue; }
    assert.equal(r.ok, false, `${name} must fail, got ${JSON.stringify(r.value)}`);
    assert.doesNotMatch(String(r.value ?? ''), /pid|versions/);
  }
});

test('unknown operations and forged replies are refused; refusals do not leak host errors', async () => {
  const r = await runProgram(`async function run(api) { try { await api.chat({tier: 'best'}); return 'no'; } catch (e) { return [e instanceof Error, e.constructor === Error, String(e.message)]; } }`, null, { chat: async () => { throw new Error('tier best is not allowed in the sandbox'); } });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.value, [true, true, 'tier best is not allowed in the sandbox']);
});

test('time, memory and size limits stop a program', async () => {
  let r = await runProgram(`async function run() { for (;;) {} }`, null, api(), { timeMs: 1500 });
  assert.equal(r.code, 'sandbox_time_limit');
  r = await runProgram(`async function run() { for (;;) { await null; } }`, null, api(), { timeMs: 1500 });
  assert.equal(r.code, 'sandbox_time_limit');
  r = await runProgram(`async function run() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }`, null, api(), { timeMs: 20000, heapMb: 32 });
  // The limit holds even when the host runs with NODE_OPTIONS=--max-old-space-size=8192 (the sandbox is its own process).
  assert.equal(r.code, 'sandbox_memory_limit', r.message);
  r = await runProgram('x'.repeat(30000), null, api());
  assert.equal(r.code, 'sandbox_too_long');
  r = await runProgram(`async function run() { return 'x'.repeat(300000); }`, null, api());
  assert.equal(r.code, 'sandbox_result_limit');
  r = await runProgram(`function run( {`, null, api());
  assert.equal(r.ok, false);
});

test('many sandboxes at once all finish (bounded concurrency)', async () => {
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => runProgram(`async function run(api, input) { return input * 2; }`, i, {})));
  assert.ok(many.every((r, i) => r.ok && r.value === i * 2));
});
