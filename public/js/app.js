/**
 * Application controller: owns state, wires the UI, drives the pipeline.
 *
 * Pipeline:
 *   parse link/file  →  geocode names  →  route  →  elevation  →  analyse
 *                   →  ride time  →  render  →  export GPX
 */

import { parseInput, parseFile, geocode } from './parsers.js';
import { detectServer, hasServer, resolveShortLink, fetchJson } from './net.js';
import { ENGINES, defaultProfile, route as runRoute } from './routing.js';
import { addElevation } from './elevation.js';
import { analyse, DEFAULTS as ANALYSIS_DEFAULTS } from './analysis.js';
import { fromOrsExtras, fromOverpass, rideabilityFactor } from './surface.js';
import { estimate, climbTimes, powerForFlatSpeed, BIKE_PRESETS, DEFAULTS as PHYS_DEFAULTS } from './timemodel.js';
import { buildGpx, gpxFilename, DEVICE_PRESETS, fitToLimit } from './gpx.js';
import * as strava from './strava.js';
import { ElevationProfile } from './profile.js';
import { RouteMap } from './map.js';
import {
  computeDistances, fmtDistance, fmtElevation, fmtDuration, fmtSpeed, fmtGradient, bounds as boundsOf,
} from './util.js';

const $ = (id) => document.getElementById(id);
// Bump when a stored default changes meaning, so existing users pick up the
// new value instead of being pinned to a stale one.
const STORE_KEY = 'gpx-forge:settings:v2';

// Exposed for debugging from the console; nothing in the app reads it.
const debugState = () => state;

/* ================================================================== *
 * State
 * ================================================================== */

const state = {
  waypoints: [],        // user-editable points
  routePoints: [],      // full geometry
  stats: null,
  surface: null,
  time: null,
  meta: {},
  isFullGeometry: false, // imported track — do not re-route over it
  units: 'metric',
  busy: false,
  selectedClimb: null,
  segments: [],          // Strava segments matched onto this route
  stravaStatus: { configured: false, connected: false },
};

const settings = loadSettings();

