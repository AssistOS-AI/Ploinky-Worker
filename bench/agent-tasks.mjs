#!/usr/bin/env node
// A small task set with known results for `pworker run` (the agent with the TaskLambda cache): four task families (CSV totals,
// renaming by a pattern, extracting a table from text, a summary through a skill script), a parameter variant of each, a paraphrased
// variant, and three near misses (a different task that shares most words with a cached one) that must NOT reuse a cached TaskLambda.
//
//   node Ploinky Workers/bench/agent-tasks.mjs [--out DIR] [--only id,id] [--config file]
//
// The tasks run in order in one fresh work folder with one TaskLambda cache, so later tasks see the TaskLambdas of earlier ones; the
// call folders go to <out>/calls. Model calls go to the Ploinky Workers server (PWORKER_URL). Writes <out>/rows.jsonl and
// <out>/summary.json and prints the summary.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPworkerClient } from '../lib/client.mjs';
import { loadLayers } from '../lib/config.mjs';
import { runAgent } from '../lib/agent/index.mjs';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };

// ---- fixtures and known results ----
const SALES = [['id', 'region', 'amount', 'qty'], [1, 'north', 12.5, 3], [2, 'south', 40, 1], [3, 'north', 7.25, 10], [4, 'east', 99.9, 2], [5, 'west', 3.35, 7], [6, 'south', 18, 4]];
const INVENTORY = [['sku', 'name', 'price', 'stock'], ['a1', 'bolt', 0.2, 1200], ['a2', 'nut', 0.1, 800], ['b7', 'hinge', 3.5, 45], ['c3', 'bracket', 2.25, 130]];
const PLANETS = [['Planet', 'Mass (Earth = 1)', 'Moons'], ['Mercury', '0.055', '0'], ['Venus', '0.815', '0'], ['Earth', '1', '1'], ['Mars', '0.107', '2'], ['Jupiter', '317.8', '95']];
const CITIES = [['City', 'Country', 'Population'], ['Lisbon', 'Portugal', '545000'], ['Porto', 'Portugal', '232000'], ['Cluj-Napoca', 'Romania', '286000'], ['Graz', 'Austria', '298000']];
const ESSAY = 'Rivers shape valleys. A river carries sand, and sand builds banks. Over time the river moves, the valley widens, and the banks change. Rivers, sand and time: the valley is their record.';
const STORY = 'The fox watched the farm. The farm dog watched the fox. Each night the fox came closer, and each night the dog barked. In the end the fox and the dog became quiet neighbours of the farm.';
const csv = (rows) => rows.map((r) => r.join(',')).join('\n') + '\n';
const pipe = (rows) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n').replace(/\n/, `\n|${rows[0].map(() => '---').join('|')}|\n`);
const sum = (rows, col) => rows.slice(1).reduce((s, r) => s + Number(r[rows[0].indexOf(col)]), 0);
const STATS_SCRIPT = `// text-stats: words, lines and the most frequent words of a text file. Usage: stats.mjs <file> [top]
import fs from 'node:fs';
const [file, top = '5'] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
const counts = new Map();
for (const w of words) if (w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
const frequent = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, Number(top)).map(([word, count]) => ({word, count}));
console.log(JSON.stringify({file, words: words.length, lines: text.split('\\n').filter(Boolean).length, frequent}));
`;
// The same counting as the script, for the known results.
const statsOf = (text, top) => {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const counts = new Map();
  for (const w of words) if (w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
  return { words: words.length, frequent: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, top).map(([w]) => w) };
};

function makeFolder(dir) {
  const w = (p, t) => { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); };
  w('sales.csv', csv(SALES));
  w('inventory.csv', csv(INVENTORY));
  for (const f of ['a.txt', 'b.txt', 'c.md']) w(`notes/${f}`, `note ${f}\n`);
  for (const f of ['x.md', 'y.md', 'z.txt']) w(`drafts/${f}`, `draft ${f}\n`);
  for (const f of ['p1.jpeg', 'p2.jpeg', 'p3.jpeg', 'logo.png']) w(`photos/${f}`, 'img');
  w('reports/planets.txt', `Planet notes\n\nThe inner planets are small; the giants are far heavier. The table below lists the mass and the known moons.\n\n${pipe(PLANETS)}\n\nSource: a school almanac.\n`);
  w('reports/cities.txt', `City survey\n\nFour cities were visited in spring. Their populations are given here.\n\n${pipe(CITIES)}\n\nFigures are rounded.\n`);
  w('texts/essay.txt', ESSAY + '\n');
  w('texts/story.txt', STORY + '\n');
  w('.agents/skills/text-stats/SKILL.md', `---\nname: text-stats\ndescription: Word count, line count and the most frequent words (longer than three letters) of a text file, as JSON.\n---\n# text-stats\n\nRun \`scripts/stats.mjs\` with the file path (relative to the work folder) and optionally the number of frequent words (default 5):\n\n    tools.runSkillScript('text-stats', 'scripts/stats.mjs', ['texts/a.txt', '3'])\n\nIt prints one JSON line: {"file", "words", "lines", "frequent": [{"word", "count"}]}. Parse stdout with JSON.parse.\n`);
  w('.agents/skills/text-stats/scripts/stats.mjs', STATS_SCRIPT);
}

