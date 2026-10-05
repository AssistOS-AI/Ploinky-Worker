// The agent of `pworker run`: BM25, frontmatter, path confinement, skill discovery and scripts, schema extraction, the TaskLambda
// cache lifecycle (written -> verified -> reused; draft; edited -> re-verified), re-planning, plan-only, promotion, and adversarial
// TaskLambdas against the tools. Model calls go to a fake client; call folders go to a temporary folder; no server, no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildIndex, terms, parseFrontmatter, createWorkspace, discoverSkills, skillRoots, runSkillScript, coerceToSchema, matchLambda,
  runAgent, LambdaCache, lambdaHash, moduleScript, executeLambda, agentSettings, promotedLambdaSource, extractMeta, hardcodedValues, codeLiterals,
} from '../lib/agent/index.mjs';

const tmp = (name = 'ta-agent-') => fs.mkdtempSync(path.join(os.tmpdir(), name));
const MATCH_PROMPT = new URL('../prompts/agent-match.md', import.meta.url).pathname;

/** A fake Ploinky Workers client: `reply(o)` gives the text of each call by tier; every call is kept. */
function fakeTa(reply) {
  const calls = [];
  const ta = {
    calls,
    with: () => ta,
    async chat(o) { calls.push(o); const text = await reply(o, calls); return { ok: true, text, tier: o.tier, served: `fake-${o.tier}`, credits: o.tier === 'good' ? 0.1 : 0, usage: { in: 100, out: 50 }, ms: 2 }; },
    registerRun: async () => ({ ok: true }), finishRun: async () => ({ ok: true }),
  };
  return ta;
}
const CALLS = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-calls-'));
const CONFIG = { agent: { plannerTier: 'good', matchTier: 'tiny', askTiers: ['tiny', 'small'], timeMs: 20000 }, calls: { dir: CALLS } };
const block = (code) => '```js\n' + code + '\n```';

const SUM_PLAN = `export const meta = {
  name: 'sum-csv-column',
  task: 'Sum a numeric column of a CSV file.',
  params: {file: {type: 'string', description: 'the CSV file'}, column: {type: 'string', description: 'the header of the column to sum'}},
  example: {file: 'sales.csv', column: 'amount'}, effects: ['pure'],
  skills: [],
};
const rowsOf = (text) => text.trim().split('\\n').map((l) => l.split(','));
export default async function run(tools, params) {
  const rows = rowsOf(await tools.read(params.file));
  const i = rows[0].indexOf(params.column);
  if (i < 0) throw new Error('no column ' + params.column);
  return {answer: String(rows.slice(1).reduce((s, r) => s + Number(r[i]), 0)), outputs: []};
}
export async function check(tools, params, result) {
  const rows = rowsOf(await tools.read(params.file));
  const i = rows[0].indexOf(params.column);
  let t = 0; for (const r of rows.slice(1)) t += Number(r[i]);
  return {ok: String(t) === result.answer, reason: 'recomputed the total'};
}`;

function csvFolder() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'sales.csv'), 'id,amount,qty\n1,10,2\n2,32,1\n3,8,5\n');
  fs.writeFileSync(path.join(dir, 'march.csv'), 'id,amount,qty\n1,100,7\n2,1,1\n');
  return dir;
}

test('BM25 ranks the document that shares the rare terms first, in milliseconds', () => {
  assert.deepEqual(terms('Renaming the FILES, copies; boxes'), ['renaming', 'the', 'file', 'copy', 'box']);
  const docs = [
    { id: 'sum', fields: [{ text: 'Sum a numeric column of a CSV file', weight: 2 }, { text: 'file column' }] },
    { id: 'rename', fields: [{ text: 'Rename files in a folder by a pattern', weight: 2 }, { text: 'folder pattern prefix' }] },
    { id: 'table', fields: [{ text: 'Extract a table from a text file into CSV', weight: 2 }] },
  ];
  for (let i = 0; i < 300; i++) docs.push({ id: `filler-${i}`, fields: [{ text: `unrelated document number ${i} about weather and gardens` }] });
  const t0 = performance.now();
  const idx = buildIndex(docs);
  const hits = idx.search('rename the photos in this folder with prefix img', { k: 3 });
  assert.ok(performance.now() - t0 < 100, 'index and search within 100 ms');
  assert.equal(hits[0].id, 'rename');
  assert.equal(idx.search('sum the qty column of march.csv')[0].id, 'sum');
  assert.deepEqual(idx.search('zzz qqq'), []);
});

