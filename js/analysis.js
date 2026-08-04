/**
 * Route analysis: ascent, climbs, gradient distribution.
 *
 * The hard part of "total ascent" is that it is not a well-defined number —
 * it depends entirely on how much vertical noise you choose to ignore. Sum
 * every raw DEM wiggle over a 100 km route and you can invent 800 m of
 * climbing that does not exist. So the pipeline is deliberate:
 *
 *   1. resample to a uniform ground interval  (removes vertex-density bias)
 *   2. smooth over a distance window          (removes DEM sampling noise)
 *   3. accumulate with a hysteresis threshold (ignores sub-threshold ripples)
 *
 * Both the filtered and the raw figure are reported so the number is honest
 * rather than merely flattering.
 */

import {
  computeDistances,
  resampleByDistance,
  medianFilterElevation,
  smoothElevation,
  clamp,
} from './util.js';

/**
 * Smoothing defaults are tuned against real switchback climbs, not synthetic
 * data. On hairpins a 30–90 m DEM cannot resolve the road: consecutive road
 * points 300 m apart along the tarmac sit only tens of metres apart
 * horizontally, so the terrain model reads the mountainside dropping away
 * between bends. The elevation profile then oscillates about the true steady
 * gradient with a wavelength of a few hundred metres.
 *
 * Measured on Alpe d'Huez (a climb that never descends), the share of the
 * profile falsely reading as downhill falls 4.3% → 0% moving from a 75/50 m
 * pair to 150/200 m, and steepest-sustained-100 m drops from an impossible
 * 19.2% to ~15% against the climb's real ~13% maximum. Total ascent moves by
 * only 5 m across that whole range, so the hysteresis filter — not the
 * smoothing — is what protects the headline numbers.
 */
export const DEFAULTS = {
  sampleInterval: 10,     // m — profile resolution
  medianWindow: 90,       // m — despiking window, removes bad DEM cells
  smoothWindow: 150,      // m — elevation moving-average window
  ascentThreshold: 3,     // m — ignore rises smaller than this
  gradeWindow: 200,       // m — window for the displayed gradient
  climbProminence: 10,    // m — vertical prominence for a real summit
  minClimbGain: 25,       // m
  minClimbLength: 400,    // m
  minClimbGrade: 0.025,   // 2.5 %
  mergeMaxDip: 0.25,      // merge climbs if the dip is < 25 % of combined gain
  mergeMaxGapDist: 1500,  // m — …and the dip is shorter than this
};

/** Gradient bands used for the distribution chart and the profile colouring. */
export const GRADIENT_BANDS = [
  { id: 'd4', label: '< −12%', min: -Infinity, max: -0.12, color: '#1b6ca8', descent: true },
  { id: 'd3', label: '−12 … −9%', min: -0.12, max: -0.09, color: '#2585c4', descent: true },
  { id: 'd2', label: '−9 … −6%', min: -0.09, max: -0.06, color: '#41a5e0', descent: true },
  { id: 'd1', label: '−6 … −3%', min: -0.06, max: -0.03, color: '#7cc6ec', descent: true },
  { id: 'f', label: '−3 … 3%', min: -0.03, max: 0.03, color: '#8fbf6d' },
  { id: 'u1', label: '3 … 6%', min: 0.03, max: 0.06, color: '#e3c04a' },
  { id: 'u2', label: '6 … 9%', min: 0.06, max: 0.09, color: '#e88b3a' },
  { id: 'u3', label: '9 … 12%', min: 0.09, max: 0.12, color: '#dd5a33' },
  { id: 'u4', label: '12 … 15%', min: 0.12, max: 0.15, color: '#c02f2f' },
  { id: 'u5', label: '> 15%', min: 0.15, max: Infinity, color: '#8b1a1a' },
];

export function bandFor(grade) {
  for (const b of GRADIENT_BANDS) if (grade >= b.min && grade < b.max) return b;
  return GRADIENT_BANDS[GRADIENT_BANDS.length - 1];
}

/* ================================================================== *
 * Main entry
 * ================================================================== */

