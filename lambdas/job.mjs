// Built-in TaskLambda: run a job folder (job.json + prompt.md + plugins) with the job runner.
export default {
  name: 'job',
  description: 'Run an existing batch job folder (job.json, prompt.md, plugins) through the job runner: inputs, packing, tier ladder, checks and repair, decider, audit, budget, summary of at most 10 lines.',
  effects: ['runs-jobs', 'writes-external'],
  params: {
    dir: {type: 'string', min: 1, description: 'the job folder (absolute, or relative to the server working folder)'},
    stage: {type: 'string', required: false, description: 'run through this stage only (e.g. pilot)'},
  },
  run: (ctx) => ctx.jobs.runJob(ctx.params.dir, {stage: ctx.params.stage ?? null}),
};
