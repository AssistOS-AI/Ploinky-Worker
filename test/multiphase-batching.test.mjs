import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Pworker,validateTask} from '../lib/pworker/task.mjs';
const inputs=o=>JSON.parse(o.prompt.slice(o.prompt.lastIndexOf('\n')+1));
const respond=(o,fn)=>({ok:true,status:200,json:{results:Object.fromEntries(inputs(o).map(r=>[r.id,fn(r.input)]))}});
function pipeline(prefix='Transform',batchedJudge=true){return {
 begin:{tier:'small',batch:true,template:prefix+'\n${input}',code:'this.raw=result; this.next("convert")'},
 convert:{tier:null,code:'if(this.raw==="INVALID") throw new Error("Invalid intermediate result"); this.localTrace=["convert:"+this.input]; this.pair={source:this.input,candidate:this.raw}; this.next("judge")'},
 judge:{tier:'best',batch:batchedJudge,template:'Review\n${pair}',code:'this.review=result;',next:'finish'
},
 finish:{tier:null,code:'this.localTrace.push("finish:"+this.input); this.end({source:this.input,raw:this.raw,judgment:this.review,localTrace:this.localTrace})'}
};}

test('BATCH begin -> INDIVIDUAL convert -> BATCH judge -> INDIVIDUAL finish: one flush, ten isolated states',async()=>{
 const calls=[];const fake={json:async o=>{calls.push(o);return respond(o,x=>o.tier==='small'?'converted:'+x:{same:x.candidate==='converted:'+x.source});}};
 const w=new Pworker({client:fake,config:{batching:{small:{enabled:true},best:{enabled:true}},taskExecution:{batchScheduling:'wave',request:{cache:'use',noFallback:true}}}});
 for(let i=0;i<10;i++)w.enqueue(pipeline(),'source-'+i);
 assert.equal(calls.length,0);assert.equal(w.pending.length,10);
 const results=await w.flush();
 assert.deepEqual(calls.map(o=>[o.tier,o.batchSize]),[['small',10],['best',10]]);
 assert.ok(calls.every(o=>o.cache==='use'&&o.noFallback===true&&o.maxTokens===undefined));
 results.forEach((r,i)=>{assert.equal(r.ok,true,r.error);assert.equal(r.steps,4);assert.deepEqual(r.value,{source:'source-'+i,raw:'converted:source-'+i,judgment:{same:true},localTrace:['convert:source-'+i,'finish:source-'+i]});assert.equal(r.responses.length,2);});
});

test('different first prompts and staggered results still batch compatible later phases',async()=>{
 const calls=[];
 const w=new Pworker({client:{json:async o=>{calls.push(o);if(o.prompt.startsWith('Slow'))await new Promise(r=>setTimeout(r,25));return respond(o,x=>o.tier==='small'?'converted:'+x:{same:true});}},config:{batching:{small:{enabled:true},best:{enabled:true,windowMs:100}}}});
 for(let i=0;i<6;i++)w.enqueue(pipeline(i<3?'Fast':'Slow'),String(i));
 const results=await w.flush();assert.ok(results.every(r=>r.ok));
 assert.equal(calls.filter(o=>o.tier==='small').length,2);
 const judgments=calls.filter(o=>o.tier==='best');assert.equal(judgments.reduce((s,o)=>s+o.batchSize,0),6);
 assert.ok(judgments.every(o=>o.batchSize>=3));
});

test('local failure skips only that item and nonbatchable review remains independent',async()=>{
 const calls=[];
 const fake={json:async o=>{calls.push(o);return respond(o,x=>x==='bad'?'INVALID':'converted:'+x);},chat:async o=>{calls.push(o);return {ok:true,text:'reviewed'};}};
 const w=new Pworker({client:fake,config:{taskExecution:{batchScheduling:'wave'},batching:{small:{enabled:true},best:{enabled:true}}}});
 for(const x of ['one','bad','two'])w.enqueue(pipeline('Transform',false),x);
 const results=await w.flush();assert.deepEqual(results.map(r=>r.ok),[true,false,true]);
 assert.match(results[1].error,/Invalid intermediate/);assert.equal(calls.filter(o=>o.tier==='best').length,2);
});


test('recovered invalid batches continue through individual conversion, batched review and finish',async()=>{
 const calls=[];let broken=true;
 const fake={json:async o=>{calls.push(o);if(broken){broken=false;return {ok:true,status:200,json:{results:{unexpected:'bad'}}};}return respond(o,x=>o.tier==='small'?'converted:'+x:{same:true});},chat:async o=>({ok:true,status:200,text:'converted:'+o.prompt.split('\n').at(-1)})};
 const w=new Pworker({client:fake,config:{taskExecution:{batchScheduling:'wave'},batching:{small:{enabled:true},best:{enabled:true}}}});
 for(let i=0;i<4;i++)w.enqueue(pipeline(),'source-'+i);
 const results=await w.flush();
 assert.ok(results.every(r=>r.ok),JSON.stringify(results.map(r=>r.error)));
 results.forEach((r,i)=>{assert.equal(r.steps,4);assert.equal(r.value.source,'source-'+i);assert.deepEqual(r.value.localTrace,['convert:source-'+i,'finish:source-'+i]);});
 assert.equal(calls.filter(c=>c.tier==='small').length,3);
 assert.equal(calls.filter(c=>c.tier==='best').length,1);
});

