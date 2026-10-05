import { emitKeypressEvents } from 'node:readline';

const BACK = Symbol('back');

function terminal(input, output) {
  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();
  return () => { input.setRawMode(false); input.pause(); };
}

export async function selectMenu({ input, output, rl }, title, choices, { searchable = false } = {}) {
  const entries = [...choices.map((choice) => typeof choice === 'string' ? { label: choice, value: choice } : choice), { label: 'Back / Cancel', value: BACK }];
  if (!input.isTTY || !output.isTTY) {
    output.write(`${title}\n${entries.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}\n`);
    const answer = await rl.question('Choice (blank to cancel): ');
    const selected = entries[Number(answer) - 1];
    return selected && selected.value !== BACK ? selected.value : null;
  }
  let query = '', index = 0, top = 0;
  const stop = terminal(input, output);
  const filtered = () => entries.filter((entry) => entry.value === BACK || !searchable || entry.label.toLowerCase().includes(query.toLowerCase()));
  const draw = () => {
    const matches = filtered();
    index = Math.max(0, Math.min(index, matches.length - 1));
    const height = Math.max(5, Math.min(14, (output.rows || 24) - 7));
    top = Math.max(0, Math.min(top, Math.max(0, matches.length - height)));
    if (index < top) top = index;
    if (index >= top + height) top = index - height + 1;
    const width = Math.max(20, (output.columns || 80) - 5);
    const rows = matches.slice(top, top + height).map((entry, offset) => `${top + offset === index ? '›' : ' '} ${entry.label.slice(0, width)}`);
    output.write(`\x1b[2J\x1b[H${title}\n${searchable ? `Filter: ${query || '(type to search)'}   ${Math.max(0, matches.length - 1)} matching\n` : ''}\n${rows.join('\n')}\n\n↑/↓ select · Enter confirm · Esc cancel${searchable ? ' · type to filter · Backspace erase' : ''}`);
  };
  draw();
  return new Promise((resolve) => {
    const finish = (value) => { input.off('keypress', onKey); stop(); output.write('\n'); resolve(value === BACK ? null : value); };
    const onKey = (char, key = {}) => {
      const matches = filtered();
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
      if (key.name === 'up') index = (index + matches.length - 1) % matches.length;
      else if (key.name === 'down') index = (index + 1) % matches.length;
      else if (key.name === 'pageup') index = Math.max(0, index - 10);
      else if (key.name === 'pagedown') index = Math.min(matches.length - 1, index + 10);
      else if (key.name === 'home') index = 0;
      else if (key.name === 'end') index = matches.length - 1;
      else if (key.name === 'return') return finish(matches[index]?.value ?? null);
      else if (searchable && key.name === 'backspace') { query = query.slice(0, -1); index = 0; top = 0; }
      else if (searchable && char && !key.ctrl && !key.meta && char.length === 1 && char >= ' ') { query += char; index = 0; top = 0; }
      draw();
    };
    input.on('keypress', onKey);
  });
}

export async function promptField({ input, output, rl }, label, { secret = false, allowEmpty = false, initial = '' } = {}) {
  if (!input.isTTY || !output.isTTY) {
    const answer = await rl.question(`${label}${initial ? ` [${initial}]` : ''} (blank to cancel): `);
    return answer.trim() || (allowEmpty ? '' : initial || null);
  }
  let value = '';
  const stop = terminal(input, output);
  const draw = () => output.write(`\x1b[2J\x1b[H${label}\n\n> ${secret ? '•'.repeat(value.length) : value}\n\nEnter confirm · Esc cancel · Backspace erase${initial ? ` · empty uses ${initial}` : ''}`);
  draw();
  return new Promise((resolve) => {
    const finish = (answer) => { input.off('keypress', onKey); stop(); output.write('\n'); resolve(answer); };
    const onKey = (char, key = {}) => {
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) return finish(null);
      if (key.name === 'return') return finish(value.trim() || (allowEmpty ? '' : initial || null));
      if (key.name === 'backspace') value = value.slice(0, -1);
      else if (char && !key.ctrl && !key.meta && char >= ' ') value += char;
      draw();
    };
    input.on('keypress', onKey);
  });
}
