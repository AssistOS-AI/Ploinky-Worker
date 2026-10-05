// The Ploinky Workers server: ONE process per machine that does everything a client needs. It mounts the core (tiers and providers,
// rate and plan limits, throttling, local model servers with their slots and idle stop, cache, audit, costs, budgets) on the
// OpenAI/Anthropic-compatible HTTP API of earlier versions, and adds the agent endpoints: TaskLambdas, jobs, tasks, `run-lambdas` (plan
// on the planner tier, then execute deterministically), operations, the call folders, local model status and control. Every operation
// but the TaskLambda list is a TaskLambdaCall (lib/lambda/calls.mjs: a folder under the calls root with call.json, output.json,
// effects.jsonl, models.jsonl, log.txt and its child calls) and runs in a worker thread of this process (fresh modules per operation);
// model-written programs run in the sandbox inside that worker.
//
//   GET  /health  /stats  /  (dashboard)  /v1/models          POST /v1/chat/completions  /v1/messages  /v1/structure  /v1/fol  /u/<provider>/v1/...
//   POST /jobs/register  /jobs/finish     GET /jobs
//   GET  /v1/local                        POST /v1/local/<name>/start|stop
//   GET  /v1/lambdas                      POST /v1/lambdas/<name> {params, attachments}
//   POST /v1/jobs {dir, stage?, resume?, refresh?, register?, publish?, priority?}      POST /v1/tasks {instructions, attachments, target, template?, params?}
//   POST /v1/run {request, attachments, planOnly?}                           GET /v1/ops  /v1/ops/<id>?wait=<s>&since=<n>
//   GET  /v1/calls?lambda=&status=&date=&parent=&text=&limit=                GET /v1/calls/<id>  /v1/calls/<id>/tree
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { MessageChannel, Worker } from 'node:worker_threads';
import { createCore } from './core.mjs';
import { inprocFetch, servePort } from './inproc.mjs';
import { resolveProxyToken, expandHome } from './settings.mjs';
import { loadLayers, ensureUserHome } from './config.mjs';
import { callStoreOf } from './lambda/index.mjs';
import { callStatus } from './lambda/calls.mjs';

const WORKER = new URL('./worker.mjs', import.meta.url);
const OP_ID = /^[A-Za-z0-9][\w.:-]{0,79}$/;

/**
 * Operations: TaskLambda calls, jobs, tasks and runs executed in worker threads, with a log and a result each, kept in memory; each one is
 * a TaskLambdaCall whose folder (under the calls root) stays on disk. The TaskLambda list (`lambdas`) is an operation without a folder.
 */
