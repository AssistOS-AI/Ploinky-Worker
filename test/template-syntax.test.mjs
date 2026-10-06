import './home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {batchTemplate, renderTemplate, validateTask, Pworker} from '../lib/pworker/task.mjs';

test('braced templates preserve literal dollar notation and dollars inside input', () => {
  const template = 'Reference: $x1. Math $x + 1$. INPUT: ${input}';
  assert.deepEqual(batchTemplate(template), {prefix:'Reference: $x1. Math $x + 1$. INPUT: ', variable:'input'});
  assert.equal(renderTemplate(template, {input:'literal ${secret} $e2'}), 'Reference: $x1. Math $x + 1$. INPUT: literal ${secret} $e2');
  assert.throws(() => renderTemplate(template, {}), /missing/);
  assert.equal(renderTemplate('${x} / ${x} / $x', {x: 7}), '7 / 7 / $x');
  assert.equal(batchTemplate('${x} ${input}'), null);
  assert.equal(batchTemplate('${input}\n'), null);
  assert.equal(renderTemplate('old: $input', {input:'works'}), 'old: $input');
  assert.equal(renderTemplate('$input$tail', {'input$tail':'legacy'}), '$input$tail');
  assert.equal(renderTemplate('${input} ${process.exit()}', {input:'safe'}), 'safe ${process.exit()}');
  validateTask({begin:{tier:'small', batch:true, template}});
});

test('braced template batches two inputs into one request with a literal prefix', async () => {
  const calls=[];
  const worker=new Pworker({client:{json:async ({prompt}) => {
    calls.push(prompt);
    const inputs=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
    const json={results:Object.fromEntries(inputs.map(x=>[x.id, 'answer '+x.input]))};
    return {ok:true,json,text:JSON.stringify(json)};
  }},config:{batching:{small:{enabled:true}}}});
  const task={begin:{tier:'small',batch:true,template:'Use reference a=$x1.\nINPUT DATA:\n${input}',code:'this.end(result)'}};
  worker.enqueue(task,'A');worker.enqueue(task,'B');
  const result=await worker.flush();
  assert.equal(calls.length,1);
  assert.match(calls[0], /a=\$x1/);
  assert.deepEqual(result.map(x=>x.value),['answer A','answer B']);
});