test('frontmatter: scalars, quoted strings, block scalars, lists and one nested map', () => {
  const { data, body } = parseFrontmatter(`---\nname: csv-tools\ndescription: >\n  Tools for CSV files:\n  totals and columns.\nlicense: "MIT"\nscripts:\n  - scripts/stats.mjs\n  - scripts/x.py\nmetadata:\n  version: 2\n  author: someone\nflag: true\n---\n# Body\ntext\n`);
  assert.equal(data.name, 'csv-tools');
  assert.equal(data.description, 'Tools for CSV files: totals and columns.');
  assert.equal(data.license, 'MIT');
  assert.deepEqual(data.scripts, ['scripts/stats.mjs', 'scripts/x.py']);
  assert.deepEqual(data.metadata, { version: 2, author: 'someone' });
  assert.equal(data.flag, true);
  assert.match(body, /^# Body/);
  assert.equal(parseFrontmatter('no frontmatter').hasFrontmatter, false);
});

test('path confinement: escapes through .., absolute paths, symbolic links and protected folders are refused', () => {
  const dir = tmp(), outside = tmp('ta-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'A');
  fs.symlinkSync(outside, path.join(dir, 'out-link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'secret-link.txt'));
  fs.symlinkSync(path.join(dir, 'sub', 'a.txt'), path.join(dir, 'inner-link.txt'));
  fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(dir, 'dangling.txt'));
  const ws = createWorkspace(dir);
  assert.equal(ws.read('sub/a.txt'), 'A');
  assert.equal(ws.read(path.join(dir, 'sub', 'a.txt')), 'A', 'an absolute path inside is accepted');
  assert.equal(ws.read('inner-link.txt'), 'A', 'a link that stays inside can be read');
  for (const p of ['../x', 'sub/../../x', path.join(outside, 'secret.txt'), 'out-link/secret.txt', 'secret-link.txt', 'dangling.txt', 'a\0b', '', '/etc/passwd']) {
    assert.throws(() => ws.read(p), (e) => e.code === 'path_refused', `read ${JSON.stringify(p)}`);
  }
  for (const p of ['out-link/new.txt', 'inner-link.txt', 'dangling.txt', '.pworker/plans/x/plan.mjs', '.agents/skills/x/SKILL.md', '.git/config', '.', '../y.txt']) {
    assert.throws(() => ws.write(p, 'x'), (e) => e.code === 'path_refused', `write ${JSON.stringify(p)}`);
  }
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
  assert.deepEqual(ws.write('deep/new/file.txt', 'hi'), { path: 'deep/new/file.txt', bytes: 2 });
  assert.deepEqual(ws.move('deep/new/file.txt', 'moved.txt'), { from: 'deep/new/file.txt', to: 'moved.txt' });
  assert.throws(() => ws.move('sub/a.txt', 'moved.txt'), /never overwrites/);
  assert.throws(() => ws.move('moved.txt', 'out-link/x.txt'), (e) => e.code === 'path_refused');
  assert.throws(() => ws.list('out-link'), (e) => e.code === 'path_refused');
  const listed = ws.list('.', { recursive: true }).map((e) => e.path);
  assert.ok(listed.includes('sub/a.txt') && listed.includes('out-link') && !listed.includes('out-link/secret.txt'), 'links are listed, never followed');
  assert.deepEqual(ws.search('a', { dir: 'sub' }).map((h) => h.path), ['sub/a.txt']);
  const small = createWorkspace(dir, { limits: { maxWriteBytes: 10 } });
  assert.throws(() => small.write('big.txt', 'x'.repeat(11)), /write limit/);
});

test('skill discovery: .agents/skills first, then the configured folders; declared scripts only; no shell', async () => {
  const dir = tmp(), extra = tmp('ta-skills-'), outside = tmp('ta-outside-');
  const mk = (root, name, fm, files = {}) => {
    fs.mkdirSync(path.join(root, name, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(root, name, 'SKILL.md'), `---\n${fm}\n---\n# ${name}\nInstructions of ${name}.\n`);
    for (const [f, t] of Object.entries(files)) fs.writeFileSync(path.join(root, name, f), t);
  };
  const local = path.join(dir, '.agents', 'skills');
  mk(local, 'csv-tools', 'name: csv-tools\ndescription: Totals of CSV columns.', { 'scripts/echo.mjs': 'console.log(JSON.stringify(process.argv.slice(2)))', 'scripts/slow.mjs': 'setTimeout(() => {}, 100000)', 'scripts/loud.mjs': 'process.stdout.write("x".repeat(1e6))' });
  mk(local, 'listed', 'name: listed\ndescription: Only the listed script.\nscripts: [scripts/ok.mjs]', { 'scripts/ok.mjs': 'console.log("ok")', 'scripts/hidden.mjs': 'console.log("hidden")' });
  fs.writeFileSync(path.join(outside, 'evil.mjs'), 'console.log("evil")');
  fs.symlinkSync(path.join(outside, 'evil.mjs'), path.join(local, 'csv-tools', 'scripts', 'evil.mjs'));
  mk(extra, 'csv-tools', 'name: csv-tools\ndescription: A second definition that loses.');
  mk(extra, 'summarize', 'name: summarize\ndescription: Summaries of text files.');
  mk(extra, 'Bad_Name', 'name: Bad_Name\ndescription: invalid');
  const { skills, problems } = discoverSkills(skillRoots(dir, [extra]));
  assert.deepEqual([...skills.keys()].sort(), ['csv-tools', 'listed', 'summarize']);
  assert.equal(skills.get('csv-tools').description, 'Totals of CSV columns.');
  assert.deepEqual(skills.get('csv-tools').scripts, ['scripts/echo.mjs', 'scripts/loud.mjs', 'scripts/slow.mjs'], 'a link leaving the skill folder is not a script');
  assert.deepEqual(skills.get('listed').scripts, ['scripts/ok.mjs']);
  assert.ok(problems.some((p) => /already defined/.test(p)) && problems.some((p) => /Bad_Name/.test(p)));
  const r = await runSkillScript(skills.get('csv-tools'), 'scripts/echo.mjs', ['$(touch pwned)', '; rm -rf /', '`id`'], { cwd: dir });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.stdout), ['$(touch pwned)', '; rm -rf /', '`id`']);
  assert.equal(fs.existsSync(path.join(dir, 'pwned')), false);
  await assert.rejects(runSkillScript(skills.get('listed'), 'scripts/hidden.mjs', [], { cwd: dir }), /not declared/);
  await assert.rejects(runSkillScript(skills.get('csv-tools'), 'scripts/evil.mjs', [], { cwd: dir }), /not declared/);
  await assert.rejects(runSkillScript(skills.get('csv-tools'), '../../../../bin/sh', [], { cwd: dir }), /not declared/);
  await assert.rejects(runSkillScript(skills.get('csv-tools'), 'scripts/echo.mjs', [1], { cwd: dir }), /strings/);
  const slow = await runSkillScript(skills.get('csv-tools'), 'scripts/slow.mjs', [], { cwd: dir, limits: { timeMs: 500 } });
  assert.equal(slow.timedOut, true);
  const loud = await runSkillScript(skills.get('csv-tools'), 'scripts/loud.mjs', [], { cwd: dir, limits: { maxOutputBytes: 1000 } });
  assert.equal(loud.truncated, true);
  assert.ok(loud.stdout.length <= 1000);
});

test('schema extraction: values are coerced and validated; a refusal, a wrong id, a misfit or an invented value goes to the planner', async () => {
  const schema = { n: { type: 'integer', description: 'n' }, on: { type: 'boolean', description: 'b' }, cols: { type: 'string[]', description: 'c' } };
  assert.deepEqual(coerceToSchema(schema, { n: '12', on: 'false', cols: 'a' }), { n: 12, on: false, cols: ['a'] });
  const plans = [{ id: 'sum-csv-column-abc123', status: 'verified', description: 'Sum a numeric column of a CSV file.', firstRequest: 'Sum the amount column of sales.csv',
    meta: { name: 'sum-csv-column', task: 'Sum a numeric column of a CSV file.', params: { file: { type: 'string', description: 'csv' }, column: { type: 'string', description: 'column' } }, example: { file: 'sales.csv', column: 'amount' } } }];
  const run = (answer, request = 'Sum the qty column of march.csv') => matchLambda({ request, lambdas: plans, promptFile: MATCH_PROMPT, ask: async () => ({ ok: true, text: JSON.stringify(answer), ms: 1 }) });
  let d = await run({ plan: 'sum-csv-column-abc123', values: { file: 'march.csv', column: 'qty' }, reason: 'same' });
  assert.equal(d.decision, 'reuse');
  assert.deepEqual(d.values, { file: 'march.csv', column: 'qty' });
  assert.equal(d.candidates[0].id, 'sum-csv-column-abc123');
  assert.equal(typeof d.bm25Ms, 'number');
  d = await run({ plan: null, values: {}, reason: 'different' });
  assert.equal(d.decision, 'plan');
  d = await run({ plan: 'other-plan', values: {} });
  assert.match(d.reason, /not a candidate/);
  d = await run({ plan: 'sum-csv-column-abc123', values: { file: 'march.csv' } });
  assert.match(d.reason, /column: required/);
  d = await run({ plan: 'sum-csv-column-abc123', values: { file: 'march.csv', column: 'qty', extra: 1 } });
  assert.match(d.reason, /not a parameter/);
  d = await run({ plan: 'sum-csv-column-abc123', values: { file: 'april.csv', column: 'qty' } });
  assert.match(d.reason, /not found in the request: file/);
  d = await matchLambda({ request: 'Paint a fence green', lambdas: plans, promptFile: MATCH_PROMPT, ask: async () => assert.fail('no candidate: no model call') });
  assert.equal(d.decision, 'plan');
});

test('the cache lifecycle: written -> verified -> called again for a parameter variant without the planner; a different task is planned', async () => {
  const dir = csvFolder();
  let planner = 0, match = 0;
  const ta = fakeTa((o) => {
    if (o.tier === 'good') { planner += 1; return block(SUM_PLAN); }
    match += 1;
    const req = o.messages.at(-1).content.split('NEW REQUEST:\n')[1];
    return /qty column of march/.test(req) ? JSON.stringify({ lambda: o.messages.at(-1).content.match(/id: (\S+)/)[1], values: { file: 'march.csv', column: 'qty' }, reason: 'same task' }) : JSON.stringify({ lambda: null, reason: 'different task' });
  });
  const logs = [];
  const r1 = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG, log: (l) => logs.push(l) });
  assert.equal(r1.status, 'finished', JSON.stringify(r1));
  assert.equal(r1.answer, '50');
  assert.equal(r1.how, 'plan');
  assert.equal(r1.lambdaStatus, 'verified');
  assert.equal(r1.lambdas, path.join(fs.realpathSync(dir), '.pworker', 'lambdas'));
  assert.ok(logs.some((l) => l.startsWith('lambdas: ')) && logs.some((l) => l.startsWith('call: ')), 'every run prints the TaskLambda folder and its call folder');
  for (const f of ['call.json', 'decision.json', 'lambda-1.mjs', 'models.jsonl', 'output.json', 'summary.json']) assert.ok(fs.existsSync(path.join(r1.callDir, f)), f);
  assert.ok(r1.callDir.startsWith(CALLS), 'the call folder is in the calls root');
  const cache = new LambdaCache(r1.lambdas);
  const stored = cache.read(r1.lambda);
  assert.equal(stored.status, 'verified');
  for (const f of ['lambda.mjs', 'LAMBDA.md', 'calls.jsonl']) assert.ok(fs.existsSync(path.join(stored.dir, f)), f);
  assert.match(stored.md, /## Parameters\n- `file` \(string\)/);

  const r2 = await runAgent({ request: 'Sum the qty column of march.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r2.status, 'finished');
  assert.equal(r2.how, 'reuse');
  assert.equal(r2.answer, '8');
  assert.equal(planner, 1, 'the variant ran the cached plan: no planner call');
  assert.equal(r2.stats.roles.planner, undefined);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r2.callDir, 'decision.json'), 'utf8')).decision, 'reuse');
  assert.equal(cache.calls(r1.lambda).length, 2);

  const r3 = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r3.decision.how, 'exact', 'the same request calls the TaskLambda without the match tier');
  assert.equal(match, 1);

  const r4 = await runAgent({ request: 'Count the lines of every csv file', workdir: dir, ta, config: CONFIG });
  assert.equal(r4.decision.decision, 'plan', 'a different task is not a reuse');
  assert.equal(planner, 2);
});

