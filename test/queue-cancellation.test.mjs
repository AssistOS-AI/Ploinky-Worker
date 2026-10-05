import test from 'node:test';
import assert from 'node:assert/strict';
import {Limiter} from '../lib/limiter.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCore} from '../lib/core.mjs';
import {inprocFetch} from '../lib/inproc.mjs';

test('aborted queued work is removed without consuming a start or running its callback',async()=>{
  const limiter=new Limiter({maxConcurrent:1});
  let release;
  const first=limiter.schedule(()=>new Promise(resolve=>{release=resolve;}));
  await Promise.resolve();
  const abort=new AbortController();let invoked=false;
  const queued=limiter.schedule(()=>{invoked=true;},null,1,abort.signal);
  const rejection=assert.rejects(queued,{name:'AbortError'});
  assert.equal(limiter.depth,1);abort.abort();await rejection;
  assert.equal(limiter.depth,0);release();await first;
  assert.equal(invoked,false);assert.equal(limiter.starts.length,1);
});

test('a cancelled retry waiting behind a provider pause does not occupy the queue',async()=>{
  const limiter=new Limiter({maxConcurrent:2});limiter.pause(60000);
  const abort=new AbortController();
  const result=limiter.schedule(()=>assert.fail('Cancelled retry executed'),null,1,abort.signal);
  const rejection=assert.rejects(result,{name:'AbortError'});
  abort.abort();await rejection;
  assert.equal(limiter.depth,0);assert.equal(limiter.starts.length,0);
  await assert.rejects(limiter.schedule(()=>assert.fail(),null,1,abort.signal),{name:'AbortError'});
});

test('core cancellation removes a queued 429 retry without a second provider attempt',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'pworker-cancel-'));
  let calls=0;
  const core=createCore({dataDir,env:{},config:{defaultUpstream:'stub',upstreams:{stub:{baseUrl:'http://stub.local',noKey:true,limits:{maxConcurrent:1},retry:{max:4,baseMs:60000,maxWaitMs:60000}}}},
    fetchImpl:async url=>{if(url.endsWith('/v1/models'))return Response.json({data:[{id:'m'}]});calls++;return new Response('{"error":"busy"}',{status:429,headers:{'retry-after':'60','content-type':'application/json'}});}});
  const abort=new AbortController();
  const request=inprocFetch(core.handle)('http://pworker.local/v1/chat/completions',{method:'POST',headers:{'x-pworker-purpose':'test:cancel'},body:JSON.stringify({model:'m',messages:[{role:'user',content:'test'}]}),signal:abort.signal});
  const rejection=assert.rejects(request,{name:'AbortError'});
  try{
    for(let i=0;i<100&&core.limiters.stub.depth===0;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);assert.equal(core.limiters.stub.depth,1);
    abort.abort();await rejection;await new Promise(resolve=>setImmediate(resolve));
    assert.equal(core.limiters.stub.depth,0);assert.equal(calls,1);
    assert.equal(core.limiters.stub.starts.length,1);
  }finally{abort.abort();clearTimeout(core.limiters.stub.timer);fs.rmSync(dataDir,{recursive:true,force:true});}
});
