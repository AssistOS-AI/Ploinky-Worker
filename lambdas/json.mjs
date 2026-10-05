// Built-in TaskLambda: one call whose answer is a JSON object (extraction of a few fields, a classification with a reason).
export default {
  name: 'json',
  description: 'Ask one model tier for one JSON object (a few extracted fields, a classification with a reason) from a short instruction and optional short attachments.',
  effects: ['model-calls'],
  params: {
    prompt: {type: 'string', min: 1, max: 20000, description: 'the instruction, naming the JSON fields wanted'},
    tier: {type: 'string', enum: ['nano', 'micro', 'tiny', 'small', 'medium', 'good'], default: 'small', description: 'the model tier'},
  },
  async run(ctx) {
    const texts = [];
    for (const a of ctx.attachments) texts.push(`=== ${a.name} ===\n${(await ctx.readAttachment(a.name)).slice(0, 60000)}`);
    const r = await ctx.ta.json({tier: ctx.params.tier, system: 'Answer with one JSON object only.', prompt: [ctx.params.prompt, ...texts].join('\n\n'), maxTokens: 4000, temperature: 0, retryCut: true});
    if (!r.ok) return {status: 'failed', summary: `no JSON from ${ctx.params.tier}: ${r.reason}`};
    return {status: 'finished', summary: JSON.stringify(r.json).slice(0, 2000), json: r.json};
  },
};
