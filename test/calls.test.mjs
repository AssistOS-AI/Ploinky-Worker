// TaskLambdaCalls (lib/lambda/calls.mjs) and the agent's calls: a folder per call with call.json, output.json, effects, inputs and
// model calls; nested calls and the call tree; the index and its search; prune; pure reuse (the recorded output for the same hash,
// params and unchanged inputs) and no replay of a call with effects; declared effects enforced; the migration of an old plan folder;
// and the old name of the concept nowhere in Ploinky Workers. Model calls go to a fake client; no server, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallStore, effectsProblems, effectsUsedBy, inferredEffects, callStoreOf, importRunFolders } from '../lib/lambda/index.mjs';
import { runAgent, LambdaCache, executeLambda, createWorkspace, agentSettings, lambdaHash } from '../lib/agent/index.mjs';

const tmp = (name = 'ta-calls-') => fs.mkdtempSync(path.join(os.tmpdir(), name));
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const block = (code) => '```js\n' + code + '\n```';

function fakeTa(reply) {
  const calls = [];
  const ta = {
    calls, with: () => ta,
    async chat(o) { calls.push(o); return { ok: true, text: await reply(o, calls), tier: o.tier, served: `fake-${o.tier}`, credits: o.tier === 'good' ? 0.75 : 0, usage: { in: 100, out: 50 }, ms: 2, cacheKey: `k-${calls.length}` }; },
    registerRun: async () => ({ ok: true }), finishRun: async () => ({ ok: true }),
  };
  return ta;
}

const COUNT = `export const meta = {
  name: 'count-lines', task: 'Count the lines of a text file.',
  params: {file: {type: 'string', description: 'the file'}}, example: {file: 'notes.txt'}, effects: ['pure'], skills: [],
};
export default async function run(tools, params) { const t = await tools.read(params.file); return {answer: String(t.trim().split('\\n').length), outputs: []}; }
export async function check(tools, params, result) { return {ok: /^\\d+$/.test(result.answer), reason: 'a number'}; }`;

const APPEND = `export const meta = {
  name: 'append-line', task: 'Append a line of text to a log file.',
  params: {file: {type: 'string', description: 'the log file'}, text: {type: 'string', description: 'the line'}}, example: {file: 'log.txt', text: 'hello'},
  effects: ['writes-workdir'], skills: [],
};
export default async function run(tools, params) {
  let t = ''; try { t = await tools.read(params.file); } catch { t = ''; }
  await tools.write(params.file, t + params.text + '\\n');
  await tools.write('copy.tmp', 'x'); await tools.move('copy.tmp', 'copy-' + (t.split('\\n').length) + '.txt');
  return {answer: 'appended', outputs: [params.file]};
}
export async function check(tools, params, result) { const t = await tools.read(params.file); return {ok: t.endsWith(params.text + '\\n'), reason: 'the line is last'}; }`;

test('effects: declarations are checked; the code shows what it uses; old code gets inferred effects', () => {
  assert.deepEqual(effectsProblems(['pure']), []);
  assert.deepEqual(effectsProblems(['writes-workdir', 'model-calls']), []);
  assert.match(effectsProblems(['pure', 'model-calls'])[0], /stands alone/);
  assert.match(effectsProblems(['network'])[0], /not allowed/);
  assert.match(effectsProblems(['teleport'])[0], /unknown kind/);
  assert.match(effectsProblems(undefined)[0], /a list/);
  assert.deepEqual(effectsUsedBy(APPEND), ['writes-workdir']);
  assert.deepEqual(inferredEffects(COUNT), ['pure']);
  assert.deepEqual(inferredEffects("await tools.ask('tiny', 'x'); await tools.runSkillScript('s', 'a.mjs', [])"), ['model-calls', 'runs-scripts']);
});

