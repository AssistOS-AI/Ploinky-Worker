import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Pworker} from '../lib/pworker/task.mjs';
import {modelBudget,conservativeTokens} from '../lib/pworker/model-budget.mjs';
const config=(contextTokens=1000000)=>({providers:{fake:{modelLimits:{large:{contextTokens,maxOutputTokens:400,defaultOutputTokens:400}}}},tiers:{small:[{upstream:'fake',model:'large'}]},taskExecution:{batchScheduling:'wave',request:{noFallback:true}},batching:{small:{enabled:true}}});
const task=(prefix='Rules')=>({begin:{tier:'small',batch:true,template:prefix+'\n${input}',code:'this.end(result);'}});
const client=calls=>({json:async o=>{calls.push(o);return {ok:true,json:{results:Object.fromEntries(JSON.parse(o.prompt.split('\n').at(-1)).map(x=>[x.id,x.input]))}};},chat:async o=>{calls.push(o);return {ok:true,text:o.prompt.split('\n').at(-1)};}});
test('known model capabilities batch more than twenty inputs without a legacy character cap',async()=>{
 const calls=[],w=new Pworker({client:client(calls),config:config()});for(let i=0;i<40;i++)w.enqueue(task(),{input:'input-'+i+'x'.repeat(1000)});
 const rows=await w.flush();assert.ok(rows.every(r=>r.ok));assert.equal(calls.length,1);assert.equal(calls[0].batchSize,40);
 assert.equal(rows[0].responses[0].modelBudget.contextTokens,1000000);
});
test('model budget includes instructions, batch envelope and output reserve while preserving entire inputs',async()=>{
 const calls=[],cfg=config(1700),w=new Pworker({client:client(calls),config:cfg});const inputs=Array.from({length:8},(_,i)=>'full-file-'+i+':'+('é'.repeat(100)));
 for(const input of inputs)w.enqueue(task('Rules '.repeat(25)),{input});const rows=await w.flush();assert.ok(rows.every(r=>r.ok));assert.ok(calls.length>1);
 for(const o of calls)assert.ok(conservativeTokens(o.prompt)<=modelBudget(cfg,'small').inputBudgetTokens);
 assert.deepEqual(rows.map(r=>r.value),inputs);
});
test('an oversized indivisible file fails without a provider call or splitting its content',async()=>{
 const calls=[],w=new Pworker({client:client(calls),config:config(700)});w.enqueue(task(),{input:'x'.repeat(900)});
 const [row]=await w.flush();assert.equal(row.ok,false);assert.match(row.error,/never split/);assert.equal(calls.length,0);
});
test('capability validation rejects impossible output budgets',()=>{
 assert.throws(()=>modelBudget(config(),'small',{maxTokens:401}),/exceeds/);
 assert.throws(()=>modelBudget(config(200),'small'),/exceeds/);
});