function loadSettings() {
  const defaults = {
    orsKey: '',
    engine: 'brouter',
    profile: 'trekking',
    elevationProvider: 'terrarium',
    device: 'universal',
    units: 'metric',
    smoothWindow: ANALYSIS_DEFAULTS.smoothWindow,
    ascentThreshold: ANALYSIS_DEFAULTS.ascentThreshold,
    minClimbGain: ANALYSIS_DEFAULTS.minClimbGain,
    minClimbGrade: ANALYSIS_DEFAULTS.minClimbGrade * 100,
    bikePreset: 'road-hoods',
    riderMass: PHYS_DEFAULTS.riderMass,
    bikeMass: PHYS_DEFAULTS.bikeMass,
    power: PHYS_DEFAULTS.power,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

/* ================================================================== *
 * Boot
 * ================================================================== */

let map;
let chart;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.units = settings.units;

  map = new RouteMap('map', {
    units: state.units,
    onMapClick: (p) => addWaypoint(p),
    onWaypointMove: (i, p) => moveWaypoint(i, p),
    onWaypointRemove: (i) => removeWaypoint(i),
    onRouteHover: (p) => { chart?.setCursor(p?.dist ?? null); map.setCursor(p); },
    onRouteClick: (p) => insertWaypointAt(p),
    onTileFallback: (name) =>
      toast(`${name} tiles are not loading (their server is busy) — switched to OpenStreetMap.`),
  });

  chart = new ElevationProfile($('profile'), {
    units: state.units,
    onHover: (sample) => {
      map.setCursor(sample);
      $('profile-readout').textContent = sample
        ? `${fmtDistance(sample.dist, state.units)} · ${fmtElevation(sample.ele, state.units)} · ${fmtGradient(sample.grade)}` +
          (sample.climb ? ` · ${sample.climb.category.label} climb ${sample.climb.number}` : '')
        : '';
    },
    onClimbClick: (climb) => climb && selectClimb(climb),
  });

  buildSelects();
  bindEvents();
  applySettingsToForm();
  registerServiceWorker();
  // Debug handle for the console. The API key is deliberately withheld —
  // there is no reason for it to be reachable from `window`.
  window.gpxForge = {
    state: debugState,
    reanalyse,
    get settings() { const { orsKey, ...rest } = settings; return rest; },
  };

  // Leaflet measures its container on construction; in a grid layout that can
  // happen before the final size is known, leaving tiles in a partial band.
  requestAnimationFrame(() => map.invalidate());

  const online = await detectServer();
  setStatus(
    online
      ? 'Ready. Paste a map link, or click the map to drop points.'
      : 'Ready (static mode). Short link expansion is unavailable — paste full URLs.',
    online ? '' : 'busy'
  );

  refreshStravaStatus();

  const params = new URLSearchParams(location.search);

  // Returning from the Strava OAuth round trip.
  const stravaResult = params.get('strava');
  if (stravaResult === 'connected') {
    toast('Connected to Strava. Build a route, then search for segments.', 'ok');
    history.replaceState(null, '', location.pathname);
  } else if (stravaResult === 'denied') {
    toast('Strava sign-in was cancelled.', 'error');
    history.replaceState(null, '', location.pathname);
  }

  // Deep link support: ?route=<url>
  const shared = params.get('route');
  if (shared) {
    $('input-text').value = shared;
    buildFromInput();
  }
}

/* ================================================================== *
 * UI construction
 * ================================================================== */

function buildSelects() {
  const engine = $('engine-select');
  engine.innerHTML = '';
  for (const e of Object.values(ENGINES)) {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = e.label + (e.needsKey ? ' — needs key' : '');
    engine.append(opt);
  }
  engine.value = settings.engine;
  syncProfileSelect();

  const device = $('device-select');
  device.innerHTML = '';
  for (const d of Object.values(DEVICE_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.label;
    device.append(opt);
  }
  device.value = settings.device;
  $('device-blurb').textContent = DEVICE_PRESETS[settings.device].blurb;
  $('opt-plain').checked = Boolean(DEVICE_PRESETS[settings.device].plainGpx);

  const bike = $('bike-select');
  bike.innerHTML = '';
  for (const b of BIKE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.label;
    bike.append(opt);
  }
  bike.value = settings.bikePreset;
}

function syncProfileSelect() {
  const spec = ENGINES[$('engine-select').value];
  const sel = $('profile-select');
  sel.innerHTML = '';
  for (const p of spec.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.append(opt);
  }
  sel.value = spec.profiles.some((p) => p.id === settings.profile) ? settings.profile : spec.profiles[0].id;
  settings.profile = sel.value;

  let blurb = spec.blurb;
  if (spec.needsKey && !settings.orsKey) blurb += ' — add your key in Settings to use it.';
  $('engine-blurb').textContent = blurb;
}

function applySettingsToForm() {
  $('ors-key').value = settings.orsKey;
  $('elev-provider').value = settings.elevationProvider;
  $('set-smooth').value = settings.smoothWindow;
  $('set-threshold').value = settings.ascentThreshold;
  $('set-mingain').value = settings.minClimbGain;
  $('set-mingrade').value = settings.minClimbGrade;
  $('rider-mass').value = settings.riderMass;
  $('bike-mass').value = settings.bikeMass;
  $('power-input').value = settings.power;
  updatePowerReadout();
  setUnits(settings.units, true);
}

function bindEvents() {
  $('build-btn').addEventListener('click', buildFromInput);
  $('input-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') buildFromInput();
  });

  $('file-btn').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) importFile(file);
    e.target.value = '';
  });

  // Drag & drop anywhere
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    dragDepth++;
    document.body.classList.add('is-dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    const file = e.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });

  $('engine-select').addEventListener('change', (e) => {
    settings.engine = e.target.value;
    syncProfileSelect();
    saveSettings();
  });
  $('profile-select').addEventListener('change', (e) => {
    settings.profile = e.target.value;
    saveSettings();
  });
  $('reroute-btn').addEventListener('click', () => rebuildRoute({ force: true }));

  $('reverse-btn').addEventListener('click', () => {
    state.waypoints.reverse();
    rebuildRoute();
  });
  $('loop-btn').addEventListener('click', () => {
    if (state.waypoints.length < 2) return;
    const first = state.waypoints[0];
    state.waypoints.push({ lat: first.lat, lon: first.lon, name: `${first.name || 'Start'} (return)` });
    rebuildRoute();
  });
  $('clear-btn').addEventListener('click', clearAll);

  $('surface-btn').addEventListener('click', analyseSurface);
  $('download-btn').addEventListener('click', downloadGpx);

  $('device-select').addEventListener('change', (e) => {
    settings.device = e.target.value;
    const preset = DEVICE_PRESETS[settings.device];
    $('device-blurb').textContent = preset.blurb;
    // Follow the preset's recommendation, which the user can still override.
    $('opt-plain').checked = Boolean(preset.plainGpx);
    saveSettings();
    updateExportNote();
  });
  $('opt-plain').addEventListener('change', updateExportNote);

  $('bike-select').addEventListener('change', (e) => {
    settings.bikePreset = e.target.value;
    const preset = BIKE_PRESETS.find((b) => b.id === e.target.value);
    if (preset) { settings.bikeMass = preset.bikeMass; $('bike-mass').value = preset.bikeMass; }
    saveSettings();
    recomputeTime();
  });
  for (const id of ['rider-mass', 'bike-mass']) {
    $(id).addEventListener('change', () => {
      settings.riderMass = Number($('rider-mass').value) || PHYS_DEFAULTS.riderMass;
      settings.bikeMass = Number($('bike-mass').value) || PHYS_DEFAULTS.bikeMass;
      saveSettings();
      recomputeTime();
    });
  }
  $('power-input').addEventListener('input', () => {
    settings.power = Number($('power-input').value);
    updatePowerReadout();
  });
  $('power-input').addEventListener('change', () => { saveSettings(); recomputeTime(); });

  $('unit-metric').addEventListener('click', () => setUnits('metric'));
  $('unit-imperial').addEventListener('click', () => setUnits('imperial'));

  $('settings-btn').addEventListener('click', () => $('settings-dialog').showModal());
  $('settings-dialog').addEventListener('close', () => {
    const hadKey = Boolean(settings.orsKey);
    settings.orsKey = $('ors-key').value.trim();
    settings.elevationProvider = $('elev-provider').value;
    settings.smoothWindow = clampNum($('set-smooth').value, 0, 500, ANALYSIS_DEFAULTS.smoothWindow);
    settings.ascentThreshold = clampNum($('set-threshold').value, 0, 30, ANALYSIS_DEFAULTS.ascentThreshold);
    settings.minClimbGain = clampNum($('set-mingain').value, 5, 500, ANALYSIS_DEFAULTS.minClimbGain);
    settings.minClimbGrade = clampNum($('set-mingrade').value, 0.5, 15, ANALYSIS_DEFAULTS.minClimbGrade * 100);
    // Adding a key is only ever done in order to use OpenRouteService, so
    // switch to it rather than leaving the key inert behind a dropdown the
    // user then has to find. Freely reversible from the engine selector.
    // Catch a mis-paste now rather than as a puzzling 403 halfway through a
    // route. Current ORS keys are a base64 JWT ("eyJ…"); older ones are 40 hex
    // characters. A warning only — the format is theirs to change, not ours.
    const keyLooksValid =
      !settings.orsKey ||
      /^eyJ[\w-]/.test(settings.orsKey) ||
      /^[0-9a-f]{32,64}$/i.test(settings.orsKey);

    const keyJustAdded = !hadKey && Boolean(settings.orsKey);
    if (keyJustAdded && settings.engine !== 'ors') {
      settings.engine = 'ors';
      settings.profile = defaultProfile('ors');
      $('engine-select').value = 'ors';
    }

    saveSettings();
    syncProfileSelect();

    if (!keyLooksValid) {
      // Takes precedence over the success message — a single toast slot, and
      // this is the one the user needs to act on.
      toast('That does not look like an OpenRouteService key — check for a stray space or a partial copy.', 'error');
    } else if (keyJustAdded) {
      toast(
        state.waypoints.length >= 2
          ? 'Key saved — switched to OpenRouteService. Re-routing to pick up surface data…'
          : 'Key saved — switched to OpenRouteService for the best cycling profiles.',
        'ok'
      );
      // ORS returns surface and road type with the route, so a re-route now
      // fills in the surface card for free.
      if (state.waypoints.length >= 2 && !state.isFullGeometry) { rebuildRoute(); return; }
    }

    if (state.routePoints.length) reanalyse();
  });
  $('settings-reset').addEventListener('click', () => {
    localStorage.removeItem(STORE_KEY);
    Object.assign(settings, loadSettings());
    applySettingsToForm();
    buildSelects();
    toast('Settings reset to defaults.');
  });

  // PWA install prompt
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    $('install-btn').hidden = false;
  });
  $('install-btn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('install-btn').hidden = true;
  });

  window.addEventListener('resize', () => map.invalidate());
}

