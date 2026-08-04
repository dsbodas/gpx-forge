/**
 * Leaflet map wrapper: base layers, the route line, draggable waypoints,
 * climb markers and the cursor that stays in sync with the elevation chart.
 */

import { bandFor } from './analysis.js';
import { bounds as boundsOf, haversine, fmtDistance, fmtElevation } from './util.js';

const L = window.L;

const BASE_LAYERS = {
  'CyclOSM (cycling)': {
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    options: {
      maxZoom: 20,
      subdomains: 'abc',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · CyclOSM',
    },
  },
  'OpenStreetMap': {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    },
  },
  'OpenTopoMap (terrain)': {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    options: {
      maxZoom: 17,
      subdomains: 'abc',
      attribution: '&copy; OpenStreetMap · SRTM · <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    },
  },
};

export class RouteMap {
  constructor(elementId, opts = {}) {
    this.onMapClick = opts.onMapClick || (() => {});
    this.onWaypointMove = opts.onWaypointMove || (() => {});
    this.onWaypointRemove = opts.onWaypointRemove || (() => {});
    this.onRouteHover = opts.onRouteHover || (() => {});
    this.onRouteClick = opts.onRouteClick || (() => {});
    this.onTileFallback = opts.onTileFallback || null;
    this.units = opts.units || 'metric';

    this.map = L.map(elementId, {
      zoomControl: true,
      // Leaflet's default tap handler swallows long-press on iOS.
      tapHold: true,
      // Leaflet fades tiles in over requestAnimationFrame. When frames are
      // throttled — background tab, low-power mode, a resize landing mid-fade —
      // the transition can stall and leave tiles stuck part-transparent, which
      // looks exactly like tiles that failed to load. Not worth the risk for a
      // 200 ms cosmetic fade.
      fadeAnimation: false,
    }).setView([46.5, 8.0], 6);

    const layers = {};
    let first = true;
    for (const [name, cfg] of Object.entries(BASE_LAYERS)) {
      const layer = L.tileLayer(cfg.url, cfg.options);
      layers[name] = layer;
      if (first) { layer.addTo(this.map); this.activeLayerName = name; first = false; }

      // These are donated, volunteer-run tile servers and they throttle by IP.
      // When that happens the map renders half-blank, which reads as a broken
      // app rather than a busy server — so fall back to the standard OSM tiles,
      // which have the most headroom, and say so once.
      let errors = 0;
      layer.on('tileerror', () => {
        errors++;
        if (errors !== 6 || name === 'OpenStreetMap') return;
        if (!this.map.hasLayer(layer)) return;
        this.map.removeLayer(layer);
        layers['OpenStreetMap'].addTo(this.map);
        this.activeLayerName = 'OpenStreetMap';
        this.onTileFallback?.(name);
      });
    }
    this.baseLayers = layers;
    L.control.layers(layers, {}, { position: 'topright', collapsed: true }).addTo(this.map);
    // A deliberate layer choice should not be second-guessed by the fallback.
    this.map.on('baselayerchange', (e) => { this.activeLayerName = e.name; });
    L.control.scale({ imperial: this.units === 'imperial', metric: this.units === 'metric' }).addTo(this.map);

    this.routeLayer = L.layerGroup().addTo(this.map);
    this.waypointLayer = L.layerGroup().addTo(this.map);
    this.climbLayer = L.layerGroup().addTo(this.map);
    this.cursorMarker = null;
    this.routePoints = [];

    this.map.on('click', (e) => this.onMapClick({ lat: e.latlng.lat, lon: e.latlng.lng }));

    // Leaflet caches its container size, so any layout change (grid resolving,
    // the panel growing, an orientation flip) leaves tiles drawn for the old
    // dimensions — the classic "tiles only fill part of the map" symptom.
    const container = this.map.getContainer();
    this._resizeObserver = new ResizeObserver(() => this.map.invalidateSize({ pan: false }));
    this._resizeObserver.observe(container);
  }

  invalidate() { this.map.invalidateSize(); }

  setUnits(units) { this.units = units; }

  /* ---------------- route ---------------- */