export function analyse(points, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  if (!points || points.length < 2) throw new Error('Not enough points to analyse.');
  if (points[0].dist == null) computeDistances(points);

  const distance = points[points.length - 1].dist;
  const hasElevation = points.some((p) => p.ele != null);

  if (!hasElevation) {
    return {
      distance,
      hasElevation: false,
      profile: [],
      climbs: [],
      bands: GRADIENT_BANDS.map((b) => ({ ...b, distance: 0, share: 0 })),
    };
  }

  // Keep the profile bounded on very long routes so the chart stays responsive.
  const interval = Math.max(opt.sampleInterval, Math.ceil(distance / 20000));
  const sampled = resampleByDistance(points, interval);
  // Median first to throw out bad DEM cells, then mean to smooth what remains.
  // Order matters: averaging first would blend an outlier into its neighbours
  // and put it beyond the median's reach.
  const despiked = medianFilterElevation(sampled, opt.medianWindow);
  const smoothed = smoothElevation(despiked, opt.smoothWindow);

  const grades = computeGrades(smoothed, opt.gradeWindow);
  const profile = smoothed.map((p, i) => ({
    dist: p.dist,
    ele: p.ele,
    lat: p.lat,
    lon: p.lon,
    grade: grades[i],
  }));

  const filtered = accumulate(smoothed, opt.ascentThreshold);
  const raw = accumulate(sampled, 0);

  const elevations = smoothed.map((p) => p.ele).filter(Number.isFinite);
  const minEle = Math.min(...elevations);
  const maxEle = Math.max(...elevations);

  const climbs = detectClimbs(profile, opt);
  const bands = gradientDistribution(profile);

  const steepestClimbGrade = climbs.reduce((m, c) => Math.max(m, c.maxGrade), 0);
  const steepest100 = steepestSustained(profile, 100);

  return {
    distance,
    hasElevation: true,
    interval,
    profile,
    ascent: filtered.ascent,
    descent: filtered.descent,
    ascentRaw: raw.ascent,
    descentRaw: raw.descent,
    minEle,
    maxEle,
    startEle: smoothed[0].ele,
    endEle: smoothed[smoothed.length - 1].ele,
    netElevation: smoothed[smoothed.length - 1].ele - smoothed[0].ele,
    climbs,
    climbCount: climbs.length,
    bands,
    steepestClimbGrade,
    // Steepest *sustained* 100 m. The instantaneous maximum below is a single
    // ±25 m sample and on switchbacks it is usually a DEM artefact, not a
    // gradient anyone rides — so this is the figure worth showing a rider.
    steepest100,
    maxGrade: Math.max(...grades),
    minGrade: Math.min(...grades),
    // metres of climbing per kilometre — the usual "how hilly is this" yardstick
    climbRate: distance > 0 ? filtered.ascent / (distance / 1000) : 0,
    difficulty: routeDifficulty(filtered.ascent, distance, climbs),
  };
}

/* ================================================================== *
 * Gradient
 * ================================================================== */

/**
 * Central-difference gradient over a fixed ground window. Point-to-point
 * slope on a 10 m spacing is dominated by DEM quantisation; a ±25 m window
 * gives a number that matches what a rider actually feels.
 */
function computeGrades(profile, windowMetres) {
  const n = profile.length;
  const grades = new Array(n).fill(0);
  if (n < 2) return grades;

  const step = Math.max(1, Math.round(windowMetres / 2 / Math.max(1, profile[1].dist - profile[0].dist)));

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - step);
    const hi = Math.min(n - 1, i + step);
    const run = profile[hi].dist - profile[lo].dist;
    const rise = profile[hi].ele - profile[lo].ele;
    // Clamp to ±40 %: anything beyond that is a bridge, tunnel or DEM artefact.
    grades[i] = run > 0 ? clamp(rise / run, -0.4, 0.4) : 0;
  }
  return grades;
}

/**
 * Steep gradient held continuously over `windowMetres`, reported as a high
 * percentile rather than the outright maximum.
 *
 * Why not the maximum: where a road switchbacks tightly on a steep face, no
 * terrain model can resolve the tarmac — consecutive road points are far apart
 * along the road but nearly on top of each other horizontally, so the model
 * reads the mountainside between the bends. Checked against OpenStreetMap, the
 * worst offender on one test route sits on an asphalt secondary road whose real
 * maximum is about 13%, yet both Copernicus and SRTM independently report over
 * 28% there. It is not noise that filtering can remove — the true elevation is
 * simply absent from the data.
 *
 * A percentile ignores that handful of unresolvable points while still
 * reflecting genuinely steep sections, so the number stays useful and stops
 * claiming gradients no public road has.
 */
