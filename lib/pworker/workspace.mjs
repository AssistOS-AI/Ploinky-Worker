// The task work folder and the confined file tools phase statements may use: read, list, search, write, move. Every path is relative to
// the work folder (an absolute path is accepted only when it lies inside). Refused:
//   - a path that leaves the folder (`..`, an absolute path elsewhere, a NUL byte);
//   - a path whose existing part resolves, through a symbolic link anywhere on the way, to a place outside the folder;
//   - writing or moving through a symbolic link (the final component is opened with O_NOFOLLOW), or onto an existing file by `move`;
//   - writing into the agent's own folders (`.pworker` holds the plan cache and the run folders, `.agents` the skills, `.git`).
// Sizes are bounded (a read, a write, the total written, list and search results). A hard link inside the folder to a file elsewhere is
// not detected: it is a file of the folder.
import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_LIMITS = Object.freeze({ maxReadBytes: 2_000_000, maxWriteBytes: 2_000_000, maxTotalWriteBytes: 20_000_000, maxList: 2000, maxSearchFiles: 2000, maxSearchResults: 200, maxSearchFileBytes: 2_000_000 });
export const PROTECTED = Object.freeze(['.pworker', '.agents', '.git']);
const SKIP_DIRS = new Set(['.git', '.pworker', 'node_modules']);

export class PathRefused extends Error {
  constructor(message) { super(message); this.code = 'path_refused'; }
}

const inside = (root, p) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/**
 * A confined view of `root`: {root, resolve(p, {write}), read, list, search, write, move}. `limits` overrides WORKSPACE_LIMITS.
 * `protectedDirs` are top-level folder names a plan may read but never write.
 */
export function createWorkspace(root, { limits = {}, protectedDirs = PROTECTED } = {}) {
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`the work folder ${root} does not exist`);
  const real = fs.realpathSync(root);
  const L = { ...WORKSPACE_LIMITS, ...limits };
  let written = 0;

  /** The absolute path of `p` inside the folder, or a PathRefused error. */
  function resolveIn(p, { write = false } = {}) {
    if (typeof p !== 'string' || !p.trim()) throw new PathRefused('a path must be a non-empty string');
    if (p.includes('\0')) throw new PathRefused('a path must not contain a NUL byte');
    if (p.length > 1024) throw new PathRefused('the path is too long');
    const abs = path.resolve(real, p);
    if (!inside(real, abs)) throw new PathRefused(`${p}: outside the work folder`);
    // The longest existing prefix must resolve (through any symbolic links) inside the folder.
    let probe = abs;
    while (!fs.existsSync(probe) && !isLink(probe)) probe = path.dirname(probe);
    let target;
    try { target = fs.realpathSync(probe); } catch { throw new PathRefused(`${p}: a broken symbolic link on the way`); }
    if (!inside(real, target)) throw new PathRefused(`${p}: leaves the work folder through a symbolic link`);
    if (probe === abs && isLink(abs) && write) throw new PathRefused(`${p}: is a symbolic link; writing through links is refused`);
    const rel = path.relative(real, abs);
    if (write) {
      if (rel === '') throw new PathRefused('the work folder itself cannot be written');
      const top = rel.split(path.sep)[0];
      if (protectedDirs.includes(top)) throw new PathRefused(`${p}: ${top}/ is the agent's own folder and cannot be written by a plan`);
    }
    return abs;
  }
  const relOf = (abs) => path.relative(real, abs).split(path.sep).join('/') || '.';

  function read(p) {
    const abs = resolveIn(p);
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) throw new Error(`${p}: no such file`);
    if (!st.isFile()) throw new Error(`${p}: not a file`);
    if (st.size > L.maxReadBytes) throw new Error(`${p}: ${st.size} bytes, more than the read limit of ${L.maxReadBytes}`);
    return fs.readFileSync(abs, 'utf8');
  }

  function list(dir = '.', { recursive = false } = {}) {
    const abs = resolveIn(dir || '.');
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isDirectory()) throw new Error(`${dir}: not a folder`);
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (out.length >= L.maxList) return;
        const full = path.join(d, e.name);
        if (e.isSymbolicLink()) { out.push({ path: relOf(full), type: 'link' }); continue; }
        if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) && d === real) continue; out.push({ path: relOf(full), type: 'dir' }); if (recursive) walk(full); continue; }
        if (e.isFile()) out.push({ path: relOf(full), type: 'file', bytes: fs.statSync(full).size });
      }
    };
    walk(abs);
    return out;
  }

  /** Literal text search (no regular expressions: a pattern never runs in the host). */
  function search(text, { dir = '.', ignoreCase = true, maxResults = L.maxSearchResults } = {}) {
    if (typeof text !== 'string' || !text) throw new Error('search needs a non-empty text');
    const needle = ignoreCase ? text.toLowerCase() : text;
    const cap = Math.min(Number(maxResults) || L.maxSearchResults, L.maxSearchResults);
    const files = list(dir, { recursive: true }).filter((e) => e.type === 'file' && e.bytes <= L.maxSearchFileBytes).slice(0, L.maxSearchFiles);
    const hits = [];
    for (const f of files) {
      const body = fs.readFileSync(path.join(real, f.path), 'utf8');
      if (body.includes('\0')) continue; // binary
      const lines = body.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < cap; i++) if ((ignoreCase ? lines[i].toLowerCase() : lines[i]).includes(needle)) hits.push({ path: f.path, line: i + 1, text: lines[i].slice(0, 300) });
      if (hits.length >= cap) break;
    }
    return hits;
  }

  function write(p, text) {
    if (typeof text !== 'string') throw new Error('write needs text (a string)');
    const bytes = Buffer.byteLength(text);
    if (bytes > L.maxWriteBytes) throw new Error(`${p}: ${bytes} bytes, more than the write limit of ${L.maxWriteBytes}`);
    if (written + bytes > L.maxTotalWriteBytes) throw new Error(`the run's total write limit of ${L.maxTotalWriteBytes} bytes is reached`);
    const abs = resolveIn(p, { write: true });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    resolveIn(p, { write: true }); // the folders created on the way are checked again
    const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
    written += bytes;
    return { path: relOf(abs), bytes };
  }

  function move(from, to) {
    const a = resolveIn(from, { write: true }), b = resolveIn(to, { write: true });
    const st = fs.lstatSync(a, { throwIfNoEntry: false });
    if (!st) throw new Error(`${from}: no such file`);
    if (!st.isFile()) throw new Error(`${from}: only files can be moved`);
    if (fs.existsSync(b) || isLink(b)) throw new Error(`${to}: exists; move never overwrites`);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    resolveIn(to, { write: true });
    fs.renameSync(a, b);
    return { from: relOf(a), to: relOf(b) };
  }

  function makeDirectory(p) {
    const abs = resolveIn(p, { write: true });
    fs.mkdirSync(abs, { recursive: true });
    resolveIn(p, { write: true });
    return { path: relOf(abs) };
  }

  function removeFile(p) {
    const abs = resolveIn(p, { write: true });
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) throw new Error(`${p}: not a regular file`);
    fs.unlinkSync(abs);
    return { path: relOf(abs) };
  }

  return { root: real, resolve: resolveIn, relOf, read, list, search, write, move, makeDirectory, removeFile, written: () => written };
}

function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }
