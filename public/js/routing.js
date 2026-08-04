/**
 * Routing engines behind a single interface.
 *
 * All three snap waypoints to the real OSM road/path network. They differ in
 * what they know about cycling:
 *
 *   ors      – OpenRouteService. Best profiles, and the only one that hands
 *              back surface + waytype tags for free. Needs a free API key.
 *   brouter  – BRouter. No key, genuinely cycling-first profiles, and returns
 *              SRTM elevation baked into the geometry.
 *   osrm     – FOSSGIS OSRM bike server (the one osm.org itself uses). No key,
 *              fast, but a single generic bike profile and no elevation.
 *
 * Every engine returns the same shape:
 *   { points: [{lat, lon, ele?}], distance, ascent?, descent?, duration?,
 *     extras?: { surface, waytype, steepness }, engine, profile }
 */

import { request } from './net.js';
import { computeDistances, haversine, mapLimit } from './util.js';

export const ENGINES = {
  ors: {
    id: 'ors',
    label: 'OpenRouteService',
    needsKey: true,
    hasElevation: true,
    hasSurface: true,
    maxWaypoints: 50,
    blurb: 'Best cycling profiles + surface data. Free key, 2 000 routes/day.',
    profiles: [
      { id: 'cycling-regular', label: 'Bike — regular' },
      { id: 'cycling-road', label: 'Bike — road' },
      { id: 'cycling-mountain', label: 'Bike — mountain' },
      { id: 'cycling-electric', label: 'Bike — e-bike' },
      { id: 'foot-hiking', label: 'Foot — hiking' },
    ],
  },
  brouter: {
    id: 'brouter',
    label: 'BRouter',
    needsKey: false,
    hasElevation: true,
    hasSurface: false,
    maxWaypoints: 200,
    blurb: 'No key needed. Cycling-first profiles with elevation included.',
    profiles: [
      { id: 'trekking', label: 'Trekking (balanced)' },
      { id: 'fastbike', label: 'Fast bike (speed)' },
      { id: 'fastbike-lowtraffic', label: 'Fast bike — low traffic' },
      { id: 'safety', label: 'Safety (quiet roads)' },
      { id: 'trekking-steep', label: 'Trekking — accepts steep' },
      { id: 'trekking-nosteps', label: 'Trekking — no steps' },
      { id: 'shortest', label: 'Shortest' },
      { id: 'hiking-beta', label: 'Hiking' },
    ],
  },
  osrm: {
    id: 'osrm',
    label: 'OSRM (OSM bike server)',
    needsKey: false,
    hasElevation: false,
    hasSurface: false,
    maxWaypoints: 100,
    blurb: 'No key needed. Fast and reliable; elevation fetched separately.',
    profiles: [
      { id: 'routed-bike', label: 'Bike' },
      { id: 'routed-foot', label: 'Foot' },
    ],
  },
  direct: {
    id: 'direct',
    label: 'Straight lines (no routing)',
    needsKey: false,
    hasElevation: false,
    hasSurface: false,
    maxWaypoints: 10000,
    blurb: 'Joins your points directly. Useful for open terrain or debugging.',
    profiles: [{ id: 'direct', label: 'Direct' }],
  },
};

export function defaultProfile(engineId) {
  return ENGINES[engineId]?.profiles[0].id;
}

/**
 * Routes through the given waypoints.
 * @param {Array<{lat,lon}>} waypoints
 * @param {object} opts { engine, profile, apiKey, avoid, onProgress }
 */
export async function route(waypoints, opts = {}) {
  const { engine = 'brouter', profile, apiKey = '', onProgress = () => {} } = opts;
  if (waypoints.length < 2) throw new Error('At least two waypoints are needed to build a route.');

  const spec = ENGINES[engine];
  if (!spec) throw new Error(`Unknown routing engine "${engine}".`);
  if (spec.needsKey && !apiKey) {
    throw new Error(`${spec.label} needs an API key. Add one in Settings, or switch to BRouter/OSRM which need no key.`);
  }

  const prof = profile || defaultProfile(engine);
  const chunks = chunkWaypoints(waypoints, spec.maxWaypoints);
  if (chunks.length > 1) {
    onProgress(`Route is long — sending it to ${spec.label} in ${chunks.length} parts…`);
  }

  const impl = { ors: routeOrs, brouter: routeBrouter, osrm: routeOsrm, direct: routeDirect }[engine];

  const legs = [];
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) onProgress(`Routing part ${i + 1} of ${chunks.length}…`);
    legs.push(await impl(chunks[i], prof, apiKey));
  }

  const merged = mergeLegs(legs);
  merged.engine = engine;
  merged.engineLabel = spec.label;
  merged.profile = prof;
  merged.profileLabel = spec.profiles.find((p) => p.id === prof)?.label || prof;
  computeDistances(merged.points);
  merged.distance = merged.points[merged.points.length - 1].dist;
  return merged;
}

/** Splits into overlapping chunks so joined legs stay continuous. */
function chunkWaypoints(waypoints, max) {
  if (waypoints.length <= max) return [waypoints];
  const chunks = [];
  for (let start = 0; start < waypoints.length - 1; start += max - 1) {
    chunks.push(waypoints.slice(start, Math.min(start + max, waypoints.length)));
  }
  return chunks;
}

