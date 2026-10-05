// Tasks: planning from instructions over a template library, deterministic plan validation, prompt and adapter templates, pruning.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runTask, validatePlan, loadTemplates, pruneTasks} from '../lib/jobs/index.mjs';
import {fakeProxy} from './fake-endpoint.mjs';

function library(root) {
  const t = path.join(root, 'templates');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(t, rel)), {recursive: true}); fs.writeFileSync(path.join(t, rel), typeof text === 'string' ? text : JSON.stringify(text)); };
  w('extract/template.json', {name: 'extract', description: 'extract records', kind: 'prompt', targets: ['none'], taskKind: 'extract',
    params: {columns: {type: 'string[]', min: 1, max: 5}, chunk_chars: {type: 'integer', min: 10, max: 1000, default: 200}}, ladder: ['small', 'good'], ladderAllowed: ['small', 'good'], budget: {usd: 0.1}});
  w('extract/job.json', {name: 'extract', kind: 'extract', inputs: {attachments: {chunkChars: '{{params.chunk_chars}}'}, promptFields: ['text']}, ladder: ['small', 'good'],
    output: {format: 'jsonl', fields: {record: 'object'}}, repairRounds: 0, budget: {usd: 0.1}, decider: null, stages: [{name: 'all', items: null}]});
  w('extract/prompt.md', '<<<system>>>\nColumns: {{params.columns}}\n<<<item>>>\n{{text}}\n');
  w('learn/template.json', {name: 'learn', description: 'learn a document', kind: 'adapter', adapter: 'adapter.mjs', targets: ['memory'], params: {rights: {type: 'string', enum: ['cleared', 'owner-provided']}}, budget: {usd: 0.2}});
  w('learn/adapter.mjs', `export async function run({params, attachments, target, fetchImpl, endpoint}) {
    const r = await fetchImpl(endpoint + '/v1/chat/completions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({model: 'small', messages: [{role: 'user', content: 'x'}]})});
    await r.text();
    return {status: 'finished', summary: 'learned ' + attachments.length + ' file(s) into ' + target.id + ' with rights ' + params.rights};
  }`);
  return t;
}

const config = (root, templatesDir) => ({endpoint: null, dataDir: path.join(root, 'state'), roles: {planner: 'good', decider: 'good', auditor: 'medium', worker: 'small'},
  fallback: {small: [{upstream: 'fake', model: 'small-m'}], good: [{upstream: 'fake', model: 'good-m'}]}, limits: {maxTaskUsd: 1}, tasks: {keepDays: 7}, templatesDir});

test('plan validation is deterministic: template, target, params, ladder and budget limits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-task-'));
  const templates = loadTemplates(library(root));
  const ok = validatePlan({template: 'extract', params: {columns: ['price']}}, {templates, target: 'none', limits: {maxTaskUsd: 1}});
  assert.ok(ok.ok);
  assert.equal(ok.plan.params.chunk_chars, 200, 'defaults apply');
  const bad = validatePlan({template: 'extract', params: {columns: [], extra: 1}, ladder: ['tiny'], budget: {usd: 5}}, {templates, target: 'memory', limits: {maxTaskUsd: 1}});
  assert.ok(!bad.ok);
  for (const want of [/cannot write to a memory/, /params.extra: not a parameter/, /params.columns: at least 1/, /ladder:/, /budget.usd: 5 is above the limit 1/]) assert.ok(bad.problems.some(p => want.test(p)), String(want));
  assert.ok(!validatePlan({template: 'nope'}, {templates}).ok);
  fs.rmSync(root, {recursive: true, force: true});
});

test('a task is planned by the planner tier, run as a job over chunked attachments, and leaves a task folder with a short summary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pworker-task-'));
  const proxy = await fakeProxy(({body, user}) => {
    if (body.model === 'good-m' && user.includes('INSTRUCTIONS')) return {content: user.includes('round two') ? '' : '{"template":"extract","params":{"columns":["price"]},"reason":"prices"}'};
    return {content: `{"record": {"price": "${(/(\d+) EUR/.exec(user) || [])[1] ?? 'none'}"}}`};
  });
  try {
    const cfg = {...config(root, library(root)), endpoint: proxy.url};
    const file = path.join(root, 'prices.txt');
    fs.writeFileSync(file, 'Apples cost 3 EUR.\n\nPears cost 4 EUR.\n\nPlums cost 5 EUR.');
    const r = await runTask({instructions: 'Extract the prices', attachments: [{name: 'prices.txt', path: file}], target: {kind: 'none'}, config: cfg, live: new Set()});
    assert.equal(r.status, 'finished', r.summary);
    assert.equal(r.plan.template, 'extract');
    assert.ok(r.summary.split('\n').length <= 10);
    assert.ok(fs.existsSync(path.join(r.dir, 'task.json')) && fs.existsSync(path.join(r.dir, 'plan.json')) && fs.existsSync(path.join(r.dir, 'attachments', 'prices.txt')));
    const planner = proxy.chat().find(q => q.body.model === 'good-m');
    assert.equal(planner.headers['x-pworker-purpose'], 'job:planner');
    assert.ok(!planner.user.includes('Plums cost 5 EUR') || planner.user.length < 2000, 'the planner sees previews, not whole files');
    const runDir = path.join(r.dir, 'extract', r.result.run);
    assert.ok(fs.readFileSync(path.join(runDir, 'accepted.jsonl'), 'utf8').includes('"price":"3"'));
    // An explicit template skips the planner; an adapter template gets a tagged fetch.
    const before = proxy.chat().filter(q => q.body.model === 'good-m').length;
    const a = await runTask({attachments: [{name: 'doc.txt', text: 'hello'}], target: {kind: 'memory', id: 'm1'}, template: 'learn', params: {rights: 'cleared'}, config: cfg, live: new Set()});
    assert.equal(a.status, 'finished', a.summary);
    assert.match(a.summary, /learned 1 file\(s\) into m1 with rights cleared/);
    assert.equal(proxy.chat().filter(q => q.body.model === 'good-m').length, before);
    const tagged = proxy.chat().at(-1);
    assert.equal(tagged.headers['x-pworker-purpose'], 'job:learn');
    assert.equal(tagged.headers['x-pworker-run'], a.task);
    assert.ok(proxy.requests.some(q => q.path === '/jobs/register' && q.body.run === a.task && q.body.budget.usd === 0.2));
    // A plan the validator refuses is reported, never run.
    const refused = await runTask({attachments: [{name: 'doc.txt', text: 'x'}], target: {kind: 'memory', id: 'm1'}, template: 'learn', params: {rights: 'unknown'}, config: cfg, live: new Set()});
    assert.equal(refused.status, 'plan_refused');
    assert.match(refused.summary, /params.rights: one of/);
    // Pruning removes task folders past keepDays only.
    assert.deepEqual(pruneTasks(cfg), []);
    assert.equal(pruneTasks(cfg, {now: Date.now() + 8 * 86400_000}).length, 3);
  } finally { await proxy.close(); fs.rmSync(root, {recursive: true, force: true}); }
});
