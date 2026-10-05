// In-process transports: a fetch that calls the core's request handler without a socket (code running inside the server: TaskLambdas,
// jobs, plugins), and a fetch over a MessagePort (code running in a worker thread of the server). Both carry exactly the HTTP API of
// `pworker serve`, so a TaskLambda sees the same tiers, cache, budgets and statistics as an outside client.
import { Readable } from 'node:stream';

const headerObject = (h) => {
  const out = {};
  for (const [k, v] of new Headers(h ?? {})) out[k.toLowerCase()] = v;
  return out;
};

/** A fetch that dispatches to `handle(req, res)` (node:http shaped) in this process. Streams are supported. */
export function inprocFetch(handle) {
  return async function fetchInproc(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://pworker.local');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body == null ? Buffer.alloc(0) : Buffer.isBuffer(init.body) ? init.body : Buffer.from(typeof init.body === 'string' ? init.body : await new Response(init.body).arrayBuffer());
    const req = Readable.from(body.length ? [body] : []);
    Object.assign(req, { trusted: true, method, url: url.pathname + url.search, headers: { 'user-agent': 'pworker-inproc', ...headerObject(init.headers) } });
    return new Promise((resolve, reject) => {
      let controller = null, status = 200, headers = {}, closed = false;
      const closeListeners = [];
      const stream = new ReadableStream({ start(c) { controller = c; }, cancel() { fire(); } });
      const fire = () => { if (closed) return; closed = true; for (const f of closeListeners) { try { f(); } catch { /* ignore */ } } };
      const res = {
        headersSent: false, writableEnded: false,
        on(ev, f) { if (ev === 'close') closeListeners.push(f); return res; },
        once(ev, f) { return res.on(ev, f); },
        setHeader(k, v) { headers[k.toLowerCase()] = v; },
        writeHead(st, h = {}) {
          status = st; res.headersSent = true;
          for (const [k, v] of Object.entries(h)) if (v != null) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
          resolve(new Response(st === 204 || st === 304 ? null : stream, { status: st, headers }));
          return res;
        },
        write(chunk) { if (!res.headersSent) res.writeHead(status); if (chunk != null && chunk.length !== 0) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk)); return true; },
        end(chunk) {
          if (!res.headersSent) res.writeHead(status);
          if (chunk != null && chunk.length !== 0) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk));
          if (!res.writableEnded) { res.writableEnded = true; try { controller.close(); } catch { /* cancelled */ } }
          fire();
        },
      };
      if (init.signal) {
        if (init.signal.aborted) return reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'));
        init.signal.addEventListener('abort', () => { fire(); try { controller.error(init.signal.reason ?? new DOMException('aborted', 'AbortError')); } catch { /* closed */ } if (!res.headersSent) reject(init.signal.reason ?? new DOMException('aborted', 'AbortError')); }, { once: true });
      }
      Promise.resolve().then(() => handle(req, res)).catch((e) => { if (!res.headersSent) reject(e); else res.end(); });
    });
  };
}

/** The server side of a port transport: answers fetch requests posted on `port` with `fetchImpl` (whole bodies, no streaming). */
export function servePort(port, fetchImpl) {
  port.on('message', async (m) => {
    if (m?.type !== 'fetch') return;
    try {
      const r = await fetchImpl(m.url, { method: m.method, headers: m.headers, body: m.body ?? undefined });
      const body = await r.text();
      port.postMessage({ type: 'response', id: m.id, status: r.status, headers: Object.fromEntries(r.headers), body });
    } catch (e) {
      port.postMessage({ type: 'response', id: m.id, error: String(e?.message ?? e) });
    }
  });
}

/** The worker side: a fetch over `port` (request and response bodies as strings). */
export function portFetch(port) {
  let next = 1;
  const pending = new Map();
  port.on('message', (m) => {
    if (m?.type !== 'response' || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error));
    else resolve(new Response(m.status === 204 ? null : m.body, { status: m.status, headers: m.headers }));
  });
  return (input, init = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    const body = init.body == null ? null : typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8');
    port.postMessage({ type: 'fetch', id, url: typeof input === 'string' ? input : input.url, method: init.method || 'GET', headers: headerObject(init.headers), body });
  });
}
