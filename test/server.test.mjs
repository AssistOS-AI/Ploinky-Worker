// The Ploinky Workers server and its library: client calls by tier, the agent endpoints (TaskLambdas, jobs, run-lambdas, write-lambda), the
// call folders of operations (a job run with one child call per item, run-lambdas with one per step), configuration layers and the
// user's home, old header and endpoint names, the port guard. Providers are stub servers: no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPworkerServer } from '../lib/server.mjs';
import { createPworkerClient, PworkerUnavailable } from '../lib/client.mjs';
import { mergeLayers, absolutize, ensureUserHome, loadLayers } from '../lib/config.mjs';

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `pworker-${p}-`));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const reply = (res, content, extra = {}) => { res.writeHead(200, { 'content-type': 'application/json', 'x-quota-cost': '0.1' }); res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 }, ...extra })); };

const PROGRAM_CODE = "async function run(api, input) { const files = await api.listInputs(); const t = await api.readInput(files[0].name); const a = await api.chat({tier: 'tiny', prompt: 'COUNT ' + t}); await api.writeOutput('count.txt', a.text); return {summary: 'counted: ' + a.text, outputs: ['count.txt']}; }";

/** A stub provider: `tiny-m` answers questions, `good-m` plans and writes plugins. */
async function stubProvider() {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    const c = []; for await (const x of req) c.push(x);
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[]}'); }
    const b = JSON.parse(Buffer.concat(c).toString());
    seen.push(b);
    const last = String(b.messages.at(-1).content);
    if (b.model === 'good-m' && b.messages[0].content.includes('You plan how to do')) return reply(res, last.includes('count') ? '{"steps":[{"lambda":"write-lambda","params":{"goal":"count the words","tier":"good"}}],"reason":"no TaskLambda counts"}' : last.includes('old form') ? '{"steps":[{"skill":"echo","inputs":{"text":"hi"}}],"reason":"echo fits"}' : '{"steps":[{"lambda":"echo","params":{"text":"hi"}}],"reason":"echo fits"}');
    if (b.model === 'good-m' && b.messages[0].content.includes('TaskLambda written on the fly')) return reply(res, '```js\n' + PROGRAM_CODE + '\n```');
    if (last.startsWith('COUNT ')) return reply(res, String(last.slice(6).trim().split(/\s+/).length));
    if (b.model === 'cut-m') return reply(res, 'partial', { choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] });
    return reply(res, `answer to ${last}`);
  });
  const port = await listen(s);
  return { url: `http://127.0.0.1:${port}`, seen, close: () => { s.close(); s.closeAllConnections?.(); } };
}

