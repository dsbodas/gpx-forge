'use strict';

/**
 * Strava integration — server side.
 *
 * This lives on the server rather than in the browser because Strava's OAuth
 * requires `client_secret` to exchange the authorization code and does not
 * support PKCE. A browser-only client cannot hold that secret, so the static
 * GitHub Pages build genuinely cannot offer this: it needs `npm start`.
 *
 * Credentials are read from the environment or ./strava.config.json, and tokens
 * are cached in ./.strava-tokens.json. Both files are gitignored — the secret
 * must never reach the repository, which is public.
 *
 * Rate limits are 100 non-upload requests per 15 minutes and 1 000 per day, so
 * segment discovery is chunked, capped and cached.
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'strava.config.json');
const TOKEN_FILE = path.join(__dirname, '.strava-tokens.json');

const AUTHORIZE_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';

/* ------------------------------------------------------------------ *
 * Credentials
 * ------------------------------------------------------------------ */

function loadConfig() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  try {
    const file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (file.clientId && file.clientSecret) {
      return { clientId: String(file.clientId), clientSecret: String(file.clientSecret) };
    }
  } catch { /* not configured */ }
  return null;
}

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  // 0600: the refresh token is long-lived and grants access to the account.
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

/** A valid access token, refreshing it first if it is close to expiry. */
async function getAccessToken() {
  const config = loadConfig();
  if (!config) throw new Error('Strava is not configured on this server.');

  const tokens = loadTokens();
  if (!tokens?.refresh_token) throw new Error('Not connected to Strava yet.');

  // 120 s of slack so a request cannot expire mid-flight.
  if (tokens.access_token && tokens.expires_at && tokens.expires_at - 120 > Date.now() / 1000) {
    return tokens.access_token;
  }

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Strava refused to refresh the token: ${json?.message || res.status}`);
  }

  saveTokens({ ...tokens, ...json });
  return json.access_token;
}

/* ------------------------------------------------------------------ *
 * Segment discovery
 * ------------------------------------------------------------------ */

const exploreCache = new Map(); // bbox key -> { at, segments }
const CACHE_TTL_MS = 1000 * 60 * 60 * 12; // Strava caches explore per tile for 24 h anyway
const MAX_BBOXES = 40; // keeps a long route inside the 15-minute rate limit

async function exploreSegments(bboxes, activityType = 'riding') {
  const token = await getAccessToken();
  const limited = bboxes.slice(0, MAX_BBOXES);
  const found = new Map(); // id -> segment
  let requests = 0;
  let rateLimited = false;

  for (const box of limited) {
    const key = `${activityType}:${box.map((v) => v.toFixed(4)).join(',')}`;
    const hit = exploreCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      for (const s of hit.segments) found.set(s.id, s);
      continue;
    }

    const url = `${API}/segments/explore?bounds=${box.join(',')}&activity_type=${activityType}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    requests++;

    if (res.status === 429) { rateLimited = true; break; }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Strava returned ${res.status} for segment discovery. ${body.slice(0, 200)}`);
    }

    const json = await res.json();
    const segments = (json?.segments || []).map((s) => ({
      id: s.id,
      name: s.name,
      distance: s.distance,
      avgGrade: s.avg_grade,
      elevDifference: s.elev_difference,
      climbCategory: s.climb_category,
      startLatlng: s.start_latlng,
      endLatlng: s.end_latlng,
      points: s.points, // encoded polyline
    }));

    exploreCache.set(key, { at: Date.now(), segments });
    for (const s of segments) found.set(s.id, s);
  }

  return {
    segments: [...found.values()],
    requests,
    rateLimited,
    truncated: bboxes.length > limited.length,
  };
}

async function segmentDetail(id) {
  const token = await getAccessToken();
  const res = await fetch(`${API}/segments/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Strava returned ${res.status} for segment ${id}. ${body.slice(0, 200)}`);
  }
  const s = await res.json();
  return {
    id: s.id,
    name: s.name,
    activityType: s.activity_type,
    distance: s.distance,
    averageGrade: s.average_grade,
    maximumGrade: s.maximum_grade,
    elevationHigh: s.elevation_high,
    elevationLow: s.elevation_low,
    totalElevationGain: s.total_elevation_gain,
    climbCategory: s.climb_category,
    city: s.city,
    state: s.state,
    country: s.country,
    effortCount: s.effort_count,
    athleteCount: s.athlete_count,
    starCount: s.star_count,
    // Present only for the authenticated athlete; absent is normal.
    athleteStats: s.athlete_segment_stats || null,
    xoms: s.xoms || null,
  };
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

function register(app) {
  app.get('/api/strava/status', (_req, res) => {
    const config = loadConfig();
    const tokens = loadTokens();
    res.json({
      configured: Boolean(config),
      connected: Boolean(tokens?.refresh_token),
      athlete: tokens?.athlete
        ? { id: tokens.athlete.id, firstname: tokens.athlete.firstname, username: tokens.athlete.username }
        : null,
    });
  });

  app.get('/api/strava/login', (req, res) => {
    const config = loadConfig();
    if (!config) {
      return res.status(503).json({ error: 'Strava is not configured. See README → Strava segments.' });
    }
    // Strava validates this against the app's "Authorization Callback Domain".
    const redirectUri = `${req.protocol}://${req.get('host')}/api/strava/callback`;
    const url =
      `${AUTHORIZE_URL}?client_id=${encodeURIComponent(config.clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&approval_prompt=auto&scope=read`;
    res.redirect(url);
  });

  app.get('/api/strava/callback', async (req, res) => {
    const config = loadConfig();
    if (!config) return res.status(503).send('Strava is not configured on this server.');

    if (req.query.error) {
      return res.redirect(`/?strava=denied`);
    }
    const code = String(req.query.code || '');
    if (!code) return res.status(400).send('Strava did not return an authorization code.');

    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: 'authorization_code',
          code,
        }),
      });
      const json = await tokenRes.json();
      if (!tokenRes.ok) {
        return res.status(502).send(`Strava rejected the token exchange: ${json?.message || tokenRes.status}`);
      }
      saveTokens(json);
      res.redirect('/?strava=connected');
    } catch (err) {
      res.status(502).send(`Could not complete Strava sign-in: ${err.message}`);
    }
  });

  app.post('/api/strava/logout', (_req, res) => {
    try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
    res.json({ ok: true });
  });

  app.post('/api/strava/explore', async (req, res) => {
    const { bboxes, activityType } = req.body || {};
    if (!Array.isArray(bboxes) || !bboxes.length) {
      return res.status(400).json({ error: 'No bounding boxes supplied.' });
    }
    const valid = bboxes.filter(
      (b) => Array.isArray(b) && b.length === 4 && b.every((v) => Number.isFinite(v))
    );
    if (!valid.length) return res.status(400).json({ error: 'Bounding boxes are malformed.' });

    try {
      res.json(await exploreSegments(valid, activityType === 'running' ? 'running' : 'riding'));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/strava/segment/:id', async (req, res) => {
    try {
      res.json(await segmentDetail(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}

module.exports = { register, loadConfig };
