import { resolveUpstream } from '../settings.mjs';

export function providerSpec(name, endpoint, key, rpm = 60, prior = {}) {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error('Invalid provider name');
  const url = new URL(endpoint);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('An HTTP(S) endpoint is required');
  if (url.username || url.password || url.search || url.hash) throw new Error('The endpoint must not contain credentials, a query, or a fragment');
  if (/\/chat\/completions\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, '');
  const baseUrl = url.href.replace(/\/+$/, '');
  const versioned = /\/v\d+$/.test(url.pathname.replace(/\/+$/, ''));
  const sameEndpoint = String(prior.baseUrl ?? '').replace(/\/+$/, '') === baseUrl;
  const limit = Number(rpm);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Requests per minute must be a positive integer');
  const keyVar = `PWORKER_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  return {
    ...prior,
    baseUrl,
    envFile: key ? `${name}.env` : null,
    keyVar: key ? keyVar : null,
    noKey: !key,
    modelsPath: sameEndpoint ? (prior.modelsPath ?? (versioned ? '/models' : '/v1/models')) : (versioned ? '/models' : '/v1/models'),
    formats: sameEndpoint ? (prior.formats ?? { openai: versioned ? '/chat/completions' : '/v1/chat/completions' }) : { openai: versioned ? '/chat/completions' : '/v1/chat/completions' },
    limits: { ...(prior.limits ?? {}), maxPerMinute: limit },
  };
}

export async function fetchModelCatalog(provider, { key = null, fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const url = String(provider.baseUrl).replace(/\/+$/, '') + (provider.modelsPath ?? '/v1/models');
  const response = await fetchImpl(url, { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Model list request failed (${response.status})`);
  const body = await response.json();
  const models = [...new Set((Array.isArray(body.data) ? body.data : []).map((item) => item?.id).filter((id) => typeof id === 'string' && id))].sort();
  if (!models.length) throw new Error('The provider returned no selectable models');
  return models;
}

export function connectedProviders(config, localStatus = {}, env = process.env) {
  return Object.entries(config.providers ?? {}).filter(([name]) => !name.startsWith('_')).flatMap(([name, provider]) => {
    const resolved = resolveUpstream(name, provider, env);
    if (provider.start) return localStatus[name]?.running ? [name] : [];
    return resolved.key || provider.noKey ? [name] : [];
  });
}