test('call store: folders, nested calls, the tree, the index and its search, show; reuse pointers only for pure successful calls', () => {
  const store = new CallStore(tmp()).ensure();
  const a = store.start({ lambda: { name: 'outer', hash: 'h1', origin: 'built-in', effects: ['model-calls'] }, params: { q: 'alpha' }, caller: 'test', purpose: 'test:x', run: 'r1' });
  assert.match(a.id, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.match(path.relative(store.root, a.dir), /^\d{4}-\d{2}-\d{2}\/outer-[0-9a-f]{8}$/);
  a.model({ ok: true, tier: 'tiny', served: 'm', usage: { in: 3, out: 2 }, credits: 0.5, cacheKey: 'abc', cached: false, ms: 7 }, { role: 'ask' });
  a.log('hello');
  const k = CallStore.reuseKey({ hash: 'h2', params: { n: 1 } });
  const b = a.child({ lambda: { name: 'inner', hash: 'h2', origin: 'model-written', effects: ['pure'] }, params: { n: 1 }, reuseKey: k });
  b.input({ op: 'read', path: 'x.txt', sha: 'aa' });
  b.input({ op: 'read', path: 'x.txt', sha: 'aa' });
  assert.ok(b.dir.startsWith(path.join(a.dir, 'calls')));
  const c = a.child({ lambda: { name: 'writer', hash: 'h3', effects: ['writes-workdir'] }, params: {}, reuseKey: CallStore.reuseKey({ hash: 'h3' }) });
  c.effect({ kind: 'write', path: 'out.txt', before: null, after: 'ff', bytes: 2 });
  b.finish({ status: 'ok', result: { answer: 2 } });
  c.finish({ status: 'ok', result: { answer: 'written' } });
  a.finish({ status: 'ok', result: { done: true } });
  // Files of a call.
  for (const f of ['call.json', 'output.json', 'summary.json', 'models.jsonl', 'log.txt']) assert.ok(fs.existsSync(path.join(a.dir, f)), f);
  const ac = read(path.join(a.dir, 'call.json'));
  assert.deepEqual([ac.lambda.name, ac.lambda.hash, ac.params.q, ac.caller, ac.purpose, ac.run, ac.parent, ac.root, ac.status], ['outer', 'h1', 'alpha', 'test', 'test:x', 'r1', null, a.id, 'ok']);
  assert.ok(ac.started_at && ac.finished_at && ac.ms >= 0);
  const summary = read(path.join(a.dir, 'summary.json'));
  assert.deepEqual([summary.models.calls, summary.models.credits, summary.models.by_tier.tiny.calls, summary.children], [1, 0.5, 1, 2]);
  assert.deepEqual(lines(path.join(a.dir, 'models.jsonl'))[0].cache_key, 'abc');
  const bc = read(path.join(b.dir, 'call.json'));
  assert.deepEqual([bc.parent, bc.root, bc.inputs, bc.inputs_complete], [a.id, a.id, [{ op: 'read', path: 'x.txt', sha: 'aa' }], true]);
  assert.equal(read(path.join(c.dir, 'summary.json')).effects.by_kind.write, 1);
  // Reuse pointers: the pure call has one, the call with effects never.
  assert.equal(store.findReusable(k)?.id, b.id);
  assert.equal(store.findReusable(k, () => false), null, 'inputs that no longer hold: no reuse');
  assert.equal(store.findReusable(CallStore.reuseKey({ hash: 'h3' })), null);
  // The tree, the index and its search, show.
  const tree = store.tree(a.id);
  assert.deepEqual([tree.lambda, tree.children.map((x) => x.lambda)], ['outer', ['inner', 'writer']]);
  assert.deepEqual(store.search({ lambda: 'inner' }).map((e) => e.id), [b.id]);
  assert.deepEqual(store.search({ parent: a.id }).map((e) => e.id).sort(), [b.id, c.id].sort());
  assert.deepEqual(store.search({ topLevel: true }).map((e) => e.id), [a.id]);
  assert.deepEqual(store.search({ text: 'alpha' }).map((e) => e.id), [a.id]);
  assert.deepEqual(store.search({ status: 'ok', date: a.record.started_at.slice(0, 10) }).length, 3);
  assert.deepEqual(store.search({ date: '1999-01-01' }), []);
  const e = store.search({ lambda: 'outer' })[0];
  assert.deepEqual([e.status, e.children, e.credits], ['ok', 2, 0.5]);
  assert.equal(store.show(b.id).call.lambda.name, 'inner');
  assert.equal(store.show('20000101-000000-00000000'), null);
  assert.throws(() => store.show('../etc'), /invalid call id/);
  // A large result goes to result.json and is never reused.
  const big = new CallStore(tmp(), { maxResultBytes: 50 }).ensure();
  const kb = CallStore.reuseKey({ hash: 'big' });
  const h = big.start({ lambda: { name: 'big', hash: 'big', effects: ['pure'] }, reuseKey: kb });
  h.finish({ status: 'ok', result: 'x'.repeat(200) });
  assert.equal(read(path.join(h.dir, 'output.json')).result_truncated, true);
  assert.ok(fs.existsSync(path.join(h.dir, 'result.json')));
  assert.equal(big.findReusable(kb), null);
});

test('prune keeps call.json, output.json and summary.json of old calls (children included) and leaves recent and running calls', () => {
  const store = new CallStore(tmp()).ensure();
  const old = store.start({ lambda: { name: 'old', effects: ['pure'] }, now: new Date(Date.now() - 40 * 86400_000) });
  fs.writeFileSync(path.join(old.dir, 'lambda.mjs'), 'x'.repeat(1000));
  fs.mkdirSync(path.join(old.dir, 'outputs')); fs.writeFileSync(path.join(old.dir, 'outputs', 'a.csv'), 'a,b');
  const kid = old.child({ lambda: { name: 'kid', effects: ['pure'] } });
  kid.log('noise'); kid.input({ op: 'read', path: 'a', sha: 'b' });
  kid.finish({ status: 'ok', result: 1 });
  old.log('noise');
  old.finish({ status: 'ok', result: { answer: 'kept' } });
  const running = store.start({ lambda: { name: 'running', effects: ['pure'] }, now: new Date(Date.now() - 40 * 86400_000) });
  running.log('still running');
  const fresh = store.start({ lambda: { name: 'fresh', effects: ['pure'] } });
  fresh.log('recent'); fresh.finish({ status: 'ok' });
  const dry = store.prune({ days: 30, dryRun: true });
  assert.equal(dry.calls, 2);
  assert.ok(fs.existsSync(path.join(old.dir, 'lambda.mjs')), 'a dry run removes nothing');
  const r = store.prune({ days: 30 });
  assert.deepEqual([r.calls, r.days.length], [2, 1]);
  assert.ok(r.bytes >= 1000);
  assert.deepEqual(fs.readdirSync(old.dir).sort(), ['call.json', 'calls', 'output.json', 'summary.json']);
  assert.deepEqual(fs.readdirSync(kid.dir).sort(), ['call.json', 'output.json', 'summary.json']);
  assert.equal(read(path.join(old.dir, 'output.json')).result.answer, 'kept');
  assert.ok(read(path.join(old.dir, 'summary.json')).pruned_at);
  assert.ok(fs.existsSync(path.join(running.dir, 'log.txt')), 'a running call is left as it is');
  assert.ok(fs.existsSync(path.join(fresh.dir, 'log.txt')), 'a recent call is left as it is');
});

test('the calls root: the Ploinky Workers home by default, calls.dir of the configuration, or an explicit folder', () => {
  const home = tmp('ta-home-');
  assert.equal(callStoreOf({}, null, { PWORKER_HOME: home }).root, path.join(home, 'calls'));
  const dir = tmp();
  assert.equal(callStoreOf({ calls: { dir } }, null, { PWORKER_HOME: home }).root, dir);
  const explicit = tmp();
  assert.equal(callStoreOf({ calls: { dir } }, explicit, { PWORKER_HOME: home }).root, explicit);
});

/** A work folder, its call store and an agent whose planner writes `code`. */
function agentSetup(code) {
  const dir = tmp('ta-work-');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(dir, 'todo.txt'), 'x\ny\n');
  const calls = new CallStore(tmp()).ensure();
  let planner = 0;
  const ta = fakeTa((o) => {
    if (o.tier === 'good') { planner += 1; return block(code); }
    const req = o.messages.at(-1).content.split('NEW REQUEST:\n')[1];
    const id = o.messages.at(-1).content.match(/id: (\S+)/)[1];
    if (/todo\.txt/.test(req)) return JSON.stringify({ lambda: id, values: { file: 'todo.txt' }, reason: 'same task' });
    return JSON.stringify({ lambda: null, reason: 'different' });
  });
  const config = { agent: { plannerTier: 'good', matchTier: 'tiny', askTiers: ['tiny'], timeMs: 20000 } };
  return { dir, calls, ta, config, planners: () => planner, run: (request) => runAgent({ request, workdir: dir, calls, ta, config }) };
}

