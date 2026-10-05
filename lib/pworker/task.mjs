import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pworkerHome } from '../settings.mjs';
import { runProgram } from '../sandbox.mjs';
import { createWorkspace } from './workspace.mjs';
import { randomUUID } from 'node:crypto';

const VAR = /\$([A-Za-z_$][\w$]*)/g;
const ID = /^[A-Za-z_$][\w$]*$/;
const hash = (s) => createHash('sha256').update(s).digest('hex');

export function validateTask(task) {
  const seen = new Set();
  function jsonOnly(value, where) {
    if (value === null || ['string','boolean'].includes(typeof value) || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) throw new Error(`${where}: tasks contain JSON data only, never functions or class instances`);
    if (seen.has(value)) throw new Error(`${where}: cyclic task data`);
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      if (typeof key !== 'string' || !('value' in descriptor)) throw new Error(`${where}: task accessors and symbols are forbidden`);
      jsonOnly(descriptor.value,`${where}.${key}`);
    }
    seen.delete(value);
  }
  jsonOnly(task,'task');
  if (!task || typeof task !== 'object' || Array.isArray(task)) throw new Error('A task must be an object containing phases.');
  if (Object.hasOwn(task,'phases') || Object.hasOwn(task,'start')) throw new Error('Use a direct phase map {begin:{...}, nextPhase:{...}}, not a wrapped task');
  const phases = task;
  const start = 'begin';
  if (!phases[start]) throw new Error(`Missing initial phase: ${start}.`);
  for (const [name, phase] of Object.entries(phases)) {
    if (!ID.test(name) || !phase || typeof phase !== 'object' || Array.isArray(phase)) throw new Error(`Invalid phase: ${name}`);
    const allowedFields = ['tier','template','batch','code','next','request'];
    for (const key of Object.keys(phase)) if (!allowedFields.includes(key)) throw new Error(`${name}: unsupported phase field ${key}`);
    if (phase.tier != null && (typeof phase.tier !== 'string' || !phase.tier)) throw new Error(`${name}: invalid tier`);
    if (phase.template != null && typeof phase.template !== 'string') throw new Error(`${name}: invalid template`);
    if (phase.batch && !batchTemplate(phase.template ?? '')) throw new Error(`${name}: batching requires exactly one $variable at the end of the template`);
    if (phase.batch != null && typeof phase.batch !== 'boolean') throw new Error(`${name}: batch must be boolean`);
    if (phase.code != null && typeof phase.code !== 'string') throw new Error(`${name}: code must be a JavaScript statement string`);
    if (typeof phase.code === 'string') {
      const source=phase.code.replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/,'').trim();
      if (/^(?:\(\s*)*(?:async\s+)?function\b/.test(source) || /^(?:\(\s*)*(?:async\s+)?(?:\([^]*?\)|[A-Za-z_$][\w$]*)\s*=>/.test(source)) throw new Error(`${name}: legacy function/lambda phase code is not supported; use statements`);
    }
    if (phase.next != null && !phases[phase.next]) throw new Error(`${name}: next phase ${phase.next} does not exist`);
    if (phase.tier == null && phase.batch) throw new Error(`${name}: a model-free phase cannot use batching`);
    if (phase.request != null) {
      if (typeof phase.request !== 'object' || Array.isArray(phase.request)) throw new Error(`${name}: request must be an object`);
      const allowed = ['maxTokens', 'temperature', 'cache', 'retryCut', 'cutCap', 'timeoutMs', 'noFallback'];
      for (const key of Object.keys(phase.request)) if (!allowed.includes(key)) throw new Error(`${name}: unsupported request option ${key}`);
      for (const key of ['maxTokens','cutCap','timeoutMs']) if (phase.request[key] != null && (!Number.isSafeInteger(phase.request[key]) || phase.request[key] < 1)) throw new Error(`${name}: ${key} must be a positive integer`);
      for (const key of ['retryCut','noFallback']) if (phase.request[key] != null && typeof phase.request[key] !== 'boolean') throw new Error(`${name}: ${key} must be boolean`);
      if (phase.request.temperature != null && (!Number.isFinite(phase.request.temperature) || phase.request.temperature < 0 || phase.request.temperature > 2)) throw new Error(`${name}: temperature must be between 0 and 2`);
      if (phase.request.cache != null && !['use','off','record','strict'].includes(phase.request.cache)) throw new Error(`${name}: invalid cache mode`);
    }
  }
  return { phases, start };
}

