/**
 * Strava segments — client side.
 *
 * The server holds the OAuth credentials (Strava needs client_secret and does
 * not support PKCE), so everything here goes through /api/strava/*. That also
 * means this feature only exists when running `npm start`; the static build has
 * no server to hold the secret.
 *
 * Strava's /segments/explore takes a bounding box and returns at most ten
 * segments, so a route is walked in overlapping boxes. Those boxes catch
 * everything *near* the route, most of which is not on it — a segment on the
 * parallel main road, or the descent you are climbing. The matching below is
 * what makes the result trustworthy.
 */

import { decodePolyline, haversine, computeDistances, bounds as boundsOf } from './util.js';

/** Strava's climb_category is 0–5; 0 means uncategorised, 5 means HC. */
const CATEGORY_LABELS = ['Uncat', 'Cat 4', 'Cat 3', 'Cat 2', 'Cat 1', 'HC'];
const CATEGORY_COLORS = ['#8a94a6', '#2e7d32', '#f9a825', '#ef6c00', '#c62828', '#7b1fa2'];

export const categoryLabel = (c) => CATEGORY_LABELS[c] || 'Uncat';
export const categoryColor = (c) => CATEGORY_COLORS[c] || '#8a94a6';

export async function status() {
  try {
    const res = await fetch('/api/strava/status');
    if (!res.ok) return { configured: false, connected: false };
    return await res.json();
  } catch {
    return { configured: false, connected: false };
  }
}

export async function disconnect() {
  await fetch('/api/strava/logout', { method: 'POST' });
}

/* ------------------------------------------------------------------ *
 * Bounding boxes along the route
 * ------------------------------------------------------------------ */

/**
 * Splits a route into overlapping bounding boxes.
 *
 * `explore` returns only the ten most popular segments per box, so one box
 * around the whole route would miss almost everything on a long ride. Boxes of
 * a few kilometres keep the density of returned segments useful, and the
 * overlap stops a segment straddling a boundary from being missed.
 */
export function routeBoundingBoxes(points, chunkMetres = 4000, padDegrees = 0.004) {
  if (!points.length) return [];
  if (points[0].dist == null) computeDistances(points);

  const boxes = [];
  const total = points[points.length - 1].dist;
  const step = Math.max(1000, chunkMetres);

  for (let start = 0; start < total; start += step * 0.75) { // 25% overlap
    const end = Math.min(total, start + step);
    const slice = points.filter((p) => p.dist >= start && p.dist <= end);
    if (slice.length < 2) continue;

    const [[minLat, minLon], [maxLat, maxLon]] = boundsOf(slice);
    boxes.push([
      +(minLat - padDegrees).toFixed(5),
      +(minLon - padDegrees).toFixed(5),
      +(maxLat + padDegrees).toFixed(5),
      +(maxLon + padDegrees).toFixed(5),
    ]);
    if (end >= total) break;
  }
  return boxes;
}

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

/**
 * Builds a coarse spatial index so matching does not become O(segments × points).
 * Cell size is roughly `cellMetres` at the route's latitude.
 */
function buildIndex(points, cellMetres = 100) {
  const latSize = cellMetres / 111_320;
  const midLat = points[Math.floor(points.length / 2)].lat;
  const lonSize = cellMetres / (111_320 * Math.cos((midLat * Math.PI) / 180) || 1);
  const cells = new Map();

  points.forEach((p, i) => {
    const key = `${Math.floor(p.lat / latSize)}/${Math.floor(p.lon / lonSize)}`;
    let bucket = cells.get(key);
    if (!bucket) cells.set(key, (bucket = []));
    bucket.push(i);
  });

  return {
    nearest(pt) {
      const cy = Math.floor(pt.lat / latSize);
      const cx = Math.floor(pt.lon / lonSize);
      let best = null;
      let bestDist = Infinity;
      // Search the cell and its eight neighbours.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = cells.get(`${cy + dy}/${cx + dx}`);
          if (!bucket) continue;
          for (const i of bucket) {
            const d = haversine(points[i], pt);
            if (d < bestDist) { bestDist = d; best = i; }
          }
        }
      }
      return best == null ? null : { index: best, distance: bestDist };
    },
  };
}

