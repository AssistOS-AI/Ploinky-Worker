#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createPworkerClient } from '../lib/client.mjs';
import { ensureUserHome, loadLayers } from '../lib/config.mjs';
import { pworkerHome } from '../lib/settings.mjs';
import { Pworker } from '../lib/pworker/task.mjs';
import { jobStore } from '../lib/pworker/jobs.mjs';
import { selectMenu, promptField } from '../lib/pworker/menu.mjs';
import { connectedProviders, fetchModelCatalog, providerSpec } from '../lib/pworker/providers.mjs';
import { resolveUpstream } from '../lib/settings.mjs';
import { HELP } from '../lib/pworker/help.mjs';

const args = process.argv.slice(2);
const command = args[0];
const home = pworkerHome();
const pidFile = path.join(home, 'pworker.pid');
const configFile = path.join(home, 'config.json');
const queueFile = path.join(home, 'queue.json');
const option = (name, fallback = null) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const json = (v) => console.log(JSON.stringify(v, null, 2));
const client = () => createPworkerClient({ purpose: 'pworker:cli', client: 'pworker' });
const sleep = (n) => new Promise((resolve) => setTimeout(resolve, n));

function readUserConfig() { return JSON.parse(fs.readFileSync(configFile, 'utf8')); }
function saveUserConfig(c) { fs.writeFileSync(configFile, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 }); }
function runningPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('/pworker.mjs') && cmdline.includes('serve') ? pid : null;
  } catch { return null; }
}
async function startProxy() {
  if (runningPid()) return;
  const log = fs.openSync(path.join(home, 'logs', 'pworker.log'), 'a');
  const child = spawn(process.execPath, [path.resolve(process.argv[1]), 'serve'], { detached: true, stdio: ['ignore', log, log] });
  child.unref(); fs.closeSync(log);
  for (let i = 0; i < 40; i++) { await sleep(250); if (runningPid()) return; }
  throw new Error(`The proxy did not start. See ${path.join(home, 'logs', 'pworker.log')}`);
}
async function stopProxy() {
  const pid = runningPid();
  if (!pid) return false;
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 40; i++) { await sleep(100); if (!runningPid()) return true; }
  return false;
}
async function restartProxy() { if (runningPid()) { await stopProxy(); await startProxy(); } }

function publicJob(job) {
  if (!job) return null;
  const { id, status, phase, steps, currentWorkingDirectory, createdAt, updatedAt, result, error } = job;
  return { id, status, phase, steps, currentWorkingDirectory, createdAt, updatedAt, result, error };
}

function startDetachedTasks(items) {
  const store = jobStore(home);
  const prepared = items.map(({ request, input, currentWorkingDirectory }) => {
    const supplied = currentWorkingDirectory ?? (input && typeof input === 'object' && !Array.isArray(input) ? input.currentWorkingDirectory : null);
    const cwd = supplied ? fs.realpathSync(path.resolve(supplied)) : null;
    if (cwd && !fs.statSync(cwd).isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
    return { request, input, currentWorkingDirectory: cwd };
  });
  const jobs = prepared.map((item) => store.create(item));
  const batchId = randomUUID();
  const manifest = path.join(store.dir, `batch-${batchId}.json`);
  fs.writeFileSync(manifest, JSON.stringify(jobs.map((job) => job.id)), { mode: 0o600 });
  const log = fs.openSync(path.join(home, 'logs', `batch-${batchId}.log`), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [path.resolve(process.argv[1]), '_execute-batch', batchId], { cwd: process.cwd(), detached: true, stdio: ['ignore', log, log] });
    if (!child.pid) throw new Error('Could not start the task process');
    for (const job of jobs) store.update(job.id, { pid: child.pid });
    child.unref();
  } catch (error) {
    for (const job of jobs) store.update(job.id, { status: 'failed', error: error.message });
    throw error;
  } finally { fs.closeSync(log); }
  return jobs.map((job) => publicJob(store.read(job.id)));
}