async function setup() {
  const root = tmp('srv');
  const up = await stubProvider();
  // Project TaskLambdas and a job folder registered by configuration: echo (model calls), double (pure), sneaky (declares pure, calls a model).
  fs.mkdirSync(path.join(root, 'lambdas'));
  fs.writeFileSync(path.join(root, 'lambdas', 'echo.mjs'), `export default {name: 'echo', description: 'Echo a text through the tiny tier.', effects: ['model-calls'], params: {text: {type: 'string'}},
    async run(ctx) { const r = await ctx.ta.chat({tier: 'tiny', prompt: ctx.params.text}); return {status: 'finished', summary: r.text, purpose: ctx.ta.purpose}; }};
export const lambdas = [
  {name: 'double', description: 'Twice a number (pure).', effects: ['pure'], params: {n: {type: 'number'}}, async run(ctx) { globalThis.__doubled = (globalThis.__doubled ?? 0) + 1; return {status: 'finished', summary: String(2 * ctx.params.n), value: 2 * ctx.params.n}; }},
  {name: 'sneaky', description: 'Declares pure, then calls a model.', effects: ['pure'], params: {}, async run(ctx) { const r = await ctx.ta.chat({tier: 'tiny', prompt: 'x'}); return {status: 'finished', summary: r.text}; }},
];`);
  const job = path.join(root, 'jobs', 'upper');
  fs.mkdirSync(job, { recursive: true });
  fs.writeFileSync(path.join(job, 'job.json'), JSON.stringify({ name: 'upper', inputs: { items: [{ id: 'a', q: 'x' }, { id: 'b', q: 'y' }], promptFields: ['q'] }, models: 'tier:tiny', output: { format: 'text' }, repairRounds: 0, decider: null, budget: { calls: 20 }, stages: [{ name: 'all', items: null }] }));
  fs.writeFileSync(path.join(job, 'prompt.md'), '<<<system>>>\nAnswer.\n<<<item>>>\n{{q}}\n');
  const config = {
    dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'), auditDir: path.join(root, 'audit'), logDir: path.join(root, 'logs'),
    defaultUpstream: 'stub',
    providers: { stub: { baseUrl: up.url, noKey: true, limits: { maxConcurrent: 4 }, retry: { max: 0, baseMs: 10, maxWaitMs: 100 }, formats: { openai: '/v1/chat/completions' } } },
    tiers: { tiny: [{ upstream: 'stub', model: 'tiny-m' }], good: [{ upstream: 'stub', model: 'good-m' }], cutty: [{ upstream: 'stub', model: 'cut-m' }] },
    policy: { allowedPurposes: ['job:*', 'lambda:*', 'run:*', 'test:*'], untaggedDailyMax: 1000 },
    cache: { defaultMode: 'use' },
    runner: { dataDir: path.join(root, 'runs'), roles: { planner: 'good', decider: 'good', auditor: 'good', worker: 'tiny' }, limits: {}, tasks: { keepDays: 7 } },
    lambdas: { project: [path.join(root, 'lambdas')], jobs: { upper: job } },
    calls: { dir: path.join(root, 'calls') },
    run: { budget: { calls: 50 }, maxSteps: 3 },
    sandbox: { timeMs: 20000, heapMb: 64, maxCalls: 5, tiers: ['tiny'] },
  };
  const s = await createPworkerServer({ config, env: {} });
  const port = await listen(s.server);
  const url = `http://127.0.0.1:${port}`;
  const ta = createPworkerClient({ url, purpose: 'test:server', autostart: false, env: {} });
  return { root, up, s, url, ta, job, close: async () => { await s.close(); up.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('library: chat and json by tier, tags, cache hit, cut marked and re-asked, purpose required, unavailable server', async () => {
  const t = await setup();
  try {
    const r = await t.ta.chat({ tier: 'tiny', prompt: 'hello', maxTokens: 50 });
    assert.equal(r.ok, true); assert.equal(r.text, 'answer to hello'); assert.equal(r.tier, 'tiny'); assert.equal(r.served, 'stub/tiny-m'); assert.equal(r.credits, 0.1);
    const again = await t.ta.chat({ tier: 'tiny', prompt: 'hello', maxTokens: 50 });
    assert.equal(again.cached, true);
    const j = await t.ta.json({ tier: 'tiny', prompt: 'COUNT a b c' });
    assert.equal(j.ok, false); assert.match(j.reason, /no JSON/);
    const cut = await t.ta.chat({ tier: 'cutty', prompt: 'long', maxTokens: 100 });
    assert.equal(cut.ok, true); assert.equal(cut.cut, true);
    const retried = await t.ta.chat({ tier: 'cutty', prompt: 'long', maxTokens: 100, retryCut: true, cutCap: 1600 });
    assert.equal(retried.ok, false); assert.match(retried.reason, /budget_exhausted/); assert.equal(retried.budget_retries, 2);
    const recs = fs.readdirSync(path.join(t.root, 'data')).filter((f) => f.startsWith('requests-')).flatMap((f) => fs.readFileSync(path.join(t.root, 'data', f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
    assert.ok(recs.every((x) => x.purpose === 'test:server'));
    assert.throws(() => createPworkerClient({}), /purpose tag is required/);
    const off = createPworkerClient({ url: 'http://127.0.0.1:1', purpose: 'test:x', autostart: false, env: {} });
    await assert.rejects(off.health(), (e) => e instanceof PworkerUnavailable && /start it with/.test(e.message));
    assert.match((await off.chat({ tier: 'tiny', prompt: 'x' })).reason, /not reachable/);
  } finally { await t.close(); }
});

test('TaskLambdas: built-ins, project ones and a job folder, each call a call folder; a job run has one child call per item', async () => {
  const t = await setup();
  try {
    const list = await t.ta.lambdas();
    const byName = Object.fromEntries(list.lambdas.map((s) => [s.name, s]));
    for (const n of ['chat', 'json', 'job', 'task', 'write-lambda', 'echo', 'double', 'sneaky', 'upper']) assert.ok(byName[n], n);
    assert.deepEqual([byName.chat.origin, byName.echo.origin, byName.upper.origin], ['built-in', 'project', 'job']);
    assert.deepEqual(byName.echo.effects, ['model-calls']);
    assert.match(byName.echo.hash, /^[0-9a-f]{16}$/);
    const op = await t.ta.call('echo', { text: 'ping' });
    assert.equal(op.status, 'finished', op.error);
    assert.equal(op.result.summary, 'answer to ping'); assert.equal(op.result.purpose, 'lambda:echo');
    // The call folder: call.json (lambda resolved by the worker), output.json, models.jsonl, summary.json, log.txt.
    assert.ok(op.dir.startsWith(path.join(t.root, 'calls')), op.dir);
    const call = JSON.parse(fs.readFileSync(path.join(op.dir, 'call.json'), 'utf8'));
    assert.deepEqual([call.id, call.lambda.name, call.lambda.origin, call.lambda.hash, call.status, call.params.text], [op.id, 'echo', 'project', byName.echo.hash, 'ok', 'ping']);
    const output = JSON.parse(fs.readFileSync(path.join(op.dir, 'output.json'), 'utf8'));
    assert.deepEqual([output.status, output.result.summary], ['ok', 'answer to ping']);
    const models = fs.readFileSync(path.join(op.dir, 'models.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([models.length, models[0].tier, models[0].model, models[0].credits], [1, 'tiny', 'stub/tiny-m', 0.1]);
    assert.ok(models[0].cache_key, 'the cache key of the model call is recorded');
    const bad = await t.ta.call('echo', { nope: 1 });
    assert.equal(bad.status, 'failed'); assert.match(bad.result.summary, /invalid params/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(bad.dir, 'output.json'), 'utf8')).status, 'failed');
    // A declared effect is enforced: a pure TaskLambda that calls a model fails.
    const sneaky = await t.ta.call('sneaky', {});
    assert.equal(sneaky.status, 'failed'); assert.match(sneaky.error, /needs the effect model-calls/);
    // Pure reuse: the same TaskLambda, hash and params return the recorded output without running; other params run.
    const d1 = await t.ta.call('double', { n: 21 });
    const d2 = await t.ta.call('double', { n: 21 });
    const d3 = await t.ta.call('double', { n: 4 });
    assert.deepEqual([d1.result.value, d2.result.value, d3.result.value], [42, 42, 8]);
    assert.equal(d1.result.reused_from, undefined);
    assert.equal(d2.result.reused_from, d1.id, 'the second call returned the recorded output of the first');
    assert.equal(JSON.parse(fs.readFileSync(path.join(d2.dir, 'output.json'), 'utf8')).reused_from, d1.id);
    assert.equal(d3.result.reused_from, undefined);
    // The echo call has effects: called again with the same params it runs again (never replayed).
    const again = await t.ta.call('echo', { text: 'ping' });
    assert.equal(again.result.reused_from, undefined);
    // A job run: one child call per item, with the item's model calls; the run's folder is linked from call.json.
    const job = await t.ta.runJob(t.job);
    assert.equal(job.status, 'finished', job.error);
    assert.match(job.result.summary, /accepted 2/);
    const tree = await t.ta.callTree(job.id);
    assert.equal(tree.lambda, 'job');
    assert.deepEqual(tree.children.map((c) => [c.lambda, c.status]).sort(), [['upper.item', 'ok'], ['upper.item', 'ok']]);
    const item = JSON.parse(fs.readFileSync(path.join(job.dir, 'calls', fs.readdirSync(path.join(job.dir, 'calls'))[0], 'models.jsonl'), 'utf8').trim().split('\n')[0]);
    assert.deepEqual([item.tier, item.model, item.role], ['tiny', 'stub/tiny-m', 'work']);
    const jc = JSON.parse(fs.readFileSync(path.join(job.dir, 'call.json'), 'utf8'));
    assert.equal(jc.job.name, 'upper'); assert.ok(fs.existsSync(path.join(jc.job_run.dir, 'accepted.jsonl')));
    const viaLambda = await t.ta.call('upper', {});
    assert.equal(viaLambda.status, 'finished', viaLambda.error);
    assert.equal((await t.ta.callTree(viaLambda.id)).children.length, 2);
    // The calls index over HTTP.
    const found = await t.ta.calls({ lambda: 'double' });
    assert.deepEqual(found.data.map((c) => c.id).sort(), [d1.id, d2.id, d3.id].sort());
    assert.equal((await t.ta.callInfo(d2.id)).output.reused_from, d1.id);
    // The endpoint of before the rename is gone.
    assert.equal((await fetch(`${t.url}/v1/${'skills'}`)).status, 404);
    assert.ok((await t.ta.lambdas()).lambdas.some((s) => s.name === 'echo' && s.params.text));
  } finally { await t.close(); }
});

test('run-lambdas: the planner tier chooses a TaskLambda and the executor runs it as a child call; write-lambda writes a sandboxed program when none fits', async () => {
  const t = await setup();
  try {
    let op = await t.ta.run('say hi');
    assert.equal(op.status, 'finished', op.error);
    assert.match(op.result.summary, /echo/);
    assert.equal((await t.ta.run('say hi in the old form')).status, 'finished', 'a step written as {skill, inputs} is still read');
    const f = path.join(t.root, 'words.txt');
    fs.writeFileSync(f, 'one two three four');
    op = await t.ta.run('count the words of the attached file', { attach: [f] });
    assert.equal(op.status, 'finished', JSON.stringify(op.result ?? op.error));
    const step = op.result.results[0];
    assert.equal(step.lambda, 'write-lambda'); assert.match(step.summary, /counted: 4/);
    // The tree: run-lambdas -> write-lambda (a step) -> program (the model-written TaskLambda, with its code and outputs).
    const tree = await t.ta.callTree(op.id);
    assert.equal(tree.lambda, 'run-lambdas');
    assert.equal(tree.children[0].lambda, 'write-lambda');
    assert.equal(tree.children[0].children[0].lambda, 'program');
    const stepDir = path.join(op.dir, 'calls', fs.readdirSync(path.join(op.dir, 'calls')).find((d) => d.startsWith('write-lambda-')));
    const progDir = path.join(stepDir, 'calls', fs.readdirSync(path.join(stepDir, 'calls'))[0]);
    assert.ok(fs.readFileSync(path.join(progDir, 'program.js'), 'utf8').includes('async function run'));
    assert.equal(fs.readFileSync(path.join(progDir, 'outputs', 'count.txt'), 'utf8'), '4');
    const prog = JSON.parse(fs.readFileSync(path.join(progDir, 'call.json'), 'utf8'));
    assert.deepEqual([prog.lambda.origin, prog.lambda.effects], ['model-written', ['model-calls']]);
    assert.equal(fs.readFileSync(path.join(progDir, 'models.jsonl'), 'utf8').trim().split('\n').length, 1, 'the program\'s own model call is in its call');
    const planOnly = await t.ta.run('say hi', { planOnly: true });
    assert.equal(planOnly.result.status, 'planned');
  } finally { await t.close(); }
});

test('configuration layers, paths per layer, user home template without keys; port guard', async () => {
  assert.deepEqual(mergeLayers({ a: { b: 1, c: 2 }, tiers: { x: [1, 2] } }, { a: { c: 3, d: null }, tiers: { x: [9] } }), { a: { b: 1, c: 3 }, tiers: { x: [9] } });
  const abs = absolutize({ dataDir: 'd', providers: { l: { start: { gguf: 'm.gguf', bin: 'llama-server', locks: ['x.lock'] } } }, runner: { templatesDir: 't' } }, '/base');
  assert.equal(abs.dataDir, '/base/d'); assert.equal(abs.providers.l.start.gguf, '/base/m.gguf'); assert.equal(abs.providers.l.start.bin, 'llama-server'); assert.equal(abs.runner.templatesDir, '/base/t');
  const home = tmp('home');
  const env = { PWORKER_HOME: home };
  const w = ensureUserHome(env);
  assert.ok(w.written.some((f) => f.endsWith('config.json')));
  assert.ok(fs.readFileSync(path.join(home, 'keys', 'openference.env'), 'utf8').includes('# OPENFERENCE_API_KEY='));
  assert.equal(ensureUserHome(env).written.length, 0, 'never overwrites');
  const { config } = loadLayers({ project: false, env, from: home });
  assert.equal(config.tiers.supertiny, 'micro');
  assert.equal(config.tiers.best[0].upstream, 'local');
  assert.ok(config.providers.localnano.start.gguf.endsWith('Qwen3-0.6B-Q8_0.gguf'));
  fs.rmSync(home, { recursive: true, force: true });
  const t = await setup();
  try {
    const second = await createPworkerServer({ config: { dataDir: path.join(t.root, 'd2'), providers: {}, tiers: {} }, env: {} });
    await assert.rejects(second.listen(Number(new URL(t.url).port)), /EADDRINUSE/);
  } finally { await t.close(); }
});
