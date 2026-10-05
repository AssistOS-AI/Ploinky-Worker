// Built-in TaskLambda: a task over attached files, planned over the template library (or with a named template).
export default {
  name: 'task',
  description: 'Work over large attached files with instructions: the task planner chooses a template of the template library and its parameters, then the runner executes it (chunking, tiers, checks, budget).',
  effects: ['runs-jobs', 'writes-external'],
  params: {
    instructions: {type: 'string', min: 1, max: 4000, description: 'what to do with the attachments'},
    target: {type: 'string', default: 'none', description: 'where results go: none, memory:<id> or session:<id>'},
  },
  run(ctx) {
    const [kind, ...id] = String(ctx.params.target).split(':');
    return ctx.jobs.runTask({instructions: ctx.params.instructions, attachments: ctx.attachments, target: {kind, id: id.join(':') || null}});
  },
};
