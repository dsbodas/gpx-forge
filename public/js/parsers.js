/**
 * Turns pasted links, pasted coordinates and dropped files into a list of
 * waypoints.
 *
 * Neither Google nor Apple offer a route-export API, and scraping their
 * directions responses would breach their terms. What is both legitimate and
 * reliable is reading the waypoints the user themselves put in the share link
 * — those coordinates are right there in the URL — and re-routing them through
 * an OpenStreetMap cycling engine. The result is a better bike route than the
 * original anyway, because it can use cycleways and gravel that a car-oriented
 * router will not.
 *
 * Every parser returns waypoints shaped as:
 *   { lat, lon, name? }            already-located
 *   { query, name }                needs geocoding
 */

import { decodePolyline } from './util.js';

const isLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90;
const isLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180;

/** Guards against lat/lon transposition, which is easy to hit across providers. */
function coord(lat, lon, name) {
  if (!isLat(lat) && isLat(lon) && isLon(lat)) [lat, lon] = [lon, lat];
  if (!isLat(lat) || !isLon(lon)) return null;
  if (lat === 0 && lon === 0) return null; // null island — almost always a parse artefact
  return name ? { lat, lon, name } : { lat, lon };
}

/** Matches "52.5163, 13.3777" and variants with whitespace or a slash. */
const COORD_PAIR = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,/ ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

function parseCoordString(s) {
  const m = COORD_PAIR.exec(decodeURIComponent(String(s)));
  return m ? coord(parseFloat(m[1]), parseFloat(m[2])) : null;
}

/* ================================================================== *
 * Entry point
 * ================================================================== */

/**
 * @param {string} text  a URL, or newline-separated coordinates/place names
 * @param {object} opts  { resolveShortLink?: (url) => Promise<{url, body}> }
 * @returns {Promise<{waypoints: Array, source: string, note?: string}>}
 */
export async function parseInput(text, opts = {}) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Nothing to parse.');

  const urlMatch = trimmed.match(/https?:\/\/\S+/);
  if (urlMatch) return parseUrl(urlMatch[0], opts);

  // Not a link — treat as pasted coordinates and/or place names, one per line.
  return parseFreeform(trimmed);
}

export async function parseUrl(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('That does not look like a valid link.');
  }

  const host = url.hostname.replace(/^www\./, '');
  const shortHosts = ['maps.app.goo.gl', 'goo.gl', 'g.co', 'strava.app.link'];

  // Short links carry no coordinates until expanded.
  if (shortHosts.includes(host) || (host === 'maps.apple.com' && url.pathname.startsWith('/o/'))) {
    if (!opts.resolveShortLink) {
      throw new Error(
        'Short links need the local server to expand them. Start the app with "npm start", or open the link in a browser and paste the full URL from the address bar.'
      );
    }
    const resolved = await opts.resolveShortLink(rawUrl);
    const expanded = resolved?.url;
    if (!expanded || expanded === rawUrl) {
      // Fall back to mining the returned HTML — Google's interstitial pages
      // still embed the coordinates.
      const fromBody = resolved?.body ? harvestFromHtml(resolved.body) : [];
      if (fromBody.length >= 2) {
        return { waypoints: fromBody, source: 'Google Maps (from page contents)' };
      }
      throw new Error('Could not expand that short link.');
    }
    const out = await parseUrl(expanded, { ...opts, resolveShortLink: null });
    if (out.waypoints.length < 2 && resolved?.body) {
      const fromBody = harvestFromHtml(resolved.body);
      if (fromBody.length >= 2) return { waypoints: fromBody, source: out.source };
    }
    return out;
  }

  if (host.endsWith('google.com') || host.endsWith('google.co.uk') || /google\.[a-z.]+$/.test(host)) {
    return parseGoogle(url);
  }
  if (host === 'maps.apple.com' || host === 'guides.apple.com') return parseApple(url);
  if (host === 'openstreetmap.org' || host === 'osm.org') return parseOsm(url);
  if (host === 'bing.com') return parseBing(url);
  if (host === 'waze.com' || host === 'ul.waze.com') return parseWaze(url);
  if (host === 'brouter.de' || host === 'bikerouter.de') return parseBrouterWeb(url);
  if (['komoot.com', 'komoot.de', 'strava.com', 'ridewithgps.com', 'plotaroute.com'].includes(host)) {
    throw new Error(
      `${host} keeps route geometry behind its API. Export the route as GPX from that site and drop the file here — the app will re-analyse it fully.`
    );
  }

  // Unknown provider: try every generic trick before giving up.
  const generic = parseGenericUrl(url);
  if (generic.waypoints.length >= 1) return generic;
  throw new Error(`No coordinates found in that ${host} link.`);
}

