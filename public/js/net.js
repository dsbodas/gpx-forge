/**
 * Transport layer.
 *
 * When the Node server is present every upstream call is tunnelled through
 * /api/proxy — that sidesteps CORS and gives us server-side caching. When the
 * app is served as plain static files the same calls go out directly from the
 * browser; most of our upstreams do send permissive CORS headers, so the app
 * still works, just without short-link expansion.
 */

let serverAvailable = null;

export async function detectServer() {
  if (serverAvailable !== null) return serverAvailable;
  // AbortController rather than AbortSignal.timeout(), which Safari only gained
  // in 16. The fallback path would work either way, but a probe that throws on
  // older browsers is a needless thing to reason about.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch('/api/health', { signal: controller.signal });
    const json = await res.json();
    serverAvailable = json?.service === 'gpx-forge';
  } catch {
    serverAvailable = false;
  } finally {
    clearTimeout(timer);
  }
  return serverAvailable;
}

export const hasServer = () => serverAvailable === true;

/**
 * Performs a request, via the proxy when possible.
 * @param {string} url
 * @param {object} opts { method, headers, body, cacheable, raw }
 */
export async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body = null, cacheable = false, raw = false } = opts;

  let res;
  if (await detectServer()) {
    res = await fetch('/api/proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method, headers, body, cacheable }),
    });
  } else {
    res = await fetch(url, {
      method,
      headers,
      body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  const text = await res.text();
  if (!res.ok) throw new Error(describeFailure(res.status, text, url));
  if (raw) return text;

  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Upstream returned a response that was not valid JSON.');
  }
}

export const fetchJson = (url, opts) => request(url, opts);

/** Expands a shortened Maps link. Requires the local server. */
export async function resolveShortLink(url) {
  if (!(await detectServer())) throw new Error('Short-link expansion needs the local server.');
  const res = await fetch('/api/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || 'Could not expand that link.');
  return json;
}

/** Turns terse upstream errors into something a rider can act on. */
function describeFailure(status, text, url) {
  let detail = text;
  try {
    const json = JSON.parse(text);
    detail = json?.error?.message || json?.error || json?.message || json?.errorMessage || text;
    if (typeof detail === 'object') detail = JSON.stringify(detail);
  } catch { /* keep raw text */ }
  detail = String(detail).slice(0, 400).trim();

  const host = (() => { try { return new URL(url).hostname; } catch { return 'the routing service'; } })();

  if (status === 401 || status === 403) {
    return `${host} rejected the request (${status}). ${
      host.includes('openrouteservice') ? 'Check your OpenRouteService API key in Settings.' : detail
    }`;
  }
  if (status === 404) return `${host} found no route between those points (404). ${detail}`;
  if (status === 429) {
    return `${host} rate-limited us (429). Free tiers are capped — wait a minute, or switch routing engine in Settings.`;
  }
  if (status >= 500) return `${host} is having trouble (${status}). Try another routing engine in Settings. ${detail}`;
  return `${host} returned ${status}. ${detail}`;
}
