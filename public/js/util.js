/**
 * Geometry, resampling and formatting helpers.
 *
 * A "point" throughout the app is a plain object { lat, lon, ele?, dist? }
 * where `dist` is cumulative metres from the route start once computed.
 */

export const EARTH_R = 6371008.8; // IUGG mean radius, metres

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres between two points. */
export function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing a→b in degrees (0 = north). */
export function bearing(a, b) {
  const dLon = toRad(b.lon - a.lon);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Writes cumulative distance (metres from start) onto each point and returns
 * the same array. Mutates for speed — these arrays get large.
 */
export function computeDistances(points) {
  if (!points.length) return points;
  points[0].dist = 0;
  for (let i = 1; i < points.length; i++) {
    points[i].dist = points[i - 1].dist + haversine(points[i - 1], points[i]);
  }
  return points;
}

export function totalDistance(points) {
  if (points.length < 2) return 0;
  const last = points[points.length - 1];
  return last.dist != null ? last.dist : computeDistances(points)[points.length - 1].dist;
}

/** Bounding box as [[minLat, minLon], [maxLat, maxLon]]. */
export function bounds(points) {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return [[minLat, minLon], [maxLat, maxLon]];
}

/* ------------------------------------------------------------------ *
 * Encoded polylines (Google / OSRM)
 * ------------------------------------------------------------------ */

/**
 * Decodes an encoded polyline. `precision` is 5 for Google and OSRM v5
 * defaults, 6 for OSRM's polyline6 and Valhalla.
 */
export function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision;
  const out = [];
  let index = 0, lat = 0, lon = 0;

  while (index < str.length) {
    let result = 1, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < str.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < str.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Resampling & smoothing
 * ------------------------------------------------------------------ */

/**
 * Resamples a track to evenly spaced points every `interval` metres.
 * Used to give the elevation analysis a uniform x-axis — without this,
 * ascent totals are biased by however densely the router happened to
 * place vertices.
 */
export function resampleByDistance(points, interval = 10) {
  if (points.length < 2) return points.slice();
  if (points[0].dist == null) computeDistances(points);

  const total = points[points.length - 1].dist;
  const out = [{ ...points[0], dist: 0 }];
  let seg = 1;

  for (let d = interval; d < total; d += interval) {
    while (seg < points.length - 1 && points[seg].dist < d) seg++;
    const a = points[seg - 1];
    const b = points[seg];
    const span = b.dist - a.dist;
    const t = span > 0 ? (d - a.dist) / span : 0;
    out.push({
      lat: lerp(a.lat, b.lat, t),
      lon: lerp(a.lon, b.lon, t),
      ele: a.ele != null && b.ele != null ? lerp(a.ele, b.ele, t) : (a.ele ?? b.ele),
      dist: d,
      srcIndex: seg - 1,
    });
  }
  out.push({ ...points[points.length - 1], dist: total });
  return out;
}

/**
 * Reads an elevation off a distance→elevation series at an arbitrary distance.
 * `series` must be sorted ascending by `dist`.
 */
export function elevationAt(series, dist) {
  if (!series.length) return null;
  if (dist <= series[0].dist) return series[0].ele;
  const last = series[series.length - 1];
  if (dist >= last.dist) return last.ele;

  let lo = 0, hi = series.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (series[mid].dist <= dist) lo = mid;
    else hi = mid;
  }
  const a = series[lo], b = series[hi];
  const span = b.dist - a.dist;
  return span > 0 ? lerp(a.ele, b.ele, (dist - a.dist) / span) : a.ele;
}

/**
 * Distance-aware median filter over the elevation channel.
 *
 * Terrain models contain isolated bad cells — a pixel of cliff face where the
 * road actually runs, a void filled by interpolation. A moving *average*
 * cannot remove these: it spreads one bad sample across the whole window,
 * turning a spike into a sustained ramp. Measured on an alpine valley road,
 * mean-only smoothing left a 37% "sustained" gradient that does not exist.
 *
 * A median is the standard remedy for impulse noise: it discards outliers
 * outright while leaving genuine edges — the real start of a steep ramp —
 * intact. Run this first, then the mean filter for general smoothness.
 */
export function medianFilterElevation(points, windowMetres = 60) {
  if (points.length < 5) return points.map((p) => ({ ...p }));
  const half = windowMetres / 2;
  const out = new Array(points.length);
  let lo = 0;
  let hi = 0;

  for (let i = 0; i < points.length; i++) {
    const d = points[i].dist;
    while (hi < points.length && points[hi].dist <= d + half) hi++;
    while (points[lo].dist < d - half) lo++;

    const window = [];
    for (let j = lo; j < hi; j++) {
      if (points[j].ele != null) window.push(points[j].ele);
    }
    if (!window.length) { out[i] = { ...points[i] }; continue; }
    window.sort((a, b) => a - b);
    const mid = window.length >> 1;
    const median = window.length % 2 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
    out[i] = { ...points[i], ele: median };
  }
  return out;
}

/**
 * Distance-aware moving average over the elevation channel.
 *
 * DEM samples carry several metres of vertical noise; summing raw
 * point-to-point rises inflates total ascent badly (the classic "my GPS says
 * 1400 m, Strava says 900 m" problem). Averaging over a fixed *ground
 * distance* window rather than a fixed point count keeps the filter
 * consistent regardless of vertex density.
 */
export function smoothElevation(points, windowMetres = 75) {
  if (points.length < 3) return points.map((p) => ({ ...p }));
  const half = windowMetres / 2;
  const out = new Array(points.length);
  let lo = 0, hi = 0, sum = 0, count = 0;

  for (let i = 0; i < points.length; i++) {
    const d = points[i].dist;
    while (hi < points.length && points[hi].dist <= d + half) {
      if (points[hi].ele != null) { sum += points[hi].ele; count++; }
      hi++;
    }
    while (points[lo].dist < d - half) {
      if (points[lo].ele != null) { sum -= points[lo].ele; count--; }
      lo++;
    }
    out[i] = { ...points[i], ele: count > 0 ? sum / count : points[i].ele };
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Simplification
 * ------------------------------------------------------------------ */

/** Perpendicular distance from p to segment a→b, in metres (planar approx). */
function perpendicularDistance(p, a, b) {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos(toRad(p.lat));
  const px = p.lon * mPerDegLon, py = p.lat * mPerDegLat;
  const ax = a.lon * mPerDegLon, ay = a.lat * mPerDegLat;
  const bx = b.lon * mPerDegLon, by = b.lat * mPerDegLat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Ramer–Douglas–Peucker over the ground track. Iterative rather than
 * recursive so it cannot blow the stack on the 100k-point tracks that long
 * routes produce.
 *
 * Returns a keep-mask so callers can union several passes together.
 */
export function simplifyMask(points, toleranceMetres = 1) {
  const keep = new Uint8Array(points.length);
  if (points.length === 0) return keep;
  keep[0] = keep[points.length - 1] = 1;
  if (points.length < 3 || toleranceMetres <= 0) return keep.fill(1);

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0, index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpendicularDistance(points[i], points[first], points[last]);
      if (d > maxDist) { maxDist = d; index = i; }
    }
    if (maxDist > toleranceMetres && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return keep;
}

/**
 * RDP over the elevation profile, measuring *vertical* error against the line
 * that would be interpolated between the kept points. The tolerance therefore
 * means exactly what it says: "no point's elevation is ever misrepresented by
 * more than N metres".
 *
 * This pass is what stops a dead-straight road over a mountain pass from
 * collapsing to two points — plan-view RDP sees a straight line and throws the
 * entire climb away.
 */
export function simplifyProfileMask(points, toleranceMetres = 1.5) {
  const keep = new Uint8Array(points.length);
  if (points.length === 0) return keep;
  keep[0] = keep[points.length - 1] = 1;
  if (points.length < 3 || toleranceMetres <= 0) return keep.fill(1);
  if (!points.some((p) => p.ele != null)) return keep;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    const a = points[first], b = points[last];
    const span = (b.dist ?? 0) - (a.dist ?? 0);
    let maxErr = 0, index = -1;

    for (let i = first + 1; i < last; i++) {
      const p = points[i];
      if (p.ele == null) continue;
      const t = span > 0 ? ((p.dist ?? 0) - (a.dist ?? 0)) / span : 0;
      const err = Math.abs(p.ele - lerp(a.ele ?? p.ele, b.ele ?? p.ele, t));
      if (err > maxErr) { maxErr = err; index = i; }
    }
    if (maxErr > toleranceMetres && index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return keep;
}

/**
 * Simplifies while protecting both the ground track and the elevation profile.
 * A point survives if either pass wants to keep it.
 */
export function simplify(points, toleranceMetres = 1, elevationToleranceMetres = null) {
  if (points.length < 3 || toleranceMetres <= 0) return points.slice();
  const planar = simplifyMask(points, toleranceMetres);
  // Cap the vertical tolerance: a slack ground tolerance is fine on a straight
  // road, but letting elevation error grow with it would undo the point.
  const eleTol = elevationToleranceMetres ?? clamp(toleranceMetres / 4, 0.75, 3);
  const vertical = simplifyProfileMask(points, eleTol);
  return points.filter((_, i) => planar[i] || vertical[i]);
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

export function fmtDistance(metres, units = 'metric') {
  if (metres == null || !isFinite(metres)) return '—';
  if (units === 'imperial') {
    const mi = metres / 1609.344;
    return mi < 0.1 ? `${Math.round(metres * 3.28084)} ft` : `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
  }
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
}

export function fmtElevation(metres, units = 'metric') {
  if (metres == null || !isFinite(metres)) return '—';
  return units === 'imperial'
    ? `${Math.round(metres * 3.28084).toLocaleString()} ft`
    : `${Math.round(metres).toLocaleString()} m`;
}

export function fmtSpeed(kmh, units = 'metric') {
  if (kmh == null || !isFinite(kmh)) return '—';
  return units === 'imperial' ? `${(kmh / 1.609344).toFixed(1)} mph` : `${kmh.toFixed(1)} km/h`;
}

export function fmtDuration(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m} min`;
  return `${h}h ${String(m === 60 ? 59 : m).padStart(2, '0')}m`;
}

export function fmtGradient(fraction) {
  if (fraction == null || !isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(1)}%`;
}

/** Concurrency-limited map — keeps us polite to free public APIs. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