/* ================================================================== *
 * Google Maps
 * ================================================================== */

function parseGoogle(url) {
  const waypoints = [];
  let note;

  // --- Maps URLs API: ?api=1&origin=&waypoints=a|b&destination= ---------
  const params = url.searchParams;
  if (params.get('origin') || params.get('destination')) {
    const push = (raw, label) => {
      if (!raw) return;
      const c = parseCoordString(raw);
      waypoints.push(c || { query: decodeURIComponent(raw), name: decodeURIComponent(raw) });
      void label;
    };
    push(params.get('origin'));
    for (const w of (params.get('waypoints') || '').split('|').filter(Boolean)) push(w);
    push(params.get('destination'));
    if (waypoints.length >= 2) {
      return { waypoints, source: 'Google Maps directions link' };
    }
  }

  // --- /maps/dir/... : the common "share directions" shape ---------------
  const path = decodeURIComponent(url.pathname);
  const dirMatch = path.match(/\/maps\/dir\/(.*)/);

  // Coordinates hidden in the opaque `data=` parameter. Each waypoint appears
  // as !2m2!1d<longitude>!2d<latitude>. These are the exact points the user
  // dropped, so they beat anything we could geocode from the place names.
  const dataCoords = [];
  const data = url.searchParams.get('data') || (path.match(/data=([^/?]+)/)?.[1] ?? '');
  if (data) {
    for (const m of data.matchAll(/!1d(-?\d+(?:\.\d+)?)!2d(-?\d+(?:\.\d+)?)/g)) {
      const c = coord(parseFloat(m[2]), parseFloat(m[1])); // 1d = lon, 2d = lat
      if (c) dataCoords.push(c);
    }
    // Place pages use the reverse convention: !3d<lat>!4d<lon>.
    if (!dataCoords.length) {
      for (const m of data.matchAll(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/g)) {
        const c = coord(parseFloat(m[1]), parseFloat(m[2]));
        if (c) dataCoords.push(c);
      }
    }
  }

  if (dirMatch) {
    const segments = dirMatch[1]
      .split('/')
      .filter((s) => s && !s.startsWith('@') && !s.startsWith('data=') && !s.startsWith('am=') && s !== 'dir');

    const named = segments.map((s) => {
      const c = parseCoordString(s);
      const label = s.replace(/\+/g, ' ');
      return c ? { ...c, name: label } : { query: label, name: label };
    });

    // Prefer the precise data= coordinates, keeping the readable names.
    if (dataCoords.length && dataCoords.length === named.length) {
      return {
        waypoints: dataCoords.map((c, i) => ({ ...c, name: named[i].name })),
        source: 'Google Maps directions',
      };
    }
    if (dataCoords.length >= 2) {
      return { waypoints: dataCoords, source: 'Google Maps directions' };
    }
    if (named.length >= 1) {
      const needGeocode = named.filter((w) => w.query).length;
      if (needGeocode) note = `${needGeocode} place name(s) will be geocoded via OpenStreetMap.`;
      return { waypoints: named, source: 'Google Maps directions', note };
    }
  }

  if (dataCoords.length) {
    return { waypoints: dataCoords, source: 'Google Maps' };
  }

  // --- single place / map view ------------------------------------------
  const q = params.get('q') || params.get('ll') || params.get('center') || params.get('daddr');
  const single = q && parseCoordString(q);
  if (single) return { waypoints: [single], source: 'Google Maps place' };

  const at = path.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (at) {
    const c = coord(parseFloat(at[1]), parseFloat(at[2]));
    if (c) {
      return {
        waypoints: [c],
        source: 'Google Maps view',
        note: 'That link only contains a map position, not a route. Added it as a single waypoint — click the map to add more.',
      };
    }
  }

  const placeName = path.match(/\/maps\/place\/([^/@]+)/);
  if (placeName) {
    const name = decodeURIComponent(placeName[1]).replace(/\+/g, ' ');
    return { waypoints: [{ query: name, name }], source: 'Google Maps place', note: 'Geocoding place name.' };
  }

  throw new Error('No route or coordinates found in that Google Maps link.');
}

/** Last-resort scrape of coordinates out of a returned HTML page. */
function harvestFromHtml(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/!1d(-?\d+\.\d+)!2d(-?\d+\.\d+)/g)) {
    const c = coord(parseFloat(m[2]), parseFloat(m[1]));
    const key = c && `${c.lat.toFixed(6)},${c.lon.toFixed(6)}`;
    if (c && !seen.has(key)) { seen.add(key); out.push(c); }
  }
  return out;
}

