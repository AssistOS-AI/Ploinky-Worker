import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProxy} from '../lib/core.mjs';
import {createPworkerClient} from '../lib/client.mjs';
import {Pworker,batchRequests} from '../lib/pworker/task.mjs';
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));

test('content IDs are independent of execution IDs and object key order, and preserve duplicates',()=>{
 const make=(id,input)=>({id,state:{input}});
 const a=batchRequests('prompt',[make('a',{x:1,y:2}),make('b',{x:1,y:2})],'input');
 const b=batchRequests('prompt',[make('new-a',{y:2,x:1}),make('new-b',{y:2,x:1})],'input');
 assert.deepEqual(a.map(x=>x.request),b.map(x=>x.request));
 assert.notEqual(a[0].request.id,a[1].request.id);
 assert.notEqual(a[0].request.id,batchRequests('different',[make('a',{x:1,y:2})],'input')[0].request.id);
});

test('a second flush with fresh task IDs hits the real proxy cache without another fake-provider call',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-batch-cache-'));let calls=0;
 const provider=http.createServer(async(req,res)=>{
  if(req.method==='GET'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({data:[{id:'fake-model'}]}));}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());calls++;
  const prompt=body.messages.at(-1).content;
  const entries=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
  const content=JSON.stringify({results:Object.fromEntries(entries.map(x=>[x.id,x.input]))});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({model:'fake-model',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10}}));
 });
 let proxy;
 try{
  const port=await listen(provider);
  proxy=createProxy({env:{},dataDir:dir,config:{defaultUpstream:'fake',upstreams:{fake:{baseUrl:`http://127.0.0.1:${port}`,noKey:true,formats:{openai:'/v1/chat/completions'}}},tiers:{small:[{upstream:'fake',model:'fake-model'}]}}});
  const client=createPworkerClient({url:`http://127.0.0.1:${await listen(proxy.server)}`,purpose:'test:batch-cache',autostart:false,env:{}});
  const run=async inputs=>{
   const worker=new Pworker({client,config:{batching:{small:{enabled:true}}}});
   for(const input of inputs)worker.enqueue({begin:{tier:'small',batch:true,template:'Echo\n${input}',code:'this.end(result);'}},{input});
   return worker.flush();
  };
  const first=await run([{a:1,b:2},'other',{a:1,b:2}]);
  const second=await run(['other',{b:2,a:1},{b:2,a:1}]);
  assert.equal(calls,1);
  assert.ok(first[0].responses[0].cacheKey);
  assert.equal(first[0].responses[0].cacheKey,second[0].responses[0].cacheKey);
  assert.ok(first.every(x=>x.ok&&!x.responses[0].cached));
  assert.ok(second.every(x=>x.ok&&x.responses[0].cached));
  assert.deepEqual(second.map(x=>x.value),['other',{a:1,b:2},{a:1,b:2}]);
  assert.equal(new Set([...first,...second].map(x=>x.id)).size,6);
 }finally{for(const s of [provider,proxy?.server]){s?.close();s?.closeAllConnections?.();}fs.rmSync(dir,{recursive:true,force:true});fs.rmSync(dir+'-cache',{recursive:true,force:true});fs.rmSync(dir+'-audit',{recursive:true,force:true});}
});