/** Concatenates legs, dropping the duplicated join point and re-basing extras. */
function mergeLegs(legs) {
  if (legs.length === 1) return legs[0];
  const points = [];
  const extras = { surface: [], waytype: [], steepness: [] };
  let ascent = 0, descent = 0, duration = 0;
  let anyExtras = false;

  for (const leg of legs) {
    // Chunks overlap by one waypoint, so every leg after the first repeats the
    // previous leg's final point. `offset` is where this leg's local index 0
    // lands in the merged array, which is exactly that shared join point.
    const offset = points.length ? points.length - 1 : 0;
    points.push(...(points.length ? leg.points.slice(1) : leg.points));

    ascent += leg.ascent || 0;
    descent += leg.descent || 0;
    duration += leg.duration || 0;
    if (leg.extras) {
      anyExtras = true;
      for (const key of Object.keys(extras)) {
        for (const [s, e, v] of leg.extras[key] || []) extras[key].push([s + offset, e + offset, v]);
      }
    }
  }
  return {
    points,
    ascent: ascent || undefined,
    descent: descent || undefined,
    duration: duration || undefined,
    extras: anyExtras ? extras : null,
  };
}

/* ------------------------------------------------------------------ *
 * OpenRouteService
 * ------------------------------------------------------------------ */

async function routeOrs(waypoints, profile, apiKey) {
  const body = {
    coordinates: waypoints.map((w) => [round6(w.lon), round6(w.lat)]),
    elevation: true,
    instructions: false,
    extra_info: ['surface', 'waytype', 'steepness'],
    geometry_simplify: false,
  };

  const json = await request(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
    method: 'POST',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/geo+json',
    },
    body,
    cacheable: true,
  });

  const feature = json?.features?.[0];
  if (!feature) throw new Error('OpenRouteService returned no route.');

  const points = feature.geometry.coordinates.map(([lon, lat, ele]) => ({
    lat,
    lon,
    ele: Number.isFinite(ele) ? ele : undefined,
  }));

  const props = feature.properties || {};
  return {
    points,
    ascent: props.ascent,
    descent: props.descent,
    duration: props.summary?.duration,
    hasElevation: points.some((p) => p.ele != null),
    extras: {
      surface: props.extras?.surface?.values || [],
      waytype: props.extras?.waytype?.values || [],
      steepness: props.extras?.steepness?.values || [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * BRouter
 * ------------------------------------------------------------------ */

async function routeBrouter(waypoints, profile) {
  const lonlats = waypoints.map((w) => `${round6(w.lon)},${round6(w.lat)}`).join('|');
  const url =
    `https://brouter.de/brouter?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;

  const json = await request(url, { cacheable: true });
  const feature = json?.features?.[0];
  if (!feature) {
    throw new Error('BRouter returned no route. It may not have map data for that area, or a point is unreachable.');
  }

  const points = feature.geometry.coordinates.map(([lon, lat, ele]) => ({
    lat,
    lon,
    ele: Number.isFinite(ele) ? ele : undefined,
  }));

  const p = feature.properties || {};
  const num = (v) => (v == null ? undefined : Number(v) || undefined);
  return {
    points,
    // BRouter's "filtered ascend" is already noise-filtered and is the honest number.
    ascent: num(p['filtered ascend']) ?? num(p['plain-ascend']),
    duration: num(p['total-time']),
    hasElevation: points.some((p2) => p2.ele != null),
    extras: null,
  };
}

/* ------------------------------------------------------------------ *
 * OSRM (FOSSGIS public bike server)
 * ------------------------------------------------------------------ */

async function routeOsrm(waypoints, profile) {
  const coords = waypoints.map((w) => `${round6(w.lon)},${round6(w.lat)}`).join(';');
  // The profile segment in the OSRM path is ignored; the server instance
  // (routed-bike / routed-foot) is what selects the profile.
  const url =
    `https://routing.openstreetmap.de/${profile}/route/v1/driving/${coords}` +
    `?overview=full&geometries=geojson&steps=false&annotations=false`;

  const json = await request(url, { cacheable: true });
  if (json?.code && json.code !== 'Ok') {
    throw new Error(`OSRM could not route this: ${json.message || json.code}`);
  }
  const r = json?.routes?.[0];
  if (!r) throw new Error('OSRM returned no route.');

  return {
    points: r.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
    duration: r.duration,
    hasElevation: false,
    extras: null,
  };
}

/* ------------------------------------------------------------------ *
 * Direct lines
 * ------------------------------------------------------------------ */

async function routeDirect(waypoints) {
  // Densify so elevation sampling and gradient analysis still have something
  // to work with between distant points.
  const points = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const steps = Math.max(1, Math.min(500, Math.round(haversine(a, b) / 25)));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      points.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
  }
  const last = waypoints[waypoints.length - 1];
  points.push({ lat: last.lat, lon: last.lon });
  return { points, hasElevation: false, extras: null };
}

const round6 = (v) => Math.round(v * 1e6) / 1e6;

/**
 * Snaps arbitrary points to the nearest routable way. Used when the user drops
 * a pin in the middle of a field — keeps the router from silently detouring.
 */
export async function snapToRoad(points, engineId = 'osrm') {
  if (engineId !== 'osrm') return points;
  return mapLimit(points, 4, async (p) => {
    try {
      const json = await request(
        `https://routing.openstreetmap.de/routed-bike/nearest/v1/driving/${round6(p.lon)},${round6(p.lat)}?number=1`,
        { cacheable: true }
      );
      const wp = json?.waypoints?.[0];
      if (wp?.location) return { ...p, lat: wp.location[1], lon: wp.location[0] };
    } catch { /* keep the original point */ }
    return p;
  });
}