  setRoute(points, { colorByGradient = true, profile = null } = {}) {
    this.routeLayer.clearLayers();
    this.routePoints = points || [];
    if (!points || points.length < 2) return;

    // A wide translucent casing under the line makes it readable on busy
    // cycling tiles and gives a fat hit target for hover/click.
    const casing = L.polyline(points.map((p) => [p.lat, p.lon]), {
      color: '#12181f',
      weight: 8,
      opacity: 0.35,
      lineJoin: 'round',
      interactive: true,
    }).addTo(this.routeLayer);

    casing.on('mousemove', (e) => {
      const hit = this._nearestOnRoute(e.latlng);
      if (hit) this.onRouteHover(hit);
    });
    casing.on('mouseout', () => this.onRouteHover(null));
    casing.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      const hit = this._nearestOnRoute(e.latlng);
      if (hit) this.onRouteClick(hit);
    });

    if (colorByGradient && profile?.length) {
      // Cap the number of drawn segments: 20 000 individual polylines would
      // bring the browser to its knees for no visible benefit.
      const stride = Math.max(1, Math.ceil(profile.length / 1200));
      let runStart = 0;
      let runBand = bandFor(profile[0].grade).color;

      for (let i = stride; i < profile.length; i += stride) {
        const band = bandFor(profile[i].grade).color;
        if (band !== runBand || i + stride >= profile.length) {
          const seg = profile.slice(runStart, Math.min(i + 1, profile.length));
          if (seg.length > 1) {
            L.polyline(seg.map((p) => [p.lat, p.lon]), {
              color: runBand,
              weight: 4.5,
              opacity: 0.95,
              lineJoin: 'round',
              interactive: false,
            }).addTo(this.routeLayer);
          }
          runStart = i;
          runBand = band;
        }
      }
    } else {
      L.polyline(points.map((p) => [p.lat, p.lon]), {
        color: '#e8590c',
        weight: 4.5,
        opacity: 0.95,
        lineJoin: 'round',
        interactive: false,
      }).addTo(this.routeLayer);
    }
  }

  /** Nearest route vertex to a latlng, with its distance along the route. */
  _nearestOnRoute(latlng) {
    const target = { lat: latlng.lat, lon: latlng.lng };
    let best = null;
    let bestD = Infinity;
    // Coarse then fine, so hovering a 100k-point route stays smooth.
    const coarse = Math.max(1, Math.floor(this.routePoints.length / 2000));
    for (let i = 0; i < this.routePoints.length; i += coarse) {
      const d = haversine(this.routePoints[i], target);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best == null) return null;
    for (let i = Math.max(0, best - coarse); i < Math.min(this.routePoints.length, best + coarse); i++) {
      const d = haversine(this.routePoints[i], target);
      if (d < bestD) { bestD = d; best = i; }
    }
    const p = this.routePoints[best];
    return { ...p, index: best, dist: p.dist };
  }

  /* ---------------- waypoints ---------------- */

  setWaypoints(waypoints) {
    this.waypointLayer.clearLayers();
    if (!waypoints?.length) return;

    waypoints.forEach((wp, index) => {
      const isFirst = index === 0;
      const isLast = index === waypoints.length - 1;
      const kind = isFirst ? 'start' : isLast ? 'end' : 'via';
      const label = isFirst ? 'S' : isLast ? 'F' : String(index);

      const marker = L.marker([wp.lat, wp.lon], {
        draggable: true,
        keyboard: true,
        title: wp.name || `Waypoint ${index + 1}`,
        icon: L.divIcon({
          className: 'wp-icon-wrap',
          html: `<div class="wp-icon wp-${kind}">${label}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      }).addTo(this.waypointLayer);

      marker.on('dragend', (e) => {
        const ll = e.target.getLatLng();
        this.onWaypointMove(index, { lat: ll.lat, lon: ll.lng });
      });

      const name = wp.name ? escapeHtml(wp.name) : `Waypoint ${index + 1}`;
      marker.bindPopup(
        `<div class="wp-popup"><strong>${name}</strong>` +
          `<div class="muted">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</div>` +
          `<button type="button" data-remove="${index}">Remove point</button></div>`
      );
      marker.on('popupopen', (e) => {
        const btn = e.popup.getElement()?.querySelector('[data-remove]');
        btn?.addEventListener('click', () => {
          this.map.closePopup();
          this.onWaypointRemove(index);
        });
      });
    });
  }

  /* ---------------- climbs ---------------- */

  setClimbs(climbs) {
    this.climbLayer.clearLayers();
    if (!climbs?.length) return;

    for (const climb of climbs) {
      const label = climb.category.label === 'Uncategorised' ? `C${climb.number}` : climb.category.label;
      L.marker([climb.lat, climb.lon], {
        icon: L.divIcon({
          className: 'climb-icon-wrap',
          html: `<div class="climb-icon" style="--cat:${climb.category.color}">${label}</div>`,
          iconSize: [40, 18],
          iconAnchor: [20, 9],
        }),
      })
        .bindPopup(
          `<div class="wp-popup"><strong>Climb ${climb.number} — ${climb.category.label}</strong>` +
            `<div>${fmtDistance(climb.length, this.units)} at ${(climb.avgGrade * 100).toFixed(1)}% ` +
            `(max ${(climb.maxGrade * 100).toFixed(1)}%)</div>` +
            `<div>${fmtElevation(climb.gain, this.units)} gain · tops at ${fmtElevation(climb.topEle, this.units)}</div>` +
            `<div class="muted">From ${fmtDistance(climb.startDist, this.units)} to ${fmtDistance(climb.endDist, this.units)}</div>` +
            `</div>`
        )
        .addTo(this.climbLayer);
    }
  }

  /* ---------------- cursor ---------------- */

  setCursor(point) {
    if (!point) {
      if (this.cursorMarker) { this.map.removeLayer(this.cursorMarker); this.cursorMarker = null; }
      return;
    }
    const latlng = [point.lat, point.lon];
    if (!this.cursorMarker) {
      this.cursorMarker = L.circleMarker(latlng, {
        radius: 6,
        color: '#fff',
        weight: 2.5,
        fillColor: '#e8590c',
        fillOpacity: 1,
        interactive: false,
      }).addTo(this.map);
    } else {
      this.cursorMarker.setLatLng(latlng);
    }
  }

  /* ---------------- viewport ---------------- */

  fit(points, options = {}) {
    if (!points?.length) return;
    // Recompute the container size first: fitBounds derives the zoom from it,
    // so a stale size (layout still settling, orientation change) silently
    // yields a wildly wrong zoom level.
    this.map.invalidateSize({ pan: false });
    const b = boundsOf(points);
    // Generous padding costs a whole zoom level on a short phone-sized map.
    const size = this.map.getSize();
    const pad = Math.max(14, Math.min(36, Math.round(Math.min(size.x, size.y) * 0.06)));
    this.map.fitBounds(b, { padding: [pad, pad], maxZoom: 16, ...options });
  }

  zoomTo(climb) {
    if (!climb || !this.routePoints.length) return;
    const seg = this.routePoints.filter((p) => p.dist >= climb.startDist && p.dist <= climb.endDist);
    if (seg.length > 1) this.fit(seg, { padding: [50, 50] });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