function steepestSustained(profile, windowMetres, percentile = 0.98) {
  if (profile.length < 2) return 0;
  const spacing = Math.max(1, profile[1].dist - profile[0].dist);
  const win = Math.max(1, Math.round(windowMetres / spacing));

  const grades = [];
  for (let i = 0; i + win < profile.length; i++) {
    const run = profile[i + win].dist - profile[i].dist;
    if (run <= 0) continue;
    grades.push((profile[i + win].ele - profile[i].ele) / run);
  }
  if (!grades.length) return 0;

  grades.sort((a, b) => a - b);
  // Too few windows to talk about percentiles — fall back to the maximum.
  if (grades.length < 25) return grades[grades.length - 1];
  return grades[Math.min(grades.length - 1, Math.floor(grades.length * percentile))];
}

function gradientDistribution(profile) {
  const totals = new Map(GRADIENT_BANDS.map((b) => [b.id, 0]));
  let total = 0;

  for (let i = 1; i < profile.length; i++) {
    const seg = profile[i].dist - profile[i - 1].dist;
    if (seg <= 0) continue;
    const grade = (profile[i].grade + profile[i - 1].grade) / 2;
    const band = bandFor(grade);
    totals.set(band.id, totals.get(band.id) + seg);
    total += seg;
  }

  return GRADIENT_BANDS.map((b) => ({
    ...b,
    distance: totals.get(b.id),
    share: total > 0 ? totals.get(b.id) / total : 0,
  }));
}

/* ================================================================== *
 * Ascent accumulation
 * ================================================================== */

/**
 * Sums rises and falls, ignoring reversals smaller than `threshold` metres.
 * A threshold of 0 gives the raw (over-counted) figure.
 */
function accumulate(profile, threshold) {
  let ascent = 0;
  let descent = 0;
  const n = profile.length;
  if (n < 2) return { ascent, descent };

  if (threshold <= 0) {
    // Raw mode: take every step at face value. This is the number that
    // over-counts, kept only for comparison against the filtered figure.
    for (let i = 1; i < n; i++) {
      const d = profile[i].ele - profile[i - 1].ele;
      if (!Number.isFinite(d)) continue;
      if (d > 0) ascent += d; else descent -= d;
    }
    return { ascent, descent };
  }

  let dir = 0;      // 1 = climbing, -1 = descending, 0 = undecided
  let ref = profile[0].ele;   // elevation of the last confirmed turning point
  let cur = profile[0].ele;   // running extreme in the current direction
  let minSoFar = profile[0].ele;
  let maxSoFar = profile[0].ele;

  for (let i = 1; i < n; i++) {
    const e = profile[i].ele;
    if (!Number.isFinite(e)) continue;

    if (dir === 1) {
      if (e > cur) cur = e;
      else if (e <= cur - threshold) {
        ascent += cur - ref;
        ref = cur;
        cur = e;
        dir = -1;
      }
    } else if (dir === -1) {
      if (e < cur) cur = e;
      else if (e >= cur + threshold) {
        descent += ref - cur;
        ref = cur;
        cur = e;
        dir = 1;
      }
    } else {
      minSoFar = Math.min(minSoFar, e);
      maxSoFar = Math.max(maxSoFar, e);
      // Measure the first move from whichever extreme it departed from, so a
      // route that drifts down before climbing still counts the full climb.
      if (e >= minSoFar + threshold) {
        dir = 1; ref = minSoFar; cur = e;
      } else if (e <= maxSoFar - threshold) {
        dir = -1; ref = maxSoFar; cur = e;
      }
    }
  }

  if (dir === 1) ascent += cur - ref;
  else if (dir === -1) descent += ref - cur;

  return { ascent, descent };
}

/* ================================================================== *
 * Climb detection
 * ================================================================== */

/**
 * Alternating minima/maxima, filtered by vertical prominence so that a bumpy
 * false flat does not register as forty separate summits.
 */
