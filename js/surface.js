/**
 * Surface and road-type breakdown.
 *
 * Two sources, in order of preference:
 *   1. OpenRouteService `extras` — comes back with the route for free and is
 *      already aligned to the geometry. Nothing to pay, nothing to wait for.
 *   2. Overpass — for the keyless engines. We sample the route and ask OSM what
 *      is under each sample. Slower and rate-limited, so it is opt-in.
 */

import { haversine, resampleByDistance, mapLimit } from './util.js';

/* ---------- classification tables ---------- */

export const SURFACE_GROUPS = {
  paved: { label: 'Paved / asphalt', color: '#3f4c5a', rideable: 1.0 },
  cobbles: { label: 'Cobbles / setts', color: '#8d6e63', rideable: 0.82 },
  compacted: { label: 'Compacted / fine gravel', color: '#a5885c', rideable: 0.9 },
  gravel: { label: 'Gravel', color: '#c8a25a', rideable: 0.82 },
  unpaved: { label: 'Dirt / ground', color: '#9c7a4a', rideable: 0.75 },
  sand: { label: 'Sand', color: '#e0c88a', rideable: 0.5 },
  grass: { label: 'Grass', color: '#7fa25a', rideable: 0.6 },
  unknown: { label: 'Unknown', color: '#b0b7c0', rideable: 0.95 },
};

const OSM_SURFACE_TO_GROUP = {
  asphalt: 'paved', concrete: 'paved', 'concrete:lanes': 'paved', 'concrete:plates': 'paved',
  paved: 'paved', paving_stones: 'paved', chipseal: 'paved', metal: 'paved', wood: 'paved',
  bricks: 'paved', tartan: 'paved', rubber: 'paved',
  sett: 'cobbles', cobblestone: 'cobbles', unhewn_cobblestone: 'cobbles',
  compacted: 'compacted', fine_gravel: 'compacted',
  gravel: 'gravel', pebblestone: 'gravel', shells: 'gravel', rock: 'gravel',
  unpaved: 'unpaved', dirt: 'unpaved', ground: 'unpaved', earth: 'unpaved',
  mud: 'unpaved', woodchips: 'unpaved',
  sand: 'sand',
  grass: 'grass', grass_paver: 'grass',
};

/** ORS surface codes → our groups (see the ORS extra_info documentation). */
const ORS_SURFACE = {
  0: 'unknown', 1: 'paved', 2: 'unpaved', 3: 'paved', 4: 'paved', 5: 'cobbles',
  6: 'paved', 7: 'paved', 8: 'compacted', 9: 'compacted', 10: 'gravel', 11: 'unpaved',
  12: 'unpaved', 13: 'unknown', 14: 'paved', 15: 'sand', 16: 'unpaved', 17: 'grass',
  18: 'grass',
};

export const WAY_GROUPS = {
  cycleway: { label: 'Cycleway', color: '#2e7d32', traffic: 0 },
  path: { label: 'Path / bridleway', color: '#7cb342', traffic: 0 },
  track: { label: 'Track', color: '#a1887f', traffic: 0 },
  quiet: { label: 'Quiet / residential road', color: '#42a5f5', traffic: 1 },
  minor: { label: 'Minor road', color: '#1e88e5', traffic: 2 },
  secondary: { label: 'Secondary road', color: '#fb8c00', traffic: 3 },
  main: { label: 'Main road', color: '#e53935', traffic: 4 },
  steps: { label: 'Steps', color: '#8e24aa', traffic: 0 },
  ferry: { label: 'Ferry', color: '#00acc1', traffic: 0 },
  unknown: { label: 'Unknown', color: '#b0b7c0', traffic: 1 },
};

const OSM_HIGHWAY_TO_GROUP = {
  cycleway: 'cycleway',
  path: 'path', footway: 'path', bridleway: 'path', pedestrian: 'path',
  track: 'track',
  residential: 'quiet', living_street: 'quiet', service: 'quiet',
  unclassified: 'minor', tertiary: 'minor', tertiary_link: 'minor', road: 'minor',
  secondary: 'secondary', secondary_link: 'secondary',
  primary: 'main', primary_link: 'main', trunk: 'main', trunk_link: 'main',
  motorway: 'main', motorway_link: 'main',
  steps: 'steps',
};

/** ORS waytype codes → our groups. */
const ORS_WAYTYPE = {
  0: 'unknown', 1: 'main', 2: 'minor', 3: 'quiet', 4: 'path', 5: 'track',
  6: 'cycleway', 7: 'path', 8: 'steps', 9: 'ferry', 10: 'unknown',
};

/** OSM highways with no surface tag still imply one, more often than not. */
const IMPLIED_SURFACE = {
  cycleway: 'paved', residential: 'paved', living_street: 'paved', tertiary: 'paved',
  secondary: 'paved', primary: 'paved', trunk: 'paved', motorway: 'paved',
  unclassified: 'paved', service: 'paved', footway: 'paved', pedestrian: 'paved',
  track: 'unpaved', path: 'unpaved', bridleway: 'unpaved',
};

/* ================================================================== *
 * From ORS extras
 * ================================================================== */

export function fromOrsExtras(points, extras) {
  if (!extras) return null;
  const surface = tally(points, extras.surface, (code) => ORS_SURFACE[code] || 'unknown', SURFACE_GROUPS);
  const waytype = tally(points, extras.waytype, (code) => ORS_WAYTYPE[code] || 'unknown', WAY_GROUPS);
  if (!surface && !waytype) return null;
  return { surface, waytype, source: 'OpenRouteService', assumed: 0 };
}