test('a TaskLambda without a check is stored as draft and not reused until verified', async () => {
  const dir = csvFolder();
  const noCheck = SUM_PLAN.slice(0, SUM_PLAN.indexOf('export async function check'));
  let planner = 0;
  const ta = fakeTa((o) => { if (o.tier === 'good') { planner += 1; return block(noCheck); } return JSON.stringify({ lambda: o.messages.at(-1).content.match(/id: (\S+)/)[1], values: { file: 'march.csv', column: 'qty' } }); });
  const r1 = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r1.lambdaStatus, 'draft');
  const r2 = await runAgent({ request: 'Sum the qty column of march.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r2.how, 'plan', 'a draft is never reused');
  assert.equal(r2.decision.reason, 'the cache has no verified TaskLambda');
  const cache = new LambdaCache(r1.lambdas);
  cache.verify(r1.lambda);
  const r3 = await runAgent({ request: 'Sum the qty column of march.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r3.how, 'reuse');
  assert.equal(r3.answer, '8');
});

test('a TaskLambda edited by hand changes its hash and is re-verified by its check before reuse; a failing edit is not reused', async () => {
  const dir = csvFolder();
  let planner = 0;
  const ta = fakeTa((o) => { if (o.tier === 'good') { planner += 1; return block(SUM_PLAN); } return JSON.stringify({ lambda: o.messages.at(-1).content.match(/id: (\S+)/)[1], values: { file: 'march.csv', column: 'qty' } }); });
  const r1 = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  const cache = new LambdaCache(r1.lambdas);
  const file = path.join(cache.lambdaDir(r1.lambda), 'lambda.mjs');
  const before = cache.read(r1.lambda).hash;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("return {answer: String(", "tools.log('edited');\n  return {answer: String("));
  assert.equal(cache.read(r1.lambda).status, 'edited');
  const r2 = await runAgent({ request: 'Sum the qty column of march.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r2.how, 'reuse-reverified');
  assert.equal(r2.answer, '8');
  const after = cache.read(r1.lambda);
  assert.equal(after.status, 'verified');
  assert.notEqual(after.hash, before);
  assert.equal(after.front.verified_hash, after.hash);
  // A wrong edit: the check fails, the plan is not reused, the planner writes a new one.
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("String(rows.slice(1)", "String(1 + rows.slice(1)"));
  const r3 = await runAgent({ request: 'Sum the qty column of march.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r3.how, 'plan');
  assert.equal(r3.status, 'finished');
  assert.notEqual(r3.lambda, r1.lambda, 'a new TaskLambda never overwrites one edited by hand');
  assert.equal(planner, 2);
  assert.equal(r3.decision.fallback.lambda, r1.lambda);
  assert.equal(cache.read(r1.lambda).status, 'edited');
});

test('a failing TaskLambda goes back to the planner with its error, at most maxRounds rounds; plan-only runs nothing', async () => {
  const dir = csvFolder();
  const broken = SUM_PLAN.replace("rows[0].indexOf(params.column);\n  if", "rows[0].indexOf(params.colum);\n  if");
  const seen = [];
  const ta = fakeTa((o) => { seen.push(o.messages.at(-1).content); return block(seen.length === 1 ? broken : SUM_PLAN); });
  const r = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG, useCache: false });
  assert.equal(r.status, 'finished');
  assert.equal(r.rounds, 2);
  assert.match(seen[1], /The TaskLambda failed \(run, sandbox_error\): no column amount \(at run \(lambda\.js:12:/, 'the error names the line of lambda.mjs');
  assert.match(seen[1], /read\("sales\.csv"\)/);
  assert.equal(fs.readFileSync(path.join(r.callDir, 'errors.jsonl'), 'utf8').trim().split('\n').length, 1);
  assert.ok(fs.existsSync(path.join(r.callDir, 'lambda-2.mjs')));

  const always = fakeTa(() => block(broken));
  const f = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta: always, config: { agent: { ...CONFIG.agent, maxRounds: 3 } }, useCache: false });
  assert.equal(f.status, 'failed');
  assert.equal(always.calls.length, 3);

  const dry = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: tmp(), ta: fakeTa(() => block(SUM_PLAN)), config: CONFIG, planOnly: true });
  assert.equal(dry.status, 'planned');
  assert.match(dry.code, /export default async function run/);
  assert.deepEqual(new LambdaCache(dry.lambdas).ids(), [], 'plan-only stores nothing');
});

test('the planner may ask once for skill bodies and file heads (progressive disclosure)', async () => {
  const dir = csvFolder();
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'csv-tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'csv-tools', 'SKILL.md'), '---\nname: csv-tools\ndescription: Totals of CSV columns.\n---\nBODY-OF-CSV-TOOLS\n');
  const seen = [];
  const ta = fakeTa((o) => { seen.push(o.messages.map((m) => ({ ...m }))); return seen.length === 1 ? '{"load_skills": ["csv-tools"], "peek": ["sales.csv", "../etc/passwd"]}' : block(SUM_PLAN); });
  const r = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r.status, 'finished');
  assert.match(seen[0][0].content, /- csv-tools: Totals of CSV columns\./);
  assert.doesNotMatch(seen[0][0].content, /BODY-OF-CSV-TOOLS/, 'the planner sees names and descriptions first');
  const context = seen[1].at(-1).content;
  assert.match(context, /BODY-OF-CSV-TOOLS/);
  assert.match(context, /id,amount,qty/);
  assert.match(context, /etc\/passwd: .*outside/);
});

