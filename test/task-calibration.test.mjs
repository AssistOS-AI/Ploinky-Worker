import test from 'node:test';
import assert from 'node:assert/strict';
import {Pworker,validateTask} from '../lib/pworker/task.mjs';
test('statement code may contain arrow callbacks', async()=>{
  const w=new Pworker({client:{}});
  w.enqueue({begin:{tier:null,code:'this.end([1,2].map(x => x + 1))'}});
  const [r]=await w.flush(); assert.equal(r.ok,true,r.error); assert.deepEqual(r.value,[2,3]);
});
test('different request budgets do not share a batch and request options reach client', async()=>{
  const calls=[];
  const w=new Pworker({client:{chat:async o=>{calls.push(o);return {ok:true,text:'ok'};}},config:{batching:{small:{enabled:true}}}});
  for(const maxTokens of [100,200]) w.enqueue({begin:{tier:'small',template:'Task $input',batch:true,request:{maxTokens,cache:'off',retryCut:false},code:'this.end(result)'}},'a');
  assert.ok((await w.flush()).every(r=>r.ok)); assert.deepEqual(calls.map(c=>c.maxTokens).sort(),[100,200]); assert.ok(calls.every(c=>c.cache==='off' && !c.retryCut));
});
test('extra batch IDs fail closed',async()=>{
  const w=new Pworker({client:{json:async()=>({ok:true,json:{results:{a:'a',b:'b',extra:'bad'}}})},config:{batching:{small:{enabled:true}}}});
  const t={begin:{tier:'small',template:'Task $input',batch:true}};
  w.enqueue(t,'a',{id:'a'});w.enqueue(t,'b',{id:'b'});
  assert.ok((await w.flush()).every(r=>!r.ok && /Unexpected/.test(r.error)));
});
test('a truncated but parseable response cannot become a successful task',async()=>{
  const w=new Pworker({client:{chat:async()=>({ok:true,text:'pos_likes(ada,tea).',cut:true})}});
  w.enqueue({begin:{tier:'small',template:'$input',request:{retryCut:false}}},'source');
  assert.match((await w.flush())[0].error,/truncated/);
  assert.throws(()=>validateTask({begin:{tier:'small',request:{maxTokens:-1}}}),/positive integer/);
});
