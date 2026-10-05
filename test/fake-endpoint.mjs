// A fake OpenAI-compatible endpoint for the tests (no network).
import http from 'node:http';

/** A fake proxy: `respond({body, user, headers, path})` -> {status?, json?, content?, headers?}. Records every request. */
export async function fakeProxy(respond, {health = {ok: true}} = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, {'content-type': 'application/json'}); return res.end(JSON.stringify(health)); }
    if (req.url.startsWith('/jobs/')) { requests.push({path: req.url, body, headers: req.headers}); res.writeHead(200, {'content-type': 'application/json'}); return res.end('{"ok":true}'); }
    const user = body.messages.filter(m => m.role === 'user').at(-1).content;
    requests.push({path: req.url, body, headers: req.headers, user});
    const r = (await respond({body, user, headers: req.headers, path: req.url, messages: body.messages})) ?? {};
    const json = r.json ?? {choices: [{message: {content: r.content ?? ''}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 5, cost: 0.001}};
    res.writeHead(r.status ?? 200, {'content-type': 'application/json', ...(r.headers ?? {'x-quota-cost': '0.1'})});
    res.end(JSON.stringify(json));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {url: `http://127.0.0.1:${server.address().port}`, requests, chat: () => requests.filter(r => r.path.includes('/chat/completions')), close: () => new Promise(r => server.close(r))};
}

