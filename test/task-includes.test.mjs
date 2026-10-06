import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pworker,expandTaskIncludes,batchTemplate,batchRequests} from '../lib/pworker/task.mjs';
const task={begin:{tier:'small',batch:true,template:'${{prompts/rules.md}}\nData:\n${input}',code:'this.end(result);'}};
test('constant nested includes expand before batching, freeze at enqueue and never expand input data',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pw-includes-'));
 try{
  fs.mkdirSync(path.join(dir,'prompts'));fs.writeFileSync(path.join(dir,'prompts/rules.md'),'Rules $event\n${{common.txt}}');fs.writeFileSync(path.join(dir,'prompts/common.txt'),'Common');
  const calls=[];const client={json:async o=>{calls.push(o);const input=JSON.parse(o.prompt.split('\n').at(-1));return {ok:true,json:{results:Object.fromEntries(input.map(r=>[r.id,r.input]))}};}};
  const w=new Pworker({client,config:{batching:{small:{enabled:true}}}});
  w.enqueue(task,{input:'${{secret}}'},{currentWorkingDirectory:dir});w.enqueue(task,{input:'b'},{currentWorkingDirectory:dir});
  fs.writeFileSync(path.join(dir,'prompts/common.txt'),'Changed');
  const rows=await w.flush();assert.ok(rows.every(r=>r.ok));assert.equal(calls.length,1);assert.match(calls[0].prompt,/Rules \$event\nCommon/);assert.doesNotMatch(calls[0].prompt,/Changed/);assert.equal(rows[0].value,'${{secret}}');
  const a=batchTemplate(expandTaskIncludes(task,{currentWorkingDirectory:dir}).begin.template);
  fs.writeFileSync(path.join(dir,'prompts/common.txt'),'Third');
  const b=batchTemplate(expandTaskIncludes(task,{currentWorkingDirectory:dir}).begin.template);
  assert.notEqual(batchRequests(a.prefix,[{state:{input:'same'}}],'input')[0].request.id,batchRequests(b.prefix,[{state:{input:'same'}}],'input')[0].request.id);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('includes reject cycles, variable content, missing files, path escapes and escaping symlinks',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pw-includes-'));
 const expand=template=>expandTaskIncludes({begin:{template}},{currentWorkingDirectory:dir});
 try{
  fs.writeFileSync(path.join(dir,'a'),'${{b}}');fs.writeFileSync(path.join(dir,'b'),'${{a}}');assert.throws(()=>expand('${{a}}'),/Cyclic/);
  fs.writeFileSync(path.join(dir,'a'),'${input}');assert.throws(()=>expand('${{a}}'),/constant/);
  assert.throws(()=>expand('${{missing}}'));assert.throws(()=>expand('${{../outside}}'),/outside/);
  fs.symlinkSync(os.tmpdir(),path.join(dir,'escape'));assert.throws(()=>expand('${{escape/outside}}'),/symbolic link/);
  assert.throws(()=>expandTaskIncludes(task),/currentWorkingDirectory/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('same include path with different workspace contents makes distinct batch prefixes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pw-include-workspaces-'));
 try{
  const dirs=['first','second'].map(name=>{const dir=path.join(root,name);fs.mkdirSync(path.join(dir,'prompts'),{recursive:true});fs.writeFileSync(path.join(dir,'prompts/rules.md'),name);return dir;});
  const calls=[];
  const worker=new Pworker({client:{json:async o=>{
   calls.push(o.prompt);const inputs=JSON.parse(o.prompt.split('\n').at(-1));
   return {ok:true,json:{results:Object.fromEntries(inputs.map(r=>[r.id,r.input]))}};
  }},config:{batching:{small:{enabled:true}}}});
  for(const currentWorkingDirectory of dirs)for(const input of ['a','b'])worker.enqueue(task,{input},{currentWorkingDirectory});
  assert.ok((await worker.flush()).every(r=>r.ok));assert.equal(calls.length,2);
  assert.ok(calls.some(p=>p.startsWith('first')));assert.ok(calls.some(p=>p.startsWith('second')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
