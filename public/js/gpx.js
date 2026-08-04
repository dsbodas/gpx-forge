/**
 * GPX 1.1 writer, aimed squarely at cycling computers.
 *
 * Element order matters: the GPX 1.1 schema uses xsd:sequence throughout, and
 * strict parsers (Garmin Connect among them) reject files whose children are
 * out of order. The builders below emit the schema order deliberately.
 *
 * Device notes baked into the presets:
 *  - Timestamps are OFF by default. A <time> on every trkpt makes several
 *    Garmin Edge units import the file as a *completed activity* rather than a
 *    course to follow.
 *  - Older Edge units silently truncate long tracks, so each preset carries a
 *    point budget and we simplify to fit rather than let the device mangle it.
 */

import { simplify, clamp, bounds as boundsOf, fmtDistance, fmtElevation, fmtDuration } from './util.js';

const NS = 'http://www.topografix.com/GPX/1/1';
const NS_XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const NS_GPXX = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
const NS_FORGE = 'https://gpx-forge.local/xmlschemas/RouteStats/v1';

export const DEVICE_PRESETS = {
  universal: {
    id: 'universal',
    label: 'Universal (recommended)',
    maxPoints: 10000,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Works on Garmin, Wahoo, Hammerhead, Strava, Komoot, RideWithGPS.',
  },
  garminEdge: {
    id: 'garminEdge',
    label: 'Garmin Edge — modern (5xx/8xx/10xx/54x)',
    maxPoints: 10000,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Track-based course, no timestamps, climb waypoints included.',
  },
  garminOld: {
    id: 'garminOld',
    label: 'Garmin Edge — older (500/510/800/810)',
    maxPoints: 4000,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Simplified to 4 000 points; older units drop anything longer.',
  },
  wahoo: {
    id: 'wahoo',
    label: 'Wahoo ELEMNT / BOLT / ROAM',
    maxPoints: 15000,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Wahoo handles dense tracks well, so detail is preserved.',
  },
  karoo: {
    id: 'karoo',
    label: 'Hammerhead Karoo',
    maxPoints: 20000,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Full detail; Karoo re-routes from the track anyway.',
  },
  maxDetail: {
    id: 'maxDetail',
    label: 'Maximum detail (no simplification)',
    maxPoints: Infinity,
    includeTrack: true,
    includeRoute: false,
    timestamps: false,
    blurb: 'Every point kept. Large files; best for archiving or re-editing.',
  },
};

/* ------------------------------------------------------------------ */

const escapeXml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Strip control characters that are illegal in XML 1.0.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

/** Six decimal places is ~0.1 m at the equator — ample, and keeps files small. */
const num = (v) => String(parseFloat(Number(v).toFixed(6)));

/**
 * Reduces a track to at most `maxPoints` by raising the RDP tolerance until it
 * fits. Binary search rather than a fixed tolerance, because the right value
 * depends entirely on how twisty the route is.
 */
export function fitToLimit(points, maxPoints) {
  if (!Number.isFinite(maxPoints) || points.length <= maxPoints) return points;

  // One knob drives both tolerances, so the ground track and the elevation
  // profile degrade together instead of one being sacrificed for the other.
  // The vertical tolerance is capped at 4 m: a slack ground tolerance is
  // acceptable on a straight road, but misreporting elevation by tens of
  // metres would corrupt the very thing this file exists to carry.
  const at = (scale) => simplify(points, scale, clamp(scale / 8, 0.5, 4));

  let lo = 0.25;
  let hi = 120;
  let best = at(hi);

  for (let i = 0; i < 28 && hi - lo > 0.1; i++) {
    const mid = (lo + hi) / 2;
    const candidate = at(mid);
    if (candidate.length > maxPoints) lo = mid;
    else { best = candidate; hi = mid; }
  }
  if (best.length <= maxPoints) return best;

  // Union-of-two-RDP-passes has a floor it cannot go below — the elevation
  // pass keeps insisting on points however slack the ground tolerance gets. No
  // device preset ever reaches here (the smallest budget is 4 000), but
  // picking a dozen representative waypoints from an imported track does, and
  // silently returning 90 of them would be wrong. Decimate uniformly, keeping
  // the endpoints.
  const stride = best.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints - 1; i++) out.push(best[Math.floor(i * stride)]);
  out.push(best[best.length - 1]);
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * Builds the GPX document.
 *
 * @param {object} input
 *   points     route geometry [{lat, lon, ele?, dist?}]
 *   stats      result of analysis.analyse()
 *   name       route name
 *   waypoints  user waypoints [{lat, lon, name?}]
 *   surface    surface breakdown (optional)
 *   time       ride-time estimate (optional)
 *   options    { preset, includeClimbWaypoints, includeWaypoints, timestamps,
 *                startTime, includeRoute, units }
 */