test('agent calls: the run is a call of `agent`, the TaskLambda a child call with its code, tool calls, inputs and output', async () => {
  const s = agentSetup(COUNT);
  const r = await s.run('Count the lines of notes.txt');
  assert.equal(r.status, 'finished', r.summary);
  assert.equal(r.answer, '3');
  const top = read(path.join(r.callDir, 'call.json'));
  assert.deepEqual([top.lambda.name, top.lambda.origin, top.params.request, top.run, top.purpose], ['agent', 'built-in', 'Count the lines of notes.txt', r.callId, `run:${r.callId}`]);
  assert.equal(read(path.join(r.callDir, 'output.json')).result.answer, '3');
  const planner = lines(path.join(r.callDir, 'models.jsonl'));
  assert.deepEqual([planner.length, planner[0].role, planner[0].tier, planner[0].credits, planner[0].cache_key], [1, 'planner', 'good', 0.75, 'k-1']);
  const tree = s.calls.tree(r.callId);
  assert.deepEqual(tree.children.map((c) => [c.lambda, c.status]), [['count-lines', 'ok']]);
  const child = path.join(r.callDir, 'calls', fs.readdirSync(path.join(r.callDir, 'calls'))[0]);
  const cc = read(path.join(child, 'call.json'));
  assert.deepEqual([cc.id, cc.parent, cc.lambda.hash, cc.lambda.origin, cc.lambda.effects, cc.params], [r.lambdaCall, r.callId, lambdaHash(COUNT), 'model-written', ['pure'], { file: 'notes.txt' }]);
  assert.equal(fs.readFileSync(path.join(child, 'lambda.mjs'), 'utf8').trim(), COUNT.trim());
  assert.deepEqual(cc.inputs.map((i) => [i.op, i.path]), [['read', 'notes.txt']]);
  assert.deepEqual(lines(path.join(child, 'tools.jsonl')).map((c) => c.op), ['read'], 'every tool call is in tools.jsonl');
  assert.equal(read(path.join(child, 'output.json')).result.result.answer, '3');
  assert.equal(new LambdaCache(r.lambdas).calls(r.lambda)[0].call, r.lambdaCall);
});

