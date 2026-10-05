// The job runner against a fake OpenAI-compatible endpoint: no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fakeProxy} from './fake-endpoint.mjs';
import {loadJob, runJob, RunStore, finalRecords, packCalls, validateSpec, tierChains, liveTiers, publishSummary, chooseStart, readTierStats} from '../lib/jobs/index.mjs';

const TIERS = {
  small: [{upstream: 'fake', model: 'worker-1', tier: 'small'}, {upstream: 'fake', model: 'worker-2', tier: 'small'}],
  good: [{upstream: 'fake', model: 'decider-1', tier: 'good'}],
  medium: [{upstream: 'fake', model: 'auditor-1', tier: 'medium'}],
};
const ROLES = {worker: 'small', decider: 'good', auditor: 'medium', planner: 'good'};
const CONFIG = {roles: ROLES, fallback: {}, dataDir: null, endpoint: null};

function makeJob(dir, spec, {prompt, checks, audit} = {}) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(spec));
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt ?? '<<<system>>>\nAnswer.\n<<<item>>>\nQ {{id}}: {{q}}\n<<<repair>>>\nFix:\n{{problems}}\nHint: {{hint}}\n');
  if (checks) fs.writeFileSync(path.join(dir, 'checks.mjs'), checks);
  if (audit) fs.writeFileSync(path.join(dir, 'audit.md'), audit);
  return dir;
}

const CHECKS = `export const parse = t => ({final: (/Final: *(.*)$/m.exec(t) || [])[1] ?? null});
export function check(item, out) { return out.final ? {ok: true, value: out.final} : {ok: false, problems: ['no Final line'], hint: 'end with Final:'}; }
export function score(item, out) { return {label: out.final === item.gold ? 'correct' : 'wrong'}; }`;

const ITEMS = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({id, q: `question ${id}`, gold: id.toUpperCase(), secret: `zz-secret-${id}`}));
const baseSpec = (extra = {}) => ({name: 'test-job', inputs: {items: ITEMS, promptFields: ['q']}, models: 'role:worker', output: {format: 'text'}, checks: 'checks.mjs',
  repairRounds: 1, concurrency: 2, budget: {usd: 1, credits: 50}, stages: [{name: 'pilot', items: 3}, {name: 'all', items: null, stop: {maxRejectRate: 0.5}}], ...extra});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-jobs-')); }

/** Worker: item b answers without a Final line first (repaired), c never (rejected), the others answer their gold. */
const worker = ({body, user, messages}) => {
  if (body.model === 'decider-1') return {content: user.includes('=== CASE c') ? '{"id":"c","action":"escalate","reason":"cannot fix"}\n{"done":true}' : '{"done":true}'};
  if (body.model === 'auditor-1') return {content: '{"done":true}'};
  const id = /Q (\w):/.exec(messages[1].content)[1];
  const repair = messages.length > 2;
  if (id === 'c') return {content: 'I do not know'};
  if (id === 'b' && !repair) return {content: 'thinking...'};
  return {content: `steps\nFinal: ${id.toUpperCase()}`};
};