/**
 * Decides whether a Strava segment lies on the route, and which way round.
 *
 * A segment counts as matched when nearly all of its points sit within
 * `toleranceMetres` of the route AND its own start-to-end order agrees with the
 * direction of travel. The direction test matters: segments are directional, so
 * the descent of a climb you are riding up is a different segment and should
 * not be reported as being on your route.
 */
export function matchSegment(segment, routePoints, index, opts = {}) {
  const { toleranceMetres = 25, minCoverage = 0.9 } = opts;

  let pts;
  try {
    pts = decodePolyline(segment.points);
  } catch {
    return null;
  }
  if (pts.length < 2) return null;

  // Sample rather than test every vertex — segment polylines can be dense and
  // the answer does not change.
  const stride = Math.max(1, Math.floor(pts.length / 60));
  const sampled = [];
  for (let i = 0; i < pts.length; i += stride) sampled.push(pts[i]);
  if (sampled[sampled.length - 1] !== pts[pts.length - 1]) sampled.push(pts[pts.length - 1]);

  let within = 0;
  let sumDist = 0;
  const routeDistances = [];

  for (const p of sampled) {
    const hit = index.nearest(p);
    if (!hit) continue;
    if (hit.distance <= toleranceMetres) {
      within++;
      sumDist += hit.distance;
      routeDistances.push(routePoints[hit.index].dist);
    }
  }

  const coverage = within / sampled.length;
  if (coverage < minCoverage || routeDistances.length < 2) return null;

  const startDist = routeDistances[0];
  const endDist = routeDistances[routeDistances.length - 1];

  // Direction: the segment's end must lie further along the route than its
  // start. A tolerance guards against jitter on very short segments.
  if (endDist - startDist < Math.max(50, segment.distance * 0.4)) return null;

  return {
    ...segment,
    coverage,
    meanOffset: within ? sumDist / within : null,
    startDist: Math.min(startDist, endDist),
    endDist: Math.max(startDist, endDist),
    categoryLabel: categoryLabel(segment.climbCategory),
    categoryColor: categoryColor(segment.climbCategory),
    latlngs: pts,
  };
}

/**
 * Finds Strava segments that lie along the route.
 * @param {Array} routePoints  full route geometry
 * @param {object} opts { activityType, onProgress, toleranceMetres }
 */
export async function findSegments(routePoints, opts = {}) {
  const { activityType = 'riding', onProgress = () => {} } = opts;
  if (routePoints.length < 2) throw new Error('Build a route first.');
  if (routePoints[0].dist == null) computeDistances(routePoints);

  const boxes = routeBoundingBoxes(routePoints);
  onProgress(`Asking Strava about ${boxes.length} sections of the route…`);

  const res = await fetch('/api/strava/explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bboxes: boxes, activityType }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || `Strava lookup failed (${res.status}).`);

  onProgress(`Checking which of ${json.segments.length} nearby segments are actually on your route…`);

  const index = buildIndex(routePoints);
  const matched = [];
  for (const seg of json.segments) {
    const m = matchSegment(seg, routePoints, index, opts);
    if (m) matched.push(m);
  }
  matched.sort((a, b) => a.startDist - b.startDist);

  return {
    segments: matched,
    considered: json.segments.length,
    boxes: boxes.length,
    requests: json.requests,
    rateLimited: json.rateLimited,
    truncated: json.truncated,
  };
}

/** Full detail for one segment, including your own stats if you have ridden it. */
export async function segmentDetail(id) {
  const res = await fetch(`/api/strava/segment/${encodeURIComponent(id)}`);
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error || `Could not load segment ${id}.`);
  return json;
}