/* ================================================================== *
 * Pipeline
 * ================================================================== */

async function buildFromInput() {
  const text = $('input-text').value.trim();
  if (!text) { setStatus('Paste a map link, coordinates or place names first.', 'error'); return; }

  await withBusy($('build-btn'), async () => {
    setStatus('Reading link…', 'busy');
    const parsed = await parseInput(text, {
      resolveShortLink: hasServer() ? resolveShortLink : null,
    });

    // Resolve any place names.
    const needGeocode = parsed.waypoints.filter((w) => w.query);
    if (needGeocode.length) {
      setStatus(`Looking up ${needGeocode.length} place name(s)…`, 'busy');
      const box = viewboxHint(parsed.waypoints);
      for (const wp of parsed.waypoints) {
        if (!wp.query) continue;
        const found = await geocode(wp.query, fetchJson, box);
        wp.lat = found.lat;
        wp.lon = found.lon;
        wp.name = wp.name || found.name;
        delete wp.query;
      }
    }

    state.isFullGeometry = Boolean(parsed.isFullGeometry);
    state.meta = { source: parsed.source };

    if (state.isFullGeometry) {
      // An imported track already *is* the route. Re-routing it would replace
      // the rider's actual line with the router's opinion of it.
      state.routePoints = computeDistances(parsed.waypoints.map((p) => ({ ...p })));
      state.waypoints = pickRepresentativeWaypoints(state.routePoints, parsed.markers);
      if (!$('route-name').value && parsed.name) $('route-name').value = parsed.name;
      setStatus(`Imported ${parsed.source}. Analysing…`, 'busy');
      await finishRoute({ skipRouting: true, hasElevation: parsed.hasElevation });
    } else {
      state.waypoints = parsed.waypoints;
      if (parsed.note) toast(parsed.note);
      if (state.waypoints.length < 2) {
        renderWaypoints();
        map.setWaypoints(state.waypoints);
        map.fit(state.waypoints);
        setStatus('Only one point found — click the map to add more, then Re-route.', 'ok');
        showCards();
        return;
      }
      await routeAndAnalyse();
    }
  });
}

async function importFile(file) {
  await withBusy($('file-btn'), async () => {
    setStatus(`Reading ${file.name}…`, 'busy');
    const text = await file.text();
    const parsed = parseFile(file.name, text);

    state.isFullGeometry = Boolean(parsed.isFullGeometry);
    state.meta = { source: `${parsed.source} — ${file.name}` };

    if (!$('route-name').value) {
      $('route-name').value = parsed.name || file.name.replace(/\.[^.]+$/, '');
    }

    if (state.isFullGeometry) {
      state.routePoints = computeDistances(parsed.waypoints.map((p) => ({ ...p })));
      state.waypoints = pickRepresentativeWaypoints(state.routePoints, parsed.markers);
      await finishRoute({ skipRouting: true, hasElevation: parsed.hasElevation });
    } else {
      state.waypoints = parsed.waypoints;
      await routeAndAnalyse();
    }
  });
}

