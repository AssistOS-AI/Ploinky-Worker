import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pworker,validateTask,loadTask,compileTask} from '../lib/pworker/task.mjs';

test('only direct JSON phase maps are accepted and legacy inputs never reach a model',()=>{
  let invoked=false;
  const worker=new Pworker({client:{chat:()=>{invoked=true;}}});
  const forms=[()=>({}),{run:()=>{}},{begin:{tier:null,code:()=>{invoked=true;}}},
    {start:'begin',phases:{begin:{tier:null}}},
    {begin:{tier:null,code:'function(result){ this.end(result) }'}},
    {begin:{tier:null,code:'/* old */ ((result) => result)'}},
    {begin:{tier:null,code:'async (result) => result'}},
    {begin:{tier:null,run:'legacy'}},
  ];
  for(const task of forms)assert.throws(()=>worker.enqueue(task));
  assert.equal(worker.pending.length,0);assert.equal(invoked,false);
  const getter={};Object.defineProperty(getter,'begin',{get(){invoked=true;return {};},enumerable:true});
  assert.throws(()=>validateTask(getter),/accessors/);assert.equal(invoked,false);
});

test('loading static declarations never evaluates module imports or top-level side effects',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-static-task-'));
  try {
    const marker=path.join(dir,'executed');
    const file=path.join(dir,'evil.mjs');
    fs.writeFileSync(file,`import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)},'bad'); export default {begin:{tier:null}};`);
    await assert.rejects(loadTask(file),/only export default/);
    assert.equal(fs.existsSync(marker),false);
    const task={begin:{tier:null,code:'this.end(this.input)'}};
    fs.writeFileSync(file,'export default '+JSON.stringify(task)+';');
    assert.deepEqual(await loadTask(file),task);
    const json=path.join(dir,'task.json');fs.writeFileSync(json,JSON.stringify(task));
    assert.deepEqual(await loadTask(json),task);
    fs.writeFileSync(file,'export default (() => '+JSON.stringify(task)+')();');
    await assert.rejects(loadTask(file),SyntaxError);
  } finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('compiled tasks use only the new schema; stale legacy modules are never reused',async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-compile-contract-'));
  try {
    const bad={json:async()=>({ok:true,json:{start:'begin',phases:{begin:{tier:null}}}})};
    await assert.rejects(compileTask('sample',{home,client:bad}),/direct phase map/);
    assert.equal(fs.readdirSync(path.join(home,'tasks')).length,0);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
