import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPworkerClient} from '../lib/client.mjs';

test('public client exposes phased tasks and no legacy execution methods',async()=>{
  const requests=[];
  const client=createPworkerClient({purpose:'test:client',url:'http://127.0.0.1:1',fetchImpl:async(url,init)=>{
    requests.push({url,body:init.body?JSON.parse(init.body):null});
    return new Response(JSON.stringify({id:'task-1',status:'queued'}),{status:202});
  }});
  for(const method of ['lambdas','call','runJob'])assert.equal(client[method],undefined);
  assert.notEqual(typeof client.run,'function'); // run is only a budget identity tag
  const task={begin:{tier:null,code:'this.end(this.input)'}};
  await client.task(task,{input:{input:'a'},wait:false});
  assert.deepEqual(requests[0].body,{task,input:{input:'a'},currentWorkingDirectory:null});
  assert.throws(()=>client.task({begin:{tier:null,code:()=>1}}),/JSON/);
  assert.equal(requests.length,1,'Reject functions before JSON serialization can drop them');
});

test('capacity waiting retries 429 without limit but fails a permanent 5xx after bounded retries', async () => {
  let calls = 0;
  const fail = createPworkerClient({ purpose: 'test:bounded', fetchImpl: async () => { calls += 1; return Response.json({ error: { type: 'proxy_error', message: 'bad base URL' } }, { status: 502 }); } });
  const r = await fail.chat({ model: 'm', waitForCapacity: true, retryPauseMs: 1, retries: 3 });
  assert.equal(r.ok, false); assert.equal(calls, 4);
  let n = 0;
  const busy = createPworkerClient({ purpose: 'test:bounded', fetchImpl: async () => (++n <= 6 ? Response.json({ error: { type: 'rate_limit' } }, { status: 429 }) : Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })) });
  const ok = await busy.chat({ model: 'm', waitForCapacity: true, retryPauseMs: 1, retries: 2 });
  assert.equal(ok.ok, true); assert.equal(n, 7);
});

test('extraBody never overrides the budget a retryCut raises', async () => {
  const budgets = [];
  const c = createPworkerClient({ purpose: 'test:cut', fetchImpl: async (url, init) => { const b = JSON.parse(init.body); budgets.push(b.max_tokens); return Response.json({ choices: [{ message: { content: 'x' }, finish_reason: budgets.length < 2 ? 'length' : 'stop' }] }); } });
  const r = await c.chat({ model: 'm', extraBody: { max_tokens: 100, top_p: 0.5 }, retryCut: true });
  assert.equal(r.ok, true); assert.deepEqual(budgets, [100, 400]);
});
