// The sandbox for declared phase code: code written by a model is UNTRUSTED. It runs
//   - in a child process of its own started with an explicit V8 heap limit (--max-old-space-size, --max-semi-space-size) and an empty
//     environment (so NODE_OPTIONS of the host, e.g. --max-old-space-size=8192, never widens the limit; worker-thread resourceLimits
//     are overridden by such host flags), no stdin, discarded stdout, killed after a wall-time limit; at most
//     os.availableParallelism() sandboxes run at once, the others wait;
//   - inside that worker, in a fresh V8 context (node:vm) whose global object has only the ECMAScript built-ins: no require or unrestricted imports,
//     process, console, timers, fetch, Buffer or WebAssembly; code generation from strings and WebAssembly are disabled (eval and
//     Function("…") throw);
//   - with ONE capability: a message channel to an allow-listed set of host operations, checked by the host (tiers, call count, sizes,
//     names, declared effects). Only strings and numbers cross the boundary: arguments and results are JSON text parsed inside the
//     context, the host's bridge function never throws into the context and never returns an object, so no object of the worker or of
//     the host (and so no host `Function`) is reachable.
// node:vm alone is not a security boundary; worker limits bound time and memory.
// This internal primitive executes wrappers generated from validated phase statements.
import { spawn } from 'node:child_process';
import os from 'node:os';

export const SANDBOX_LIMITS = Object.freeze({ timeMs: 120000, heapMb: 128, youngMb: 32, codeMb: 16, stackMb: 4, maxCodeBytes: 20000, maxResultBytes: 200000, maxModuleBytes: 2000000, maxModules: 64, syncMs: 2000 });

// The worker's own code (CommonJS, evaluated from this string).
const BOOTSTRAP = `
const vm = require('node:vm');
const parentPort = {postMessage: (m) => process.send(m), on: (e, f) => process.on(e, f)};
process.once('message', (workerData) => {
const {code, inputJson, syncMs, maxResultBytes, bridgeSource, programHead, programTail, opsJson, filename, maxModuleBytes, maxModules} = workerData;
const pending = new Map();
const modulePending = new Map();
let next = 1, finished = false;
const done = (m) => { if (finished) return; finished = true; parentPort.postMessage(m); };
// The host side of the bridge: takes (op string, args JSON string), returns a call id (a number) or 0; never throws, never returns an object.
function hostCall(op, argsJson) {
  try {
    if (typeof op !== 'string' || typeof argsJson !== 'string' || argsJson.length > 4000000) return 0;
    const id = next++;
    pending.set(id, true);
    parentPort.postMessage({type: 'call', id, op: String(op), args: String(argsJson)});
    return id;
  } catch { return 0; }
}
function hostDone(ok, text) {
  try {
    if (typeof text !== 'string') return done({type: 'done', ok: false, code: 'sandbox_no_result', message: 'the result is not JSON text'});
    if (text.length > maxResultBytes) return done({type: 'done', ok: false, code: 'sandbox_result_limit', message: 'the result is larger than ' + maxResultBytes + ' bytes'});
    done({type: 'done', ok: ok === true, json: ok === true ? text : null, code: ok === true ? null : 'sandbox_error', message: ok === true ? null : text.slice(0, 500)});
  } catch { done({type: 'done', ok: false, code: 'sandbox_error', message: 'unreadable result'}); }
}
try {
  const context = vm.createContext(Object.create(null), {codeGeneration: {strings: false, wasm: false}, name: 'taskPhase'});
  vm.runInContext('for (const k of ["WebAssembly", "SharedArrayBuffer", "Atomics", "FinalizationRegistry", "WeakRef", "console"]) delete globalThis[k];', context);
  // The bridge, defined inside the context: in-context promises, settled by the host with primitives only.
  const bridge = new vm.Script(bridgeSource, {filename: 'bridge.js'}).runInContext(context, {timeout: syncMs})(hostCall, hostDone, opsJson);
  parentPort.on('message', (m) => {
    if (m && m.type === 'reply' && pending.has(m.id)) {
      pending.delete(m.id);
      const waiter = modulePending.get(m.id);
      if (waiter) { modulePending.delete(m.id); if (m.ok) { try { waiter.resolve(JSON.parse(m.text)); } catch { waiter.reject(new Error('Invalid module reply')); } } else waiter.reject(new Error(String(m.text))); }
      else bridge.settle(m.id, m.ok === true, String(m.text));
    }
  });
  // Modules share the task's VM context, never Node's host module loader.
  const makeError = new vm.Script('(message) => new Error(message)').runInContext(context);
  const modules = new Map(); let moduleBytes = 0, linkTail = Promise.resolve();
  const requestModule = (specifier, referrer) => new Promise((resolve, reject) => {
    const id = hostCall('loadModule', JSON.stringify({specifier, referrer}));
    if (!id) return reject(new Error('Module request refused'));
    modulePending.set(id, {resolve, reject});
  });
  async function getModule(specifier, referrer) {
    const descriptor = await requestModule(specifier, referrer);
    if (!descriptor || typeof descriptor.identifier !== 'string' || typeof descriptor.source !== 'string') throw new Error('Invalid module source');
    if (modules.has(descriptor.identifier)) return modules.get(descriptor.identifier);
    moduleBytes += Buffer.byteLength(descriptor.source);
    if (moduleBytes > maxModuleBytes || modules.size >= maxModules) throw new Error('Sandbox module limit exceeded');
    const module = new vm.SourceTextModule(descriptor.source, {
      context, identifier: descriptor.identifier,
      initializeImportMeta: (meta) => { meta.url = 'sandbox:///' + descriptor.identifier; },
      importModuleDynamically: (name, referencing) => importLocal(name, referencing.identifier)
    });
    modules.set(descriptor.identifier, module); return module;
  }
  async function importLocal(specifier, referrer) {
    try {
      const module = await getModule(specifier, referrer);
      // Serialize linking, but release the link lock before evaluation so nested
      // dynamic imports and top-level await cannot wait on their own parent.
      const linked = linkTail.then(async () => {
        if (module.status === 'unlinked') await module.link((name, referencing) => getModule(name, referencing.identifier));
      });
      linkTail = linked.catch(() => {}); await linked;
      if (module.status === 'errored') throw module.error;
      await module.evaluate({timeout: syncMs});
      return module;
    } catch (error) {
      // Do not leak a host Error/Function constructor through a rejected import.
      throw makeError(String(error && error.message || error).slice(0, 500));
    }
  }
  const start = new vm.Script(programHead + code + programTail, {filename,
    importModuleDynamically: (name) => importLocal(name, filename)
  }).runInContext(context, {timeout: syncMs});
  start(bridge.api, inputJson, bridge.finish);
} catch (error) {
  // A syntax error names its line in the first line of its stack ("phase.js:12").
  const where = String(error && error.stack || '').split('\\n').find((l) => l.startsWith(filename + ':'));
  const message = (String(error && error.message || error) + (where ? ' (' + where + ')' : '')).slice(0, 300);
  done({type: 'done', ok: false, code: /timed out/.test(message) ? 'sandbox_time_limit' : /Code generation from strings disallowed/.test(message) ? 'code_generation_refused' : /Unexpected|SyntaxError|Invalid or unexpected/.test(message) ? 'sandbox_syntax' : 'sandbox_error', message});
}
});
`;
// At most this many sandboxes run at once (a flush of 400 tasks must not start 400 processes).
const MAX_RUNNING = Math.max(2, os.availableParallelism?.() ?? os.cpus().length);
let running = 0;
const waiting = [];
async function slot() {
  if (running < MAX_RUNNING) { running += 1; return; }
  await new Promise((resolve) => waiting.push(resolve));
}
function release() { const next = waiting.shift(); if (next) next(); else running -= 1; }