async function executeDetachedBatch(batchId) {
  const store = jobStore(home);
  if (!/^[a-f0-9-]{36}$/.test(batchId)) throw new Error('Invalid batch ID');
  const manifest = path.join(store.dir, `batch-${batchId}.json`);
  const ids = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  try {
    const worker = new Pworker({ client: client(), config: loadLayers().config, onProgress: (event) => store.update(event.id, event) });
    for (const id of ids) {
      const job = store.read(id);
      if (!job) continue;
      store.update(id, { pid: process.pid, status: 'compiling' });
      try { await worker.enqueueRequest(job.request, job.input, { id, currentWorkingDirectory: job.currentWorkingDirectory }); }
      catch (error) { store.update(id, { status: 'failed', phase: null, error: error.message }); }
    }
    if (worker.pending.length) await worker.flush();
  } catch (error) {
    for (const id of ids) if (!['completed', 'failed'].includes(store.read(id)?.status)) store.update(id, { status: 'failed', phase: null, error: error.message });
  } finally { try { fs.unlinkSync(manifest); } catch {} }
}

function saveProvider(name, spec, key) {
  const c = readUserConfig();
  c.providers ??= {};
  c.providers[name] = spec;
  saveUserConfig(c);
  if (key) fs.writeFileSync(path.join(home, 'keys', spec.envFile ?? `${name}.env`), `${spec.keyVar}=${JSON.stringify(key)}\n`, { mode: 0o600 });
}
function setTier(tier, provider, model, batch) {
  const c = readUserConfig();
  c.tiers ??= {};
  c.tiers[tier] = [{ upstream: provider, model }];
  c.batching ??= {};
  if (batch !== undefined) c.batching[tier] = { enabled: batch };
  saveUserConfig(c);
}
const ui = (rl) => ({ input: stdin, output: stdout, rl });
const note = (message) => stdout.write(`\n${message}\n`);

async function localStates() {
  try { return await client().models(); }
  catch { return {}; }
}

async function modelsFromProxy(provider) {
  const response = await client().providerModels(provider);
  const models = [...new Set((response.data ?? []).map((item) => item?.id).filter((id) => typeof id === 'string' && id))].sort();
  if (!models.length) throw new Error(`${provider} returned no selectable models`);
  return models;
}

async function connectProvider(screen) {
  for (;;) {
    const config = loadLayers().config;
    const local = await localStates();
    const choices = Object.entries(config.providers ?? {}).filter(([name]) => !name.startsWith('_')).map(([name, provider]) => {
      if (provider.start) return { label: `${name} · local ${provider.start.alias ?? ''} · ${local[name]?.running ? 'running' : 'stopped'}`, value: `local:${name}` };
      const key = resolveUpstream(name, provider).key;
      return { label: `${name} · ${key || provider.noKey ? 'connected' : 'API key needed'}`, value: `api:${name}` };
    });
    choices.push({ label: 'Add OpenAI-compatible endpoint', value: 'custom' });
    const selected = await selectMenu(screen, 'Log in / connect provider', choices);
    if (!selected) return null;
    try {
      if (selected.startsWith('local:')) {
        const name = selected.slice(6);
        if (!local[name]?.running) {
          note(`Starting ${name}...`);
          const result = await client().model(name, 'start');
          if (!result.ok) throw new Error(result.status?.last_refusal?.reason ?? `Could not start ${name}`);
        }
        const models = await modelsFromProxy(name);
        note(`Connected to ${name} (${models.length} models).`);
        return { name, models };
      }
      if (selected === 'custom') {
        const name = await promptField(screen, 'Provider name');
        if (name == null) continue;
        if (config.providers?.[name]?.start) throw new Error('A managed local provider cannot be replaced here');
        const endpoint = await promptField(screen, 'Base endpoint URL');
        if (endpoint == null) continue;
        const key = await promptField(screen, 'API key (leave empty for a keyless local endpoint)', { secret: true, allowEmpty: true });
        if (key == null) continue;
        const rpm = await promptField(screen, 'Maximum requests per minute', { initial: '60' });
        if (rpm == null) continue;
        const spec = providerSpec(name, endpoint, key, rpm, config.providers?.[name] ?? {});
        note('Checking the provider model list...');
        const models = await fetchModelCatalog(spec, { key });
        saveProvider(name, spec, key);
        await restartProxy();
        note(`Connected to ${name} (${models.length} models).`);
        return { name, models };
      }
      const name = selected.slice(4), provider = config.providers[name];
      const resolved = resolveUpstream(name, provider);
      let key = resolved.key;
      if (key || provider.noKey) {
        const action = await selectMenu(screen, `${name} credentials`, [
          { label: key ? 'Use configured API key' : 'Use keyless endpoint', value: 'use' },
          ...(!process.env[provider.keyVar] ? [{ label: 'Replace API key', value: 'replace' }] : []),
        ]);
        if (!action) continue;
        if (action === 'replace') key = await promptField(screen, `${name} API key`, { secret: true });
      } else key = await promptField(screen, `${name} API key`, { secret: true });
      if (key == null) continue;
      note('Checking the provider model list...');
      const models = await fetchModelCatalog(provider, { key });
      if (key !== resolved.key) {
        fs.writeFileSync(path.join(home, 'keys', provider.envFile ?? `${name}.env`), `${provider.keyVar}=${JSON.stringify(key)}\n`, { mode: 0o600 });
        await restartProxy();
      }
      note(`Connected to ${name} (${models.length} models).`);
      return { name, models };
    } catch (error) { note(`Connection failed: ${error.message}`); }
  }
}

