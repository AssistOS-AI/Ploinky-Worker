import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pworkerHome } from '../settings.mjs';

const JOB_ID = /^[a-f0-9-]{36}$/;

export function jobStore(home = pworkerHome()) {
  const dir = path.join(home, 'jobs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileOf = (id) => {
    if (!JOB_ID.test(id)) throw new Error('Invalid task ID');
    return path.join(dir, `${id}.json`);
  };
  const read = (id) => {
    try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const write = (job) => {
    const file = fileOf(job.id);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
    return job;
  };
  const create = ({ request, input, currentWorkingDirectory = null }) => {
    const now = new Date().toISOString();
    return write({ id: randomUUID(), status: 'queued', phase: null, steps: 0, request, input, currentWorkingDirectory, pid: null, createdAt: now, updatedAt: now, result: null, error: null });
  };
  const update = (id, change) => {
    const current = read(id);
    if (!current) throw new Error(`Task ${id} does not exist`);
    return write({ ...current, ...change, updatedAt: new Date().toISOString() });
  };
  const view = (id) => {
    const job = read(id);
    if (!job) return null;
    if (['queued', 'running', 'compiling'].includes(job.status) && job.pid) {
      try { process.kill(job.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') return update(id, { status: 'failed', error: 'The task process stopped before reporting a result.' });
      }
    }
    return job;
  };
  const list = () => fs.readdirSync(dir).filter((name) => JOB_ID.test(name.slice(0, -5)) && name.endsWith('.json'))
    .map((name) => view(name.slice(0, -5))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { dir, create, read, update, view, list };
}