// In-context promises are settled by the host with primitives only.
const BRIDGE_CORE = 'const pending = new Map();' +
  'const call = (op, args) => new Promise((res, rej) => { const id = hostCall(op, JSON.stringify(args === undefined ? null : args)); if (typeof id !== "number" || id <= 0) { rej(new Error("refused: " + op)); return; } pending.set(id, {res, rej}); });' +
  'const settle = (id, ok, text) => { const p = pending.get(id); if (!p) return; pending.delete(id); if (ok) { let v; try { v = JSON.parse(text); } catch (e) { p.rej(new Error("bad reply")); return; } p.res(v); } else p.rej(new Error(String(text))); };';
// A failure's text: its message and, for a module, the line of the module where it happened ("phase.js:12:5").
const FINISH = (where) => 'const finish = (ok, v) => { let text; try { if (ok) text = JSON.stringify(v === undefined ? null : v); else { text = String(v && v.message || v);' +
  (where ? ` const at = String(v && v.stack || "").split("\\n").map((l) => l.trim()).find((l) => l.includes("${where}:")); if (at) text += " (at " + at.replace(/^at\\s+/, "") + ")";` : '') +
  ' } } catch (e) { ok = false; text = "the result cannot be written as JSON"; } hostDone(ok, typeof text === "string" ? text : "null"); };';
const PROGRAM_BRIDGE = '(function (hostCall, hostDone) {"use strict";' + BRIDGE_CORE +
  'const api = Object.freeze({chat: (o) => call("chat", o), listInputs: () => call("listInputs"), readInput: (name) => call("readInput", {name}), writeOutput: (name, text) => call("writeOutput", {name, text}), log: (message) => call("log", {message}), readFile: (path) => call("readFile", {path}), writeFile: (path, text) => call("writeFile", {path, text}), listFiles: (path, recursive) => call("listFiles", {path, recursive}), moveFile: (from, to) => call("moveFile", {from, to}), makeDirectory: (path) => call("makeDirectory", {path}), removeFile: (path) => call("removeFile", {path})});' +
  FINISH(null) + 'return {api, settle, finish};})';
