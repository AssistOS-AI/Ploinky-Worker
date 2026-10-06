import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pworker,parseTaskSource,formatMarkdownTask,loadTask} from '../lib/pworker/task.mjs';

test('Markdown preserves prompt and code exactly, including quotes, fences, whitespace and literal dollars',()=>{
 const prompt='Quoted "value", \\path, $event, ${input}\n```js\nexample\n```\n';
 const task={begin:{tier:'small',template:prompt,code:'const x = `quoted "${result}"`;\nthis.end(x);\n',request:{temperature:0},next:'finish'},finish:{tier:null,code:''}};
 const text=formatMarkdownTask(task);
 assert.match(text,/````text/);
 assert.deepEqual(parseTaskSource(text,'.md'),task);
 assert.deepEqual(parseTaskSource(text.replaceAll('\n','\r\n'),'.markdown'),task);
 assert.deepEqual(parseTaskSource(JSON.stringify(task),'.json'),task);
});

test('Markdown rejects ambiguous or executable declarations before execution',()=>{
 const bad=[
  '## begin\n### tier\nnull\n### tier\nsmall',
  '## begin\n## begin',
  '## begin\n### batch\nyes',
  '## begin\n### codeFile\nsecret.js',
  '## begin\n### code\n```js\nthis.end(1);',
  '## begin\n### code\n```text\nthis.end(1);\n```',
  '## begin\n### code\n```js\nthis.end(1);\n```\n### code\n```js\nthis.end(2);\n```',
  '## begin\n### request\n```json\n{broken}\n```',
  '## begin\n### next\nmissing',
  '# Task\nprocess.exit(1)',
  '## begin\n### code\n```js\nfunction(){return 1}\n```'
 ];
 for(const source of bad)assert.throws(()=>parseTaskSource(source,'.md'),undefined,source);
});

test('Markdown four-phase tasks batch two model phases around individual imported code with isolated state',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-markdown-'));
 const calls=[];
 try{
  fs.writeFileSync(path.join(dir,'transform.mjs'),'let count=0; export function pair(source,candidate){return {source,candidate,count:++count};}');
  const task={
   begin:{tier:'small',batch:true,template:'Transform\n${input}',code:'this.raw=result;',next:'convert'},
   convert:{tier:null,code:'const {pair}=await import("./transform.mjs"); this.pair=pair(this.input,this.raw);',next:'judge'},
   judge:{tier:'best',batch:true,template:'Judge\n${pair}',code:'this.review=result;',next:'finish'},
   finish:{tier:null,code:'this.end({pair:this.pair,review:this.review});'}
  };
  const file=path.join(dir,'task.md');fs.writeFileSync(file,formatMarkdownTask(task));
  assert.deepEqual(await loadTask(file),task);
  const fake={json:async o=>{calls.push(o);const inputs=JSON.parse(o.prompt.slice(o.prompt.lastIndexOf('\n')+1));return {ok:true,json:{results:Object.fromEntries(inputs.map(x=>[x.id,o.tier==='small'?'converted:'+x.input:x.input.candidate==='converted:'+x.input.source]))}};}};
  const worker=new Pworker({client:fake,config:{batching:{small:{enabled:true},best:{enabled:true}}}});
  for(let i=0;i<10;i++)await worker.enqueueRequest(file,'item-'+i,{currentWorkingDirectory:dir});
  assert.equal(calls.length,0);
  const results=await worker.flush();
  assert.deepEqual(calls.map(x=>[x.tier,x.batchSize]),[['small',10],['best',10]]);
  results.forEach((r,i)=>{assert.equal(r.ok,true,r.error);assert.equal(r.steps,4);assert.deepEqual(r.value,{pair:{source:'item-'+i,candidate:'converted:item-'+i,count:1},review:true});});
  await assert.rejects(worker.enqueueRequest(path.join(dir,'missing.md')),/does not exist/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('compact field headings accept optional spaces and reject duplicate or ambiguous values',()=>{
 const source='## begin\n### tier:null\n###next:finish\n## finish\n###tier:null';
 assert.deepEqual(parseTaskSource(source,'.md'),{begin:{tier:null,next:'finish'},finish:{tier:null}});
 assert.match(formatMarkdownTask({begin:{tier:null}}),/### tier:null/);
 assert.throws(()=>parseTaskSource('## begin\n### tier:null\n### tier:small','.md'),/duplicate/);
 assert.throws(()=>parseTaskSource('## begin\n### batch:maybe','.md'),/true or false/);
});
