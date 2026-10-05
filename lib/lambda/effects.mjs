// The effects of a TaskLambda: what a call may do besides computing its output. Every TaskLambda declares them (REQUIRED): either
// `['pure']`, or a list of effect kinds. The declaration is checked where Ploinky Workers can check it (the tools of the agent, the model
// client and the job functions given to a server TaskLambda refuse an undeclared effect) and decides result reuse: only a `pure`
// TaskLambda's output is reused for the same hash, parameters and input files; a call with effects is never replayed, only audited.
//
//   pure            no effect: the output depends only on the parameters and the files or attachments read (recorded with hashes)
//   writes-workdir  writes, moves or deletes files of the work folder (each one in the call's effects.jsonl, with before/after hashes)
//   model-calls     calls models through Ploinky Workers (each call in the call's models.jsonl)
//   runs-scripts    runs a declared script of an Agent Skill (trusted code; its own writes are not observed, the run is recorded)
//   runs-jobs       starts job runs or tasks (child calls)
//   writes-external writes outside the work folder and the call folder (a project store, a repository path); declared by trusted code
//   network         direct network access: none is allowed today, so a TaskLambda declaring it is refused
// A call always writes its own call folder (outputs, logs); that is not an effect.

export const EFFECT_KINDS = Object.freeze(['writes-workdir', 'model-calls', 'runs-scripts', 'runs-jobs', 'writes-external', 'network']);
export const REFUSED_EFFECTS = Object.freeze(['network']);

/** Problems of an effects declaration ([] when valid). */
export function effectsProblems(effects) {
  if (!Array.isArray(effects) || !effects.length || effects.some((e) => typeof e !== 'string')) return [`effects: a list, ['pure'] or kinds of ${EFFECT_KINDS.join(', ')}`];
  if (effects.includes('pure')) return effects.length === 1 ? [] : ["effects: 'pure' stands alone"];
  const p = [];
  for (const e of effects) {
    if (!EFFECT_KINDS.includes(e)) p.push(`effects: unknown kind ${JSON.stringify(e)} (pure, ${EFFECT_KINDS.join(', ')})`);
    else if (REFUSED_EFFECTS.includes(e)) p.push(`effects: ${e} is not allowed`);
  }
  if (new Set(effects).size !== effects.length) p.push('effects: a kind is listed twice');
  return p;
}

export const isPure = (effects) => Array.isArray(effects) && effects.length === 1 && effects[0] === 'pure';
export const allows = (effects, kind) => Array.isArray(effects) && effects.includes(kind);

export class EffectRefused extends Error {
  constructor(kind, what) { super(`${what} needs the effect ${kind}, which this TaskLambda does not declare (meta.effects)`); this.code = 'effect_refused'; this.kind = kind; }
}

/** Throws EffectRefused when `effects` lacks `kind`. */
export function requireEffect(effects, kind, what) { if (!allows(effects, kind)) throw new EffectRefused(kind, what); }

/**
 * The effects a lambda's code shows it uses (agent TaskLambdas, which reach the world only through `tools.*`): a declaration that
 * lacks one is refused before the code runs. Over-declaring is allowed.
 */
export function effectsUsedBy(code) {
  const s = String(code ?? '');
  const used = [];
  if (/\btools\s*\.\s*(write|move)\s*\(/.test(s)) used.push('writes-workdir');
  if (/\btools\s*\.\s*ask\s*\(/.test(s)) used.push('model-calls');
  if (/\btools\s*\.\s*runSkillScript\s*\(/.test(s)) used.push('runs-scripts');
  return used;
}

/** The declaration inferred from code (the migration of lambdas written before effects were required). */
export const inferredEffects = (code) => { const u = effectsUsedBy(code); return u.length ? u : ['pure']; };
