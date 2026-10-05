// Built-in TaskLambda: one chat call on a tier (a short question, a rewrite, a summary of the attached text).
export default {
  name: 'chat',
  description: 'Ask one model tier one question and return its answer as text (a short question, a rewrite, a summary of a short attached text). Not for batch work over many items.',
  effects: ['model-calls'],
  params: {
    prompt: {type: 'string', min: 1, max: 20000, description: 'the question or instruction'},
    tier: {type: 'string', enum: ['nano', 'micro', 'tiny', 'small', 'medium', 'good'], default: 'small', description: 'the model tier'},
    system: {type: 'string', max: 4000, required: false, description: 'an optional system instruction'},
    maxTokens: {type: 'integer', min: 16, max: 32000, default: 2000, description: 'the answer budget'},
  },
  async run(ctx) {
    const {prompt, tier, system, maxTokens} = ctx.params;
    const texts = [];
    for (const a of ctx.attachments) texts.push(`=== ${a.name} ===\n${(await ctx.readAttachment(a.name)).slice(0, 60000)}`);
    const r = await ctx.ta.chat({tier, system, prompt: texts.length ? `${prompt}\n\n${texts.join('\n\n')}` : prompt, maxTokens, temperature: 0, retryCut: true});
    if (!r.ok) return {status: 'failed', summary: `chat on ${tier} failed: ${r.reason}`};
    return {status: 'finished', summary: r.text.slice(0, 2000), text: r.text, served: r.served, cached: r.cached};
  },
};
