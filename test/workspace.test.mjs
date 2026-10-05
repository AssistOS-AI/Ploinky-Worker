import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWorkspace,PathRefused} from '../lib/pworker/workspace.mjs';
const tmp=(prefix='pworker-workspace-')=>fs.mkdtempSync(path.join(os.tmpdir(),prefix));
test('path confinement: escapes through .., absolute paths, symbolic links and protected folders are refused', () => {
  const dir = tmp(), outside = tmp('ta-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'A');
  fs.symlinkSync(outside, path.join(dir, 'out-link'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'secret-link.txt'));
  fs.symlinkSync(path.join(dir, 'sub', 'a.txt'), path.join(dir, 'inner-link.txt'));
  fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(dir, 'dangling.txt'));
  const ws = createWorkspace(dir);
  assert.equal(ws.read('sub/a.txt'), 'A');
  assert.equal(ws.read(path.join(dir, 'sub', 'a.txt')), 'A', 'an absolute path inside is accepted');
  assert.equal(ws.read('inner-link.txt'), 'A', 'a link that stays inside can be read');
  for (const p of ['../x', 'sub/../../x', path.join(outside, 'secret.txt'), 'out-link/secret.txt', 'secret-link.txt', 'dangling.txt', 'a\0b', '', '/etc/passwd']) {
    assert.throws(() => ws.read(p), (e) => e.code === 'path_refused', `read ${JSON.stringify(p)}`);
  }
  for (const p of ['out-link/new.txt', 'inner-link.txt', 'dangling.txt', '.pworker/plans/x/plan.mjs', '.agents/skills/x/SKILL.md', '.git/config', '.', '../y.txt']) {
    assert.throws(() => ws.write(p, 'x'), (e) => e.code === 'path_refused', `write ${JSON.stringify(p)}`);
  }
  assert.equal(fs.existsSync(path.join(outside, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret');
  assert.deepEqual(ws.write('deep/new/file.txt', 'hi'), { path: 'deep/new/file.txt', bytes: 2 });
  assert.deepEqual(ws.move('deep/new/file.txt', 'moved.txt'), { from: 'deep/new/file.txt', to: 'moved.txt' });
  assert.throws(() => ws.move('sub/a.txt', 'moved.txt'), /never overwrites/);
  assert.throws(() => ws.move('moved.txt', 'out-link/x.txt'), (e) => e.code === 'path_refused');
  assert.throws(() => ws.list('out-link'), (e) => e.code === 'path_refused');
  const listed = ws.list('.', { recursive: true }).map((e) => e.path);
  assert.ok(listed.includes('sub/a.txt') && listed.includes('out-link') && !listed.includes('out-link/secret.txt'), 'links are listed, never followed');
  assert.deepEqual(ws.search('a', { dir: 'sub' }).map((h) => h.path), ['sub/a.txt']);
  const small = createWorkspace(dir, { limits: { maxWriteBytes: 10 } });
  assert.throws(() => small.write('big.txt', 'x'.repeat(11)), /write limit/);
});
