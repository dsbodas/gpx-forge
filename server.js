'use strict';

/**
 * GPX Forge server.
 *
 * Deliberately thin. All routing / elevation / analysis logic lives in the
 * browser so that `public/` can also be dropped onto any static host and still
 * work. The server exists for the three things a browser cannot do itself:
 *
 *   1. follow a shortened Google/Apple Maps link (opaque redirect, CORS-blocked)
 *   2. reach upstream APIs that do not send permissive CORS headers
 *   3. cache elevation lookups so repeated edits of a route stay fast
 *
 * The proxy is host-allowlisted rather than open, so it cannot be used to reach
 * internal network addresses (SSRF).
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8787;
const HOST = process.env.HOST || '0.0.0.0';

/** Upstreams the proxy is permitted to reach. Exact hostname match only. */
const ALLOWED_HOSTS = new Set([
  // routing
  'api.openrouteservice.org',
  'routing.openstreetmap.de',
  'brouter.de',
  'routing.gpx.studio',
  // elevation
  'api.open-meteo.com',
  'api.opentopodata.org',
  // OSM tags (surface / highway classification)
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
  // geocoding
  'nominatim.openstreetmap.org',
]);

/** Hosts whose redirects we are willing to follow when expanding short links. */
const ALLOWED_REDIRECT_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'www.google.com',
  'google.com',
  'maps.google.com',
  'g.co',
  'maps.apple.com',
  'guides.apple.com',
  'osm.org',
  'www.openstreetmap.org',
  'openstreetmap.org',
  'ridewithgps.com',
  'www.komoot.com',
  'www.strava.com',
  'strava.app.link',
]);

app.use(express.json({ limit: '12mb' }));

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      // The service worker must never be served stale or it can pin an old build.
      if (filePath.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

const strava = require('./strava');
strava.register(app);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'gpx-forge',
    version: 1,
    // Lets the client show or hide the Strava panel without a second probe.
    strava: Boolean(strava.loadConfig()),
  });
});

/* ------------------------------------------------------------------ *
 * Short-link expansion
 * ------------------------------------------------------------------ */

app.post('/api/resolve', async (req, res) => {
  const raw = String(req.body?.url || '').trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'Not a valid URL.' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return res.status(400).json({ error: 'Only http(s) URLs can be resolved.' });
  }
  if (!ALLOWED_REDIRECT_HOSTS.has(url.hostname)) {
    return res.status(403).json({ error: `Refusing to resolve host "${url.hostname}".` });
  }

  // Follow the redirect chain manually so every hop is checked against the
  // allowlist — `redirect: 'follow'` would happily walk off to anywhere.
  let current = url;
  const chain = [current.toString()];
  try {
    for (let hop = 0; hop < 8; hop++) {
      const upstream = await fetchWithTimeout(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          // Google serves the coordinate-bearing page only to a real UA.
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      const location = upstream.headers.get('location');
      if (upstream.status >= 300 && upstream.status < 400 && location) {
        const next = new URL(location, current);
        if (!ALLOWED_REDIRECT_HOSTS.has(next.hostname)) {
          return res
            .status(403)
            .json({ error: `Redirect led to disallowed host "${next.hostname}".` });
        }
        current = next;
        chain.push(current.toString());
        continue;
      }

      // Terminal response. Some Google short links resolve to a consent or JS
      // shim page that carries the real coordinates in the body, so hand the
      // body back too and let the client-side parser mine it.
      const body = await upstream.text();
      return res.json({
        url: current.toString(),
        chain,
        status: upstream.status,
        body: body.slice(0, 400_000),
      });
    }
    return res.status(508).json({ error: 'Too many redirects.' });
  } catch (err) {
    return res.status(502).json({ error: `Could not resolve link: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ *
 * Allowlisted upstream proxy
 * ------------------------------------------------------------------ */

const cache = new Map(); // key -> { at, status, body, contentType }
const CACHE_TTL_MS = 1000 * 60 * 60 * 6;
const CACHE_MAX = 600;

app.post('/api/proxy', async (req, res) => {
  const { url: raw, method = 'GET', headers = {}, body = null, cacheable = false } = req.body || {};

  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return res.status(400).json({ error: 'Not a valid URL.' });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return res.status(400).json({ error: 'Only http(s) URLs may be proxied.' });
  }
  if (!ALLOWED_HOSTS.has(url.hostname)) {
    return res.status(403).json({ error: `Host "${url.hostname}" is not on the proxy allowlist.` });
  }

  const cacheKey = cacheable ? `${method} ${url} ${typeof body === 'string' ? body : JSON.stringify(body)}` : null;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      res.setHeader('Content-Type', hit.contentType);
      res.setHeader('X-Proxy-Cache', 'hit');
      return res.status(hit.status).send(hit.body);
    }
  }

  // Only forward headers the upstreams actually need; never pass through
  // cookies or client auth material.
  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/^(authorization|content-type|accept|api-key)$/i.test(k)) safeHeaders[k] = String(v);
  }
  if (!safeHeaders['User-Agent']) {
    safeHeaders['User-Agent'] = 'GPX-Forge/1.0 (self-hosted cycling route tool)';
  }

  try {
    const upstream = await fetchWithTimeout(
      url.toString(),
      {
        method,
        headers: safeHeaders,
        body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
        redirect: 'follow',
      },
      45_000
    );

    const text = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    if (cacheKey && upstream.ok) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(cacheKey, { at: Date.now(), status: upstream.status, body: text, contentType });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Proxy-Cache', 'miss');
    return res.status(upstream.status).send(text);
  } catch (err) {
    return res.status(502).json({ error: `Upstream request failed: ${err.message}` });
  }
});

/* ------------------------------------------------------------------ */

function fetchWithTimeout(url, options = {}, ms = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// SPA fallback: anything that is not an API call renders the app shell.
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, HOST, () => {
  console.log(`\n  GPX Forge running\n  → http://localhost:${PORT}\n`);
  console.log(`  On your phone (same Wi-Fi): http://<this-machine-ip>:${PORT}\n`);
});