test('mixed conditional branches batch only members that actually enter repair, then rejudge only them',async()=>{
 const calls=[];
 const task={
  begin:{tier:'shared',batch:true,template:'Generate\n${input}',code:'this.candidate=result;',next:'check'},
  check:{tier:null,code:'this.trace=["check"]; if(this.input.localAccept) this.next("finish"); else this.next("judge");',next:'repair'},
  judge:{tier:'shared',batch:true,template:'Judge\n${candidate}',code:'this.verdict=result; this.trace.push("judge");',next:'review'},
  review:{tier:null,code:'if(this.verdict==="bad" && !this.repaired) this.next("repair"); else this.next("finish");',next:'repair'},
  repair:{tier:'shared',batch:true,template:'Repair\n${candidate}',code:'this.candidate=result;this.repaired=true;this.trace.push("repair");',next:'judge'},
  finish:{tier:null,code:'this.end({id:this.input.id,trace:this.trace,repaired:this.repaired??false});'}
 };
 const fake={json:async o=>{
  const phase=o.prompt.split('\n')[0],items=inputs(o);calls.push({phase,ids:items.map(x=>x.input.id).sort((a,b)=>a-b)});
  return respond(o,x=>phase==='Generate'?{id:x.id,fixed:false}:phase==='Repair'?{id:x.id,fixed:true}:x.id===5?'uncertain':!x.fixed&&[2,3].includes(x.id)?'bad':'good');
 }};
 const worker=new Pworker({client:fake,config:{taskExecution:{batchScheduling:'wave'},batching:{shared:{enabled:true}}}});
 for(let id=0;id<6;id++)worker.enqueue(task,{input:{id,localAccept:[0,4].includes(id)}});
 assert.equal(calls.length,0);const results=await worker.flush();
 assert.ok(results.every(r=>r.ok),JSON.stringify(results.map(r=>r.error)));
 assert.deepEqual(calls,[{phase:'Generate',ids:[0,1,2,3,4,5]},{phase:'Judge',ids:[1,2,3,5]},{phase:'Repair',ids:[2,3]},{phase:'Judge',ids:[2,3]}]);
 for(const r of results){assert.equal(r.value.repaired,[2,3].includes(r.value.id));assert.equal(r.value.trace.filter(x=>x==='repair').length,[2,3].includes(r.value.id)?1:0);}
});

test('wave scheduling waits for slower current model phases before batching the next ready phase', {timeout:5000},async()=>{
 const calls=[];let release,started;
 const gate=new Promise(r=>{release=r;});const slowStarted=new Promise(r=>{started=r;});
 const fake={json:async o=>{
  calls.push({tier:o.tier,size:o.batchSize});
  if(o.prompt.startsWith('Slow')){started();await gate;}
  return respond(o,x=>o.tier==='small'?'converted:'+x:{same:true});
 }};
 const worker=new Pworker({client:fake,config:{taskExecution:{batchScheduling:'wave'},batching:{small:{enabled:true},best:{enabled:true,windowMs:1,maxWaitMs:2}}}});
 for(let i=0;i<4;i++)worker.enqueue(pipeline(i<2?'Fast':'Slow'),String(i));
 const pending=worker.flush();await slowStarted;
 await new Promise(r=>setTimeout(r,40));
 try{assert.equal(calls.filter(x=>x.tier==='best').length,0,'a collection timeout must not bypass the run barrier');}finally{release();}
 const rows=await pending;assert.ok(rows.every(r=>r.ok));
 assert.deepEqual(calls.filter(x=>x.tier==='best'),[{tier:'best',size:4}]);
});

test('a blocked wave in one flush does not block an independent flush', {timeout:5000},async()=>{
 let release,started;const gate=new Promise(r=>release=r),slowStarted=new Promise(r=>started=r);
 const worker=new Pworker({client:{json:async o=>{if(o.prompt.startsWith('Slow')){started();await gate;}return respond(o,x=>o.tier==='small'?'converted:'+x:{same:true});}},config:{taskExecution:{batchScheduling:'wave'},batching:{small:{enabled:true},best:{enabled:true}}}});
 for(const x of ['a','b'])worker.enqueue(pipeline('Slow'),x);
 const first=worker.flush();await slowStarted;
 for(const x of ['c','d'])worker.enqueue(pipeline('Fast'),x);
 try{const second=await worker.flush();assert.ok(second.every(r=>r.ok));}finally{release();}
 assert.ok((await first).every(r=>r.ok));
});

test('compatible model phases share a batch while each task keeps its own code and next branch',async()=>{
 const calls=[];
 const base={begin:{tier:'shared',batch:true,template:'Generate\n${input}',code:'this.raw=result;',next:'finish'},finish:{tier:null,code:'this.end({id:this.input,kind:"baseline",raw:this.raw});'}};
 const extra={begin:{...base.begin,code:'this.raw="checked:"+result;',next:'review'},review:{tier:null,code:'this.end({id:this.input,kind:"reviewed",raw:this.raw});'}};
 const worker=new Pworker({client:{json:async o=>{calls.push(o);return respond(o,x=>'result:'+x);}},config:{taskExecution:{batchScheduling:'wave'},batching:{shared:{enabled:true}}}});
 for(let i=0;i<4;i++)worker.enqueue(i%2?extra:base,String(i));
 const rows=await worker.flush();assert.ok(rows.every(r=>r.ok));assert.equal(calls.length,1);assert.equal(calls[0].batchSize,4);
 rows.forEach((r,i)=>assert.deepEqual(r.value,{id:String(i),kind:i%2?'reviewed':'baseline',raw:(i%2?'checked:':'')+'result:'+i}));
});
