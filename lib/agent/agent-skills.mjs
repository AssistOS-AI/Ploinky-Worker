// Skills of the agent, in the Agent Skills format: a folder with SKILL.md (YAML frontmatter `name`, `description`; optional `license`,
// `metadata`, `allowed-tools`; the body is the instructions) and optional files beside it, the scripts in `scripts/`.
//
// Discovery: `<workdir>/.agents/skills/*/SKILL.md`, then the folders of `agent.skillDirs` (a project's `skills/`); an earlier source wins
// a name. The planner sees names and descriptions only and loads a body when it chooses the skill (progressive disclosure).
//
// Scripts: a skill declares its scripts either in the frontmatter (`scripts: [a.mjs, b.py]`, paths under the skill folder) or, without
// that key, as the regular files directly in its `scripts/` folder. Only a declared script runs, with an interpreter chosen by its
// extension (.mjs/.js/.cjs: this Node; .py: python3; .sh: /bin/sh), without a shell (the arguments are an argv list, never interpolated),
// in the work folder, with a small environment, a timeout and an output limit. A skill's script is the skill author's code and is trusted
// like any installed tool; it is not sandboxed. A symbolic link that leaves the skill folder is not a script.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFrontmatter } from './frontmatter.mjs';

export const SCRIPT_LIMITS = Object.freeze({ timeMs: 60000, maxOutputBytes: 200_000, maxArgs: 32, maxArgChars: 8000 });
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const INTERPRETERS = { '.mjs': () => process.execPath, '.js': () => process.execPath, '.cjs': () => process.execPath, '.py': () => 'python3', '.sh': () => '/bin/sh' };
const inside = (root, p) => { const rel = path.relative(root, p); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

/** Reads one skill folder: {name, description, dir, file, scripts: [relative paths], problems} or null when it has no SKILL.md. */
export function readSkill(dir) {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return null;
  const problems = [];
  const { data } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const name = typeof data.name === 'string' ? data.name.trim() : path.basename(dir);
  if (!NAME.test(name)) problems.push(`name ${JSON.stringify(name)}: lowercase letters, digits and hyphens, at most 64`);
  if (name !== path.basename(dir)) problems.push(`name ${name} differs from its folder ${path.basename(dir)}`);
  const description = typeof data.description === 'string' ? data.description.trim().slice(0, 1024) : '';
  if (!description) problems.push('no description');
  const real = fs.realpathSync(dir);
  const declared = Array.isArray(data.scripts) ? data.scripts.map(String)
    : fs.existsSync(path.join(dir, 'scripts')) ? fs.readdirSync(path.join(dir, 'scripts')).sort().map((f) => `scripts/${f}`) : [];
  const scripts = [];
  for (const s of declared) {
    const abs = path.resolve(dir, s);
    let target = null;
    try { target = fs.realpathSync(abs); } catch { /* missing */ }
    if (!target || !inside(real, target) || !fs.statSync(target).isFile()) { if (Array.isArray(data.scripts)) problems.push(`script ${s}: not a file inside the skill folder`); continue; }
    if (!INTERPRETERS[path.extname(s)]) { problems.push(`script ${s}: unknown interpreter (use .mjs, .js, .cjs, .py or .sh)`); continue; }
    scripts.push(path.relative(dir, abs).split(path.sep).join('/'));
  }
  return { name, description, dir, file, scripts, problems };
}

/** Discovers the skills: {skills: Map name -> skill, problems}. `dirs` are skill roots (folders holding skill folders), in priority order. */
export function discoverSkills(dirs) {
  const skills = new Map(), problems = [];
  for (const root of dirs) {
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      let s;
      try { s = readSkill(path.join(root, e.name)); } catch (err) { problems.push(`${path.join(root, e.name)}: ${err.message}`); continue; }
      if (!s) continue;
      for (const p of s.problems) problems.push(`${s.file}: ${p}`);
      if (!s.description || !NAME.test(s.name)) continue;
      if (skills.has(s.name)) { problems.push(`${s.file}: skill ${s.name} is already defined by ${skills.get(s.name).file}`); continue; }
      skills.set(s.name, s);
    }
  }
  return { skills, problems };
}

/** The skill roots of a work folder: its `.agents/skills`, then `extra` (absolute, or relative to the work folder). */
export const skillRoots = (workdir, extra = []) => [path.join(workdir, '.agents', 'skills'), ...extra.map((d) => path.resolve(workdir, d))];

/** The catalog the planner sees: one line per skill, name and description, nothing else. */
export const skillCatalog = (skills) => [...skills.values()].map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ')}${s.scripts.length ? ` (scripts: ${s.scripts.join(', ')})` : ''}`).join('\n');

/** The body of a skill (its instructions, without the frontmatter), loaded when the planner chooses it. */
export function skillBody(skill, maxChars = 12000) {
  const { body } = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
  const text = body.trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[... cut at ${maxChars} characters]` : text;
}

/**
 * Runs a declared script of a skill: {code, stdout, stderr, truncated, timedOut, ms}. `args`: strings only. The process runs in `cwd` (the
 * work folder) with PATH, LANG and HOME only, no stdin, killed at `timeMs`; output beyond `maxOutputBytes` is cut and the process killed.
 */
export function runSkillScript(skill, script, args = [], { cwd, limits = {} } = {}) {
  const L = { ...SCRIPT_LIMITS, ...limits };
  if (!skill) return Promise.reject(new Error('no such skill'));
  if (typeof script !== 'string' || !skill.scripts.includes(script.replace(/^\.\//, ''))) return Promise.reject(new Error(`script ${script} is not declared by skill ${skill.name} (declared: ${skill.scripts.join(', ') || 'none'})`));
  if (!Array.isArray(args) || args.length > L.maxArgs || args.some((a) => typeof a !== 'string' || a.length > L.maxArgChars || a.includes('\0'))) return Promise.reject(new Error(`args must be a list of at most ${L.maxArgs} strings of at most ${L.maxArgChars} characters`));
  const file = path.join(skill.dir, script.replace(/^\.\//, ''));
  const bin = INTERPRETERS[path.extname(file)]();
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, [file, ...args], { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: process.env.LANG ?? 'C.UTF-8', HOME: process.env.HOME ?? cwd, PWORKER_SKILL_DIR: skill.dir } });
    } catch (e) { reject(e); return; }
    const out = [], err = [];
    let bytes = 0, truncated = false, timedOut = false;
    const take = (buf, chunk) => {
      if (truncated) return;
      const room = L.maxOutputBytes - bytes;
      if (chunk.length > room) { buf.push(chunk.subarray(0, Math.max(0, room))); bytes = L.maxOutputBytes; truncated = true; child.kill('SIGKILL'); return; }
      buf.push(chunk); bytes += chunk.length;
    };
    child.stdout.on('data', (c) => take(out, c));
    child.stderr.on('data', (c) => take(err, c));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, L.timeMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`script ${script}: ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? null, signal: signal ?? null, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated, timedOut, ms: Date.now() - t0 });
    });
  });
}