async function configureTier(screen, preferred = null) {
  const config = loadLayers().config;
  const local = await localStates();
  const available = connectedProviders(config, local);
  if (!available.length) { note('Connect an API provider or start a local model before configuring a tier.'); return; }
  const names = Object.keys(config.tiers ?? {}).filter((name) => !name.startsWith('_') && name !== 'maxWaitMs');
  const tier = await selectMenu(screen, 'Choose a tier', names.map((name) => {
    const first = Array.isArray(config.tiers[name]) ? config.tiers[name][0] : null;
    return { label: `${name}${first ? ` · ${first.upstream}/${first.model}` : ''}`, value: name };
  }));
  if (!tier) return;
  const provider = preferred && available.includes(preferred) ? preferred : await selectMenu(screen, `Provider for ${tier}`, available.map((name) => ({ label: name, value: name })));
  if (!provider) return;
  let models;
  try { note(`Loading models from ${provider}...`); models = await modelsFromProxy(provider); }
  catch (error) { note(`Model list unavailable: ${error.message}`); return; }
  const model = await selectMenu(screen, `Model for ${tier} · ${provider}`, models.map((id) => ({ label: id, value: id })), { searchable: true });
  if (!model) return;
  const currentBatch = config.batching?.[tier]?.enabled === true;
  const batch = await selectMenu(screen, `Batch requests for ${tier}? (currently ${currentBatch ? 'on' : 'off'})`, [
    { label: 'Keep current setting', value: 'keep' },
    { label: 'Enable batching', value: 'on' },
    { label: 'Disable batching', value: 'off' },
  ]);
  if (!batch) return;
  const enabled = batch === 'keep' ? currentBatch : batch === 'on';
  const confirmation = await selectMenu(screen, `Save ${tier} → ${provider}/${model} · batching ${enabled ? 'on' : 'off'}?`, [{ label: 'Save tier', value: 'save' }]);
  if (confirmation !== 'save') return;
  setTier(tier, provider, model, enabled);
  await restartProxy();
  note(`Saved ${tier} → ${provider}/${model}.`);
}

async function manageLocalModels(screen) {
  const local = await localStates();
  const name = await selectMenu(screen, 'Local models', Object.entries(local).map(([id, model]) => ({ label: `${id} · ${model.model ?? 'model'} · ${model.running ? 'running' : 'stopped'}`, value: id })));
  if (!name) return;
  const action = await selectMenu(screen, `${name}`, [
    { label: 'Start model', value: 'start' },
    { label: 'Stop model', value: 'stop' },
  ]);
  if (!action) return;
  const response = await client().model(name, action);
  if (!response.ok) throw new Error(response.status?.last_refusal?.reason ?? `${action} failed`);
  note(`${name}: ${action} completed.`);
}

