import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pworker, batchTemplate, compileTask, loadTask, validateTask } from '../lib/pworker/task.mjs';
import { jobStore } from '../lib/pworker/jobs.mjs';
import { connectedProviders, fetchModelCatalog, formatModelLabel, isModelEligibleForTier, isTextOutputModel, modelPrices, normalizeModelCatalog, providerSpec, sortModelCatalog } from '../lib/pworker/providers.mjs';
import { HELP } from '../lib/pworker/help.mjs';

const exec = promisify(execFile);

test('a task advances through model and processing phases', async () => {
  const calls = [];
  const client = { chat: async (o) => { calls.push(o); return { ok: true, text: 'HELLO' }; } };
  const task = { begin: { tier: 'tiny', template: 'Uppercase $input', code: 'this.answer = result; this.next("finish")' }, finish: { tier: null, code: 'this.end(this.answer.toLowerCase())' } };
  const worker = new Pworker({ client });
  worker.enqueue(task, 'hello');
  const [result] = await worker.flush();
  assert.equal(result.value, 'hello');
  assert.equal(result.steps, 2);
  assert.equal(calls[0].prompt, 'Uppercase hello');
  assert.equal(calls[0].tier, 'tiny');
});

test('explicit flush combines eligible tasks and dispatches results by id', async () => {
  const calls = [];
  const client = { json: async (o) => {
    calls.push(o);
    const requests = JSON.parse(o.prompt.split('Requests:\n')[1]);
    return { ok: true, json: { results: Object.fromEntries(requests.map((r) => [r.id, String(r.input).toUpperCase()])) } };
  } };
  const task = { begin: { tier: 'small', template: 'Uppercase $input', batch: true, code: 'this.end(result)' } };
  const worker = new Pworker({ client, config: { batching: { small: { enabled: true } } } });
  worker.enqueue(task, 'a', { id: 'a' }); worker.enqueue(task, 'b', { id: 'b' });
  const results = await worker.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(results.map((r) => r.value), ['A', 'B']);
  assert.equal(batchTemplate('prefix $input').variable, 'input');
  assert.equal(batchTemplate('$a then $b'), null);
  assert.throws(() => validateTask({ begin: { tier: 'tiny', batch: true, template: '$a and $b' } }), /batch/);
});

