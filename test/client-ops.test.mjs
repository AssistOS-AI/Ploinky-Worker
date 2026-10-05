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