/**
 * UI entry point. `withBusy` guards against double-clicks, so it must only
 * wrap top-level actions — internal callers use routeAndAnalyse() directly or
 * the guard silently swallows the nested call.
 */
async function rebuildRoute() {
  await withBusy($('reroute-btn'), routeAndAnalyse);
}

async function routeAndAnalyse() {
  if (state.waypoints.length < 2) {
    renderWaypoints();
    map.setWaypoints(state.waypoints);
    showCards();
    setStatus('Add at least two points to build a route.', 'busy');
    return;
  }

  state.isFullGeometry = false;
  // The old segments belong to the old geometry; keeping them would show
  // segments that are no longer on the route.
  state.segments = [];
  state.segmentMeta = null;
  const engine = settings.engine;
  setStatus(`Routing with ${ENGINES[engine].label}…`, 'busy');

  const result = await runRoute(state.waypoints, {
    engine,
    profile: settings.profile,
    apiKey: settings.orsKey,
    onProgress: (msg) => setStatus(msg, 'busy'),
  });

  state.routePoints = result.points;
  state.meta = {
    ...state.meta,
    engineLabel: result.engineLabel,
    profileLabel: result.profileLabel,
    routerAscent: result.ascent,
    routerDuration: result.duration,
  };
  state.surface = result.extras ? fromOrsExtras(result.points, result.extras) : null;

  await finishRoute({ hasElevation: result.hasElevation });
}

/** Shared tail of both paths: elevation → analysis → render. */
async function finishRoute({ hasElevation = false } = {}) {
  if (!hasElevation) {
    setStatus('Fetching elevation…', 'busy');
    state.routePoints = await addElevation(state.routePoints, {
      provider: settings.elevationProvider,
      onProgress: (msg) => setStatus(msg, 'busy'),
    });
    computeDistances(state.routePoints);
  }

  reanalyse({ silent: true });
  map.fit(state.routePoints);

  const s = state.stats;
  setStatus(
    `${fmtDistance(s.distance, state.units)} · ${fmtElevation(s.ascent, state.units)} up · ` +
      `${s.climbCount} climb${s.climbCount === 1 ? '' : 's'} · ${s.difficulty.label}`,
    'ok'
  );
}

/** Re-runs analysis on existing geometry (after a settings change). */
function reanalyse({ silent = false } = {}) {
  if (!state.routePoints.length) return;

  state.stats = analyse(state.routePoints, {
    smoothWindow: settings.smoothWindow,
    ascentThreshold: settings.ascentThreshold,
    minClimbGain: settings.minClimbGain,
    minClimbGrade: settings.minClimbGrade / 100,
  });

  recomputeTime({ skipRender: true });
  renderAll();
  if (!silent) setStatus('Re-analysed.', 'ok');
}

function recomputeTime({ skipRender = false } = {}) {
  if (!state.stats?.hasElevation) { state.time = null; return; }
  const preset = BIKE_PRESETS.find((b) => b.id === settings.bikePreset) || BIKE_PRESETS[2];
  const params = {
    riderMass: settings.riderMass,
    bikeMass: settings.bikeMass,
    power: settings.power,
    cda: preset.cda,
    crr: preset.crr,
    surfaceFactor: state.surface ? rideabilityFactor(state.surface.surface) : 1,
  };
  state.time = estimate(state.stats.profile, params);
  state.time.perClimb = climbTimes(state.stats.profile, state.stats.climbs, params);
  if (!skipRender) renderAll();
}

async function analyseSurface() {
  if (!state.routePoints.length) return;
  await withBusy($('surface-btn'), async () => {
    state.surface = await fromOverpass(state.routePoints, {
      onProgress: (msg) => setStatus(msg, 'busy'),
    });
    recomputeTime();
    setStatus('Surface analysis complete.', 'ok');
  });
}

/* ================================================================== *
 * Waypoint editing
 * ================================================================== */

function addWaypoint(point) {
  if (state.busy) return;
  state.waypoints.push({ ...point });
  renderWaypoints();
  map.setWaypoints(state.waypoints);
  if (state.waypoints.length >= 2) rebuildRoute();
  else { showCards(); setStatus('One point set. Add another to build a route.', 'busy'); }
}

/** Inserts a point on the route between the two waypoints it falls between. */
function insertWaypointAt(hit) {
  if (state.busy || !state.waypoints.length) return;

  // Find which waypoint pair this position sits between, by comparing the
  // along-route distance of each waypoint's nearest geometry vertex.
  const wpDistances = state.waypoints.map((wp) => {
    let best = Infinity;
    let bestDist = 0;
    for (const p of state.routePoints) {
      const d = (p.lat - wp.lat) ** 2 + (p.lon - wp.lon) ** 2;
      if (d < best) { best = d; bestDist = p.dist; }
    }
    return bestDist;
  });

  let insertAt = wpDistances.findIndex((d) => d > hit.dist);
  if (insertAt < 0) insertAt = state.waypoints.length;

  state.waypoints.splice(insertAt, 0, { lat: hit.lat, lon: hit.lon });
  renderWaypoints();
  map.setWaypoints(state.waypoints);
  rebuildRoute();
}