async function interactive() {
  await startProxy();
  const rl = !stdin.isTTY || !stdout.isTTY ? readline.createInterface({ input: stdin, output: stdout }) : null;
  const screen = ui(rl);
  try {
    for (;;) {
      const available = connectedProviders(loadLayers().config, await localStates());
      const choice = await selectMenu(screen, `Ploinky Workers · ${available.length} connected provider${available.length === 1 ? '' : 's'}`, [
        { label: 'Log in / connect provider', value: 'connect' },
        ...(available.length ? [{ label: 'Configure tier', value: 'tier' }] : []),
        { label: 'Run task', value: 'run' },
        { label: 'Manage local models', value: 'local' },
        { label: 'Statistics', value: 'stats' },
        { label: 'Stop proxy', value: 'stop' },
        { label: 'Exit', value: 'exit' },
      ]);
      if (!choice || choice === 'exit') return;
      try {
        if (choice === 'stop') { note((await stopProxy()) ? 'Proxy stopped.' : 'The proxy is not running.'); return; }
        if (choice === 'stats') { json(await client().stats()); continue; }
        if (choice === 'connect') {
          const connected = await connectProvider(screen);
          if (connected && await selectMenu(screen, `${connected.name} is ready`, [{ label: 'Configure a tier now', value: 'tier' }]) === 'tier') await configureTier(screen, connected.name);
          continue;
        }
        if (choice === 'tier') { await configureTier(screen); continue; }
        if (choice === 'local') { await manageLocalModels(screen); continue; }
        if (choice === 'run') {
          const task = await promptField(screen, '.mjs file or natural-language request');
          if (task == null) continue;
          const inputText = await promptField(screen, 'Input (text or JSON)', { allowEmpty: true });
          if (inputText == null) continue;
          const cwd = await promptField(screen, 'Working directory (empty for none)', { allowEmpty: true });
          if (cwd == null) continue;
          const mode = await selectMenu(screen, 'Execution mode', [{ label: 'Wait for result', value: 'wait' }, { label: 'Return task ID immediately', value: 'async' }]);
          if (!mode) continue;
          let value = inputText; try { value = JSON.parse(inputText); } catch { /* plain text */ }
          if (mode === 'async') json(startDetachedTasks([{ request: task, input: value, currentWorkingDirectory: cwd || null }])[0]);
          else { const worker = new Pworker({ client: client(), config: loadLayers().config }); await worker.enqueueRequest(task, value, { currentWorkingDirectory: cwd || null }); json(await worker.flush()); }
        }
      } catch (error) { note(`Operation failed: ${error.message}`); }
    }
  } finally { rl?.close(); }
}