/* ================================================================== *
 * Apple Maps
 * ================================================================== */

function parseApple(url) {
  const p = url.searchParams;
  const waypoints = [];

  const add = (raw) => {
    if (!raw) return;
    const c = parseCoordString(raw);
    waypoints.push(c || { query: decodeURIComponent(raw), name: decodeURIComponent(raw) });
  };

  // Directions: ?saddr=A&daddr=B  (Apple chains vias as "B+to:C")
  const saddr = p.get('saddr');
  const daddr = p.get('daddr');
  if (saddr || daddr) {
    add(saddr);
    for (const leg of String(daddr || '').split(/\+to:|%20to:| to:/i).filter(Boolean)) add(leg);
    if (waypoints.length >= 1) {
      const mode = p.get('dirflg');
      return {
        waypoints,
        source: 'Apple Maps directions',
        note:
          mode && mode !== 'c'
            ? undefined
            : 'Apple gave driving directions; the route will be re-planned for cycling.',
      };
    }
  }

  // Newer place links: /place?coordinate=lat,lon&name=...
  const c =
    parseCoordString(p.get('coordinate') || '') ||
    parseCoordString(p.get('ll') || '') ||
    parseCoordString(p.get('sll') || '') ||
    parseCoordString(p.get('q') || '');
  if (c) {
    const name = p.get('name') || p.get('address');
    return {
      waypoints: [name ? { ...c, name: decodeURIComponent(name) } : c],
      source: 'Apple Maps place',
    };
  }

  const q = p.get('q') || p.get('address') || p.get('name');
  if (q) {
    const name = decodeURIComponent(q);
    return { waypoints: [{ query: name, name }], source: 'Apple Maps place', note: 'Geocoding place name.' };
  }

  throw new Error('No coordinates found in that Apple Maps link.');
}

/* ================================================================== *
 * Other providers
 * ================================================================== */

function parseOsm(url) {
  // /directions?route=lat,lon;lat,lon
  const route = url.searchParams.get('route');
  if (route) {
    const waypoints = decodeURIComponent(route)
      .split(';')
      .map(parseCoordString)
      .filter(Boolean);
    if (waypoints.length) return { waypoints, source: 'OpenStreetMap directions' };
  }
  const hash = url.hash.match(/map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/);
  if (hash) {
    const c = coord(parseFloat(hash[1]), parseFloat(hash[2]));
    if (c) return { waypoints: [c], source: 'OpenStreetMap view' };
  }
  const mlat = url.searchParams.get('mlat');
  const mlon = url.searchParams.get('mlon');
  if (mlat && mlon) {
    const c = coord(parseFloat(mlat), parseFloat(mlon));
    if (c) return { waypoints: [c], source: 'OpenStreetMap marker' };
  }
  throw new Error('No coordinates found in that OpenStreetMap link.');
}

function parseBing(url) {
  // ?rtp=pos.52.5_13.4~pos.52.6_13.5
  const rtp = url.searchParams.get('rtp');
  if (rtp) {
    const waypoints = [];
    for (const leg of rtp.split('~')) {
      const m = leg.match(/pos\.(-?\d+(?:\.\d+)?)_(-?\d+(?:\.\d+)?)/);
      if (m) {
        const c = coord(parseFloat(m[1]), parseFloat(m[2]));
        if (c) waypoints.push(c);
      } else if (leg.startsWith('adr.')) {
        const name = decodeURIComponent(leg.slice(4));
        waypoints.push({ query: name, name });
      }
    }
    if (waypoints.length) return { waypoints, source: 'Bing Maps directions' };
  }
  const cp = url.searchParams.get('cp');
  if (cp) {
    const c = parseCoordString(cp.replace('~', ','));
    if (c) return { waypoints: [c], source: 'Bing Maps view' };
  }
  throw new Error('No coordinates found in that Bing Maps link.');
}

function parseWaze(url) {
  const ll = url.searchParams.get('ll') || url.searchParams.get('to')?.replace(/^ll\./, '').replace('_', ',');
  const c = parseCoordString(ll || '');
  if (c) return { waypoints: [c], source: 'Waze link' };
  throw new Error('No coordinates found in that Waze link.');
}

function parseBrouterWeb(url) {
  // #map=...&lonlats=lon,lat;lon,lat
  const src = url.hash || url.search;
  const m = src.match(/lonlats=([^&]+)/);
  if (m) {
    const waypoints = decodeURIComponent(m[1])
      .split(';')
      .map((pair) => {
        const [lon, lat] = pair.split(',').map(Number);
        return coord(lat, lon);
      })
      .filter(Boolean);
    if (waypoints.length) return { waypoints, source: 'BRouter link' };
  }
  throw new Error('No coordinates found in that BRouter link.');
}