function moveWaypoint(index, point) {
  if (!state.waypoints[index]) return;
  state.waypoints[index] = { ...state.waypoints[index], ...point };
  renderWaypoints();
  rebuildRoute();
}

function removeWaypoint(index) {
  state.waypoints.splice(index, 1);
  renderWaypoints();
  map.setWaypoints(state.waypoints);
  if (state.waypoints.length >= 2) rebuildRoute();
  else {
    state.routePoints = [];
    state.stats = null;
    map.setRoute([]);
    map.setClimbs([]);
    chart.setData(null);
    renderAll();
  }
}

function clearAll() {
  state.waypoints = [];
  state.routePoints = [];
  state.stats = null;
  state.surface = null;
  state.time = null;
  state.selectedClimb = null;
  state.isFullGeometry = false;
  state.segments = [];
  state.segmentMeta = null;
  $('input-text').value = '';
  map.setRoute([]);
  map.setWaypoints([]);
  map.setClimbs([]);
  map.setSegments([]);
  map.setCursor(null);
  chart.setData(null);
  renderAll();
  setStatus('Cleared. Paste a link or click the map to start again.');
}

/**
 * An imported track has thousands of points but no meaningful "waypoints".
 * Keep a handful so the user can still edit and re-route if they want to.
 */
function pickRepresentativeWaypoints(points, markers) {
  if (markers?.length >= 2) return markers.map((m) => ({ ...m }));
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const simplified = fitToLimit(points, 12);
  return simplified.map((p, i) => ({
    lat: p.lat,
    lon: p.lon,
    name: i === 0 ? 'Start' : i === simplified.length - 1 ? 'Finish' : undefined,
  }));
}

/* ================================================================== *
 * Rendering
 * ================================================================== */

function renderAll() {
  showCards();
  renderWaypoints();
  renderStats();
  renderClimbs();
  renderGradient();
  renderSurface();
  renderStrava();
  renderTime();
  updateExportNote();

  map.setWaypoints(state.waypoints);
  map.setRoute(state.routePoints, { profile: state.stats?.profile });
  map.setClimbs(state.stats?.climbs || []);
  map.setSegments(state.segments);
  chart.setData(state.stats);
}

function showCards() {
  const hasPoints = state.waypoints.length > 0;
  const hasRoute = state.routePoints.length > 1;
  const hasEle = Boolean(state.stats?.hasElevation);

  $('waypoints-card').hidden = !hasPoints;
  $('routing-card').hidden = !hasPoints;
  $('stats-card').hidden = !hasRoute;
  $('climbs-card').hidden = !hasEle;
  $('gradient-card').hidden = !hasEle;
  $('surface-card').hidden = !hasRoute;
  $('time-card').hidden = !hasEle;
  $('export-card').hidden = !hasRoute;
}

function renderWaypoints() {
  const list = $('wp-list');
  list.innerHTML = '';
  $('wp-count').textContent = state.waypoints.length ? String(state.waypoints.length) : '';

  state.waypoints.forEach((wp, i) => {
    const isStart = i === 0;
    const isEnd = i === state.waypoints.length - 1;
    const li = document.createElement('li');
    li.className = `wp-item${isStart ? ' is-start' : ''}${isEnd && !isStart ? ' is-end' : ''}`;

    const num = document.createElement('span');
    num.className = 'wp-num';
    num.textContent = isStart ? 'S' : isEnd ? 'F' : String(i);

    const name = document.createElement('span');
    name.className = 'wp-name';
    name.textContent = wp.name || `Point ${i + 1}`;
    name.title = wp.name || '';

    const coord = document.createElement('span');
    coord.className = 'wp-coord';
    coord.textContent = `${wp.lat.toFixed(4)}, ${wp.lon.toFixed(4)}`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'wp-del';
    del.textContent = '×';
    del.title = 'Remove this point';
    del.setAttribute('aria-label', `Remove point ${i + 1}`);
    del.addEventListener('click', () => removeWaypoint(i));

    li.append(num, name, coord, del);
    li.addEventListener('mouseenter', () => map.setCursor(wp));
    li.addEventListener('mouseleave', () => map.setCursor(null));
    list.append(li);
  });
}

function renderStats() {
  const s = state.stats;
  const grid = $('stats-grid');
  grid.innerHTML = '';
  if (!s) return;

  const cells = [['Distance', fmtDistance(s.distance, state.units)]];

  if (s.hasElevation) {
    cells.push(
      ['Total ascent', fmtElevation(s.ascent, state.units)],
      ['Total descent', fmtElevation(s.descent, state.units)],
      ['Climbs', String(s.climbCount)],
      ['Max elevation', fmtElevation(s.maxEle, state.units)],
      ['Min elevation', fmtElevation(s.minEle, state.units)],
      ['Steepest 100 m', fmtGradient(s.steepest100)],
      ['Climbing rate', `${Math.round(s.climbRate)} m/km`],
      ['Difficulty', s.difficulty.label],
    );
  }

  for (const [k, v] of cells) {
    const div = document.createElement('div');
    div.className = 'stat';
    div.innerHTML = `<div class="v"></div><div class="k"></div>`;
    div.querySelector('.v').textContent = v;
    div.querySelector('.k').textContent = k;
    grid.append(div);
  }

  const note = $('ascent-note');
  if (s.hasElevation) {
    const parts = [
      `Ascent filtered at ${settings.ascentThreshold} m (raw sum would be ${fmtElevation(s.ascentRaw, state.units)}).`,
    ];
    if (state.meta.routerAscent) {
      parts.push(`Router reported ${fmtElevation(state.meta.routerAscent, state.units)}.`);
    }
    note.textContent = parts.join(' ');
  } else {
    note.textContent = '';
  }
}

