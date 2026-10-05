// TaskLambdas and TaskLambdaCalls: the registry of the server's TaskLambdas, effects, and the call folders (README.md "TaskLambdas").
import path from 'node:path';
import { pworkerHome, expandHome } from '../settings.mjs';
import { CallStore, CALL_DEFAULTS } from './calls.mjs';

export { CallStore, CallHandle, CALL_DEFAULTS, KEEP_ON_PRUNE, callStatus, modelRow, summarize, sha256, canonical, fileHash } from './calls.mjs';
export { EFFECT_KINDS, REFUSED_EFFECTS, effectsProblems, isPure, allows, requireEffect, EffectRefused, effectsUsedBy, inferredEffects } from './effects.mjs';
export { loadLambdas, validateParams, catalogOf, lambdaView, dirHash, freshImport, UNDECLARED_EFFECTS } from './registry.mjs';
export { importRunFolders } from './import.mjs';

/** The calls settings: CALL_DEFAULTS under the configuration's `calls` section (`dir` null means `<Ploinky Workers home>/calls`). */
export function callSettings(config = {}, env = process.env) {
  const c = { ...CALL_DEFAULTS, ...(config.calls ?? {}) };
  return { ...c, dir: path.resolve(c.dir ? expandHome(c.dir) : path.join(pworkerHome(env), 'calls')) };
}

/** The call store of a configuration, or of an explicit folder (`--calls DIR`). */
export function callStoreOf(config = {}, explicit = null, env = process.env) {
  const s = callSettings(config, env);
  return new CallStore(explicit ? path.resolve(explicit) : s.dir, { maxResultBytes: s.maxResultBytes, maxInputs: s.maxInputs }).ensure();
}