/** Generic fallbacks: encoded polylines and loose lat/lon params. */
function parseGenericUrl(url) {
  const whole = url.href;

  // An encoded polyline anywhere in the URL is the jackpot — full geometry.
  const poly = whole.match(/(?:polyline|path|geometry|enc:?)=([A-Za-z0-9_@?~`^{}|\\[\]-]{40,})/);
  if (poly) {
    try {
      const pts = decodePolyline(decodeURIComponent(poly[1]));
      const valid = pts.filter((p) => isLat(p.lat) && isLon(p.lon));
      if (valid.length > 10) {
        return {
          waypoints: valid,
          source: 'Encoded polyline in link',
          note: 'Decoded a full polyline — using it directly rather than re-routing.',
          isFullGeometry: true,
        };
      }
    } catch { /* not a polyline after all */ }
  }

  const waypoints = [];
  for (const key of ['ll', 'q', 'center', 'coord', 'coordinate', 'start', 'end', 'from', 'to']) {
    const c = parseCoordString(url.searchParams.get(key) || '');
    if (c) waypoints.push(c);
  }
  if (waypoints.length) return { waypoints, source: `${url.hostname} link` };

  // Bare pairs in the path or hash, e.g. /route/52.5,13.4/52.6,13.5
  const pairs = [...whole.matchAll(/(-?\d{1,2}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})/g)];
  const found = pairs.map((m) => coord(parseFloat(m[1]), parseFloat(m[2]))).filter(Boolean);
  if (found.length) {
    return {
      waypoints: found,
      source: `${url.hostname} link`,
      note: 'Coordinates were guessed from the URL — check the pins on the map.',
    };
  }
  return { waypoints: [] };
}

/* ================================================================== *
 * Pasted text
 * ================================================================== */

function parseFreeform(text) {
  const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
  const waypoints = [];
  let coordCount = 0;

  for (const line of lines) {
    const c = parseCoordString(line);
    if (c) {
      waypoints.push(c);
      coordCount++;
      continue;
    }
    // "Name @ 52.5,13.4" or "52.5,13.4 Name"
    const embedded = line.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
    if (embedded) {
      const cc = coord(parseFloat(embedded[1]), parseFloat(embedded[2]));
      if (cc) {
        const name = line.replace(embedded[0], '').replace(/[@,|-]/g, ' ').trim();
        waypoints.push(name ? { ...cc, name } : cc);
        coordCount++;
        continue;
      }
    }
    waypoints.push({ query: line, name: line });
  }

  if (!waypoints.length) throw new Error('No coordinates or place names found.');
  const toGeocode = waypoints.length - coordCount;
  return {
    waypoints,
    source: 'Pasted text',
    note: toGeocode ? `${toGeocode} name(s) will be geocoded via OpenStreetMap.` : undefined,
  };
}

/* ================================================================== *
 * File import — the universal path for "any other map website"
 * ================================================================== */

export function parseFile(filename, text) {
  const name = filename.toLowerCase();
  if (name.endsWith('.gpx')) return parseGpx(text);
  if (name.endsWith('.kml')) return parseKml(text);
  if (name.endsWith('.tcx')) return parseTcx(text);
  if (name.endsWith('.geojson') || name.endsWith('.json')) return parseGeoJson(text);

  // Sniff the content when the extension is unhelpful.
  if (/<gpx[\s>]/i.test(text)) return parseGpx(text);
  if (/<kml[\s>]/i.test(text)) return parseKml(text);
  if (/<TrainingCenterDatabase/i.test(text)) return parseTcx(text);
  if (/^\s*[{[]/.test(text)) return parseGeoJson(text);
  throw new Error(`Unrecognised file type: ${filename}`);
}

function xmlDoc(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('The file is not valid XML.');
  return doc;
}

function parseGpx(text) {
  const doc = xmlDoc(text);
  const points = [];

  // Prefer track points; fall back to route points.
  let nodes = [...doc.getElementsByTagName('trkpt')];
  let kind = 'track';
  if (!nodes.length) {
    nodes = [...doc.getElementsByTagName('rtept')];
    kind = 'route';
  }

  for (const n of nodes) {
    const c = coord(parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon')));
    if (!c) continue;
    const eleNode = n.getElementsByTagName('ele')[0];
    if (eleNode) {
      const e = parseFloat(eleNode.textContent);
      if (Number.isFinite(e)) c.ele = e;
    }
    points.push(c);
  }

  const markers = [...doc.getElementsByTagName('wpt')]
    .map((n) => {
      const c = coord(parseFloat(n.getAttribute('lat')), parseFloat(n.getAttribute('lon')));
      if (!c) return null;
      const nm = n.getElementsByTagName('name')[0];
      if (nm) c.name = nm.textContent.trim();
      return c;
    })
    .filter(Boolean);

  if (!points.length) {
    if (markers.length) return { waypoints: markers, source: 'GPX waypoints' };
    throw new Error('That GPX file contains no track, route or waypoints.');
  }

  const nameNode = doc.getElementsByTagName('name')[0];
  return {
    waypoints: points,
    markers,
    isFullGeometry: true,
    name: nameNode ? nameNode.textContent.trim() : undefined,
    source: `GPX ${kind} (${points.length.toLocaleString()} points)`,
    hasElevation: points.some((p) => p.ele != null),
  };
}

function parseKml(text) {
  const doc = xmlDoc(text);
  const points = [];

  for (const node of doc.getElementsByTagName('coordinates')) {
    for (const tuple of node.textContent.trim().split(/\s+/)) {
      const [lon, lat, ele] = tuple.split(',').map(Number);
      const c = coord(lat, lon);
      if (!c) continue;
      if (Number.isFinite(ele) && ele !== 0) c.ele = ele;
      points.push(c);
    }
  }
  if (!points.length) throw new Error('That KML file contains no coordinates.');

  return {
    waypoints: points,
    isFullGeometry: points.length > 2,
    source: `KML (${points.length.toLocaleString()} points)`,
    hasElevation: points.some((p) => p.ele != null),
  };
}

function parseTcx(text) {
  const doc = xmlDoc(text);
  const points = [];
  for (const tp of doc.getElementsByTagName('Trackpoint')) {
    const lat = parseFloat(tp.getElementsByTagName('LatitudeDegrees')[0]?.textContent);
    const lon = parseFloat(tp.getElementsByTagName('LongitudeDegrees')[0]?.textContent);
    const c = coord(lat, lon);
    if (!c) continue;
    const ele = parseFloat(tp.getElementsByTagName('AltitudeMeters')[0]?.textContent);
    if (Number.isFinite(ele)) c.ele = ele;
    points.push(c);
  }
  if (!points.length) throw new Error('That TCX file contains no trackpoints.');
  return {
    waypoints: points,
    isFullGeometry: true,
    source: `TCX (${points.length.toLocaleString()} points)`,
    hasElevation: points.some((p) => p.ele != null),
  };
}

function parseGeoJson(text) {
  const data = JSON.parse(text);
  const points = [];

  const eat = (coords, depth) => {
    if (!Array.isArray(coords)) return;
    if (depth === 0) {
      const c = coord(coords[1], coords[0]);
      if (!c) return;
      if (Number.isFinite(coords[2])) c.ele = coords[2];
      points.push(c);
      return;
    }
    for (const child of coords) eat(child, depth - 1);
  };

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FeatureCollection') node.features?.forEach(walk);
    else if (node.type === 'Feature') walk(node.geometry);
    else if (node.type === 'Point') eat(node.coordinates, 0);
    else if (node.type === 'LineString' || node.type === 'MultiPoint') eat(node.coordinates, 1);
    else if (node.type === 'MultiLineString' || node.type === 'Polygon') eat(node.coordinates, 2);
    else if (node.type === 'GeometryCollection') node.geometries?.forEach(walk);
  };
  walk(data);

  if (!points.length) throw new Error('That GeoJSON contains no usable geometry.');
  return {
    waypoints: points,
    isFullGeometry: points.length > 2,
    source: `GeoJSON (${points.length.toLocaleString()} points)`,
    hasElevation: points.some((p) => p.ele != null),
  };
}

/* ================================================================== *
 * Geocoding
 * ================================================================== */

/** Resolves { query } waypoints to coordinates via Nominatim. */
export async function geocode(query, fetchJson, viewbox) {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1' });
  if (viewbox) {
    params.set('viewbox', viewbox.join(','));
    params.set('bounded', '0');
  }
  const results = await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { Accept: 'application/json' },
    cacheable: true,
  });
  if (!Array.isArray(results) || !results.length) throw new Error(`Could not find "${query}".`);
  const c = coord(parseFloat(results[0].lat), parseFloat(results[0].lon), results[0].display_name);
  if (!c) throw new Error(`Could not find "${query}".`);
  return c;
}