test('adversarial TaskLambdas: the tools refuse escapes, undeclared scripts, other tiers; no host object is reachable', async () => {
  const dir = csvFolder(), outside = tmp('ta-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(dir, 'link'));
  const ws = createWorkspace(dir);
  const ta = fakeTa(() => 'model says hi');
  const S = agentSettings({ agent: { askTiers: ['tiny'], maxAsks: 2, timeMs: 5000 } });
  const probe = (body) => `export const meta = {name: 'probe', task: 'An adversarial probe TaskLambda.', params: {}, example: {}, effects: ['writes-workdir', 'model-calls', 'runs-scripts']};
export default async function run(tools, params) { ${body} }`;
  const attempt = async (body) => (await executeLambda({ code: probe(body), params: {}, effects: ['writes-workdir', 'model-calls', 'runs-scripts'], workspace: ws, ta, settings: S }));
  const refusals = {
    dotdot: `return await tools.read('../../etc/passwd');`,
    link: `return await tools.read('link/secret.txt');`,
    writeOut: `return await tools.write('link/pwned.txt', 'x');`,
    cache: `return await tools.write('.pworker/plans/evil/plan.mjs', 'x');`,
    skillDef: `return await tools.write('.agents/skills/evil/SKILL.md', 'x');`,
    tier: `return await tools.ask('good', 'hi');`,
    script: `return await tools.runSkillScript('nope', 'x.mjs', []);`,
    shell: `return await tools.exec('ls');`,
    ctor: `return tools.read.constructor('return process')();`,
    toolsProto: `return Object.getPrototypeOf(tools).constructor.constructor('return process')();`,
    errCtor: `try { await tools.read('../x'); } catch (e) { return e.constructor.constructor('return process')(); }`,
    imports: `const m = await import('node:fs'); return 1;`,
  };
  for (const [name, body] of Object.entries(refusals)) {
    const r = await attempt(body);
    assert.equal(r.ok, false, `${name} must fail, got ${JSON.stringify(r.result)}`);
  }
  assert.equal(fs.existsSync(path.join(outside, 'pwned.txt')), false);
  assert.equal(fs.existsSync(path.join(dir, '.pworker', 'plans', 'evil')), false);
  const asks = await attempt(`const a = await tools.ask('tiny', 'one'); const b = await tools.ask('tiny', 'two'); try { await tools.ask('tiny', 'three'); return 'no limit'; } catch (e) { return {answer: [a, b, e.message]}; }`);
  assert.equal(asks.ok, true, JSON.stringify(asks.error));
  assert.match(asks.result.answer[2], /limit of 2 model calls/);
  const globals = await attempt(`return {answer: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, Object.keys(tools).sort().join(',')].join(' ')};`);
  assert.equal(globals.result.answer, 'undefined undefined undefined undefined undefined ask,list,log,move,read,runSkillScript,search,write');
  assert.equal(moduleScript(`import fs from 'node:fs';\nexport default async function run() {}`).error.includes('never imports'), true);
  assert.equal(moduleScript(`const fs = require('fs');`).error.includes('require'), true);
  const loop = await executeLambda({ code: probe('for (;;) {}'), params: {}, effects: ['pure'], workspace: ws, ta, settings: { ...S, timeMs: 1000 } });
  assert.equal(loop.error.code, 'sandbox_time_limit');
});

test('promotion: a verified cached TaskLambda becomes a project TaskLambda that runs it with the tools confined to params.workdir', async () => {
  const dir = csvFolder();
  const ta = fakeTa(() => block(SUM_PLAN));
  const r = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  const cache = new LambdaCache(r.lambdas);
  const entry = cache.read(r.lambda);
  const { meta } = await extractMeta(entry.code);
  const toDir = tmp('ta-project-lambdas-');
  const file = path.join(toDir, 'sum-column.mjs');
  fs.writeFileSync(file, promotedLambdaSource({ name: 'sum-column', entry, meta, toDir }));
  const lambda = (await import(file)).default;
  assert.equal(lambda.name, 'sum-column');
  assert.deepEqual(lambda.effects, ['pure']);
  assert.deepEqual(Object.keys(lambda.params), ['file', 'column', 'workdir']);
  const out = await lambda.run({ params: { file: 'march.csv', column: 'amount', workdir: dir }, ta, config: CONFIG, log: () => {} });
  assert.equal(out.status, 'finished');
  assert.equal(out.summary, '101');
  assert.equal(lambdaHash(entry.code), entry.hash);
  cache.remove(r.lambda);
  assert.deepEqual(cache.ids(), []);
});

test('values of the request written into the code are found (outside meta, comments and regular expressions) and sent back to the planner', async () => {
  const code = `export const meta = {name: 'x', task: 'Add a prefix to files.', params: {folder: {type: 'string', description: 'f'}}, example: {folder: 'notes'}, effects: ['pure']};
// the 'notes' folder
const words = (t) => t.match(/[a-z']+/g);
export default async function run(tools, params) { const e = 'file'; const n = 'notes'; const x = 4 / 2;
  return (await tools.list(params.folder)).filter((f) => f.type === e && f.path.endsWith('.txt')).length + \`\${params.folder}\`; }`;
  assert.deepEqual(codeLiterals(code), ['file', 'notes', '.txt']);
  assert.deepEqual(hardcodedValues(code, 'Add the prefix 2026- to every .txt file in the notes folder', { folder: 'notes' }), ['notes', '.txt']);
  assert.deepEqual(hardcodedValues(code, 'Count the files of a folder', { folder: 'notes' }), []);
  const top = `export default async function run(tools, p) { const r = await tools.runSkillScript('text-stats', 'scripts/stats.mjs', [p.file, '3']); return r.stdout.split(',').slice(0, 2).join(' '); }`;
  assert.deepEqual(hardcodedValues(top, 'Report the 3 most frequent words of a.txt', {}, { allowed: ['text-stats', 'scripts/stats.mjs'] }), ['3'], 'a digit of the request written as text is a value');
  assert.deepEqual(hardcodedValues(top, 'Report the most frequent words of a.txt', {}, { allowed: ['text-stats', 'scripts/stats.mjs'] }), [], 'a digit the request does not hold is not');
  assert.deepEqual(hardcodedValues(`export default async function run(tools) { return tools.runSkillScript('text-stats', 'scripts/stats.mjs', []); }`, 'Use the text-stats skill on a.txt', {}, { allowed: ['text-stats', 'scripts/stats.mjs'] }), [], 'a skill named in the request is a tool, not a value');
  const dir = csvFolder();
  const hard = SUM_PLAN.replace('rows[0].indexOf(params.column);\n  if', "rows[0].indexOf('amount');\n  if");
  const seen = [];
  const ta = fakeTa((o) => { seen.push(o.messages.at(-1).content); return block(seen.length === 1 ? hard : SUM_PLAN); });
  const r = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r.rounds, 2);
  assert.match(seen[1], /writes values of this request into its code: "amount"/);
  assert.match(seen[0], /FILES NAMED IN THE REQUEST:\nFILE sales\.csv \(first lines\):\nid,amount,qty/);
});