export function buildGpx(input) {
  const {
    points,
    stats,
    name = 'Route',
    waypoints = [],
    surface = null,
    time = null,
    meta = {},
    options = {},
  } = input;

  const preset = DEVICE_PRESETS[options.preset] || DEVICE_PRESETS.universal;
  const opts = {
    includeClimbWaypoints: true,
    includeWaypoints: true,
    includeRoute: preset.includeRoute,
    timestamps: preset.timestamps,
    startTime: new Date(),
    units: 'metric',
    ...options,
  };

  const trackPoints = fitToLimit(points, preset.maxPoints);
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<gpx version="1.1" creator="GPX Forge" xmlns="${NS}" xmlns:xsi="${NS_XSI}" ` +
      `xmlns:gpxx="${NS_GPXX}" xmlns:forge="${NS_FORGE}" ` +
      `xsi:schemaLocation="${NS} ${NS}/gpx.xsd">`
  );

  /* ---- metadata (schema order: name, desc, author, link, time, keywords, bounds, extensions) ---- */
  const description = buildDescription({ stats, surface, time, meta, units: opts.units });
  const bb = boundsOf(trackPoints);

  out.push('  <metadata>');
  out.push(`    <name>${escapeXml(name)}</name>`);
  out.push(`    <desc>${escapeXml(description)}</desc>`);
  out.push('    <author><name>GPX Forge</name></author>');
  out.push(`    <time>${created}</time>`);
  out.push('    <keywords>cycling,route,course</keywords>');
  out.push(
    `    <bounds minlat="${num(bb[0][0])}" minlon="${num(bb[0][1])}" ` +
      `maxlat="${num(bb[1][0])}" maxlon="${num(bb[1][1])}"/>`
  );
  out.push(statsExtensions(stats, surface, time, meta, '    '));
  out.push('  </metadata>');

  /* ---- waypoints ---- */
  if (opts.includeWaypoints) {
    for (const wp of waypoints) {
      if (wp.lat == null || wp.lon == null) continue;
      out.push(waypointXml(wp.lat, wp.lon, wp.ele, wp.name || 'Waypoint', wp.desc, wp.sym || 'Flag, Blue'));
    }
  }

  if (opts.includeClimbWaypoints && stats?.climbs?.length) {
    for (const climb of stats.climbs) {
      const label = `${climb.category.label === 'Uncategorised' ? 'Climb' : climb.category.label} ${climb.number}`;
      const detail =
        `${fmtDistance(climb.length, opts.units)} at ${(climb.avgGrade * 100).toFixed(1)}% ` +
        `(max ${(climb.maxGrade * 100).toFixed(1)}%), ` +
        `${fmtElevation(climb.gain, opts.units)} gain, tops out at ${fmtElevation(climb.topEle, opts.units)}`;

      out.push(
        waypointXml(
          climb.startLat, climb.startLon, climb.startEle,
          `${label} start`, detail, 'Summit'
        )
      );
      out.push(
        waypointXml(
          climb.lat, climb.lon, climb.topEle,
          `${label} summit`,
          `Top of climb ${climb.number} — ${fmtElevation(climb.topEle, opts.units)}`,
          'Summit'
        )
      );
    }
  }

  /* ---- route (optional; some navigation units prefer rtept) ---- */
  if (opts.includeRoute) {
    out.push('  <rte>');
    out.push(`    <name>${escapeXml(name)}</name>`);
    const routePoints = fitToLimit(trackPoints, Math.min(preset.maxPoints, 500));
    for (const p of routePoints) {
      out.push(`    <rtept lat="${num(p.lat)}" lon="${num(p.lon)}">${eleXml(p.ele)}</rtept>`);
    }
    out.push('  </rte>');
  }

  /* ---- track ---- */
  out.push('  <trk>');
  out.push(`    <name>${escapeXml(name)}</name>`);
  out.push(`    <desc>${escapeXml(description)}</desc>`);
  out.push('    <type>Cycling</type>');
  out.push('    <trkseg>');

  // Virtual timestamps derived from the physics model, so a device can show a
  // pace target. Off by default — see the header note.
  let clock = opts.startTime instanceof Date ? opts.startTime.getTime() : Date.now();
  const speedAt = buildSpeedLookup(stats, time);

  for (let i = 0; i < trackPoints.length; i++) {
    const p = trackPoints[i];
    let stamp = '';
    if (opts.timestamps) {
      if (i > 0) {
        const span = (p.dist ?? 0) - (trackPoints[i - 1].dist ?? 0);
        const v = speedAt(p.dist ?? 0);
        clock += (span / Math.max(v, 0.8)) * 1000;
      }
      stamp = `<time>${new Date(clock).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>`;
    }
    out.push(`      <trkpt lat="${num(p.lat)}" lon="${num(p.lon)}">${eleXml(p.ele)}${stamp}</trkpt>`);
  }

  out.push('    </trkseg>');
  out.push('  </trk>');
  out.push('</gpx>');

  return out.filter(Boolean).join('\n');
}

/* ------------------------------------------------------------------ */

function eleXml(ele) {
  return Number.isFinite(ele) ? `<ele>${ele.toFixed(1)}</ele>` : '';
}

function waypointXml(lat, lon, ele, name, desc, sym) {
  // Child order per the GPX 1.1 schema: ele, time, …, name, cmt, desc, …, sym.
  const parts = [
    `  <wpt lat="${num(lat)}" lon="${num(lon)}">`,
    eleXml(ele) ? `    ${eleXml(ele)}` : '',
    `    <name>${escapeXml(name)}</name>`,
    desc ? `    <desc>${escapeXml(desc)}</desc>` : '',
    sym ? `    <sym>${escapeXml(sym)}</sym>` : '',
    '  </wpt>',
  ];
  return parts.filter(Boolean).join('\n');
}

function buildSpeedLookup(stats, time) {
  if (!time?.speeds || !stats?.profile?.length) return () => 6.5;
  const profile = stats.profile;
  const speeds = time.speeds;
  return (dist) => {
    const idx = Math.min(profile.length - 1, Math.max(0, Math.round(dist / (stats.interval || 10))));
    return speeds[idx] || 6.5;
  };
}

/**
 * Human-readable summary. This is what actually shows up under the route name
 * on Garmin Connect, Strava and most head units, so the numbers a rider cares
 * about go here rather than only in the extensions block.
 */
function buildDescription({ stats, surface, time, meta, units }) {
  if (!stats) return '';
  const parts = [];

  parts.push(`${fmtDistance(stats.distance, units)}`);
  if (stats.hasElevation) {
    parts.push(`${fmtElevation(stats.ascent, units)} ascent`);
    parts.push(`${fmtElevation(stats.descent, units)} descent`);
    parts.push(`${stats.climbCount} climb${stats.climbCount === 1 ? '' : 's'}`);
    if (stats.climbCount) {
      const cats = stats.climbs
        .map((c) => c.category.label)
        .filter((l) => l !== 'Uncategorised');
      if (cats.length) parts.push(`(${summariseCategories(cats)})`);
    }
    parts.push(`max ${fmtElevation(stats.maxEle, units)}`);
    parts.push(`${stats.difficulty.label}`);
  }
  if (time) parts.push(`≈ ${fmtDuration(time.totalSeconds)} riding`);

  let text = parts.join(' · ');

  if (surface?.surface?.length) {
    const top = surface.surface
      .slice(0, 3)
      .map((s) => `${Math.round(s.share * 100)}% ${s.label.toLowerCase()}`)
      .join(', ');
    text += ` | Surface: ${top}`;
  }
  if (meta?.engineLabel) text += ` | Routed with ${meta.engineLabel}`;
  return text;
}

function summariseCategories(labels) {
  const counts = new Map();
  for (const l of labels) counts.set(l, (counts.get(l) || 0) + 1);
  const order = ['HC', 'Cat 1', 'Cat 2', 'Cat 3', 'Cat 4'];
  return order
    .filter((o) => counts.has(o))
    .map((o) => `${counts.get(o)}× ${o}`)
    .join(', ');
}

/**
 * Machine-readable stats. GPX has no standard place for "total ascent" or
 * "climbs", so they live in a private namespace — readers that do not know it
 * ignore the block, which is exactly what the spec asks for.
 */
function statsExtensions(stats, surface, time, meta, indent) {
  if (!stats) return '';
  const L = [];
  const p = (s) => L.push(indent + s);

  p('<extensions>');
  p('  <forge:route>');
  p(`    <forge:distance unit="m">${stats.distance.toFixed(1)}</forge:distance>`);

  if (stats.hasElevation) {
    p(`    <forge:ascent unit="m">${Math.round(stats.ascent)}</forge:ascent>`);
    p(`    <forge:descent unit="m">${Math.round(stats.descent)}</forge:descent>`);
    p(`    <forge:ascentUnfiltered unit="m">${Math.round(stats.ascentRaw)}</forge:ascentUnfiltered>`);
    p(`    <forge:minElevation unit="m">${Math.round(stats.minEle)}</forge:minElevation>`);
    p(`    <forge:maxElevation unit="m">${Math.round(stats.maxEle)}</forge:maxElevation>`);
    p(`    <forge:netElevation unit="m">${Math.round(stats.netElevation)}</forge:netElevation>`);
    p(`    <forge:climbRate unit="m/km">${stats.climbRate.toFixed(1)}</forge:climbRate>`);
    p(`    <forge:maxGradient unit="percent" sustainedOver="100m">${((stats.steepest100 ?? stats.maxGrade) * 100).toFixed(1)}</forge:maxGradient>`);
    p(`    <forge:difficulty score="${Math.round(stats.difficulty.score)}">${escapeXml(stats.difficulty.label)}</forge:difficulty>`);
    p(`    <forge:climbCount>${stats.climbCount}</forge:climbCount>`);

    if (stats.climbs.length) {
      p('    <forge:climbs>');
      for (const c of stats.climbs) {
        p(
          `      <forge:climb number="${c.number}" category="${escapeXml(c.category.label)}" ` +
            `startDistance="${Math.round(c.startDist)}" endDistance="${Math.round(c.endDist)}" ` +
            `length="${Math.round(c.length)}" gain="${Math.round(c.gain)}" ` +
            `avgGradient="${(c.avgGrade * 100).toFixed(1)}" maxGradient="${(c.maxGrade * 100).toFixed(1)}" ` +
            `topElevation="${Math.round(c.topEle)}" score="${Math.round(c.score)}" ` +
            `fiets="${c.fiets.toFixed(2)}"/>`
        );
      }
      p('    </forge:climbs>');
    }

    p('    <forge:gradientDistribution>');
    for (const b of stats.bands) {
      if (b.distance <= 0) continue;
      p(
        `      <forge:band range="${escapeXml(b.label)}" distance="${Math.round(b.distance)}" ` +
          `share="${(b.share * 100).toFixed(1)}"/>`
      );
    }
    p('    </forge:gradientDistribution>');
  }

  if (surface?.surface?.length) {
    p(`    <forge:surface source="${escapeXml(surface.source || '')}">`);
    for (const s of surface.surface) {
      p(`      <forge:type name="${escapeXml(s.label)}" distance="${Math.round(s.distance)}" share="${(s.share * 100).toFixed(1)}"/>`);
    }
    p('    </forge:surface>');
  }
  if (surface?.waytype?.length) {
    p('    <forge:wayTypes>');
    for (const w of surface.waytype) {
      p(`      <forge:type name="${escapeXml(w.label)}" distance="${Math.round(w.distance)}" share="${(w.share * 100).toFixed(1)}"/>`);
    }
    p('    </forge:wayTypes>');
  }

  if (time) {
    p(
      `    <forge:estimatedTime seconds="${Math.round(time.totalSeconds)}" ` +
        `avgSpeed="${time.avgSpeedKmh.toFixed(1)}" power="${time.params.power}" ` +
        `riderMass="${time.params.riderMass}">${escapeXml(fmtDuration(time.totalSeconds))}</forge:estimatedTime>`
    );
  }
  if (meta?.engineLabel) {
    p(`    <forge:routing engine="${escapeXml(meta.engineLabel)}" profile="${escapeXml(meta.profileLabel || '')}"/>`);
  }
  if (meta?.source) p(`    <forge:source>${escapeXml(meta.source)}</forge:source>`);

  p('  </forge:route>');
  p('</extensions>');
  return L.join('\n');
}

/** Filesystem-safe filename from a route name. */
export function gpxFilename(name) {
  const clean = String(name || 'route')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return `${clean || 'route'}.gpx`;
}