export function batchTemplate(template) {
  const matches = [...String(template).matchAll(VAR)];
  if (matches.length !== 1) return null;
  const m = matches[0];
  return m.index + m[0].length === template.length ? { prefix: template.slice(0, m.index), variable: m[1] } : null;
}

export function renderTemplate(template, state) {
  return String(template).replace(VAR, (_, name) => {
    if (!Object.hasOwn(state, name)) throw new Error(`Variable $${name} is missing from the current request`);
    const value = state[name];
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export async function loadTask(file) {
  const absolute = path.resolve(file);
  if (!/\.(json|mjs)$/.test(absolute)) throw new Error('The task must be a .json file or a static JSON .mjs declaration');
  let source=fs.readFileSync(absolute,'utf8').trim();
  if(absolute.endsWith('.mjs')) {
    if(!source.startsWith('export default '))throw new Error('Task modules must contain only export default followed by JSON; imports and executable modules are not supported');
    source=source.slice('export default '.length).replace(/;\s*$/,'');
  }
  const task = JSON.parse(source);
  validateTask(task);
  return task;
}

export async function compileTask(request, { client, home = pworkerHome(), tier = 'good' } = {}) {
  if (!client) throw new Error('A model client is required to compile a request.');
  const dir = path.join(home, 'tasks');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${hash('phased-json-v1\0'+request)}.json`);
  if (fs.existsSync(file)) return { file, task: await loadTask(file), cached: true };
  const prompt = `Convert the request into a Ploinky Workers task. Reply only with a direct JSON phase map such as {"begin":{"tier":"tiny","template":"... $input","code":"this.end(result)"}}. The initial phase is named begin. Do not wrap phases in start/phases keys. Each phase permits only tier (a logical tier name or null), template, batch, request, next and code. Code is a string of JavaScript statements, never a function or lambda. Code may use this.next("name"), this.end(value), this.variable=value, and result. If currentWorkingDirectory is supplied, phase code may use await this.readFile(path), await this.writeFile(path, text), await this.listFiles(path), await this.moveFile(from, to), await this.makeDirectory(path), and await this.removeFile(path). Paths are confined to that directory. Do not use modules, unrestricted filesystem access, network access, process access, or agentic loops. Use $input for data supplied at execution time. Request:\n${request}`;
  const reply = await client.json({ tier, prompt, cache: 'use', retryCut: true, maxTokens: 4000,waitForCapacity:true });
  if (!reply.ok || !reply.json) throw new Error(`Task compilation failed: ${reply.reason ?? 'invalid JSON'}`);
  const task = reply.json;
  validateTask(task);
  const source = JSON.stringify(task, null, 2)+'\n';
  fs.writeFileSync(file, source, { flag: 'wx', mode: 0o600 });
  return { file, task, cached: false };
}

async function runCode(code, result, state, workspace = null) {
  if (code == null) return { state, next: null, ended: false, value: null };
  if(typeof code !== 'string')throw new Error('Phase code must be a statement string');
  const expression = `(async function(result){${code}\n}).call(state, result)`;
  const program = `async function run(api, input) { const state = input.state; const result = input.result; let next = null, ended = false, value = null; Object.defineProperties(state, { next: { configurable: true, value: (name) => { next = name; } }, end: { configurable: true, value: (v) => { ended = true; value = v === undefined ? result : v; } }, readFile: { configurable: true, value: api.readFile }, writeFile: { configurable: true, value: api.writeFile }, listFiles: { configurable: true, value: api.listFiles }, moveFile: { configurable: true, value: api.moveFile }, makeDirectory: { configurable: true, value: api.makeDirectory }, removeFile: { configurable: true, value: api.removeFile } }); await ${expression}; for (const key of ['next','end','readFile','writeFile','listFiles','moveFile','makeDirectory','removeFile']) delete state[key]; return { state, next, ended, value }; }`;
  const api = workspace ? { readFile: ({ path }) => workspace.read(path), writeFile: ({ path, text }) => workspace.write(path, text), listFiles: ({ path: folder, recursive }) => workspace.list(folder ?? '.', { recursive: !!recursive }), moveFile: ({ from, to }) => workspace.move(from, to), makeDirectory: ({ path }) => workspace.makeDirectory(path), removeFile: ({ path }) => workspace.removeFile(path) } : {};
  const response = await runProgram(program, { state, result }, api, { timeMs: 10_000, maxCalls: 100 });
  if (!response.ok) throw new Error(response.message);
  return response.value;
}

export class Pworker {
  constructor({ client, config = {}, home = pworkerHome(), onProgress = null, signal = null } = {}) {
    if (!client) throw new Error('Pworker requires a model client.');
    this.client = client;
    this.config = config;
    this.home = home;
    this.onProgress = onProgress;
    this.signal=signal;
    this.pending = [];
    this.items=new Map();
  }

  enqueue(task, input = {}, options = {}) {
    validateTask(task);
    task=structuredClone(task);
    const id = options.id ?? randomUUID();
    if (this.items.has(id)) throw new Error(`Duplicate task ID: ${id}`);
    const checkpoint=options.checkpoint;
    if(checkpoint && (!Object.hasOwn(task,checkpoint.phase)||!checkpoint.state||typeof checkpoint.state!=='object'||Array.isArray(checkpoint.state)||!Number.isSafeInteger(checkpoint.steps)||checkpoint.steps<0))throw new Error('Invalid task checkpoint');
    const state = checkpoint?structuredClone(checkpoint.state):typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input } : { input };
    const currentWorkingDirectory = options.currentWorkingDirectory ?? state.currentWorkingDirectory ?? null;
    if (currentWorkingDirectory) {
      const absolute = path.resolve(currentWorkingDirectory);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new Error(`Working directory does not exist: ${absolute}`);
      state.currentWorkingDirectory = fs.realpathSync(absolute);
    }
    const item = { id, task, state, workspace: state.currentWorkingDirectory ? createWorkspace(state.currentWorkingDirectory) : null, phase: checkpoint?.phase??null, done: false, value: undefined, error: null, steps: checkpoint?.steps??0,abort:new AbortController() };
    this.items.set(id,item);
    this.pending.push(item);
    return id;
  }

  cancel(id){
    const item=this.items.get(id);if(!item||item.done)return false;
    item.cancelled=true;item.done=true;item.error='Task cancelled';item.abort.abort();this.#publish(item);return true;
  }

  async enqueueRequest(requestOrFile, input = {}, options = {}) {
    const isFile=/\.(mjs|json)$/.test(String(requestOrFile));
    if (isFile && !fs.existsSync(requestOrFile)) throw new Error(`Task file does not exist: ${requestOrFile}`);
    const compiled = isFile ? { task: await loadTask(requestOrFile), file: path.resolve(requestOrFile), cached: true } : await compileTask(String(requestOrFile), { client: this.client, home: this.home, tier: options.compilerTier ?? 'good' });
    return { id: this.enqueue(compiled.task, input, options), file: compiled.file, cached: compiled.cached };
  }

  async flush() {
    const items = this.pending.splice(0);
    for (const item of items) {
      if(item.done)continue;
      try { item.definition = validateTask(item.task); item.phase ??= item.definition.start; this.onProgress?.({ id: item.id, status: 'running', phase: item.phase, steps: item.steps }); }
      catch (e) { item.error = e.message; item.done = true; this.#publish(item); }
    }
    while (items.some((i) => !i.done)) {
      const active = items.filter((i) => !i.done);
      const groups = new Map();
      for (const item of active) {
        if (++item.steps > 100) { item.done = true; item.error = 'The 100-phase execution limit was exceeded'; this.#publish(item); continue; }
        this.onProgress?.({ id: item.id, status: 'running', phase: item.phase, steps: item.steps });
        const phase = item.definition.phases[item.phase];
        const pattern = phase.batch && this.config.batching?.[phase.tier]?.enabled ? batchTemplate(phase.template ?? '') : null;
        const key = pattern ? JSON.stringify([item.phase, phase.tier, pattern.prefix, String(phase.code ?? ''), phase.next ?? null, phase.request ?? {}]) : item.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      await Promise.all([...groups.values()].map((group) => this.#advance(group)));
    }
    const results = items.map(({ id, value, state, error, steps }) => ({ id, ok: !error, value, state, error, steps }));
    for (const item of items)this.#publish(item);
    return results;
  }

  #publish(item){
    if(!item.done||item.published)return;
    item.published=true;
    this.items.delete(item.id);
    const result={id:item.id,ok:!item.error,value:item.value,state:item.state,error:item.error,steps:item.steps};
    this.onProgress?.({id:item.id,status:item.cancelled?'cancelled':result.ok?'completed':'failed',phase:null,steps:item.steps,result:result.ok?result:null,error:item.error,checkpoint:null,waitingReason:null,retryAt:null});
  }

  async #advance(group) {
    group=group.filter(item=>!item.done);if(!group.length)return;
    const first = group[0];
    const phase = first.definition.phases[first.phase];
    const deliver = async (item, result) => {
      if(item.done)return;
      this.onProgress?.({id:item.id,status:'running',phase:item.phase,steps:item.steps,checkpoint:null,waitingReason:null,retryAt:null});
      let next = phase.next ?? null;
      let ended = false;
      try {
        const outcome = await runCode(phase.code, result, item.state, item.workspace);
        item.state = outcome.state;
        if (outcome.next != null) next = outcome.next;
        ended = outcome.ended;
        if (ended) item.value = outcome.value;
        if (!phase.code && !next) { item.value = result; ended = true; }
        if (ended || !next) { item.done = true; if (!ended) item.value = result; }
        else if (!item.definition.phases[next]) throw new Error(`Phase ${next} does not exist`);
        else { item.phase = next; this.onProgress?.({ id: item.id, status: 'running', phase: next, steps: item.steps }); }
      } catch (e) { item.done = true; item.error = e.message; }
      this.#publish(item);
    };
    if (phase.tier == null) { await Promise.all(group.map((item) => deliver(item, undefined))); return; }
    const waiting=details=>{for(const item of group)if(!item.done)this.onProgress?.({id:item.id,status:'waiting',phase:item.phase,steps:item.steps,...details,checkpoint:{task:item.task,phase:item.phase,state:structuredClone(item.state),steps:item.steps-1}});};
    waiting({waitingReason:'Awaiting provider capacity or model response'});
    const groupAbort=new AbortController();
    const abortIfAll=()=>{if(group.every(item=>item.abort.signal.aborted))groupAbort.abort();};
    for(const item of group)item.abort.signal.addEventListener('abort',abortIfAll,{once:true});abortIfAll();
    const signal=this.signal?AbortSignal.any([this.signal,groupAbort.signal]):groupAbort.signal;
    const requestOptions={...phase.request,waitForCapacity:true,signal,onDeferred:waiting};
    try {
      if (group.length > 1) {
        const { prefix, variable } = batchTemplate(phase.template);
        const requests = group.map((item) => ({ id: item.id, input: item.state[variable] }));
        if (requests.some((x) => x.input === undefined)) throw new Error(`Variable $${variable} is missing`);
        const prompt = `${prefix}\nReturn only a JSON object with a results property that maps each id to its result. Requests:\n${JSON.stringify(requests)}`;
        const r = await this.client.json({ tier: phase.tier, prompt, cache: 'use', retryCut: true, ...requestOptions });
        if (r.cut) throw new Error('Model response was truncated');
        if (!r.ok || !r.json?.results || typeof r.json.results !== 'object' || Array.isArray(r.json.results)) throw new Error(`Invalid batch response: ${r.reason ?? 'results is missing'}`);
        if (Object.keys(r.json.results).some((id) => !group.some((item) => item.id === id))) throw new Error('Unexpected result ID in batch response');
        for (const item of group) if (!Object.hasOwn(r.json.results, item.id)) throw new Error(`Missing result for ${item.id}`);
        await Promise.all(group.map((item) => deliver(item, r.json.results[item.id])));
      } else {
        const prompt = renderTemplate(phase.template ?? '', first.state);
        const r = await this.client.chat({ tier: phase.tier, prompt, cache: 'use', retryCut: true, ...requestOptions });
        if (r.cut) throw new Error('Model response was truncated');
        if (!r.ok) throw new Error(r.reason ?? 'Model request failed');
        await deliver(first, r.text);
      }
    } catch (e) { for (const item of group) if(!item.done){ item.done = true; item.error = e.message; this.#publish(item); } }
    finally{for(const item of group)item.abort.signal.removeEventListener('abort',abortIfAll);}
  }
}
