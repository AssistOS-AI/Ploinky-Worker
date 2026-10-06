import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pworker,validateTask} from '../lib/pworker/task.mjs';

async function execute(dir,code,config={}) {
 const worker=new Pworker({client:{},config});
 worker.enqueue({begin:{tier:null,code}},'value',{currentWorkingDirectory:dir});
 return (await worker.flush())[0];
}

test('explicit phase imports support static dependencies and nested dynamic imports in an isolated module context',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-import-'));
 try{
  fs.mkdirSync(path.join(dir,'lib'));
  fs.writeFileSync(path.join(dir,'lib/value.mjs'),'export const value=3;');
  fs.writeFileSync(path.join(dir,'lib/convert.mjs'),'import {value} from "./value.mjs"; let count=0; export function convert(input){ return {text:input.toUpperCase(), value, count:++count}; }');
  fs.writeFileSync(path.join(dir,'lib/dynamic.mjs'),'const {value}=await import("./value.mjs"); export const doubled=value*2;');
  const code='const {convert}=await import("./lib/convert.mjs"); const {doubled}=await import("./lib/dynamic.mjs"); this.end({...convert(this.input), doubled});';
  const worker=new Pworker({client:{}});
  for(let i=0;i<3;i++)worker.enqueue({begin:{tier:null,code}},'value'+i,{currentWorkingDirectory:dir});
  const results=await worker.flush();
  results.forEach((r,i)=>{assert.equal(r.ok,true,r.error);assert.deepEqual(r.value,{text:'VALUE'+i,value:3,count:1,doubled:6});});
  const limited=await execute(dir,code,{taskExecution:{sandbox:{maxModules:1}}});
  assert.equal(limited.ok,false);assert.match(limited.error,/module limit/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('imports reject host capabilities, path and symlink escapes, and keep rejected errors in the sandbox realm',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-import-'));
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-outside-'));
 try{
  fs.writeFileSync(path.join(outside,'secret.mjs'),'export const secret="outside";');
  fs.symlinkSync(path.join(outside,'secret.mjs'),path.join(dir,'link.mjs'));
  fs.writeFileSync(path.join(dir,'host.mjs'),'export const leak=process.env;');
  fs.writeFileSync(path.join(dir,'nested.mjs'),'import fs from "node:fs"; export const leak=fs;');
  for(const specifier of ['node:fs','fs','https://example.com/a.mjs','../secret.mjs','./link.mjs','./host.mjs','./nested.mjs']){
   const r=await execute(dir,`await import(${JSON.stringify(specifier)}); this.end('escaped');`);
   assert.equal(r.ok,false,specifier);
  }
  const r=await execute(dir,`try { await import('node:fs'); } catch(error) { try { this.end(error.constructor.constructor('return process')().env); } catch { this.end('confined'); } }`);
  assert.equal(r.value,'confined');
  assert.equal((await execute(null,'await import("./library.mjs");')).ok,false);
  assert.throws(()=>validateTask({begin:{tier:null,codeFile:'convert.js'}}),/unsupported phase field codeFile/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
});