test('pure reuse: the same TaskLambda, params and unchanged inputs return the recorded output without running; a changed input runs again', async () => {
  const s = agentSetup(COUNT);
  const r1 = await s.run('Count the lines of notes.txt');
  const r2 = await s.run('Count the lines of notes.txt');
  assert.equal(r2.how, 'reuse-output');
  assert.equal(r2.reused_from, r1.lambdaCall);
  assert.equal(r2.answer, '3');
  assert.equal(s.planners(), 1);
  const child2 = s.calls.show(r2.lambdaCall);
  assert.equal(child2.output.reused_from, r1.lambdaCall);
  assert.ok(!child2.files.includes('tools.jsonl'), 'a reused call does not run: no tool call');
  // A variant (other params) runs; then the input file changes and the same call runs again.
  const r3 = await s.run('Count the lines of todo.txt');
  assert.deepEqual([r3.how, r3.answer, r3.reused_from], ['reuse', '2', null]);
  fs.appendFileSync(path.join(s.dir, 'notes.txt'), 'd\n');
  const r4 = await s.run('Count the lines of notes.txt');
  assert.deepEqual([r4.how, r4.answer, r4.reused_from], ['reuse', '4', null], 'the recorded input no longer holds');
  const r5 = await s.run('Count the lines of notes.txt');
  assert.equal(r5.reused_from, r4.lambdaCall, 'the newest call is the one reused');
  // reusePure: false, or --no-cache, runs it.
  const r6 = await runAgent({ request: 'Count the lines of notes.txt', workdir: s.dir, calls: s.calls, ta: s.ta, config: { agent: { ...s.config.agent, reusePure: false } } });
  assert.equal(r6.reused_from, null);
});