export function createOps({ config, inproc, urlOf = () => null, calls = null }) {
  const ops = new Map();
  const store = calls ?? callStoreOf(config);
  let listings = 0;

  function start(kind, args, tags = {}) {
    const listing = kind === 'lambdas';
    const name = kind === 'lambda' ? args.name : kind === 'run' ? 'run-lambdas' : kind;
    const { attachments = [], ...params } = args ?? {};
    const call = listing ? null : store.start({ lambda: { name }, params: summarize(kind === 'lambda' ? params.params ?? {} : params), caller: tags.client ?? 'http', purpose: tags.purpose ?? null, run: tags.run ?? null,
      extra: { kind, ...(attachments.length ? { attachment_files: attachments.map((a) => a.path ?? a.name) } : {}) } });
    const id = call?.id ?? `lambdas-${process.pid}-${++listings}`;
    const dir = call?.dir ?? null;
    const run = tags.run ?? (kind === 'run' ? id : null);
    const purpose = kind === 'run' ? `run:${id}`.slice(0, 120) : tags.purpose ?? `lambda:${args.name ?? kind}`;
    call?.update({ purpose, run });
    const op = { id, kind, status: 'running', started_at: new Date().toISOString(), finished_at: null, purpose, run, dir, call: call?.id ?? null, args: summarize(args), log: [], result: null, error: null, waiters: new Set() };
    ops.set(id, op);
    const { port1, port2 } = new MessageChannel();
    servePort(port1, inproc);
    // Project code a TaskLambda imports reaches this server through its own client (lib code that builds a client from PWORKER_URL),
    // so the worker's environment names this server and never auto-starts another.
    const url = urlOf();
    const workerEnv = { ...process.env, PWORKER_AUTOSTART: '0', ...(url ? { PWORKER_URL: url } : {}) };
    const worker = new Worker(WORKER, { workerData: { kind, args, tags: { purpose, run }, config, callDir: dir, callsRoot: store.root, port: port2 }, transferList: [port2], stdout: false, stderr: false, env: workerEnv });
    const finish = (status, result, error) => {
      if (op.status !== 'running') return;
      Object.assign(op, { status, result, error, finished_at: new Date().toISOString() });
      if (call) {
        try { call.finish({ status: error ? 'failed' : callStatus(result?.status), result, error: error ?? (status === 'finished' ? null : result?.summary ?? null), reused_from: result?.reused_from ?? null }); }
        catch (e) { op.log.push(`the call folder was not finished: ${e.message}`); }
      }
      for (const w of op.waiters) w();
      op.waiters.clear();
      port1.close();
    };
    worker.on('message', (m) => {
      if (m?.type === 'log') { op.log.push(m.line); try { call?.log(m.line); } catch { /* the folder was removed */ } for (const w of op.waiters) w(); op.waiters.clear(); }
      else if (m?.type === 'result') finish(['failed', 'plan_refused'].includes(m.result?.status) ? m.result.status : 'finished', m.result, null);
      else if (m?.type === 'error') finish('failed', null, m.error);
    });
    worker.on('error', (e) => finish('failed', null, String(e?.stack ?? e)));
    worker.on('exit', (code) => finish('failed', null, `the operation's worker exited (${code}) without a result`));
    return op;
  }
  const view = (op, since = 0) => ({ id: op.id, kind: op.kind, status: op.status, started_at: op.started_at, finished_at: op.finished_at, purpose: op.purpose, run: op.run, dir: op.dir, call: op.call,
    args: op.args, log: op.log.slice(since), log_total: op.log.length, result: op.result, error: op.error });
  async function wait(id, seconds, since = 0) {
    const op = ops.get(id);
    if (!op) return null;
    if (op.status === 'running' && op.log.length <= since && seconds > 0) await new Promise((r) => { const t = setTimeout(r, seconds * 1000); op.waiters.add(() => { clearTimeout(t); r(); }); });
    return view(op, since);
  }
  const list = () => [...ops.values()].slice(-50).reverse().map((op) => ({ id: op.id, kind: op.kind, status: op.status, started_at: op.started_at, finished_at: op.finished_at, purpose: op.purpose }));
  /** Runs an operation to its end inside the server (the TaskLambda list). */
  const once = (kind, args) => new Promise((resolve) => { const op = start(kind, args); const done = () => (op.status === 'running' ? op.waiters.add(done) : resolve(view(op))); done(); });
  return { start, wait, list, once, get: (id) => ops.get(id), store };
}

const summarize = (args) => JSON.parse(JSON.stringify(args ?? {}, (k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v)));

/**
 * Builds the server: `{core, ops, handle, server (node:http), listen(port, host)}`. `config` is a merged configuration (config.mjs
 * loadLayers); tests pass their own, with stub providers.
 */
