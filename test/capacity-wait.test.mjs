import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createPworkerServer} from '../lib/server.mjs';
import {createPworkerClient} from '../lib/client.mjs';
import {Pworker} from '../lib/pworker/task.mjs';

const answer=()=>Response.json({choices:[{message:{content:'ready'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}});
const configFor=root=>({taskHome:root,dataDir:path.join(root,'data'),defaultUpstream:'stub',upstreams:{stub:{baseUrl:'http://stub.local',noKey:true,limits:{maxConcurrent:1},retry:{max:0,max5xx:0,baseMs:1,maxWaitMs:1}}},tiers:{small:[{upstream:'stub',model:'m'}]}});
const task={begin:{tier:null,code:'await this.writeFile("marker.txt",this.input);this.next("model")'},model:{tier:'small',template:'$input',request:{timeoutMs:20,retryCut:false},code:'this.end(result)'}};
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));

test('429 waits beyond retry count and model deadline, then completes the same task',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-capacity-'));let attempts=0;
  const server=await createPworkerServer({config:configFor(root),env:{},coreOptions:{fetchImpl:async url=>{
    if(url.endsWith('/v1/models'))return Response.json({data:[{id:'m'}]});
    attempts++;return attempts<=3?Response.json({error:'busy'},{status:429,headers:{'retry-after':'0.05'}}):answer();
  }}});
  try{
    const addr=await server.listen(0),client=createPworkerClient({url:`http://127.0.0.1:${addr.port}`,purpose:'test:capacity',autostart:false});
    const start=Date.now();const row=await client.task(task,{input:'source',currentWorkingDirectory:root,pollSeconds:1});
    assert.equal(row.status,'finished');assert.equal(row.result.value,'ready');
    assert.equal(attempts,4);assert.ok(Date.now()-start>=150);
    assert.equal(row.steps,2,'Rate retries must not count as new task phases');
    assert.equal(server.core.monitor.records.filter(r=>r.status===429).length,3);
  }finally{await server.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('restart preserves a waiting checkpoint and cooldown without replaying earlier file phases',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-recover-')),config=configFor(root);let firstCalls=0,secondCalls=0;
  let first,second;
  try{
    first=await createPworkerServer({config,env:{},coreOptions:{fetchImpl:async url=>{
      if(url.endsWith('/v1/models'))return Response.json({data:[{id:'m'}]});firstCalls++;
      return Response.json({error:'busy'},{status:429,headers:{'retry-after':'0.4'}});
    }}});
    let addr=await first.listen(0);let client=createPworkerClient({url:`http://127.0.0.1:${addr.port}`,purpose:'test:recover',autostart:false});
    const row=await client.task(task,{input:'source',currentWorkingDirectory:root,wait:false});
    for(let i=0;i<100&&!first.core.monitor.records.some(r=>r.status===429);i++)await tick();
    assert.equal(firstCalls,1);
    const pending=first.ops.store.read(row.id);assert.equal(pending.status,'waiting');assert.equal(pending.checkpoint.phase,'model');
    const cooldown=first.core.limiters.stub.pausedUntil;
    await first.close();fs.writeFileSync(path.join(root,'marker.txt'),'must not overwrite');
    second=await createPworkerServer({config,env:{},coreOptions:{fetchImpl:async url=>{
      if(url.endsWith('/v1/models'))return Response.json({data:[{id:'m'}]});secondCalls++;assert.ok(Date.now()>=cooldown);return answer();
    }}});
    addr=await second.listen(0);client=createPworkerClient({url:`http://127.0.0.1:${addr.port}`,purpose:'test:recover',autostart:false});
    const done=await client.waitOp(row.id,{pollSeconds:1});
    assert.equal(done.status,'finished');assert.equal(done.result.value,'ready');assert.equal(done.steps,2);
    assert.equal(secondCalls,1);assert.equal(fs.readFileSync(path.join(root,'marker.txt'),'utf8'),'must not overwrite');
  }finally{await first?.close();await second?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('permanent authorization errors still fail; waiting is not infinite retry of invalid credentials',async()=>{
  let calls=0;const client=createPworkerClient({purpose:'test:auth',fetchImpl:async()=>{calls++;return Response.json({error:{type:'authentication_error'}},{status:401});}});
  const result=await client.chat({model:'m',waitForCapacity:true});
  assert.equal(result.ok,false);assert.equal(result.status,401);assert.equal(calls,1);
});

test('a finished task publishes its result while a different task still waits',async()=>{
  let release;const events=[];
  const worker=new Pworker({onProgress:e=>events.push(e),client:{chat:()=>new Promise(resolve=>{release=resolve;})}});
  worker.enqueue({begin:{tier:null,code:'this.end(42)'}},{},{id:'fast'});
  worker.enqueue({begin:{tier:'small',template:'test'}},{},{id:'slow'});
  const run=worker.flush();
  for(let i=0;i<100&&!events.some(e=>e.id==='fast'&&e.status==='completed');i++)await tick();
  assert.equal(events.find(e=>e.id==='fast'&&e.status==='completed')?.result.value,42);
  assert.ok(events.some(e=>e.id==='slow'&&e.status==='waiting'));
  release({ok:true,text:'ready'});await run;
});

test('cancelling one batched task does not cancel or execute the wrong task',async()=>{
  let release,signal;const events=[];
  const worker=new Pworker({config:{batching:{small:{enabled:true}}},onProgress:e=>events.push(e),client:{json:o=>{signal=o.signal;return new Promise(resolve=>{release=resolve;});}}});
  const t={begin:{tier:'small',template:'Task $input',batch:true,code:'this.end(result)'}};
  worker.enqueue(t,'a',{id:'a'});worker.enqueue(t,'b',{id:'b'});const run=worker.flush();
  assert.equal(worker.cancel('a'),true);assert.equal(signal.aborted,false);
  release({ok:true,json:{results:{a:'ignored',b:'kept'}}});
  const results=await run;assert.equal(results.find(r=>r.id==='a').ok,false);assert.equal(results.find(r=>r.id==='b').value,'kept');
  assert.equal(events.filter(e=>e.id==='a'&&e.status==='cancelled').length,1);
});

test('HTTP cancellation removes a waiting task and prevents restart recovery',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-cancel-task-'));let calls=0;
  const server=await createPworkerServer({config:configFor(root),env:{},coreOptions:{fetchImpl:async url=>{
    if(url.endsWith('/v1/models'))return Response.json({data:[{id:'m'}]});calls++;return Response.json({error:'busy'},{status:429,headers:{'retry-after':'60'}});
  }}});
  try{
    const addr=await server.listen(0),client=createPworkerClient({url:`http://127.0.0.1:${addr.port}`,purpose:'test:cancel',autostart:false});
    const row=await client.task({begin:task.model},{input:'source',wait:false});
    for(let i=0;i<100&&!server.core.limiters.stub.depth;i++)await tick();
    assert.equal(calls,1);assert.equal((await client.cancelTask(row.id)).status,'cancelled');
    await tick();assert.equal(server.core.limiters.stub.depth,0);
    const saved=server.ops.store.read(row.id);assert.equal(saved.checkpoint,null);assert.equal(saved.status,'cancelled');
  }finally{await server.close();fs.rmSync(root,{recursive:true,force:true});}
});
