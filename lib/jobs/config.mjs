/**
 * The job runner's configuration. Inside the server it is the `runner` section of the Ploinky Workers configuration (lib/worker.mjs
 * runnerConfig). Outside it (`loadConfig`, for programs that run a job in their own process and send its model calls to the server), it
 * comes from an explicit runner file (`file`, a JSON object with the fields below), else from the `runner` section of the Ploinky Workers
 * configuration layers found from the job folder (config.mjs loadLayers), else from built-in defaults. Relative paths resolve against
 * the file's folder.
 *
 *   endpoint   the Ploinky Workers server (default http://127.0.0.1:18080); `/v1/...` and `/u/<provider>/v1/...`
 *   dataDir    where runs, the cache, the index and tier stats live (default: `state/` inside the job folder)
 *   roles      role -> tier (planner, decider, auditor, worker, ...); jobs name tiers or roles, never concrete models
 *   fallback   tier -> concrete chain [{upstream, model, ...request fields}], used while the endpoint does not serve the tier
 *   limits     upper bounds a planned task may request (maxTaskUsd, maxTaskCredits, maxTaskCalls)
 *   tasks      task folder retention (keepDays)
 *   templatesDir  the job templates the planner may choose from
 */
import fs from 'node:fs';
import path from 'node:path';
import {DEFAULT_ENDPOINT} from './util.mjs';
import {loadLayers} from '../config.mjs';

export const DEFAULT_ROLES = Object.freeze({planner: 'good', decider: 'good', auditor: 'medium', worker: 'small', 'worker-short': 'tiny'});

/** `{file, endpoint, dataDir, roles, fallback, limits, tasks, templatesDir}`; `jobDir` locates the configuration and the default data dir. */
export function loadConfig({file = null, jobDir = process.cwd(), env = process.env} = {}) {
  let f = file, c = null, base = null;
  if (!f) {
    const layers = loadLayers({from: jobDir, env, user: false});
    if (layers.project && layers.config.runner) { c = {...layers.config.runner, endpoint: env.PWORKER_URL || `http://${layers.config.server?.host ?? '127.0.0.1'}:${layers.config.server?.port ?? 18080}`}; base = path.dirname(layers.project); f = layers.project; }
  }
  if (!c) c = f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
  base ??= f ? path.dirname(path.resolve(f)) : path.resolve(jobDir);
  const fallback = Object.fromEntries(Object.entries(c.fallback ?? {}).filter(([k]) => !k.startsWith('_')));
  return {
    file: f ? path.resolve(f) : null,
    endpoint: env.PWORKER_URL || c.endpoint || DEFAULT_ENDPOINT,
    dataDir: c.dataDir ? path.resolve(base, c.dataDir) : path.join(path.resolve(jobDir), 'state'),
    roles: {...DEFAULT_ROLES, ...(c.roles ?? {})},
    fallback,
    limits: c.limits ?? {},
    tasks: c.tasks ?? {keepDays: 7},
    templatesDir: c.templatesDir ? path.resolve(base, c.templatesDir) : null,
  };
}

/** The tiers the endpoint serves (`GET /health` -> `tiers`: names, or entries {id, x_tier: {serves} | {error}}); empty when unknown. */
export async function liveTiers(endpoint, {fetchImpl = fetch} = {}) {
  try {
    const r = await fetchImpl(`${String(endpoint).replace(/\/+$/, '')}/health`, {signal: AbortSignal.timeout(3000)});
    const t = (await r.json())?.tiers;
    if (Array.isArray(t)) return new Set(t.map(x => (typeof x === 'string' ? x : x?.x_tier?.error ? null : x?.id ?? x?.name)).filter(Boolean));
    return new Set(t && typeof t === 'object' ? Object.keys(t).filter(k => !t[k]?.error) : []);
  } catch { return new Set(); }
}

/**
 * `{tier: chain}` for every tier in the config or served by the endpoint. A served tier is one entry calling the tier name on the
 * endpoint's default route (upstream null); the endpoint walks the tier's own fallback unless the job forbids it. The request fields
 * of the configured first entry (maxTokens, temperature, reasoning, extraBody) are kept.
 */
export function tierChains(config, live = new Set()) {
  const out = {};
  for (const name of new Set([...Object.keys(config.fallback ?? {}), ...live])) {
    const fb = config.fallback?.[name] ?? [];
    const keep = Object.fromEntries(Object.entries(fb[0] ?? {}).filter(([k]) => ['maxTokens', 'temperature', 'reasoning', 'extraBody'].includes(k)));
    out[name] = live.has(name) ? [{upstream: null, model: name, tier: name, viaProxyTier: true, ...keep}] : fb.map(e => ({...e, tier: name}));
  }
  return out;
}