test('a run settles items, repairs, escalates through the decider, writes its own folder and tags every call', async () => {
  const root = tmp();
  const proxy = await fakeProxy(worker);
  try {
    const dir = makeJob(path.join(root, 'job'), baseSpec({audit: {rate: 1, role: 'auditor', instructions: 'audit.md'}}), {checks: CHECKS, audit: 'Audit the answers.'});
    const job = await loadJob(dir, {tiers: TIERS, config: CONFIG});
    const store = new RunStore({root: path.join(root, 'state')});
    const r = await runJob(job, {endpoint: proxy.url, store, backoffMs: 1});
    assert.equal(r.status, 'finished');
    const {accepted, rejected} = finalRecords(r.dir);
    assert.deepEqual([...accepted.keys()].sort(), ['a', 'b', 'd', 'e', 'f']);
    assert.deepEqual([...rejected.keys()], ['c']);
    assert.equal(accepted.get('b').repair_rounds, 1);
    assert.equal(accepted.get('a').score.label, 'correct');
    const esc = fs.readFileSync(path.join(r.dir, 'escalations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(esc.map(e => e.id), ['c']);
    const summary = fs.readFileSync(path.join(r.dir, 'summary.md'), 'utf8').trim().split('\n');
    assert.ok(summary.length <= 10, 'summary has at most 10 lines');
    for (const q of proxy.chat()) {
      assert.equal(q.headers['x-pworker-purpose'], 'job:test-job');
      assert.equal(q.headers['x-pworker-run'], r.run);
      assert.equal(q.headers['x-pworker-no-fallback'], '1');
      assert.ok(!JSON.stringify(q.body).includes('zz-secret'), 'fields outside promptFields never reach the prompt');
    }
    assert.ok(proxy.requests.some(q => q.path === '/jobs/register' && q.body.run === r.run && q.body.budget.usd === 1));
    const run = JSON.parse(fs.readFileSync(path.join(r.dir, 'run.json'), 'utf8'));
    assert.equal(run.spec_hash, job.hash);
    assert.deepEqual(run.models, ['fake/worker-1', 'fake/worker-2']);
    const cost = JSON.parse(fs.readFileSync(path.join(r.dir, 'cost.json'), 'utf8'));
    assert.ok(cost.total.usd > 0 && cost.total.credits > 0);
    const index = store.runs('test-job');
    assert.deepEqual(index.map(x => x.event), ['started', 'finished']);

    // A rerun is a new immutable folder; every call is answered from the cache (nothing paid twice).
    const before = proxy.chat().length;
    const r2 = await runJob(job, {endpoint: proxy.url, store, backoffMs: 1});
    assert.notEqual(r2.dir, r.dir);
    assert.equal(proxy.chat().length, before, 'no model call on a rerun');
    assert.equal(r2.cost.this_process.total.calls, 0);
    assert.ok(r2.cost.this_process.total.cache_hits > 0);
    assert.equal(finalRecords(r2.dir).accepted.size, 5);
    assert.equal(store.runs('test-job').length, 4);

    // A finished run is immutable; a summary is published to a dated, run-named path only.
    await assert.rejects(runJob(job, {endpoint: proxy.url, store, resume: r.run}), /immutable/);
    const pub = publishSummary(r.dir, path.join(root, 'reports'), {job: 'test-job', run: r.run});
    assert.match(path.basename(pub), /^\d{4}-\d{2}-\d{2}-test-job-\d{8}T\d{6}-[0-9a-f]{6}\.md$/);
    assert.throws(() => publishSummary(r.dir, path.join(root, 'reports'), {job: 'test-job', run: r.run}), /EEXIST/);
  } finally { await proxy.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('stop rules stop a run on empty outputs; --stage runs a prefix only', async () => {
  const root = tmp();
  const proxy = await fakeProxy(() => ({content: ''}));
  try {
    const spec = baseSpec({decider: null, stages: [{name: 'pilot', items: 4, stop: {maxEmptyRate: 0.2, minItems: 2}}, {name: 'all', items: null}], concurrency: 1, repairRounds: 0});
    const job = await loadJob(makeJob(path.join(root, 'job'), spec, {checks: CHECKS}), {tiers: TIERS, config: CONFIG});
    const r = await runJob(job, {endpoint: proxy.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false});
    assert.equal(r.status, 'stopped');
    assert.match(r.stopped, /empty/);
    assert.equal(finalRecords(r.dir).rejected.size, 2, 'stopped right after minItems');
  } finally { await proxy.close(); }
  const proxy2 = await fakeProxy(worker);
  try {
    const job = await loadJob(makeJob(path.join(root, 'job2'), baseSpec({decider: null}), {checks: CHECKS}), {tiers: TIERS, config: CONFIG});
    const r = await runJob(job, {endpoint: proxy2.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false, stage: 'pilot'});
    assert.equal(r.status, 'finished');
    const f = finalRecords(r.dir);
    assert.equal(f.accepted.size + f.rejected.size, 3);
  } finally { await proxy2.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('packed jsonl calls split by id; budget refusals by the proxy stop the run', async () => {
  const root = tmp();
  const proxy = await fakeProxy(({user}) => ({content: [...user.matchAll(/Q (\w):/g)].map(m => JSON.stringify({id: m[1], label: m[1] === 'd' ? 'bad' : 'x'})).join('\n')}));
  try {
    const spec = baseSpec({checks: undefined, decider: null, packing: {itemsPerCall: 3}, output: {format: 'jsonl', fields: {label: {type: 'string', enum: ['x', 'y']}}}, repairRounds: 0});
    delete spec.checks;
    const job = await loadJob(makeJob(path.join(root, 'job'), spec), {tiers: TIERS, config: CONFIG});
    const r = await runJob(job, {endpoint: proxy.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false});
    assert.equal(proxy.chat().length, 2, '6 items in 2 calls');
    const f = finalRecords(r.dir);
    assert.equal(f.accepted.size, 5);
    assert.match(f.rejected.get('d').problems[0], /must be one of x, y/);
  } finally { await proxy.close(); }
  const refusing = await fakeProxy(() => ({status: 402, json: {error: {type: 'budget_exceeded', message: 'run over budget'}}}));
  try {
    const job = await loadJob(makeJob(path.join(root, 'job3'), baseSpec({decider: null}), {checks: CHECKS}), {tiers: TIERS, config: CONFIG});
    const r = await runJob(job, {endpoint: refusing.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false});
    assert.equal(r.status, 'stopped');
    assert.match(r.stopped, /refused/);
  } finally { await refusing.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('resume continues an interrupted run in its own folder without redoing settled items', async () => {
  const root = tmp();
  const proxy = await fakeProxy(worker);
  try {
    const job = await loadJob(makeJob(path.join(root, 'job'), baseSpec({decider: null}), {checks: CHECKS}), {tiers: TIERS, config: CONFIG});
    const store = new RunStore({root: path.join(root, 'state')});
    const dir = store.create('test-job', '20261002T000000-abcdef', {job: 'test-job', run_id: '20261002T000000-abcdef', spec_hash: job.hash, status: 'running'});
    fs.appendFileSync(path.join(dir, 'accepted.jsonl'), JSON.stringify({id: 'a', output: {final: 'A'}}) + '\n' + JSON.stringify({id: 'd', output: {final: 'D'}}) + '\n');
    assert.throws(() => store.create('test-job', '20261002T000000-abcdef', {}), /EEXIST/);
    const r = await runJob(job, {endpoint: proxy.url, store, resume: '20261002T000000-abcdef', backoffMs: 1, register: false});
    assert.equal(r.dir, dir);
    const asked = proxy.chat().map(q => /Q (\w):/.exec(q.body.messages[1].content)[1]);
    assert.ok(!asked.includes('a') && !asked.includes('d'), 'settled items are not asked again');
    const lines = fs.readFileSync(path.join(dir, 'accepted.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(new Set(lines.map(l => l.id)).size, lines.length);
  } finally { await proxy.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('spec validation, packing and tiers served by the proxy', async () => {
  assert.ok(validateSpec({name: 'x'}).some(p => p.startsWith('budget')));
  assert.ok(validateSpec({...baseSpec(), models: TIERS.small, decider: null, packing: {itemsPerCall: 2}}).some(p => p.includes('jsonl')));
  assert.deepEqual(packCalls([1, 2, 3, 4, 5], {tokenBudget: 10, maxItems: 2}, () => 4).map(c => c.length), [2, 2, 1]);
  const proxy = await fakeProxy(() => ({content: 'Final: A'}), {health: {ok: true, tiers: [{id: 'small', x_tier: {serves: 'x/y'}}, {id: 'good', x_tier: {serves: 'x/z'}}, {id: 'best', x_tier: {error: 'not configured'}}]}});
  try {
    const live = await liveTiers(proxy.url);
    const chains = tierChains({fallback: {small: TIERS.small, medium: TIERS.medium}}, live);
    assert.deepEqual(chains.small, [{upstream: null, model: 'small', tier: 'small', viaProxyTier: true}]);
    assert.equal(chains.medium[0].model, 'auditor-1');
    const root = tmp();
    const job = await loadJob(makeJob(path.join(root, 'job'), baseSpec({decider: null, inputs: {items: ITEMS.slice(0, 1), promptFields: ['q']}}), {checks: CHECKS}), {tiers: chains, config: CONFIG});
    await runJob(job, {endpoint: proxy.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false});
    assert.equal(proxy.chat()[0].path, '/v1/chat/completions');
    assert.equal(proxy.chat()[0].body.model, 'small');
    assert.equal(proxy.chat()[0].headers['x-pworker-no-fallback'], undefined, 'a proxy tier may walk its own chain');
    assert.ok(!live.has('best'));
    fs.rmSync(root, {recursive: true, force: true});
  } finally { await proxy.close(); }
});

test('a tier ladder climbs per item, records the passing tier, learns the start tier per kind and re-probes a cheaper tier', async () => {
  const root = tmp();
  const LADDER = {tiny: [{upstream: 'fake', model: 'tiny-m', tier: 'tiny'}], small: [{upstream: 'fake', model: 'small-m', tier: 'small'}], good: [{upstream: 'fake', model: 'good-m', tier: 'good'}]};
  // tiny fails items c and d (no Final line), small fails d, good answers everything.
  let tinyGood = false;
  const proxy = await fakeProxy(({body, messages}) => {
    const id = /Q (\w):/.exec(messages[1].content)[1];
    if (body.model === 'tiny-m' && !tinyGood && (id === 'c' || id === 'd')) return {content: 'no idea'};
    if (body.model === 'small-m' && !tinyGood && id === 'd') return {content: 'still no idea'};
    return {content: `Final: ${id.toUpperCase()}`};
  });
  try {
    const spec = baseSpec({models: undefined, decider: null, kind: 'qa-test', ladder: ['tiny', 'small', 'good'], quality: {minPassRate: 0.85}, adaptive: {minItems: 3, reprobeEvery: 2, probeItems: 2}, repairRounds: 0,
      stages: [{name: 'all', items: null}]});
    delete spec.models;
    const dir = makeJob(path.join(root, 'job'), spec, {checks: CHECKS});
    const store = new RunStore({root: path.join(root, 'state')});
    const job = await loadJob(dir, {tiers: LADDER, config: CONFIG});
    const r1 = await runJob(job, {endpoint: proxy.url, store, backoffMs: 1, register: false});
    assert.equal(r1.tiers.plan.start, 0, 'no data yet: explore from the cheapest tier');
    const acc = finalRecords(r1.dir).accepted;
    assert.equal(acc.get('a').tier, 'tiny');
    assert.equal(acc.get('c').tier, 'small');
    assert.equal(acc.get('d').tier, 'good');
    assert.deepEqual(acc.get('d').tiers_tried, ['tiny', 'small', 'good']);
    assert.match(r1.summary, /passed at tiny 4 \(67%\), small 1 \(17%\), good 1 \(17%\)/);
    const rows = readTierStats(store.root);
    assert.deepEqual(rows.map(x => [x.tier, x.tried, x.passed]), [['tiny', 6, 4], ['small', 2, 1], ['good', 1, 1]]);
    // tiny missed the 90% bar with enough data; small has too little data -> start at small.
    const plan2 = chooseStart({kind: 'qa-test', ladder: ['tiny', 'small', 'good'], quality: {minPassRate: 0.85}, adaptive: {minItems: 3, reprobeEvery: 2, probeItems: 2}, rows});
    assert.equal(plan2.start, 1);
    assert.equal(plan2.probe, null, 'one run of the kind so far: no probe');
    tinyGood = true;
    const r2 = await runJob(job, {endpoint: proxy.url, store, backoffMs: 1, register: false, refresh: true});
    assert.equal(r2.tiers.plan.start, 1);
    const r3 = await runJob(job, {endpoint: proxy.url, store, backoffMs: 1, register: false, refresh: true});
    assert.deepEqual(r3.tiers.plan.probe, {level: 0, items: 2}, 'every reprobeEvery runs a cheaper tier is probed');
    assert.equal(Object.values(Object.fromEntries([...finalRecords(r3.dir).accepted].map(([k, v]) => [k, v.tier]))).filter(t => t === 'tiny').length, 2);
  } finally { await proxy.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('the sink plugin receives the final records and its result reaches the summary', async () => {
  const root = tmp();
  const proxy = await fakeProxy(worker);
  try {
    const dir = makeJob(path.join(root, 'job'), baseSpec({decider: null, sink: './sink.mjs'}), {checks: CHECKS});
    fs.writeFileSync(path.join(dir, 'sink.mjs'), `export async function sink({accepted, rejected, run}, ctx) { return {stored: accepted.length, summary: 'stored ' + accepted.length + ' for ' + ctx.target.id}; }`);
    const job = await loadJob(dir, {tiers: TIERS, config: CONFIG});
    const r = await runJob(job, {endpoint: proxy.url, store: new RunStore({root: path.join(root, 'state')}), backoffMs: 1, register: false, sinkContext: {target: {kind: 'memory', id: 'm1'}}});
    assert.equal(r.sink.stored, 5);
    assert.match(r.summary, /sink: stored 5 for m1/);
  } finally { await proxy.close(); fs.rmSync(root, {recursive: true, force: true}); }
});

test('Ploinky Workers imports nothing outside its folder', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const home = path.resolve(here, '..');
  for (const dir of [home, path.join(home, 'lib')]) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.mjs'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/g)) {
        const spec = m[1] ?? m[2];
        if (spec.startsWith('node:') || !spec.startsWith('.')) { assert.ok(spec.startsWith('node:'), `${f}: only node: built-ins (${spec})`); continue; }
        assert.ok(path.resolve(dir, spec).startsWith(home + path.sep), `${f}: ${spec} leaves Ploinky Workers/`);
      }
    }
  }
});