function findExtrema(profile, prominence) {
  const extrema = [];
  if (profile.length < 2) return extrema;

  let dir = 0;
  let extIdx = 0;
  let minIdx = 0;
  let maxIdx = 0;

  // Asymmetric tie-breaking on flat ground, and it matters:
  //   minima track the LAST point at that elevation — a climb starts where the
  //     road tilts up, not where the preceding valley floor began;
  //   maxima track the FIRST point — a climb ends on reaching the summit, not
  //     at the far side of a summit plateau.
  // Using `<` for both would bolt every flat approach onto the climb.
  for (let i = 1; i < profile.length; i++) {
    const e = profile[i].ele;
    if (dir === 1) {
      if (e > profile[extIdx].ele) extIdx = i;
      else if (e <= profile[extIdx].ele - prominence) {
        extrema.push({ index: extIdx, dist: profile[extIdx].dist, ele: profile[extIdx].ele, type: 'max' });
        dir = -1;
        extIdx = i;
      }
    } else if (dir === -1) {
      if (e <= profile[extIdx].ele) extIdx = i;
      else if (e >= profile[extIdx].ele + prominence) {
        extrema.push({ index: extIdx, dist: profile[extIdx].dist, ele: profile[extIdx].ele, type: 'min' });
        dir = 1;
        extIdx = i;
      }
    } else {
      if (e <= profile[minIdx].ele) minIdx = i;
      if (e > profile[maxIdx].ele) maxIdx = i;
      if (e >= profile[minIdx].ele + prominence) {
        extrema.push({ index: minIdx, dist: profile[minIdx].dist, ele: profile[minIdx].ele, type: 'min' });
        dir = 1;
        extIdx = i;
      } else if (e <= profile[maxIdx].ele - prominence) {
        extrema.push({ index: maxIdx, dist: profile[maxIdx].dist, ele: profile[maxIdx].ele, type: 'max' });
        dir = -1;
        extIdx = i;
      }
    }
  }

  // Close out with the final extreme so a summit finish is not lost.
  const lastIdx = profile.length - 1;
  const lastType = dir === 1 ? 'max' : dir === -1 ? 'min' : null;
  if (lastType) {
    extrema.push({ index: extIdx, dist: profile[extIdx].dist, ele: profile[extIdx].ele, type: lastType });
    if (extIdx !== lastIdx && lastType === 'max' && profile[lastIdx].ele > profile[extIdx].ele) {
      extrema[extrema.length - 1] = {
        index: lastIdx, dist: profile[lastIdx].dist, ele: profile[lastIdx].ele, type: 'max',
      };
    }
  }
  return extrema;
}

function detectClimbs(profile, opt) {
  const extrema = findExtrema(profile, opt.climbProminence);

  // Every min→max pair is a candidate climb.
  let candidates = [];
  for (let i = 0; i < extrema.length - 1; i++) {
    if (extrema[i].type === 'min' && extrema[i + 1].type === 'max') {
      candidates.push({ startIdx: extrema[i].index, endIdx: extrema[i + 1].index });
    }
  }

  candidates = mergeCandidates(candidates, profile, opt);

  const climbs = [];
  for (const c of candidates) {
    const climb = describeClimb(profile, c.startIdx, c.endIdx);
    if (
      climb.gain >= opt.minClimbGain &&
      climb.length >= opt.minClimbLength &&
      climb.avgGrade >= opt.minClimbGrade
    ) {
      climbs.push(climb);
    }
  }

  climbs.sort((a, b) => a.startDist - b.startDist);
  climbs.forEach((c, i) => { c.number = i + 1; });
  return climbs;
}

/**
 * Joins "stepped" climbs — a col reached in two ramps with a short dip between
 * them is one climb to a rider, not two.
 */
function mergeCandidates(candidates, profile, opt) {
  if (candidates.length < 2) return candidates;
  const out = [candidates[0]];

  for (let i = 1; i < candidates.length; i++) {
    const prev = out[out.length - 1];
    const next = candidates[i];

    const prevTop = profile[prev.endIdx].ele;
    const dipBottom = profile[next.startIdx].ele;
    const nextTop = profile[next.endIdx].ele;

    const dip = prevTop - dipBottom;
    const gapDist = profile[next.startIdx].dist - profile[prev.endIdx].dist;
    const combinedGain = nextTop - profile[prev.startIdx].ele;
    const combinedLength = profile[next.endIdx].dist - profile[prev.startIdx].dist;
    const combinedGrade = combinedLength > 0 ? combinedGain / combinedLength : 0;

    const shouldMerge =
      nextTop > prevTop &&
      combinedGain > 0 &&
      gapDist <= opt.mergeMaxGapDist &&
      dip <= Math.max(opt.climbProminence, opt.mergeMaxDip * combinedGain) &&
      combinedGrade >= opt.minClimbGrade;

    if (shouldMerge) prev.endIdx = next.endIdx;
    else out.push(next);
  }
  return out;
}