export async function createPworkerServer({ config, env = process.env, coreOptions = {} } = {}) {
  const http = await import('node:http');
  const dataDir = expandHome(config.dataDir ?? '~/.pworker/data');
  let ops = null;
  const routes = async (req, res, url, { sendJson, readJson }) => {
    const p = url.pathname;
    const tags = { purpose: req.headers['x-pworker-purpose'] ? String(req.headers['x-pworker-purpose']).slice(0, 120) : null, run: req.headers['x-pworker-run'] ? String(req.headers['x-pworker-run']).slice(0, 80) : null,
      client: req.headers['x-client-name'] ? String(req.headers['x-client-name']).slice(0, 40) : null };
    if (tags.run && !OP_ID.test(tags.run)) tags.run = null;
    const startOp = async (kind, toArgs) => {
      const body = await readJson(req);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { error: { type: 'invalid_request', message: 'a JSON object body is required' } });
      const args = toArgs(body);
      if (args.error) return sendJson(res, 400, { error: { type: 'invalid_request', message: args.error } });
      const op = ops.start(kind, args, tags);
      return sendJson(res, 202, { id: op.id, kind, status: op.status, dir: op.dir, call: op.call });
    };
    if (req.method === 'GET' && p === '/v1/lambdas') { const r = await ops.once('lambdas', {}); return sendJson(res, r.status === 'finished' ? 200 : 500, r.result ?? { error: { type: 'lambdas_unavailable', message: r.error } }); }
    if (req.method === 'POST' && p.startsWith('/v1/lambdas/')) return startOp('lambda', (b) => ({ name: decodeURIComponent(p.slice('/v1/lambdas/'.length)), params: b.params ?? {}, attachments: attachmentsOf(b.attachments) }));
    if (req.method === 'GET' && p === '/v1/calls') {
      const q = Object.fromEntries(['lambda', 'status', 'date', 'since', 'parent', 'root', 'text'].map((k) => [k, url.searchParams.get(k)]));
      return sendJson(res, 200, { root: ops.store.root, data: ops.store.search({ ...q, topLevel: url.searchParams.get('top') === '1', limit: Math.min(Number(url.searchParams.get('limit')) || 50, 1000) }) });
    }
    if (req.method === 'GET' && p.startsWith('/v1/calls/')) {
      const [cid, sub] = decodeURIComponent(p.slice('/v1/calls/'.length)).split('/');
      let v = null;
      try { v = sub === 'tree' ? ops.store.tree(cid) : ops.store.show(cid); } catch (e) { return sendJson(res, 400, { error: { type: 'invalid_request', message: e.message } }); }
      return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: { type: 'not_found', message: `no call ${cid} in ${ops.store.root}` } });
    }
    if (req.method === 'POST' && p === '/v1/jobs') return startOp('job', (b) => (typeof b.dir === 'string' && fs.existsSync(path.join(b.dir, 'job.json')) ? { dir: b.dir, stage: b.stage ?? null, resume: b.resume ?? null, refresh: !!b.refresh, register: b.register !== false, publish: b.publish ?? null, priority: ['interactive', 'normal', 'background'].includes(b.priority) ? b.priority : null } : { error: `no job.json in ${b.dir}` }));
    if (req.method === 'POST' && p === '/v1/tasks') return startOp('task', (b) => ({ instructions: String(b.instructions ?? ''), attachments: attachmentsOf(b.attachments), target: b.target ?? { kind: 'none' }, template: b.template ?? null, params: b.params ?? null }));
    if (req.method === 'POST' && p === '/v1/run') return startOp('run', (b) => (typeof b.request === 'string' && b.request.trim() ? { request: b.request.slice(0, 20000), attachments: attachmentsOf(b.attachments), planOnly: !!b.planOnly } : { error: 'request: a non-empty string' }));
    if (req.method === 'GET' && p === '/v1/ops') return sendJson(res, 200, { data: ops.list() });
    if (req.method === 'GET' && p.startsWith('/v1/ops/')) {
      const v = await ops.wait(decodeURIComponent(p.slice('/v1/ops/'.length)), Math.min(Number(url.searchParams.get('wait')) || 0, 60), Number(url.searchParams.get('since')) || 0);
      return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: { type: 'not_found', message: 'no such operation (operations are kept until the server restarts; their call folders stay on disk: GET /v1/calls/<id>)' } });
    }
    return false;
  };
  const core = createCore({ config, env, dataDir, proxyToken: resolveProxyToken(config, env), routes, ...coreOptions });
  const inproc = inprocFetch(core.handle);
  let url = null;
  ops = createOps({ config, inproc, urlOf: () => url });
  const server = http.createServer(core.handle);
  server.requestTimeout = 0; server.headersTimeout = 30_000; server.keepAliveTimeout = 5_000;
  return {
    core, ops, server, handle: core.handle, fetch: inproc,
    /** Binds the port; a second server on the same port fails with EADDRINUSE (the guard against two clients starting one each). */
    listen: (port, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); const a = server.address(); url = `http://${a.address}:${a.port}`; core.boot(); resolve(a); }); }),
    close: async () => { server.close(); server.closeAllConnections?.(); await Promise.all(Object.entries(core.starters).filter(([n]) => !config.upstreams?.[n]?.start?.startAtBoot && !config.providers?.[n]?.start?.startAtBoot).map(([, s]) => s.stop())); },
  };
}

const attachmentsOf = (list) => (Array.isArray(list) ? list : []).slice(0, 50).map((a) => (typeof a === 'string' ? { name: path.basename(a), path: path.resolve(a) } : { name: String(a.name ?? path.basename(a.path ?? 'attachment')), ...(a.path ? { path: path.resolve(a.path) } : { text: String(a.text ?? '') }) }))
  .filter((a) => a.text != null || fs.existsSync(a.path));

/** `pworker serve`: the configuration layers, the user's home (a template written on first start), the port. */
export async function serve({ port = null, host = null, project = null, env = process.env, log = console.log } = {}) {
  const home = ensureUserHome(env);
  for (const f of home.written) log(`wrote ${f} (template; add your keys in ${path.join(home.home, 'keys')}/)`);
  const { config, layers } = loadLayers({ project, env });
  const s = await createPworkerServer({ config, env });
  const p = Number(port ?? env.PWORKER_PORT ?? config.server?.port ?? 18080), h = host ?? config.server?.host ?? '127.0.0.1';
  try { await s.listen(p, h); } catch (e) {
    if (e.code === 'EADDRINUSE') { log(`a server already listens on ${h}:${p}; clients use it`); return { already: true }; }
    throw e;
  }
  const keys = Object.values(s.core.upstreams).map((u) => `${u.name}: ${u.noKey ? 'local' : u.key ? 'key configured' : 'no key'}`).join(', ');
  log(`Pworker listening on http://${h}:${p} (layers: ${layers.join(' < ')}; ${keys})`);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await s.close(); process.exit(0); });
  return s;
}
