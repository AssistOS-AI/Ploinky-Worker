// Built-in TaskLambda: a TaskLambda written on the fly. The planner tier writes a small program against the sandbox API
// (prompts/lambda-writer.md); the program is a model-written TaskLambda (origin model-written, effects model-calls) and every attempt
// to run it is a child call of this one: its folder holds the program (`program.js`, written before it runs), its outputs (`outputs/`)
// and its model calls. It runs in the sandbox (lib/sandbox.mjs runProgram), whose only capability is an allow-listed API: chat on the
// sandbox tiers within the call limit, reading the attachments, writing outputs into its call folder. A program that fails to load or
// throws is shown its error once and rewritten.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {runProgram} from '../lib/sandbox.mjs';

const PROMPT = fileURLToPath(new URL('../prompts/lambda-writer.md', import.meta.url));
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const codeOf = text => { const m = /```(?:js|javascript)?\s*\n([\s\S]*?)```/.exec(String(text ?? '')); return (m ? m[1] : String(text ?? '')).trim(); };
const hashOf = code => createHash('sha256').update(String(code).trim()).digest('hex').slice(0, 16);

export default {
  name: 'write-lambda',
  description: 'When no other TaskLambda fits: write a small program on the fly that calls models step by step over the attachments (split, ask, combine, check), run it in a sandbox, and return its result and output files.',
  effects: ['model-calls'],
  params: {
    goal: {type: 'string', min: 1, max: 4000, description: 'what the program must do, in full'},
    tier: {type: 'string', enum: ['small', 'medium', 'good'], default: 'good', description: 'the tier that writes the program'},
  },
  async run(ctx) {
    const box = ctx.config.sandbox ?? {};
    const tiers = box.tiers ?? ['tiny', 'small'];
    const maxCalls = box.maxCalls ?? 50;
    const system = fs.readFileSync(PROMPT, 'utf8').replace('{{tiers}}', tiers.join(', ')).replace('{{maxCalls}}', String(maxCalls));
    const messages = [{role: 'system', content: system}, {role: 'user', content: `TASK:\n${ctx.params.goal}\n\nATTACHMENTS:\n${ctx.attachments.map(a => `- ${a.name} (${a.bytes ?? '?'} bytes)`).join('\n') || '(none)'}`}];
    let last = null, chats = 0, written = [], lastDir = null, lastCall = null;
    for (let round = 1; round <= 2; round++) {
      const w = await ctx.ta.chat({tier: ctx.params.tier, messages, maxTokens: 8000, temperature: 0, retryCut: true});
      if (!w.ok) return {status: 'failed', summary: `the program writer (${ctx.params.tier}) failed: ${w.reason}`};
      const code = codeOf(w.text);
      // The attempt is a child call of the model-written TaskLambda (its folder holds the program and its outputs).
      const call = ctx.self?.child({lambda: {name: 'program', hash: hashOf(code), origin: 'model-written', effects: ['model-calls']}, params: {goal: ctx.params.goal, round}, caller: 'write-lambda', purpose: ctx.ta.purpose ?? null, run: ctx.ta.run ?? null,
        attachments: ctx.attachments.map(a => ({name: a.name, sha256: a.sha256 ?? null, bytes: a.bytes ?? null}))}) ?? null;
      const dir = call?.dir ?? path.join(ctx.dir, `program-${round}`);
      const outDir = path.join(dir, 'outputs');
      fs.mkdirSync(outDir, {recursive: true});
      written = [];
      fs.writeFileSync(path.join(dir, 'program.js'), code + '\n');
      ctx.log(`program written: ${path.relative(ctx.dir, path.join(dir, 'program.js'))} (${code.length} chars)`);
      const api = {
        async chat(o) {
          if (!o || typeof o.prompt !== 'string') throw new Error('chat needs {tier, prompt}');
          if (!tiers.includes(o.tier)) throw new Error(`tier ${o.tier} is not allowed in the sandbox (allowed: ${tiers.join(', ')})`);
          if (++chats > maxCalls) throw new Error(`the call limit of ${maxCalls} is reached`);
          const r = await ctx.ta.chat({tier: o.tier, prompt: o.prompt.slice(0, 60000), system: typeof o.system === 'string' ? o.system.slice(0, 8000) : undefined, maxTokens: Math.min(Number(o.maxTokens) || 2000, 8000), temperature: 0, retryCut: true, noRecord: !!call});
          call?.model(r, {role: 'program'});
          return {ok: r.ok, text: r.ok ? r.text : '', reason: r.ok ? null : r.reason};
        },
        listInputs: async () => ctx.attachments.map(a => ({name: a.name, bytes: a.bytes ?? null})),
        async readInput({name}) { const n = typeof name === 'string' ? name : name?.name; if (!ctx.attachments.some(a => a.name === n)) throw new Error(`no input ${n} (inputs: ${ctx.attachments.map(a => a.name).join(', ')})`); return (await ctx.readAttachment(n)).slice(0, 2_000_000); },
        async writeOutput({name, text}) {
          if (!SAFE.test(String(name)) || typeof text !== 'string') throw new Error('writeOutput needs a simple file name and text');
          if (text.length > (box.maxOutputBytes ?? 1_000_000)) throw new Error('the output is too large');
          fs.writeFileSync(path.join(outDir, name), text); if (!written.includes(name)) written.push(name);
          return {written: name};
        },
        async log({message}) { const line = `program: ${String(message).slice(0, 300)}`; ctx.log(line); call?.log(line); return true; },
      };
      last = await runProgram(code, {request: ctx.params.goal, attachments: ctx.attachments.map(a => ({name: a.name, bytes: a.bytes ?? null}))}, api, {timeMs: box.timeMs, heapMb: box.heapMb, maxCodeBytes: box.maxCodeBytes});
      call?.finish({status: last.ok ? 'ok' : 'failed', result: last.ok ? {value: last.value ?? null, outputs: written} : null, error: last.ok ? null : `${last.code}: ${last.message}`});
      lastDir = dir; lastCall = call;
      if (last.ok) break;
      messages.push({role: 'assistant', content: w.text}, {role: 'user', content: `The program failed in the sandbox: ${last.code}: ${last.message}\nWrite the corrected program, in one js code block.`});
    }
    const value = last?.value;
    const summary = last?.ok ? (typeof value === 'string' ? value : value?.summary ?? JSON.stringify(value)).slice(0, 1500) : `the program failed: ${last?.code}: ${last?.message}`;
    return {status: last?.ok ? 'finished' : 'failed', summary, value: value ?? null, program: lastCall?.id ?? null, outputs: written.map(n => path.join(lastDir, 'outputs', n)), calls: chats};
  },
};