test('a TaskLambda that uses a skill it did not load gets the skill instructions and is written again, without spending a round', async () => {
  const dir = csvFolder();
  fs.mkdirSync(path.join(dir, '.agents', 'skills', 'csv-tools', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'csv-tools', 'SKILL.md'), '---\nname: csv-tools\ndescription: Totals of CSV columns.\n---\nBODY: run scripts/total.mjs <file> <column>\n');
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'csv-tools', 'scripts', 'total.mjs'), "import fs from 'node:fs'; const [f, c] = process.argv.slice(2); const rows = fs.readFileSync(f, 'utf8').trim().split('\\n').map((l) => l.split(',')); const i = rows[0].indexOf(c); console.log(rows.slice(1).reduce((s, r) => s + Number(r[i]), 0));");
  const plan = SUM_PLAN.replace("skills: [],", "skills: ['csv-tools'],").replace("effects: ['pure']", "effects: ['runs-scripts']").replace(/export default async function run[\s\S]*?\n}\n/, "export default async function run(tools, params) {\n  const r = await tools.runSkillScript('csv-tools', 'scripts/total.mjs', [params.file, params.column]);\n  return {answer: r.stdout.trim(), outputs: []};\n}\n");
  const seen = [];
  const ta = fakeTa((o) => { seen.push(o.messages.at(-1).content); return block(plan); });
  const r = await runAgent({ request: 'Sum the amount column of sales.csv', workdir: dir, ta, config: CONFIG });
  assert.equal(r.status, 'finished', JSON.stringify(r.summary));
  assert.equal(r.answer, '50');
  assert.equal(r.rounds, 1);
  assert.equal(seen.length, 2);
  assert.match(seen[1], /uses csv-tools without its instructions/);
  assert.match(seen[1], /BODY: run scripts\/total\.mjs/);
});