function describeClimb(profile, startIdx, endIdx) {
  const start = profile[startIdx];
  const end = profile[endIdx];
  const length = end.dist - start.dist;
  const gain = end.ele - start.ele;
  const avgGrade = length > 0 ? gain / length : 0;

  // Steepest sustained 100 m within the climb, as a percentile for the same
  // reason as the route-wide figure — see steepestSustained().
  const spacing = Math.max(1, profile[1].dist - profile[0].dist);
  const win = Math.max(1, Math.round(100 / spacing));
  const windows = [];
  let steepestAt = start.dist;
  let peak = -Infinity;
  for (let i = startIdx; i + win <= endIdx; i++) {
    const run = profile[i + win].dist - profile[i].dist;
    const rise = profile[i + win].ele - profile[i].ele;
    const g = run > 0 ? rise / run : 0;
    windows.push(g);
    if (g > peak) { peak = g; steepestAt = profile[i].dist; }
  }
  windows.sort((a, b) => a - b);
  let maxGrade =
    windows.length >= 25
      ? windows[Math.min(windows.length - 1, Math.floor(windows.length * 0.97))]
      : (windows.length ? windows[windows.length - 1] : avgGrade);
  if (!(maxGrade > 0)) maxGrade = avgGrade;

  // Internal elevation actually gained (ignoring the dips inside the climb).
  let realGain = 0;
  for (let i = startIdx + 1; i <= endIdx; i++) {
    const d = profile[i].ele - profile[i - 1].ele;
    if (d > 0) realGain += d;
  }

  const gradePercent = avgGrade * 100;
  const score = length * gradePercent; // Strava's climb score
  const category = categorise(score, avgGrade, length);

  return {
    startIdx,
    endIdx,
    startDist: start.dist,
    endDist: end.dist,
    length,
    startEle: start.ele,
    topEle: end.ele,
    gain,
    realGain,
    avgGrade,
    maxGrade,
    steepestAt,
    score,
    category,
    fiets: fietsIndex(gain, length, end.ele),
    lat: end.lat,
    lon: end.lon,
    startLat: start.lat,
    startLon: start.lon,
  };
}

/**
 * Strava-compatible categorisation. score = length (m) × average grade (%),
 * with a 3 % / 500 m floor before anything is categorised at all.
 */
function categorise(score, avgGrade, length) {
  if (avgGrade < 0.03 || length < 500) return { id: 'uncat', label: 'Uncategorised', rank: 0, color: '#8a94a6' };
  if (score >= 80000) return { id: 'hc', label: 'HC', rank: 5, color: '#7b1fa2' };
  if (score >= 64000) return { id: 'cat1', label: 'Cat 1', rank: 4, color: '#c62828' };
  if (score >= 32000) return { id: 'cat2', label: 'Cat 2', rank: 3, color: '#ef6c00' };
  if (score >= 16000) return { id: 'cat3', label: 'Cat 3', rank: 2, color: '#f9a825' };
  if (score >= 8000) return { id: 'cat4', label: 'Cat 4', rank: 1, color: '#2e7d32' };
  return { id: 'uncat', label: 'Uncategorised', rank: 0, color: '#8a94a6' };
}

/**
 * FIETS index — the Dutch climb-difficulty measure. Unlike the Strava score it
 * is genuinely gradient-weighted (gain is squared), so a short wall and a long
 * drag with equal gain do not come out the same.
 */
function fietsIndex(gain, length, topEle) {
  if (length <= 0 || gain <= 0) return 0;
  const base = (gain * gain) / (length * 10);
  const altitudeBonus = topEle > 1000 ? (topEle - 1000) / 1000 : 0;
  return base + altitudeBonus;
}

function routeDifficulty(ascent, distance, climbs) {
  const km = distance / 1000;
  if (km <= 0) return { label: '—', score: 0 };
  const rate = ascent / km;
  const hardest = climbs.reduce((m, c) => Math.max(m, c.fiets), 0);
  const score = rate + hardest * 20 + km * 0.15;

  let label = 'Flat';
  if (score > 220) label = 'Very hard';
  else if (score > 150) label = 'Hard';
  else if (score > 95) label = 'Moderate';
  else if (score > 50) label = 'Rolling';
  else if (score > 20) label = 'Mostly flat';

  return { label, score, climbRate: rate, hardestFiets: hardest };
}
