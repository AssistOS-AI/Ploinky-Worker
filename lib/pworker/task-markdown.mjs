// A deliberately small Markdown declaration grammar, not a general Markdown evaluator.
// Task sources are data. Only the executor evaluates phase.code in its sandbox.
const ID = '[A-Za-z_$][\\w$]*';
const phaseHeading = new RegExp('^## (' + ID + ')\\s*$');

export function parseMarkdownTask(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const task = {};
  let phase = null, titleSeen = false;
  const fail = (i, message) => { throw new Error(`Markdown task line ${i + 1}: ${message}`); };
  const set = (i, key, value) => {
    if (Object.hasOwn(phase, key)) fail(i, `duplicate field ${key}`);
    Object.defineProperty(phase, key, {value, enumerable:true, writable:true, configurable:true});
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^# [^#]/.test(line) && !phase && !titleSeen) { titleSeen = true; continue; }
    const heading = line.match(phaseHeading);
    if (heading) {
      if (Object.hasOwn(task, heading[1])) fail(i, `duplicate phase ${heading[1]}`);
      phase = {};
      Object.defineProperty(task, heading[1], {value:phase, enumerable:true, writable:true, configurable:true});
      continue;
    }
    if (!phase) fail(i, 'expected a phase heading: ## begin');
    const section = line.match(/^###\s*(tier|batch|next|template|code|request)(?:\s*:\s*(.*))?\s*$/);
    if (!section) fail(i, 'unexpected text or unsupported field');
    const key = section[1], sectionLine = i;
    if(section[2]===undefined)while (i + 1 < lines.length && !lines[i + 1].trim()) i++;
    if (['tier','batch','next'].includes(key)) {
      const raw = section[2]!==undefined?section[2].trim():(lines[++i] ?? '').trim();
      let value;
      if (key === 'batch') {
        if (!['true','false'].includes(raw)) fail(i, 'batch must be true or false');
        value = raw === 'true';
      } else if (key === 'tier' && raw === 'null') value = null;
      else if (raw.startsWith('"')) {
        try { value = JSON.parse(raw); } catch { fail(i, 'invalid quoted setting'); }
        if (typeof value !== 'string') fail(i, 'expected a string setting');
      } else {
        if (!new RegExp('^' + ID + '$').test(raw)) fail(i, 'expected a name or quoted string');
        value = raw;
      }
      set(sectionLine, key, value); continue;
    }
    if(section[2]!==undefined)fail(sectionLine,'multiline fields require a fenced block');
    const fence = (lines[++i] ?? '').match(/^(`{3,}|~{3,})([a-z]*)\s*$/);
    if (!fence) fail(i, 'expected a fenced block');
    const languages = {template:['text',''], code:['js','javascript'], request:['json']};
    if (!languages[key].includes(fence[2])) fail(i, `invalid fence language for ${key}`);
    const close = new RegExp('^' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
    const content = [];
    for (i++; i < lines.length && !close.test(lines[i]); i++) content.push(lines[i]);
    if (i >= lines.length) fail(sectionLine, 'unclosed fenced block');
    let value = content.join('\n');
    if (key === 'request') { try { value = JSON.parse(value); } catch { fail(sectionLine, 'request must contain JSON'); } }
    set(sectionLine, key, value);
  }
  return task;
}

export function serializeMarkdownTask(task) {
  const lines = ['# Ploinky Workers task', ''];
  for (const [name, phase] of Object.entries(task)) {
    lines.push(`## ${name}`, '');
    for (const key of ['tier','batch','next']) if (Object.hasOwn(phase,key)) {
      const value = phase[key];
      const scalar = typeof value === 'string' && new RegExp('^' + ID + '$').test(value) && value !== 'null' ? value : JSON.stringify(value);
      lines.push(`### ${key}:${scalar}`);
    }
    for (const key of ['template','code','request']) if (Object.hasOwn(phase,key)) {
      const value = key === 'request' ? JSON.stringify(phase[key],null,2) : phase[key];
      if (typeof value !== 'string') throw new Error(`Cannot render non-string ${key}`);
      // Longer fences preserve embedded code fences verbatim without escaping.
      const longest = Math.max(2,...[...value.matchAll(/`+/g)].map(m=>m[0].length));
    const fence = '`'.repeat(longest + 1);
      lines.push('',`### ${key}`, '', fence + {template:'text',code:'javascript',request:'json'}[key], value, fence);
    }
    lines.push('');
  }
  return lines.join('\n');
}