function renderClimbs() {
  const wrap = $('climbs-list');
  wrap.innerHTML = '';
  const climbs = state.stats?.climbs || [];
  $('climb-count').textContent = climbs.length ? String(climbs.length) : '';

  if (!climbs.length) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = state.stats?.hasElevation
      ? 'No climbs met the threshold. Lower "min climb gain" in Settings to catch smaller rises.'
      : '';
    wrap.append(p);
    return;
  }

  climbs.forEach((climb, i) => {
    const t = state.time?.perClimb?.[i];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'climb' + (state.selectedClimb?.number === climb.number ? ' is-active' : '');
    btn.style.setProperty('--cat', climb.category.color);

    const badge = document.createElement('span');
    badge.className = 'climb-badge';
    badge.textContent = climb.category.label === 'Uncategorised' ? `#${climb.number}` : climb.category.label;

    const main = document.createElement('span');
    main.className = 'climb-main';
    const title = document.createElement('span');
    title.className = 'climb-title';
    title.textContent = `${fmtDistance(climb.length, state.units)} · ${fmtElevation(climb.gain, state.units)} up`;
    const sub = document.createElement('span');
    sub.className = 'climb-sub';
    sub.textContent =
      `from ${fmtDistance(climb.startDist, state.units)} · tops ${fmtElevation(climb.topEle, state.units)}` +
      `${t ? ` · ≈${fmtDuration(t.seconds)} (VAM ${Math.round(t.vam)})` : ''} · FIETS ${climb.fiets.toFixed(1)}`;
    main.append(title, document.createElement('br'), sub);

    const grade = document.createElement('span');
    grade.className = 'climb-grade';
    grade.innerHTML = '<small></small>';
    grade.prepend(document.createTextNode(`${(climb.avgGrade * 100).toFixed(1)}%`));
    grade.querySelector('small').textContent = `max ${(climb.maxGrade * 100).toFixed(1)}%`;

    btn.append(badge, main, grade);
    btn.addEventListener('click', () => selectClimb(climb));
    wrap.append(btn);
  });
}

function selectClimb(climb) {
  state.selectedClimb = state.selectedClimb?.number === climb.number ? null : climb;
  chart.highlightClimb(state.selectedClimb);
  if (state.selectedClimb) map.zoomTo(climb);
  renderClimbs();
}

function renderGradient() {
  const bar = $('gradient-bar');
  const legend = $('gradient-legend');
  bar.innerHTML = '';
  legend.innerHTML = '';
  const bands = state.stats?.bands?.filter((b) => b.share > 0) || [];

  for (const band of bands) {
    const seg = document.createElement('div');
    seg.className = 'bar-seg';
    seg.style.width = `${band.share * 100}%`;
    seg.style.background = band.color;
    seg.title = `${band.label}: ${fmtDistance(band.distance, state.units)} (${(band.share * 100).toFixed(1)}%)`;
    bar.append(seg);

    if (band.share < 0.005) continue;
    const item = document.createElement('span');
    item.className = 'legend-item';
    const sw = document.createElement('span');
    sw.className = 'legend-sw';
    sw.style.background = band.color;
    const label = document.createElement('span');
    label.textContent = `${band.label} · ${(band.share * 100).toFixed(0)}%`;
    item.append(sw, label);
    legend.append(item);
  }
}

/* ---------------- Strava segments ---------------- */

async function refreshStravaStatus() {
  state.stravaStatus = hasServer() ? await strava.status() : { configured: false, connected: false };
  renderStrava();
}

async function findStravaSegments() {
  if (!state.routePoints.length) return;
  await withBusy(null, async () => {
    setStatus('Looking for Strava segments…', 'busy');
    const result = await strava.findSegments(state.routePoints, {
      onProgress: (msg) => setStatus(msg, 'busy'),
    });
    state.segments = result.segments;
    state.segmentMeta = result;
    renderAll();
    setStatus(
      `${result.segments.length} segment${result.segments.length === 1 ? '' : 's'} on this route ` +
        `(of ${result.considered} nearby).`,
      'ok'
    );
  });
}

