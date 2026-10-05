// Configuration layers: the built-in defaults (config.default.json of this folder), the user's ~/.pworker/config.json, and a project
// configuration (an explicit file, PWORKER_CONFIG, or the nearest config/pworker.json or pworker.config.json above the working
// folder). Objects merge key by key; arrays and tier chains are replaced; null removes a key. Relative paths are made absolute against
// the folder of the layer that names them (its `baseDir`, else the file's folder), so the merged configuration has absolute paths only.
// On the first start of a server, a template ~/.pworker/config.json and commented key files are written, so a user only fills in keys.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { HOME, expandHome, pworkerHome } from './settings.mjs';

export const PROJECT_NAMES = Object.freeze(['config/pworker.json', 'pworker.config.json']);
export const DEFAULTS_FILE = join(HOME, 'config.default.json');

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge: objects key by key, arrays replaced, null deletes. Tier entries are replaced whole. */
export function mergeLayers(base, over, path = []) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null) { delete out[k]; continue; }
    out[k] = path.length === 1 && path[0] === 'tiers' ? v : mergeLayers(base[k], v, [...path, k]);
  }
  return out;
}

const PATH_FIELDS = ['dataDir', 'cacheDir', 'auditDir', 'logDir', 'promptsDir'];
const START_FIELDS = ['gguf', 'script', 'logFile'];
const START_LISTS = ['locks', 'identity', 'requires'];

/** Makes the paths of one layer absolute against `dir` (a bare command name such as `llama-server` stays a PATH lookup). */
export function absolutize(layer, dir) {
  const c = structuredClone(layer);
  const abs = (p) => (typeof p !== 'string' ? p : p.startsWith('~') ? expandHome(p) : isAbsolute(p) ? p : resolve(dir, p));
  for (const k of PATH_FIELDS) if (typeof c[k] === 'string') c[k] = abs(c[k]);
  for (const ups of [c.providers, c.upstreams]) for (const up of Object.values(ups ?? {})) {
    const s = up?.start;
    if (!isObj(s)) continue;
    for (const k of START_FIELDS) if (typeof s[k] === 'string') s[k] = abs(s[k]);
    if (typeof s.bin === 'string' && (s.bin.includes('/') || s.bin.startsWith('~'))) s.bin = abs(s.bin);
    for (const k of START_LISTS) if (Array.isArray(s[k])) s[k] = s[k].map(abs);
  }
  if (isObj(c.runner)) for (const k of ['dataDir', 'templatesDir']) if (typeof c.runner[k] === 'string') c.runner[k] = abs(c.runner[k]);
  // TaskLambda sources and the calls folder.
  if (isObj(c.lambdas)) {
    if (Array.isArray(c.lambdas.project)) c.lambdas.project = c.lambdas.project.map(abs);
    if (isObj(c.lambdas.jobs)) c.lambdas.jobs = Object.fromEntries(Object.entries(c.lambdas.jobs).map(([k, v]) => [k, typeof v === 'string' ? abs(v) : isObj(v) ? { ...v, dir: abs(v.dir) } : v]));
  }
  if (isObj(c.calls) && typeof c.calls.dir === 'string') c.calls.dir = abs(c.calls.dir);
  return c;
}

const readLayer = (file) => {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const dir = raw.baseDir ? resolve(dirname(file), expandHome(raw.baseDir)) : dirname(file);
  const { baseDir: _b, ...rest } = raw;
  return absolutize(rest, dir);
};

/** The nearest project configuration above `from`, or null. */
export function findProjectConfig(from = process.cwd()) {
  for (let d = resolve(from); ; d = dirname(d)) {
    const hit = PROJECT_NAMES.map((n) => join(d, n)).find(existsSync);
    if (hit) return hit;
    if (dirname(d) === d) return null;
  }
}

/**
 * The merged configuration: `{config, layers: [files], project}`. `project`: a file, false (no project layer), or null (discover);
 * `user`: false skips the user layer (tests).
 */
export function loadLayers({ project = null, from = process.cwd(), env = process.env, user = true } = {}) {
  const files = [DEFAULTS_FILE];
  const userFile = join(pworkerHome(env), 'config.json');
  if (user && existsSync(userFile)) files.push(userFile);
  const proj = project === false ? null : project ? resolve(project) : env.PWORKER_CONFIG ? resolve(env.PWORKER_CONFIG) : findProjectConfig(from);
  if (proj) files.push(proj);
  let config = {};
  for (const f of files) {
    let layer = readLayer(f);
    if (f === DEFAULTS_FILE && env.PWORKER_HOME) {
      const oldHome = expandHome('~/.pworker');
      const newHome = pworkerHome(env);
      const move = (value) => typeof value === 'string' && (value === oldHome || value.startsWith(oldHome + '/')) ? newHome + value.slice(oldHome.length)
        : Array.isArray(value) ? value.map(move) : isObj(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, move(v)])) : value;
      layer = move(layer);
    }
    config = mergeLayers(config, layer);
  }
  return { config, layers: files, project: proj };
}

const TEMPLATE = {
  _note: 'Pworker user settings layered over config.default.json. Put API keys only in keys/<provider>.env, never here. Use the interactive pworker menu to configure providers and tiers. Leading underscores mark examples.',
  _server: { port: 18080 },
  _providers: { openference: { limits: { maxPerMinute: 15 } } },
  _tiers: { small: [{ upstream: 'openference', model: 'Qwen3.8 27b' }, { upstream: 'local', model: 'Qwen3.6-35B-A3B' }] },
  _local_models: 'set providers.local.start.gguf (tiny), providers.localsuper.start.gguf (micro), providers.localnano.start.gguf (nano) and start.bin (llama-server) when your files are elsewhere than ~/.pworker/models',
};
const KEY_FILES = {
  'openference.env': '# openference plan key (https://openference.com); uncomment and fill in:\n# OPENFERENCE_API_KEY=\n',
  'openrouter.env': '# OpenRouter key (pay per token; the fallback of the cloud tiers); uncomment and fill in:\n# OPENROUTER_API_KEY=\n',
  'deepseek.env': '# Official DeepSeek API key; uncomment and fill in:\n# DEEPSEEK_API_KEY=\n',
  'openai.env': '# OPENAI_API_KEY=\n',
  'zai.env': '# PWORKER_ZAI_API_KEY=\n',
  'grok.env': '# PWORKER_GROK_API_KEY=\n',
};

/** Writes the user's template configuration and commented key files when missing (never overwrites; never writes a key). */
export function ensureUserHome(env = process.env) {
  const home = pworkerHome(env);
  const written = [];
  for (const d of ['', 'keys', 'data', 'cache', 'audit', 'logs', 'runs', 'calls', 'models', 'tasks']) mkdirSync(join(home, d), { recursive: true, mode: 0o700 });
  const cfg = join(home, 'config.json');
  if (!existsSync(cfg)) { writeFileSync(cfg, JSON.stringify(TEMPLATE, null, 2) + '\n'); written.push(cfg); }
  for (const [name, text] of Object.entries(KEY_FILES)) {
    const f = join(home, 'keys', name);
    if (!existsSync(f)) { writeFileSync(f, text, { mode: 0o600 }); try { chmodSync(f, 0o600); } catch { /* best effort */ } written.push(f); }
  }
  return { home, written };
}