test('a text task is compiled to a reusable JSON declaration in the user home', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-task-'));
  let calls = 0;
  const client = { json: async () => { calls++; return { ok: true, json: { begin: { tier: null, code: 'this.end(this.input)' } } }; } };
  try {
    const first = await compileTask('echo input', { client, home });
    const second = await compileTask('echo input', { client, home });
    assert.equal(first.file, second.file);
    assert.ok(first.file.endsWith('.json'));
    assert.equal(second.cached, true);
    assert.equal(calls, 1);
    assert.deepEqual(await loadTask(first.file), first.task);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('phase code has no process or filesystem access', async () => {
  const worker = new Pworker({ client: {} });
  worker.enqueue({ begin: { tier: null, code: 'this.end(process.env.HOME)' } }, {});
  const [result] = await worker.flush();
  assert.equal(result.ok, false);
  assert.match(result.error, /process is not defined/);
});

test('each task receives its supplied working directory and confined file operations', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-work-'));
  const a = path.join(root, 'a'), b = path.join(root, 'b');
  fs.mkdirSync(a); fs.mkdirSync(b);
  const task = { begin: { tier: null, code: 'await this.writeFile("result.txt", this.input); this.end(await this.readFile("result.txt"))' } };
  try {
    const worker = new Pworker({ client: {} });
    worker.enqueue(task, 'first', { currentWorkingDirectory: a });
    worker.enqueue(task, 'second', { currentWorkingDirectory: b });
    const results = await worker.flush();
    assert.deepEqual(results.map((r) => r.value), ['first', 'second']);
    assert.deepEqual(results.map((r) => r.state.currentWorkingDirectory), [a, b]);
    assert.equal(fs.readFileSync(path.join(a, 'result.txt'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(b, 'result.txt'), 'utf8'), 'second');
    const blocked = new Pworker({ client: {} });
    blocked.enqueue({ begin: { tier: null, code: 'await this.writeFile("../escape.txt", "bad")' } }, {}, { currentWorkingDirectory: a });
    assert.match((await blocked.flush())[0].error, /outside the work folder/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('detached task records persist their phase and result', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-jobs-'));
  try {
    const store = jobStore(home);
    const job = store.create({ request: 'test', input: { input: 'hello' }, currentWorkingDirectory: '/tmp' });
    store.update(job.id, { status: 'running', phase: 'analyze', steps: 2 });
    assert.equal(jobStore(home).view(job.id).phase, 'analyze');
    store.update(job.id, { status: 'completed', phase: null, result: { value: 'done' } });
    assert.equal(jobStore(home).list()[0].result.value, 'done');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('CLI --async returns an ID and --status retrieves the finished result', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-async-'));
  const home = path.join(root, 'home'), work = path.join(root, 'work'), file = path.join(root, 'task.mjs');
  fs.mkdirSync(work);
  fs.writeFileSync(file, 'export default '+JSON.stringify({begin:{tier:null,code:'await this.writeFile("answer.txt", this.input); this.end(await this.readFile("answer.txt"))'}})+';\n');
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const env = { ...process.env, PWORKER_HOME: home, PWORKER_PORT: String(port) };
  const bin = path.resolve('bin/pworker.mjs');
  const cli = async (...args) => JSON.parse((await exec(process.execPath, [bin, ...args], { env })).stdout);
  try {
    const submitted = await cli('run', file, '--input', 'hello', '--cwd', work, '--async');
    assert.match(submitted.id, /^[a-f0-9-]{36}$/);
    let status;
    for (let i = 0; i < 100; i++) {
      status = await cli('--status', submitted.id);
      if (['completed', 'failed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(status.status, 'completed', status.error);
    assert.equal(status.result.value, 'hello');
    assert.equal(fs.readFileSync(path.join(work, 'answer.txt'), 'utf8'), 'hello');
    assert.equal((await cli('--status'))[0].id, submitted.id);
  } finally {
    await exec(process.execPath, [bin, 'stop'], { env }).catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('provider setup checks a live model catalog before a tier can use it', async () => {
  const spec = providerSpec('sample', 'https://example.test/v1', 'secret', 25);
  assert.equal(spec.baseUrl, 'https://example.test/v1');
  assert.equal(spec.modelsPath, '/models');
  let seen;
  const models = await fetchModelCatalog(spec, { key: 'secret', fetchImpl: async (url, init) => {
    seen = { url, auth: init.headers.authorization };
    return { ok: true, json: async () => ({ data: [{ id: 'model-b' }, { id: 'model-a' }] }) };
  } });
  assert.deepEqual(models, ['model-a', 'model-b']);
  assert.deepEqual(seen, { url: 'https://example.test/v1/models', auth: 'Bearer secret' });
  assert.deepEqual(connectedProviders({ providers: { sample: spec, local: { noKey: true, start: {} } } }, { local: { running: false } }, { PWORKER_SAMPLE_API_KEY: 'secret' }), ['sample']);
  assert.deepEqual(connectedProviders({ providers: { local: { noKey: true, start: {} } } }, { local: { running: true } }, {}), ['local']);
});

test('live catalog prices are normalized, displayed with providers, and sortable', () => {
  assert.deepEqual(modelPrices({ pricing: { prompt: '0.000001', completion: '0.000002' } }), { input: 1, output: 2, cachedInput: null });
  assert.deepEqual(modelPrices({ prompt_text_token_price: 12500, completion_text_token_price: 25000 }), { input: 1.25, output: 2.5, cachedInput: null });
  assert.deepEqual(modelPrices({ id: 'private-model' }, { modelPricing: { 'private-model': { inputUsdPerM: 0.25, outputUsdPerM: 1 } } }), { input: 0.25, output: 1, cachedInput: null });
  const models = normalizeModelCatalog('router', {}, [
    { id: 'premium', pricing: { prompt: '0.00001', completion: '0.00002' } },
    { id: 'budget', pricing: { prompt: '0.000001', completion: '0.000002' } },
  ]);
  assert.deepEqual(sortModelCatalog(models, 'lowest-price').map((model) => model.id), ['budget', 'premium']);
  assert.match(formatModelLabel(models[0]), /^router · premium · in \$10\.00\/M · out \$20\.00\/M$/);
});

test('credit-billed and non-text models cannot enter automatic text tiers', () => {
  const models = normalizeModelCatalog('openference', {}, [
    { id: 'plan-text', quota_multiplier: 2, pricing: { prompt: '0.000001', completion: '0.000002' }, output_modalities: ['text'] },
    { id: 'credit-text', x_billing: 'credit', quota_multiplier: 1, output_modalities: ['text'] },
    { id: 'image-only', output_modalities: ['image'] },
  ]);
  assert.equal(isModelEligibleForTier(models[0]), true);
  assert.equal(isModelEligibleForTier(models[1]), false);
  assert.equal(isTextOutputModel(models[2]), false);
  assert.equal(isModelEligibleForTier(models[2]), false);
  assert.match(formatModelLabel(models[1]), /requires a credit balance/);
  assert.match(formatModelLabel(models[0]), /plan 2 credits\/request/);
});

test('help explains task, async, status, provider, tier, and cancellation options', () => {
  for (const word of ['--async', '--status', '--cwd', 'provider NAME', 'tier TIER', 'Esc cancels', 'flush --async']) assert.ok(HELP.includes(word), word);
});