function renderStrava() {
  const card = $('strava-card');
  const body = $('strava-body');
  const note = $('strava-note');
  const st = state.stravaStatus;

  // Nothing to show on the static build — there is no server to hold the secret.
  if (!hasServer() || !st.configured) {
    card.hidden = !state.routePoints.length || !hasServer();
    if (!card.hidden) {
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'muted small';
      p.textContent =
        'Strava needs API credentials on the server — see README → Strava segments. ' +
        'It cannot work on the hosted site because Strava requires a client secret and has no PKCE flow.';
      body.append(p);
      note.textContent = '';
    }
    return;
  }

  card.hidden = !state.routePoints.length;
  body.innerHTML = '';
  $('strava-count').textContent = state.segments.length ? String(state.segments.length) : '';

  if (!st.connected) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'Connect your Strava account to find segments along this route.';
    const a = document.createElement('a');
    a.className = 'btn primary full';
    a.href = '/api/strava/login';
    a.textContent = 'Connect Strava';
    body.append(p, a);
    note.textContent = 'Read-only access to public segments. Tokens stay on this machine.';
    return;
  }

  // Connected, but Strava is refusing the app — say so instead of offering a
  // search button that cannot possibly work.
  if (st.usable === false) {
    const warn = document.createElement('p');
    warn.className = 'status error small';
    warn.textContent = st.problem || 'Strava is refusing requests from this application.';
    const link = document.createElement('a');
    link.className = 'btn small';
    link.href = 'https://www.strava.com/settings/api';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open Strava API settings';
    body.append(warn, link);
    note.textContent = `Connected as ${st.athlete?.firstname || 'you'}, but the app itself is not permitted to call the API.`;
    return;
  }

  const find = document.createElement('button');
  find.type = 'button';
  find.className = 'btn full';
  find.textContent = state.segments.length ? 'Search again' : 'Find segments on this route';
  find.addEventListener('click', findStravaSegments);
  body.append(find);

  for (const seg of state.segments) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'climb';
    row.style.setProperty('--cat', seg.categoryColor);

    const badge = document.createElement('span');
    badge.className = 'climb-badge';
    badge.textContent = seg.categoryLabel;

    const main = document.createElement('span');
    main.className = 'climb-main';
    const title = document.createElement('span');
    title.className = 'climb-title';
    title.textContent = seg.name;
    const sub = document.createElement('span');
    sub.className = 'climb-sub';
    sub.textContent =
      `${fmtDistance(seg.distance, state.units)} · ${Number(seg.avgGrade).toFixed(1)}% · ` +
      `from ${fmtDistance(seg.startDist, state.units)}`;
    main.append(title, document.createElement('br'), sub);

    const grade = document.createElement('span');
    grade.className = 'climb-grade';
    grade.innerHTML = '<small></small>';
    grade.prepend(document.createTextNode(`${Number(seg.avgGrade).toFixed(1)}%`));
    grade.querySelector('small').textContent = `${Math.round(seg.coverage * 100)}% match`;

    row.append(badge, main, grade);
    row.addEventListener('click', () => {
      map.highlightSegment(seg);
      map.fit(seg.latlngs);
    });
    body.append(row);
  }

  const meta = state.segmentMeta;
  const bits = [];
  if (meta) {
    bits.push(`${meta.considered} segments found nearby, ${state.segments.length} actually on the route.`);
    if (meta.rateLimited) bits.push('Strava rate-limited the search — some sections were skipped.');
    if (meta.truncated) bits.push('Route is long; only the first sections were searched.');
  }
  bits.push('Matching requires 90% of the segment within 25 m of your route, travelling the same way.');
  note.textContent = bits.join(' ');
}

function renderSurface() {
  const wrap = $('surface-content');
  wrap.innerHTML = '';
  const note = $('surface-note');

  if (!state.surface) {
    note.textContent = settings.engine === 'ors'
      ? 'OpenRouteService returns surface data with the route — re-route to populate this.'
      : 'The keyless engines do not return surface tags, so this asks OpenStreetMap directly. Takes a few seconds.';
    $('surface-btn').hidden = false;
    return;
  }

  for (const [title, rows] of [['Surface', state.surface.surface], ['Road type', state.surface.waytype]]) {
    if (!rows?.length) continue;
    const h = document.createElement('h3');
    h.textContent = title;
    wrap.append(h);

    const bar = document.createElement('div');
    bar.className = 'bar-stack';
    for (const r of rows) {
      const seg = document.createElement('div');
      seg.className = 'bar-seg';
      seg.style.width = `${r.share * 100}%`;
      seg.style.background = r.color;
      seg.title = `${r.label}: ${(r.share * 100).toFixed(1)}%`;
      bar.append(seg);
    }
    wrap.append(bar);

    const list = document.createElement('div');
    list.className = 'breakdown';
    for (const r of rows) {
      if (r.share < 0.005) continue;
      const row = document.createElement('div');
      row.className = 'breakdown-row';
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = r.color;
      const label = document.createElement('span');
      label.textContent = r.label;
      const pct = document.createElement('span');
      pct.className = 'pct';
      pct.textContent = `${(r.share * 100).toFixed(1)}% · ${fmtDistance(r.distance, state.units)}`;
      row.append(sw, label, pct);
      list.append(row);
    }
    wrap.append(list);
  }

  const bits = [`Source: ${state.surface.source}.`];
  if (state.surface.assumedShare > 0.02) {
    bits.push(`${Math.round(state.surface.assumedShare * 100)}% inferred from road class (no surface tag in OSM).`);
  }
  note.textContent = bits.join(' ');
  $('surface-btn').hidden = state.surface.source !== 'OpenRouteService';
}

function renderTime() {
  const grid = $('time-grid');
  grid.innerHTML = '';
  if (!state.time) return;

  const cells = [
    ['Estimated time', fmtDuration(state.time.totalSeconds)],
    ['Average speed', fmtSpeed(state.time.avgSpeedKmh, state.units)],
  ];
  for (const [k, v] of cells) {
    const div = document.createElement('div');
    div.className = 'stat';
    div.innerHTML = '<div class="v"></div><div class="k"></div>';
    div.querySelector('.v').textContent = v;
    div.querySelector('.k').textContent = k;
    grid.append(div);
  }
  updatePowerReadout();
}