const PROGRAM_WRAPPER = ['(function (api, inputJson, finish) {"use strict";\n',
  '\n;if (typeof run !== "function") throw new Error("the program must define async function run(api, input)");' +
  'let r; try { r = run(api, JSON.parse(inputJson)); } catch (e) { finish(false, e); return; }' +
  'Promise.resolve(r).then((v) => finish(true, v), (e) => finish(false, e));})'];
/** Runs `code` in a fresh sandbox worker; `handlers` maps an operation name to a host function of its (JSON) arguments. */
async function sandboxed({ code, input, handlers, ops, bridgeSource, program, filename, limits, argsOf }) {
  const L = { ...SANDBOX_LIMITS, ...limits }, t0 = Date.now();
  if (typeof code !== 'string' || !code.trim()) return { ok: false, code: 'sandbox_empty', message: 'no program', calls: 0, ms: 0 };
  if (Buffer.byteLength(code) > L.maxCodeBytes) return { ok: false, code: 'sandbox_too_long', message: `the program is longer than ${L.maxCodeBytes} bytes`, calls: 0, ms: 0 };
  const inputJson = JSON.stringify(input ?? null);
  await slot();
  let calls = 0, worker = null;
  const result = await new Promise((resolve) => {
    // An explicit heap limit on the command line and an empty environment: the host's NODE_OPTIONS cannot raise it.
    worker = spawn(process.execPath, [`--max-old-space-size=${L.heapMb}`, `--max-semi-space-size=${Math.max(1, Math.floor(L.youngMb / 3))}`, '--disallow-code-generation-from-strings', '--experimental-vm-modules', '-e', BOOTSTRAP],
      { env: {}, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json', windowsHide: true });
    let stderr = '';
    worker.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    const timer = setTimeout(() => resolve({ ok: false, code: 'sandbox_time_limit', message: `the program ran longer than ${L.timeMs} ms` }), L.timeMs);
    const OPS = new Set(ops);
    worker.on('message', async (m) => {
      if (m?.type === 'done') { clearTimeout(timer); resolve(m); return; }
      if (m?.type !== 'call') return;
      calls += 1;
      let reply;
      try {
        if (!OPS.has(m.op) || !Object.hasOwn(handlers, m.op) || typeof handlers[m.op] !== 'function') throw new Error(`operation ${m.op} is not allowed`);
        if (L.maxCalls != null && calls > L.maxCalls) throw new Error(`the limit of ${L.maxCalls} operations is reached`);
        const value = await argsOf(handlers[m.op], JSON.parse(m.args));
        reply = { type: 'reply', id: m.id, ok: true, text: JSON.stringify(value ?? null) };
      } catch (e) { reply = { type: 'reply', id: m.id, ok: false, text: String(e?.message ?? e).slice(0, 500) }; }
      try { if (worker.connected) worker.send(reply); } catch { /* the sandbox ended */ }
    });
    worker.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, code: 'sandbox_crashed', message: String(error?.message ?? error).slice(0, 300) }); });
    worker.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      const oom = /heap out of memory|Allocation failed|out of memory/i.test(stderr);
      resolve({ ok: false, code: oom ? 'sandbox_memory_limit' : 'sandbox_crashed', message: oom ? `the program exceeded the ${L.heapMb} MB heap limit` : `the sandbox exited (${exitCode ?? signal}) before the program finished` });
    });
    try { worker.send({ code, inputJson, syncMs: L.syncMs, maxResultBytes: L.maxResultBytes, maxModuleBytes: L.maxModuleBytes, maxModules: L.maxModules, bridgeSource, programHead: program[0], programTail: program[1], opsJson: JSON.stringify(ops), filename }); }
    catch (error) { clearTimeout(timer); resolve({ ok: false, code: 'sandbox_crashed', message: String(error?.message ?? error).slice(0, 300) }); }
  }).finally(() => { try { worker?.kill('SIGKILL'); } catch { /* gone */ } release(); });
  const ms = Date.now() - t0;
  if (!result.ok) return { ok: false, code: result.code, message: result.message, calls, ms };
  try { return { ok: true, value: JSON.parse(result.json), calls, ms }; } catch { return { ok: false, code: 'sandbox_no_result', message: 'the result is not JSON', calls, ms }; }
}

/**
 * Internal primitive for generated phase wrappers; not a task loader. `api` is the host implementation of the allow-listed operations: `{chat(args), listInputs(), readInput(args),
 * writeOutput(args), log(args)}`, each returning a JSON-serialisable value or throwing (a refusal). Returns {ok, value, calls, ms} or
 * {ok: false, code, message, calls, ms}.
 */
export function runProgram(code, input = null, api = {}, limits = {}) {
  return sandboxed({ code, input, handlers: api, ops: ['chat', 'listInputs', 'readInput', 'writeOutput', 'log', 'readFile', 'writeFile', 'listFiles', 'moveFile', 'makeDirectory', 'removeFile', 'loadModule'], bridgeSource: PROGRAM_BRIDGE, program: PROGRAM_WRAPPER,
    filename: 'program.js', limits, argsOf: (fn, a) => fn(a) });
}