async function main() {
  if (command === 'help' || args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); return; }
  ensureUserHome();
  if (!command) return interactive();
  if (command === '_execute-batch') return executeDetachedBatch(args[1]);
  if (command === '--status' || command === 'status') {
    const store = jobStore(home);
    const found = args[1] ? publicJob(store.view(args[1])) : store.list().map(publicJob);
    if (args[1] && !found) { json({ error: `Task ${args[1]} does not exist` }); process.exitCode = 2; return; }
    json(found); return;
  }
  if (command === 'serve') {
    const { serve } = await import('../lib/server.mjs');
    const proxy = await serve({ port: option('port'), host: option('host') });
    if (proxy?.already) return;
    fs.writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 });
    const clear = () => { try { if (Number(fs.readFileSync(pidFile, 'utf8')) === process.pid) fs.unlinkSync(pidFile); } catch {} };
    process.on('exit', clear);
    return;
  }
  if (command === 'start') { await startProxy(); console.log('Proxy started.'); return; }
  if (command === 'stop') { console.log((await stopProxy()) ? 'Proxy stopped.' : 'The proxy is not running.'); return; }
  if (['run', '--async', 'queue', 'flush', 'stats', 'models', 'tier'].includes(command)) await startProxy();
  if (command === 'stats') { json(await client().stats()); return; }
  if (command === 'models') { const action = args[1]; json(action === 'start' || action === 'stop' ? await client().model(args[2], action) : await client().models()); return; }
  if (command === 'provider') {
    const name = args[1], key = option('key', '');
    const prior = loadLayers().config.providers?.[name] ?? {};
    if (prior.start) throw new Error('Use the local model menu to start a managed local provider');
    const spec = providerSpec(name, option('endpoint'), key, option('rpm', 60), prior);
    const models = await fetchModelCatalog(spec, { key });
    saveProvider(name, spec, key); await restartProxy();
    json({ provider: name, models: models.length }); return;
  }
  if (command === 'tier') {
    const name = option('provider'), model = option('model');
    const available = connectedProviders(loadLayers().config, await localStates());
    if (!available.includes(name)) throw new Error('Connect the provider before configuring a tier');
    if (!(await modelsFromProxy(name)).includes(model)) throw new Error(`Model ${model} is not in the provider model list`);
    setTier(args[1], name, model, args.includes('--batch') ? true : undefined); await restartProxy();
    json({ tier: args[1], provider: name, model }); return;
  }
  if (command === 'queue' && ['list', 'clear'].includes(args[1])) {
    if (args[1] === 'clear') { fs.writeFileSync(queueFile, '[]\n', { mode: 0o600 }); console.log('The queue is empty.'); }
    else json(fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : []);
    return;
  }
  if (command === 'run' || command === '--async' || command === 'queue') {
    const request = args[1] === '-' ? fs.readFileSync(0, 'utf8') : args[1];
    if (!request) throw new Error('Usage: pworker run <file.mjs|request|-> [--input text|JSON]');
    let input = option('input', ''); try { input = JSON.parse(input); } catch {}
    const currentWorkingDirectory = option('cwd', option('current-working-directory', null));
    if (command === 'queue') {
      const pending = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
      pending.push({ request, input, currentWorkingDirectory });
      fs.writeFileSync(queueFile, JSON.stringify(pending, null, 2) + '\n', { mode: 0o600 });
      console.log(`${pending.length} tasks in the queue.`); return;
    }
    if (command === '--async' || args.includes('--async')) { json(startDetachedTasks([{ request, input, currentWorkingDirectory }])[0]); return; }
    const worker = new Pworker({ client: client(), config: loadLayers().config });
    const entry = await worker.enqueueRequest(request, input, { currentWorkingDirectory });
    json({ ...entry, results: await worker.flush() }); return;
  }
  if (command === 'flush') {
    const pending = fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile, 'utf8')) : [];
    if (args.includes('--async')) {
      const jobs = pending.length ? startDetachedTasks(pending) : [];
      fs.writeFileSync(queueFile, '[]\n', { mode: 0o600 });
      json(jobs); return;
    }
    const worker = new Pworker({ client: client(), config: loadLayers().config });
    const entries = [];
    for (const item of pending) entries.push(await worker.enqueueRequest(item.request, item.input, { currentWorkingDirectory: item.currentWorkingDirectory }));
    const results = await worker.flush();
    const failed = results.filter((r) => !r.ok);
    fs.writeFileSync(queueFile, JSON.stringify(failed.map((r) => pending[results.findIndex((x) => x.id === r.id)]), null, 2) + '\n', { mode: 0o600 });
    json({ entries, results }); return;
  }
  console.log('pworker [run <task.mjs|request|-> --input text|JSON [--cwd DIR] [--async]] | --status [TASK_ID] | queue <task> --input ... [--cwd DIR] | queue list|clear | flush [--async] | start | stop | serve | stats | models [start|stop <local>] | provider <name> --endpoint URL --key KEY --rpm N | tier <name> --provider P --model ID [--batch]');
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