test('no replay of effectful calls: every call of a TaskLambda with effects runs, and its writes and moves are recorded with hashes', async () => {
  const s = agentSetup(APPEND);
  const r1 = await s.run('Append the line hello to log.txt');
  assert.equal(r1.status, 'finished', r1.summary);
  const r2 = await s.run('Append the line hello to log.txt');
  assert.equal(r2.how, 'reuse', 'the same request calls the cached TaskLambda');
  assert.equal(r2.reused_from, null, 'a call with effects is never replayed');
  assert.equal(fs.readFileSync(path.join(s.dir, 'log.txt'), 'utf8'), 'hello\nhello\n');
  const fx = lines(path.join(s.calls.show(r2.lambdaCall).dir, 'effects.jsonl'));
  assert.deepEqual(fx.map((e) => [e.kind, e.path]), [['write', 'log.txt'], ['write', 'copy.tmp'], ['move', 'copy-2.txt']]);
  assert.ok(fx[0].before && fx[0].after && fx[0].before !== fx[0].after, 'before and after hashes of an overwritten file');
  assert.equal(fx[1].before, null, 'a new file has no before hash');
  assert.deepEqual([fx[2].from, fx[2].to, fx[2].before === fx[2].after], ['copy.tmp', 'copy-2.txt', true]);
  const summary = read(path.join(s.calls.show(r2.lambdaCall).dir, 'summary.json'));
  assert.deepEqual(summary.effects.by_kind, { write: 2, move: 1 });
});

test('declared effects are enforced: a pure TaskLambda that writes is refused before it runs, and a hidden write fails in the tools', async () => {
  const lying = APPEND.replace("effects: ['writes-workdir']", "effects: ['pure']");
  const s = agentSetup(lying);
  const seen = [];
  s.ta.chat = async (o) => { seen.push(o); return { ok: true, text: block(seen.length === 1 ? lying : COUNT), tier: o.tier, served: 'fake', credits: 0, usage: {}, ms: 1 }; };
  const r = await runAgent({ request: 'Count the lines of notes.txt', workdir: s.dir, calls: s.calls, ta: s.ta, config: s.config, useCache: false });
  assert.equal(r.rounds, 2);
  assert.ok(seen[1].messages.some((m) => /meta\.effects: the code uses writes-workdir but declares \["pure"\]/.test(m.content)), 'the planner is told which effect is missing');
  const ws = createWorkspace(s.dir);
  const hidden = `export const meta = {name: 'hidden', task: 'Writes through a computed name.', params: {}, example: {}, effects: ['pure']};
export default async function run(tools) { await tools['wri' + 'te']('x.txt', 'x'); return {answer: 'wrote'}; }`;
  const x = await executeLambda({ code: hidden, params: {}, effects: ['pure'], workspace: ws, ta: s.ta, settings: agentSettings({}) });
  assert.equal(x.ok, false);
  assert.match(x.error.message, /needs the effect writes-workdir/);
  assert.equal(fs.existsSync(path.join(s.dir, 'x.txt')), false);
  const ask = `export const meta = {name: 'asker', task: 'Asks a model.', params: {}, example: {}, effects: ['writes-workdir']};
export default async function run(tools) { return {answer: await tools['a' + 'sk']('tiny', 'hi')}; }`;
  const y = await executeLambda({ code: ask, params: {}, effects: ['writes-workdir'], workspace: ws, ta: s.ta, settings: agentSettings({ agent: { askTiers: ['tiny'] } }) });
  assert.match(y.error.message, /needs the effect model-calls/);
});