// ---- checks ----
const numbersIn = (s) => (String(s).replace(/(\d),(?=\d{3}\b)/g, '$1').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
const hasNumber = (s, n) => numbersIn(s).some((x) => Math.abs(x - n) < 1e-6 * Math.max(1, Math.abs(n)));
const filesIn = (dir, sub) => fs.readdirSync(path.join(dir, sub)).sort();
const csvEquals = (dir, file, rows) => {
  if (!fs.existsSync(path.join(dir, file))) return `no ${file}`;
  const got = fs.readFileSync(path.join(dir, file), 'utf8').trim().split(/\r?\n/).map((l) => l.split(',').map((c) => c.trim().replace(/^"|"$/g, '')));
  return JSON.stringify(got) === JSON.stringify(rows.map((r) => r.map(String))) ? null : `${file}: ${JSON.stringify(got).slice(0, 200)}`;
};

const TASKS = [
  { id: 'csv-sum', family: 'csv-sum', kind: 'base', request: 'Sum the amount column of sales.csv', check: (d, r) => (hasNumber(r.answer, sum(SALES, 'amount')) ? null : `answer ${r.answer}`) },
  { id: 'rename-prefix', family: 'rename-prefix', kind: 'base', request: 'Add the prefix 2026- to the name of every .txt file in the notes folder',
    check: (d) => { const f = filesIn(d, 'notes'); return JSON.stringify(f) === JSON.stringify(['2026-a.txt', '2026-b.txt', 'c.md']) ? null : `notes: ${f.join(' ')}`; } },
  { id: 'extract-table', family: 'extract-table', kind: 'base', request: 'Extract the table in reports/planets.txt into a CSV file reports/planets.csv', check: (d) => csvEquals(d, 'reports/planets.csv', PLANETS) },
  { id: 'skill-stats', family: 'skill-stats', kind: 'base', request: 'Use the text-stats skill to report the number of words and the 3 most frequent words of texts/essay.txt',
    check: (d, r) => { const s = statsOf(ESSAY, 3); return hasNumber(r.answer, s.words) && s.frequent.every((w) => String(r.answer).toLowerCase().includes(w)) ? null : `answer ${String(r.answer).slice(0, 200)} (want ${s.words} and ${s.frequent})`; } },
  { id: 'csv-sum-variant', family: 'csv-sum', kind: 'variant', request: 'Sum the stock column of inventory.csv', check: (d, r) => (hasNumber(r.answer, sum(INVENTORY, 'stock')) ? null : `answer ${r.answer}`) },
  { id: 'rename-prefix-variant', family: 'rename-prefix', kind: 'variant', request: 'Add the prefix old_ to the name of every .md file in the drafts folder',
    check: (d) => { const f = filesIn(d, 'drafts'); return JSON.stringify(f) === JSON.stringify(['old_x.md', 'old_y.md', 'z.txt']) ? null : `drafts: ${f.join(' ')}`; } },
  { id: 'extract-table-variant', family: 'extract-table', kind: 'variant', request: 'Extract the table in reports/cities.txt into a CSV file reports/cities.csv', check: (d) => csvEquals(d, 'reports/cities.csv', CITIES) },
  { id: 'skill-stats-variant', family: 'skill-stats', kind: 'variant', request: 'Use the text-stats skill to report the number of words and the 5 most frequent words of texts/story.txt',
    check: (d, r) => { const s = statsOf(STORY, 5); return hasNumber(r.answer, s.words) && s.frequent.every((w) => String(r.answer).toLowerCase().includes(w)) ? null : `answer ${String(r.answer).slice(0, 200)} (want ${s.words} and ${s.frequent})`; } },
  { id: 'near-max', family: 'near-max', kind: 'near-miss', near: 'csv-sum', request: 'Find the largest value of the amount column of sales.csv', check: (d, r) => (hasNumber(r.answer, 99.9) ? null : `answer ${r.answer}`) },
  { id: 'near-count', family: 'near-count', kind: 'near-miss', near: 'rename-prefix', request: 'Count the .jpeg files in the photos folder', check: (d, r) => (hasNumber(r.answer, 3) && filesIn(d, 'photos').length === 4 ? null : `answer ${r.answer}`) },
  { id: 'near-moons', family: 'near-moons', kind: 'near-miss', near: 'extract-table', request: 'Read the table in reports/planets.txt and tell which planet has the most moons', check: (d, r) => (/jupiter/i.test(String(r.answer)) ? null : `answer ${r.answer}`) },
  { id: 'csv-sum-paraphrase', family: 'csv-sum', kind: 'variant', request: 'What is the total of the qty column in sales.csv?', check: (d, r) => (hasNumber(r.answer, sum(SALES, 'qty')) ? null : `answer ${r.answer}`) },
];

// ---- run ----
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const out = path.resolve(opt('out', path.join(os.tmpdir(), `pworker-bench-${Date.now()}`)));
const work = path.join(out, 'work');
fs.rmSync(work, { recursive: true, force: true });
makeFolder(work);
const { config } = loadLayers({ project: opt('config') });
const ta = createPworkerClient({ purpose: 'run:bench', client: 'agent-bench' });
const rows = [];
for (const t of TASKS.filter((x) => !only || only.has(x.id))) {
  const t0 = Date.now();
  let r;
  try { r = await runAgent({ request: t.request, workdir: work, callsDir: path.join(out, 'calls'), ta, config, log: () => {} }); } catch (e) { r = { status: 'crashed', summary: e.message, stats: { calls: 0, credits: 0, roles: {} } }; }
  const problem = r.status === 'finished' ? t.check(work, r) : `status ${r.status}: ${String(r.summary).slice(0, 200)}`;
  const chosenFamily = r.how?.startsWith('reuse') ? rows.find((x) => x.lambda === r.lambda)?.family ?? null : null;
  const row = { id: t.id, family: t.family, kind: t.kind, request: t.request, status: r.status, how: r.how ?? null, rounds: r.rounds ?? null, lambda: r.lambda ?? null, reused_from: r.reused_from ?? null, reusedFamily: chosenFamily,
    decision: r.decision?.decision ?? null, matchReason: r.decision?.reason ?? null, candidates: r.decision?.candidates ?? [], correct: !problem, problem, answer: String(r.answer ?? '').slice(0, 300),
    ms: Date.now() - t0, calls: r.stats?.calls ?? 0, credits: r.stats?.credits ?? 0, roles: r.stats?.roles ?? {}, callDir: r.callDir ?? null };
  rows.push(row);
  fs.appendFileSync(path.join(out, 'rows.jsonl'), JSON.stringify(row) + '\n');
  console.log(`${row.correct ? 'ok  ' : 'FAIL'} ${t.id.padEnd(24)} ${String(row.how).padEnd(16)} rounds ${row.rounds ?? '-'} ${String(row.ms).padStart(6)} ms ${row.calls} calls ${row.credits} cr ${problem ? `: ${problem}` : ''}`);
}

// ---- summary ----
const planned = rows.filter((r) => r.how === 'plan');
const reused = rows.filter((r) => r.how?.startsWith('reuse'));
const variants = rows.filter((r) => r.kind === 'variant');
const near = rows.filter((r) => r.kind === 'near-miss');
const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = {
  at: new Date().toISOString(), tasks: rows.length, correct: rows.filter((r) => r.correct).length,
  planned: { n: planned.length, firstPlanOk: planned.filter((r) => r.correct && r.rounds === 1).length, afterReplanOk: planned.filter((r) => r.correct && r.rounds > 1).length, failed: planned.filter((r) => !r.correct).length },
  variants: { n: variants.length, reused: variants.filter((r) => r.how?.startsWith('reuse')).length, reusedCorrect: variants.filter((r) => r.how?.startsWith('reuse') && r.correct && r.reusedFamily === r.family).length },
  nearMisses: { n: near.length, falseReuse: near.filter((r) => r.how?.startsWith('reuse')).length },
  matchPrecision: reused.length ? `${reused.filter((r) => r.correct && r.reusedFamily === r.family).length}/${reused.length}` : 'no reuse',
  latencyMs: { reuse: { mean: mean(reused.map((r) => r.ms)), median: median(reused.map((r) => r.ms)) }, plan: { mean: mean(planned.map((r) => r.ms)), median: median(planned.map((r) => r.ms)) } },
  modelCalls: { reuse: mean(reused.map((r) => r.calls)), plan: mean(planned.map((r) => r.calls)), total: rows.reduce((s, r) => s + r.calls, 0) },
  credits: { reuse: reused.reduce((s, r) => s + r.credits, 0), plan: Math.round(planned.reduce((s, r) => s + r.credits, 0) * 100) / 100, total: Math.round(rows.reduce((s, r) => s + r.credits, 0) * 100) / 100 },
  out,
};
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(JSON.stringify(summary, null, 1));