function updatePowerReadout() {
  const w = Number($('power-input').value);
  $('power-out').textContent = `${w} W`;
  const preset = BIKE_PRESETS.find((b) => b.id === settings.bikePreset) || BIKE_PRESETS[2];
  const flat = flatSpeedForPower(w, preset);
  $('power-hint').textContent =
    `About ${fmtSpeed(flat, state.units)} on the flat in still air ` +
    `(${(w / Math.max(40, settings.riderMass)).toFixed(1)} W/kg).`;
}

function flatSpeedForPower(watts, preset) {
  // Invert powerForFlatSpeed by bisection — cheap, and keeps one source of truth.
  let lo = 3, hi = 70;
  const opts = { riderMass: settings.riderMass, bikeMass: settings.bikeMass, cda: preset.cda, crr: preset.crr };
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (powerForFlatSpeed(mid, opts) < watts) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function updateExportNote() {
  if (!state.stats) { $('export-note').textContent = ''; return; }
  const preset = DEVICE_PRESETS[settings.device];
  const kept = fitToLimit(state.routePoints, preset.maxPoints).length;
  const total = state.routePoints.length;

  const parts = [
    kept < total
      ? `${kept.toLocaleString()} of ${total.toLocaleString()} points kept — simplified to fit the device budget, preserving the elevation profile.`
      : `All ${total.toLocaleString()} points kept.`,
  ];

  // Some devices cap route *length* rather than point count.
  const km = state.stats.distance / 1000;
  if (preset.maxDistanceKm && km > preset.maxDistanceKm) {
    parts.push(
      `This route is ${Math.round(km)} km, over the ${preset.maxDistanceKm} km limit for this device — ` +
        `split it into stages, or use a model with a higher limit.`
    );
  }
  if ($('opt-plain').checked) {
    parts.push('Plain GPX: statistics block omitted, summary line kept.');
  }

  $('export-note').textContent = parts.join(' ');
}

/* ================================================================== *
 * Export
 * ================================================================== */

function downloadGpx() {
  if (!state.routePoints.length) return;
  const name = $('route-name').value.trim() || defaultRouteName();

  const xml = buildGpx({
    points: state.routePoints,
    stats: state.stats,
    name,
    waypoints: state.waypoints,
    surface: state.surface,
    time: state.time,
    segments: state.segments,
    meta: state.meta,
    options: {
      preset: settings.device,
      includeSegments: $('opt-segments').checked,
      includeClimbWaypoints: $('opt-climbs').checked,
      includeWaypoints: $('opt-waypoints').checked,
      includeRoute: $('opt-route').checked,
      timestamps: $('opt-time').checked,
      plainGpx: $('opt-plain').checked,
      units: state.units,
    },
  });

  const blob = new Blob([xml], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = gpxFilename(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  toast(`Saved ${gpxFilename(name)} — ${(blob.size / 1024).toFixed(0)} KB`, 'ok');
}

function defaultRouteName() {
  const s = state.stats;
  const d = s ? fmtDistance(s.distance, state.units) : 'route';
  const date = new Date().toISOString().slice(0, 10);
  return `${d} ride ${date}`;
}

/* ================================================================== *
 * Helpers
 * ================================================================== */

function setUnits(units, silent = false) {
  state.units = units;
  settings.units = units;
  $('unit-metric').classList.toggle('is-active', units === 'metric');
  $('unit-imperial').classList.toggle('is-active', units === 'imperial');
  $('unit-metric').setAttribute('aria-pressed', String(units === 'metric'));
  $('unit-imperial').setAttribute('aria-pressed', String(units === 'imperial'));
  $('profile-title').textContent =
    units === 'imperial' ? 'Elevation profile — mi / ft' : 'Elevation profile — km / m';
  chart?.setUnits(units);
  map?.setUnits(units);
  if (!silent) { saveSettings(); renderAll(); }
}

let statusLocked = false;

/**
 * Once an error is shown it stays shown. In-flight work (parallel elevation
 * batches, for instance) keeps emitting progress after one of them rejects,
 * and those late callbacks would otherwise paper over the error with a
 * cheerful "Elevation 63%…".
 */
function setStatus(message, kind = '') {
  if (statusLocked && kind !== 'error') return;
  statusLocked = kind === 'error';
  const el = $('status');
  el.textContent = message;
  el.className = `status ${kind}`;
}

let toastTimer;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5200);
}

async function withBusy(button, fn) {
  if (state.busy) return;
  state.busy = true;
  statusLocked = false; // a new action may replace a previous error
  button?.classList.add('is-busy');
  document.querySelectorAll('.btn.primary').forEach((b) => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), 'error');
    toast(err.message || String(err), 'error');
  } finally {
    state.busy = false;
    button?.classList.remove('is-busy');
    document.querySelectorAll('.btn.primary').forEach((b) => { b.disabled = false; });
  }
}

function clampNum(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/** Biases geocoding toward the area the other waypoints are already in. */
function viewboxHint(waypoints) {
  const located = waypoints.filter((w) => w.lat != null);
  if (located.length < 1) return null;
  const [[minLat, minLon], [maxLat, maxLon]] = boundsOf(located);
  const pad = 0.5;
  return [minLon - pad, maxLat + pad, maxLon + pad, minLat - pad];
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
