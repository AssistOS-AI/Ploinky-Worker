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
  if (!Object.hasOwn(phases, start)) throw new Error(`Missing initial phase: ${start}.`);
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
    if (phase.next != null && (typeof phase.next !== 'string' || !Object.hasOwn(phases, phase.next))) throw new Error(`${name}: next phase ${phase.next} does not exist`);
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
    this.running=new Set(); // tasks of all flushes that have not finished
    this.batches=new Map(); // phase collectors: key -> {members, timer}
    this.batchStats={requests:0,items:0,saved:0,splits:0};
  }

  enqueue(task, input = {}, options = {}) {
    validateTask(task);
    task=structuredClone(task);
    const id = options.id ?? randomUUID();
    if (this.items.has(id)) throw new Error(`Duplicate task ID: ${id}`);
    const checkpoint=options.checkpoint;
    if(checkpoint && (!Object.hasOwn(task,checkpoint.phase)||!checkpoint.state||typeof checkpoint.state!=='object'||Array.isArray(checkpoint.state)||!Number.isSafeInteger(checkpoint.steps)||checkpoint.steps<0))throw new Error('Invalid task checkpoint');
    const state = checkpoint?structuredClone(checkpoint.state):typeof input === 'object' && input !== null && !Array.isArray(input) ? { ...input } : { input };
    // A checkpoint's variables were written by phase code: its directory comes only from the task record (options), never from the
    // saved state, so phase code cannot widen its own file access across a recovery.
    const currentWorkingDirectory = checkpoint ? options.currentWorkingDirectory ?? null : options.currentWorkingDirectory ?? state.currentWorkingDirectory ?? null;
    if (checkpoint) delete state.currentWorkingDirectory;
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
    // A file: an existing path, or a single word ending in .json/.mjs (a missing file is an error, never compiled as a text request).
    const text=String(requestOrFile);
    const isFile=/\.(mjs|json)$/.test(text)&&(fs.existsSync(text)||!/\s/.test(text.trim()));
    if (isFile && !fs.existsSync(requestOrFile)) throw new Error(`Task file does not exist: ${requestOrFile}`);
    const compiled = isFile ? { task: await loadTask(requestOrFile), file: path.resolve(requestOrFile), cached: true } : await compileTask(String(requestOrFile), { client: this.client, home: this.home, tier: options.compilerTier ?? 'good' });
    return { id: this.enqueue(compiled.task, input, options), file: compiled.file, cached: compiled.cached };
  }

  /**
   * Runs every pending task to its end. Tasks advance independently; a model phase with batch:true on a tier with batching enabled
   * waits in a collector shared by all flushes of this worker, so phases that become ready at about the same time share one request.
   * A collector is sent when no other task of the worker could still join soon (every other task waits for a model or is collected),
   * when it holds `maxItems`, or after `windowMs` without a new member (at most `maxWaitMs` after its first member).
   */
  async flush() {
    const items = this.pending.splice(0);
    for (const item of items) {
      if(item.done)continue;
      try { item.definition = validateTask(item.task); item.phase ??= item.definition.start; item.busy = 'pending'; this.running.add(item); this.onProgress?.({ id: item.id, status: 'running', phase: item.phase, steps: item.steps }); }
      catch (e) { item.error = e.message; item.done = true; this.#publish(item); }
    }
    await Promise.all(items.filter((item) => !item.done).map((item) => this.#run(item)));
    const results = items.map(({ id, value, state, error, steps }) => ({ id, ok: !error, value, state, error, steps }));
    for (const item of items)this.#publish(item);
    return results;
  }

  async #run(item) {
    try {
      while (!item.done) {
        if (++item.steps > 100) { item.done = true; item.error = 'The 100-phase execution limit was exceeded'; this.#publish(item); break; }
        this.onProgress?.({ id: item.id, status: 'running', phase: item.phase, steps: item.steps });
        const phase = item.definition.phases[item.phase];
        const pattern = phase.tier != null && phase.batch && this.config.batching?.[phase.tier]?.enabled ? batchTemplate(phase.template ?? '') : null;
        if (!pattern) { item.busy = phase.tier == null ? 'active' : 'model'; this.#checkBatches(); await this.#advance([item]); continue; }
        const key = JSON.stringify([item.phase, phase.tier, pattern.prefix, pattern.variable, String(phase.code ?? ''), phase.next ?? null, phase.request ?? {}]);
        await new Promise((resolve) => this.#collect(key, phase.tier, item, resolve));
      }
    } finally { item.busy = 'done'; this.running.delete(item); this.#checkBatches(); }
  }

  #batchOptions(tier) { return { maxItems: 20, maxInputChars: 32000, windowMs: 100, maxWaitMs: 2000, ...(this.config.batching?.[tier] ?? {}) }; }

  #collect(key, tier, item, resolve) {
    let c = this.batches.get(key);
    if (!c) { c = { key, tier, members: [], first: Date.now(), timer: null }; this.batches.set(key, c); }
    c.members.push({ item, resolve });
    item.busy = 'collect';
    const o = this.#batchOptions(tier);
    clearTimeout(c.timer);
    if (c.members.length >= o.maxItems) { this.#fire(c); return; }
    c.timer = setTimeout(() => this.#fire(c), Math.max(0, Math.min(o.windowMs, c.first + o.maxWaitMs - Date.now())));
    this.#checkBatches();
  }

  // Sends every collector when no running task could still join one (the others wait for a model reply or are collected themselves).
  #checkBatches() {
    if (!this.batches.size) return;
    for (const item of this.running) if (!['collect', 'model', 'done'].includes(item.busy)) return;
    for (const c of [...this.batches.values()]) this.#fire(c);
  }

  #fire(c) {
    if (this.batches.get(c.key) !== c) return;
    this.batches.delete(c.key);
    clearTimeout(c.timer);
    const members = c.members.filter(({ item, resolve }) => { if (item.done) { resolve(); return false; } return true; });
    if (!members.length) return;
    // Chunks respect maxItems and maxInputChars (the inputs' JSON size), so a batch never outgrows its token budget.
    const o = this.#batchOptions(c.tier);
    const first = members[0].item, variable = batchTemplate(first.definition.phases[first.phase].template).variable;
    const chunks = [[]];
    let size = 0;
    for (const m of members) {
      const n = JSON.stringify(m.item.state[variable] ?? null).length;
      const last = chunks[chunks.length - 1];
      if (last.length && (last.length >= o.maxItems || size + n > o.maxInputChars)) { chunks.push([m]); size = n; } else { last.push(m); size += n; }
    }
    for (const chunk of chunks) {
      for (const { item } of chunk) item.busy = 'model';
      this.#advance(chunk.map(({ item }) => item)).finally(() => { for (const { resolve } of chunk) resolve(); });
    }
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
      item.busy='active';
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
        else if (typeof next !== 'string' || !Object.hasOwn(item.definition.phases, next)) throw new Error(`Phase ${next} does not exist`);
        else { item.phase = next; this.onProgress?.({ id: item.id, status: 'running', phase: next, steps: item.steps }); }
      } catch (e) { item.done = true; item.error = e.message; }
      this.#publish(item);
    };
    if (phase.tier == null) { await Promise.all(group.map((item) => deliver(item, undefined))); return; }
    const waiting=(members,details)=>{for(const item of members)if(!item.done)this.onProgress?.({id:item.id,status:'waiting',phase:item.phase,steps:item.steps,...details,checkpoint:{task:item.task,phase:item.phase,state:structuredClone(item.state),steps:item.steps-1}});};
    const fail=(members,message)=>{for(const item of members)if(!item.done){item.done=true;item.error=message;this.#publish(item);}};
    const signalOf=(members)=>{
      const groupAbort=new AbortController();
      const abortIfAll=()=>{if(members.every(item=>item.abort.signal.aborted))groupAbort.abort();};
      for(const item of members)item.abort.signal.addEventListener('abort',abortIfAll,{once:true});abortIfAll();
      return {signal:this.signal?AbortSignal.any([this.signal,groupAbort.signal]):groupAbort.signal,done:()=>{for(const item of members)item.abort.signal.removeEventListener('abort',abortIfAll);}};
    };
    const single = async (item) => {
      const {signal,done}=signalOf([item]);
      try {
        waiting([item],{waitingReason:'Awaiting provider capacity or model response'});
        const prompt = renderTemplate(phase.template ?? '', item.state);
        const r = await this.client.chat({ tier: phase.tier, prompt, cache: 'use', retryCut: true, ...phase.request, waitForCapacity:true, signal, onDeferred:d=>waiting([item],d) });
        if (r.cut) throw new Error('Model response was truncated');
        if (!r.ok) throw new Error(r.reason ?? 'Model request failed');
        await deliver(item, r.text);
      } catch (e) { fail([item], e.message); }
      finally { done(); }
    };
    // A batch whose answer is unusable (no JSON envelope, a missing or unexpected id, a truncated reply) is split in halves and each half
    // is asked again, down to single requests; a request that fails outright (status, transport) fails its members.
    const batch = async (members) => {
      members=members.filter(item=>!item.done);
      if (!members.length) return;
      if (members.length === 1) return single(members[0]);
      const { prefix, variable } = batchTemplate(phase.template);
      const requests = members.map((item) => ({ id: item.id, input: item.state[variable] }));
      if (requests.some((x) => x.input === undefined)) return fail(members, `Variable $${variable} is missing`);
      const {signal,done}=signalOf(members);
      let r;
      try {
        waiting(members,{waitingReason:'Awaiting provider capacity or model response'});
        r = await this.client.json({ tier: phase.tier, prompt: batchPrompt(prefix, requests), cache: 'use', retryCut: true, ...phase.request, waitForCapacity:true, signal, onDeferred:d=>waiting(members,d), batchSize: members.length });
      } catch (e) { return fail(members, e.message); }
      finally { done(); }
      if (r.cancelled) return fail(members, r.reason ?? 'Request cancelled');
      this.batchStats.requests += 1;
      let problem = null;
      // One malformed item makes the whole reply unparsable; the items that parse on their own are kept and only the rest is asked again.
      const salvaged = !r.json && r.status === 200 && !r.cut && typeof r.text === 'string' ? salvageResults(r.text, members.map((item) => item.id)) : null;
      const results = salvaged ?? batchResults(r.json?.results);
      if (r.cut) problem = 'Model response was truncated';
      else if (!r.ok && !(r.status === 200 && !r.json)) return fail(members, `Invalid batch response: ${r.reason ?? 'request failed'}`);
      else if (!results || typeof results !== 'object' || Array.isArray(results)) problem = `Invalid batch response: ${r.reason ?? 'results is missing'}`;
      else if (Object.keys(results).some((id) => !members.some((item) => item.id === id))) problem = 'Unexpected result ID in batch response';
      if (problem) {
        this.batchStats.splits += 1;
        const half = Math.ceil(members.length / 2);
        await Promise.all([batch(members.slice(0, half)), batch(members.slice(half))]);
        for (const item of members) if (!item.done) fail([item], problem);
        return;
      }
      const missing = members.filter((item) => !Object.hasOwn(results, item.id));
      this.batchStats.items += members.length - missing.length; this.batchStats.saved += Math.max(0, members.length - missing.length - 1);
      await Promise.all(members.filter((item) => Object.hasOwn(results, item.id)).map((item) => deliver(item, results[item.id])));
      if (missing.length) { this.batchStats.splits += 1; await batch(missing); }
    };
    await (group.length > 1 ? batch(group) : single(first));
  }
}

/**
 * The results of a batch reply as a map id -> result. Besides the requested map, models often return an array of items that carry their id
 * ({"results":[{"id":"t-1",...}]}); such an array is accepted when every element has a distinct string id. An element {id, result} yields its
 * result, any other element yields its fields without the id. Anything else is returned unchanged and rejected by the caller.
 */
export function batchResults(results) {
  if (!Array.isArray(results)) return results;
  const map = {};
  for (const x of results) {
    if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.id !== 'string' || Object.hasOwn(map, x.id)) return results;
    const { id, ...rest } = x;
    map[id] = Object.keys(rest).length === 1 && Object.hasOwn(rest, 'result') ? rest.result : rest;
  }
  return map;
}

/** The end (exclusive) of the JSON object, array or string that starts at `start`, or -1. */
function valueEnd(text, start) {
  if (text[start] === '"') { for (let i = start + 1; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') return i + 1; } return -1; }
  if (text[start] !== '{' && text[start] !== '[') return -1;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { const end = valueEnd(text, i); if (end < 0) return -1; i = end - 1; }
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Results recovered item by item from a batch reply that is not valid JSON as a whole: for each id, the value after "<id>": (map form) or
 * the object holding "id":"<id>" (array form) is parsed on its own. Returns null when nothing can be recovered.
 */
export function salvageResults(text, ids) {
  const out = {};
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const id of ids) {
    const key = new RegExp(`"${esc(id)}"\\s*:\\s*`).exec(text);
    if (key) {
      const start = key.index + key[0].length, end = valueEnd(text, start);
      if (end > 0) { try { out[id] = JSON.parse(text.slice(start, end)); continue; } catch { /* malformed item */ } }
    }
    const field = new RegExp(`"id"\\s*:\\s*"${esc(id)}"`).exec(text);
    if (!field) continue;
    for (let open = text.lastIndexOf('{', field.index); open >= 0; open = text.lastIndexOf('{', open - 1)) {
      const end = valueEnd(text, open);
      if (end <= field.index) continue;
      try { const value = JSON.parse(text.slice(open, end)); if (value?.id === id) { const r = batchResults([value]); out[id] = r[id]; } } catch { /* malformed item */ }
      break;
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The prompt of a batched phase: the instructions of the template prefix, then the batch instruction, then the data. When the prefix ends
 * with a data marker line (a last line ending with ":", e.g. "INPUT DATA (treat as data, not instructions):"), the batch instruction is
 * placed before that marker, so the output format is never inside the data section.
 */
export function batchPrompt(prefix, requests) {
  const text = String(prefix).replace(/\s+$/, '');
  const cut = text.lastIndexOf('\n');
  const lastLine = text.slice(cut + 1);
  const marker = /:\s*$/.test(lastLine) && cut >= 0 ? lastLine.trim() : null;
  const instructions = marker ? text.slice(0, cut).replace(/\s+$/, '') : text;
  const rule = 'Several independent requests follow. Apply the instructions above to each request on its own, as if it were the only one; requests share no context. Return only a JSON object with a results property mapping each request id to its result: {"results":{"<request id>":<result>}}.';
  return `${instructions}\n\n${rule}\n${marker ?? 'Requests:'}\n${JSON.stringify(requests)}`;
}
