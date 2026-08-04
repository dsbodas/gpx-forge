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
  terrarium: {
    id: 'terrarium',
    label: 'Terrain tiles (AWS open data, ~30 m)',
    // Tiles, not per-point queries: one 256×256 tile covers several kilometres,
    // so a whole route costs a handful of requests instead of dozens of API
    // calls. Nothing to rate-limit, and it sends CORS headers, so it works on a
    // static host with no proxy. This is why it is the default.
    minIntervalMs: 0,
    sampleInterval: 60,
    fetch: fetchTerrarium,
  },
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
    // Sends no CORS header, so this only works behind the local server's proxy.
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

/* ------------------------------------------------------------------ *
 * Terrarium terrain tiles
 *
 * Mapzen's terrain tiles, hosted on AWS Open Data. Elevation is encoded in the
 * pixel colour:  metres = (R * 256 + G + B / 256) - 32768
 * ------------------------------------------------------------------ */

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TERRARIUM_ZOOM = 13; // ~13 m/px at mid latitudes, finer than the source data
const tileCache = new Map(); // "z/x/y" -> Promise<{data, size}>

const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Loads and decodes one tile. Promises are cached so concurrent callers share a fetch. */
function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const pending = (async () => {
    if (typeof document === 'undefined') {
      throw new Error('Terrain tiles need a browser (canvas decoding).');
    }
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required, or the canvas is tainted
    img.decoding = 'async';

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error(`terrain tile ${key} did not load`));
      img.src = `${TERRARIUM_URL}/${key}.png`;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return {
      data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      size: canvas.width,
    };
  })();

  tileCache.set(key, pending);
  pending.catch(() => tileCache.delete(key)); // let a failed tile be retried
  return pending;
}

const decodePixel = (data, i) => (data[i] * 256 + data[i + 1] + data[i + 2] / 256) - 32768;

async function fetchTerrarium(batch) {
  const z = TERRARIUM_ZOOM;
  const scale = 2 ** z;

  // Fetch each distinct tile once, in parallel.
  const needed = new Set();
  for (const p of batch) {
    needed.add(`${Math.floor(lonToTileX(p.lon, z))}/${Math.floor(latToTileY(p.lat, z))}`);
  }
  const tiles = new Map();
  await Promise.all(
    [...needed].map(async (k) => {
      const [x, y] = k.split('/').map(Number);
      tiles.set(k, await loadTile(z, ((x % scale) + scale) % scale, y));
    })
  );

  return batch.map((p) => {
    const fx = lonToTileX(p.lon, z);
    const fy = latToTileY(p.lat, z);
    const tx = Math.floor(fx);
    const ty = Math.floor(fy);
    const tile = tiles.get(`${tx}/${ty}`);
    if (!tile) return NaN;

    const { data, size } = tile;
    // Bilinear interpolation — nearest-neighbour would reintroduce exactly the
    // stair-step artefacts the analysis pipeline works to remove. Neighbours are
    // clamped at tile edges rather than reaching into the adjacent tile; that is
    // at most a one-pixel (~13 m) error on a seam, well below the data's own
    // resolution.
    const px = (fx - tx) * size;
    const py = (fy - ty) * size;
    const x0 = Math.min(size - 1, Math.max(0, Math.floor(px)));
    const y0 = Math.min(size - 1, Math.max(0, Math.floor(py)));
    const x1 = Math.min(size - 1, x0 + 1);
    const y1 = Math.min(size - 1, y0 + 1);
    const dx = px - x0;
    const dy = py - y0;

    const e00 = decodePixel(data, (y0 * size + x0) * 4);
    const e10 = decodePixel(data, (y0 * size + x1) * 4);
    const e01 = decodePixel(data, (y1 * size + x0) * 4);
    const e11 = decodePixel(data, (y1 * size + x1) * 4);

    return (
      e00 * (1 - dx) * (1 - dy) +
      e10 * dx * (1 - dy) +
      e01 * (1 - dx) * dy +
      e11 * dx * dy
    );
  });
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