test('migration: an old plan folder becomes the TaskLambda cache; effects are inserted, a verification is kept under the new hash', async () => {
  const dir = tmp('ta-work-');
  const old = path.join(dir, '.pworker', 'plans', 'count-lines-abc123');
  fs.mkdirSync(old, { recursive: true });
  const code = COUNT.replace("effects: ['pure'], ", '');
  const h = lambdaHash(code);
  fs.writeFileSync(path.join(old, 'plan.mjs'), code);
  fs.writeFileSync(path.join(old, 'PLAN.md'), `---\nid: count-lines-abc123\nstatus: verified\nverified_hash: ${h}\nruns: 2\n---\n# count-lines\n\n## Description\nCount lines.\n\n## First request\nCount the lines of notes.txt\n\n## Last runs\n- earlier\n`);
  fs.writeFileSync(path.join(old, 'runs.jsonl'), '{"run":"x"}\n');
  const cache = new LambdaCache(path.join(dir, '.pworker', 'lambdas')).ensure();
  assert.equal(fs.existsSync(path.join(dir, '.pworker', 'plans')), false, 'the old folder is moved');
  const e = cache.read('count-lines-abc123');
  assert.match(e.code, /export const meta = \{effects: \['pure'\], /);
  assert.equal(e.code.split('\n').length, code.split('\n').length, 'line numbers are kept');
  assert.equal(e.status, 'verified');
  assert.equal(e.front.calls, 2);
  assert.match(e.md, /## Last calls\n- earlier/);
  assert.deepEqual(cache.calls('count-lines-abc123'), [{ run: 'x' }]);
  for (const f of ['plan.mjs', 'PLAN.md', 'runs.jsonl']) assert.equal(fs.existsSync(path.join(e.dir, f)), false, f);
});

test('import: the run folders of before (job runs with items, tasks, operations, agent runs) are wrapped as calls, once', () => {
  const data = tmp('ta-runs-'), wd = tmp('ta-work-');
  const w = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v)); };
  const run = path.join(data, 'upper', '20261002T143343-3fb879');
  w(path.join(run, 'run.json'), { job: 'upper', run_id: '20261002T143343-3fb879', spec_hash: 'ab'.repeat(32), stage: 'all', status: 'finished', started_at: '2026-10-02T14:33:43.000Z', finished_at: '2026-10-02T14:35:00.000Z', counts: { accepted: 2 } });
  w(path.join(run, 'accepted.jsonl'), '{"id":"a","output":"A","at":"2026-10-02T14:34:00.000Z"}\n{"id":"b","output":"B"}\n');
  w(path.join(run, 'rejected.jsonl'), '{"id":"c","problems":["empty"]}\n');
  w(path.join(run, 'summary.md'), '# upper run: finished\n');
  w(path.join(data, 'tasks', '20261002T154702-735fe7', 'task.json'), { id: '20261002T154702-735fe7', created_at: '2026-10-02T15:47:02.000Z', instructions: 'Learn the handbook', status: 'finished', attachments: [{ name: 'h.md', sha256: 'cd', bytes: 3 }] });
  w(path.join(data, 'ops', '20261003T145619-skill-0a72dd', 'request.json'), { id: '20261003T145619-skill-0a72dd', kind: 'skill', args: { name: 'echo', inputs: { text: 'hi' }, attachments: [] }, purpose: ['skill', 'echo'].join(':') });
  w(path.join(data, 'ops', '20261003T145619-skill-0a72dd', 'result.json'), { status: 'finished', result: { status: 'finished', summary: 'hi' }, error: null });
  w(path.join(data, 'ops', '20261003T145613-skills-4fae59', 'request.json'), { id: 'x', kind: 'skills', args: {} });
  w(path.join(wd, '.pworker', 'runs', '20261003T120000-agent-aa', 'request.json'), { id: '20261003T120000-agent-aa', request: 'Sum it', at: '2026-10-03T12:00:00.000Z' });
  w(path.join(wd, '.pworker', 'runs', '20261003T120000-agent-aa', 'result.json'), { status: 'finished', answer: '5', ms: 1500 });
  const store = new CallStore(tmp()).ensure();
  const dry = importRunFolders(store, { dataDir: data, workdirs: [wd], dryRun: true });
  assert.deepEqual([dry.calls, store.days()], [4, []], 'a dry run writes nothing');
  const r = importRunFolders(store, { dataDir: data, workdirs: [wd] });
  assert.deepEqual([r.calls, r.items, r.skipped], [4, 3, 0]);
  const job = store.search({ lambda: 'job' })[0];
  assert.equal(job.started_at, '2026-10-02T14:33:43.000Z', 'the call keeps the time of the run');
  const jc = store.show(job.id);
  assert.deepEqual([jc.call.migrated_from, jc.call.job_run.run, jc.output.status, jc.call.ms], [run, '20261002T143343-3fb879', 'ok', 77000]);
  assert.deepEqual(store.tree(job.id).children.map((c) => [c.lambda, c.status]).sort(), [['upper.item', 'failed'], ['upper.item', 'ok'], ['upper.item', 'ok']]);
  assert.equal(store.search({ lambda: 'task' })[0].status, 'ok');
  const op = store.show(store.search({ lambda: 'echo' })[0].id);
  assert.deepEqual([op.call.params, op.output.result.summary], [{ text: 'hi' }, 'hi']);
  assert.equal(store.search({ lambda: 'agent' })[0].ms, 1500);
  assert.equal(importRunFolders(store, { dataDir: data, workdirs: [wd] }).skipped, 4, 'a second import adds nothing');
  assert.ok(fs.existsSync(path.join(run, 'run.json')) && !fs.existsSync(path.join(run, 'call.json')), 'the original folder is not changed');
});

test('the old names of the TaskLambda concept appear nowhere in Ploinky Workers', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // The old concept name, and the aliases dropped on 2026-10-03 (the old endpoint, command, client methods, configuration keys, purpose
  // prefix and the helpers file that carried them); the patterns are assembled so this file does not match itself.
  const OLD = new RegExp([['skill', 'plugin'].join('[\\s_-]*'), '/v1/' + 'skills', 'run-' + 'skills', 'ta\\.' + 'skills?\\(', 'skills\\.' + '(plugins|jobs)', "['\"`]" + 'skill' + ':', 'lib/' + 'legacy', 'OLD_' + 'LAMBDA', 'lambda' + '(Purpose|Sources)'].join('|'), 'i');
  // Files of another agent not yet committed when the rename landed (TODO.md "TaskLambda rename"); this list only shrinks.
  const PENDING = new Set([]);
  const bad = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|json|md)$/.test(e.name) && OLD.test(fs.readFileSync(p, 'utf8')) && !PENDING.has(path.relative(root, p))) bad.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(bad, [], 'say TaskLambda');
});
