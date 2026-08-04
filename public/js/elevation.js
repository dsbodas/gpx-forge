/**
 * Elevation lookup for routes whose engine did not supply it.
 *
 * We never query every vertex — a 200 km route can carry 100 000 of them and
 * the free DEM services cap at 100 coordinates per request. Instead we sample
 * the route at a fixed ground interval, look those up, then interpolate the
 * full geometry off that profile. Sampling by distance (not by vertex) also
 * stops dense corners from dominating the profile.
 */

import { resampleByDistance, computeDistances, elevationAt, mapLimit, sleep } from './util.js';

const BATCH = 100;          // both providers cap at 100 coordinates per call
const MAX_SAMPLES = 2500;   // keeps a long route inside free-tier daily quotas

/**
 * `minIntervalMs` is the gap enforced between *starts* of requests to that
 * provider. Both services rate-limit bursts hard — measured, Open-Meteo starts
 * refusing at four concurrent requests, and OpenTopoData documents a ceiling of
 * one call per second — so pacing is not optional.
 */
/**
 * `sampleInterval` is deliberately close to the dataset's own cell size.
 *
 * Sampling a 90 m terrain model every 20 m does not reveal any extra detail —
 * the data simply is not there. What it does produce is step artefacts as
 * consecutive samples fall either side of a cell boundary, and on a road cut
 * into a steep valley those steps read as walls: the Chamonix–Martigny route
 * sampled at 20 m reports a 30.7% maximum gradient, which no public road has.
 * Sampling near the native resolution and interpolating between samples is
 * both more honest and roughly three times cheaper in API calls.
 */
export const PROVIDERS = {
  openmeteo: {
    id: 'openmeteo',
    label: 'Open-Meteo (Copernicus DEM, 90 m)',
    minIntervalMs: 260,
    sampleInterval: 70,
    fetch: fetchOpenMeteo,
  },
  opentopo: {
    id: 'opentopo',
    label: 'OpenTopoData (SRTM/ASTER 30 m)',
    minIntervalMs: 1100,
    sampleInterval: 40,
    fetch: fetchOpenTopo,
  },
};

/**
 * Serialises request *starts* to at least `minIntervalMs` apart, while letting
 * the requests themselves overlap.
 */
function makeRateGate(minIntervalMs) {
  let queue = Promise.resolve();
  let lastStart = 0;
  return (fn) => {
    const slot = queue.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
    });
    queue = slot;
    return slot.then(fn);
  };
}

const gates = new Map();
function gateFor(provider) {
  if (!gates.has(provider.id)) gates.set(provider.id, makeRateGate(provider.minIntervalMs));
  return gates.get(provider.id);
}

const isRateLimited = (err) => /429|rate.?limit|limit exceeded|too many/i.test(err?.message || '');

/** Retries a rate-limited call with exponential backoff before giving up. */
async function withRetry(fn, attempts = 4) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRateLimited(err) || attempt === attempts - 1) throw err;
      // Jitter stops parallel batches from retrying in lockstep.
      await sleep(1200 * 2 ** attempt + Math.random() * 400);
    }
  }
  throw lastError;
}

/**
 * Fills in `ele` on every point of `points`.
 * @param {Array} points  route geometry (mutated copy returned)
 * @param {object} opts   { provider, onProgress }
 */
export async function addElevation(points, opts = {}) {
  const { provider = 'openmeteo', onProgress = () => {} } = opts;
  if (points.length < 2) return points;
  if (points[0].dist == null) computeDistances(points);

  const total = points[points.length - 1].dist;
  const native = PROVIDERS[provider]?.sampleInterval ?? 70;
  const interval = Math.max(native, Math.ceil(total / MAX_SAMPLES));
  const samples = resampleByDistance(points, interval);

  onProgress(`Sampling elevation at ${samples.length.toLocaleString()} points (every ${interval} m)…`);

  const batches = [];
  for (let i = 0; i < samples.length; i += BATCH) batches.push(samples.slice(i, i + BATCH));

  let done = 0;
  const order = [PROVIDERS[provider], ...Object.values(PROVIDERS).filter((p) => p.id !== provider)];

  // Two at a time; the per-provider gate does the real pacing.
  const results = await mapLimit(batches, 2, async (batch) => {
    const failures = [];
    for (const p of order) {
      try {
        const elevations = await withRetry(() => gateFor(p)(() => p.fetch(batch)));
        if (elevations.length === batch.length) {
          done += batch.length;
          onProgress(`Elevation ${Math.round((done / samples.length) * 100)}%…`);
          return elevations;
        }
        failures.push(`${p.label}: returned ${elevations.length} of ${batch.length} values`);
      } catch (err) {
        failures.push(`${p.label}: ${err.message}`);
      }
    }
    // Report every provider's reason — quoting only the last one hides the
    // failure that actually mattered.
    throw new Error(`Elevation lookup failed. ${failures.join(' | ')}`);
  });

  const series = [];
  results.flat().forEach((ele, i) => {
    if (Number.isFinite(ele)) series.push({ dist: samples[i].dist, ele });
  });

  if (series.length < 2) throw new Error('Elevation service returned no usable data for this route.');

  return points.map((p) => ({ ...p, ele: elevationAt(series, p.dist) }));
}

/* ------------------------------------------------------------------ */

async function fetchOpenMeteo(batch) {
  const { request } = await import('./net.js');
  const lat = batch.map((p) => p.lat.toFixed(6)).join(',');
  const lon = batch.map((p) => p.lon.toFixed(6)).join(',');
  const json = await request(
    `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`,
    { cacheable: true }
  );
  // Open-Meteo signals rate limiting with HTTP 200 and an error body, so the
  // transport layer sees a success. Check the payload, and preserve `reason`
  // verbatim — the retry logic keys off the word "limit".
  if (json?.error) throw new Error(json.reason || 'Open-Meteo rejected the request.');
  if (!Array.isArray(json?.elevation)) throw new Error('Open-Meteo returned an unexpected payload.');
  return json.elevation;
}

async function fetchOpenTopo(batch) {
  const { request } = await import('./net.js');
  const locations = batch.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
  const json = await request(
    `https://api.opentopodata.org/v1/mapzen?locations=${encodeURIComponent(locations)}`,
    { cacheable: true }
  );
  if (json?.status !== 'OK' || !Array.isArray(json?.results)) {
    throw new Error(json?.error || 'OpenTopoData returned an unexpected payload.');
  }
  return json.results.map((r) => r.elevation);
}