function tally(points, values, mapCode, groups) {
  if (!Array.isArray(values) || !values.length) return null;
  const totals = new Map();
  let total = 0;

  for (const [startIdx, endIdx, code] of values) {
    let segment = 0;
    for (let i = startIdx; i < endIdx && i + 1 < points.length; i++) {
      segment += haversine(points[i], points[i + 1]);
    }
    const group = mapCode(code);
    totals.set(group, (totals.get(group) || 0) + segment);
    total += segment;
  }

  return toBreakdown(totals, total, groups);
}

function toBreakdown(totals, total, groups) {
  return [...totals.entries()]
    .filter(([, d]) => d > 0)
    .map(([id, distance]) => ({
      id,
      label: groups[id]?.label || id,
      color: groups[id]?.color || '#b0b7c0',
      distance,
      share: total > 0 ? distance / total : 0,
    }))
    .sort((a, b) => b.distance - a.distance);
}

/* ================================================================== *
 * From Overpass
 * ================================================================== */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/**
 * Samples the route and asks OSM what is underneath each sample.
 * @param {Array} points route geometry
 * @param {object} opts { onProgress, maxSamples, sampleInterval }
 */
export async function fromOverpass(points, opts = {}) {
  const { onProgress = () => {}, maxSamples = 700 } = opts;
  const { request } = await import('./net.js');

  const total = points[points.length - 1].dist;
  const interval = Math.max(opts.sampleInterval || 120, Math.ceil(total / maxSamples));
  const samples = resampleByDistance(points, interval);

  onProgress(`Asking OpenStreetMap about ${samples.length} points along the route…`);

  const BATCH = 90;
  const batches = [];
  for (let i = 0; i < samples.length; i += BATCH) batches.push(samples.slice(i, i + BATCH));

  let done = 0;
  // Overpass is a donated, shared resource — two at a time, no more.
  const perBatch = await mapLimit(batches, 2, async (batch) => {
    const query =
      `[out:json][timeout:90];(` +
      batch.map((p) => `way(around:25,${p.lat.toFixed(6)},${p.lon.toFixed(6)})[highway];`).join('') +
      `);out tags geom;`;

    let ways = null;
    let lastError;
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const json = await request(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          cacheable: true,
        });
        ways = json?.elements || [];
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (ways === null) throw new Error(`Overpass lookup failed: ${lastError?.message || 'no endpoint responded'}`);

    done += batch.length;
    onProgress(`Surface lookup ${Math.round((done / samples.length) * 100)}%…`);
    return batch.map((p) => classifyPoint(p, ways));
  });

  const classified = perBatch.flat();

  const surfaceTotals = new Map();
  const wayTotals = new Map();
  let totalDist = 0;
  let assumed = 0;

  for (let i = 0; i < classified.length; i++) {
    const span =
      i === 0
        ? (samples[1]?.dist ?? 0) - samples[0].dist
        : samples[i].dist - samples[i - 1].dist;
    if (span <= 0) continue;
    const c = classified[i];
    surfaceTotals.set(c.surface, (surfaceTotals.get(c.surface) || 0) + span);
    wayTotals.set(c.way, (wayTotals.get(c.way) || 0) + span);
    if (c.assumed) assumed += span;
    totalDist += span;
  }

  return {
    surface: toBreakdown(surfaceTotals, totalDist, SURFACE_GROUPS),
    waytype: toBreakdown(wayTotals, totalDist, WAY_GROUPS),
    source: 'OpenStreetMap (Overpass)',
    assumedShare: totalDist > 0 ? assumed / totalDist : 0,
    perSample: classified.map((c, i) => ({ dist: samples[i].dist, ...c })),
  };
}

/** Picks the nearest way to a sample point and reads its tags. */
function classifyPoint(point, ways) {
  let best = null;
  let bestDist = Infinity;

  for (const way of ways) {
    if (!way.geometry) continue;
    for (const node of way.geometry) {
      const d = haversine(point, { lat: node.lat, lon: node.lon });
      if (d < bestDist) { bestDist = d; best = way; }
    }
  }

  if (!best || bestDist > 60) return { surface: 'unknown', way: 'unknown', assumed: false };

  const tags = best.tags || {};
  const highway = tags.highway;
  const wayGroup = OSM_HIGHWAY_TO_GROUP[highway] || 'unknown';

  const rawSurface = tags.surface || tags['cycleway:surface'];
  if (rawSurface) {
    return {
      surface: OSM_SURFACE_TO_GROUP[rawSurface] || 'unknown',
      way: wayGroup,
      assumed: false,
      name: tags.name,
    };
  }

  // No surface tag: infer from the road class, and say so.
  const implied = IMPLIED_SURFACE[highway];
  return {
    surface: implied || 'unknown',
    way: wayGroup,
    assumed: Boolean(implied),
    name: tags.name,
  };
}

/** Weighted rolling-resistance multiplier, feeding the ride-time model. */
export function rideabilityFactor(surfaceBreakdown) {
  if (!surfaceBreakdown?.length) return 1;
  let factor = 0;
  for (const s of surfaceBreakdown) {
    factor += (SURFACE_GROUPS[s.id]?.rideable ?? 0.95) * s.share;
  }
  return factor || 1;
}
