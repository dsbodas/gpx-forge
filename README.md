# GPX Forge

Turn any map link into a GPX file your cycling computer understands — with a real
elevation profile, categorised climbs, gradient breakdown, surface analysis and a
ride-time estimate.

Paste a Google Maps or Apple Maps directions link, drop a GPX from anywhere else,
or just click points on the map. The app re-plans the route on the OpenStreetMap
cycling network, fetches elevation, analyses it, and writes a GPX that loads
cleanly onto a Garmin, Wahoo or Hammerhead.

---

## Running it

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:8787**.

To use it from your phone on the same Wi-Fi, find your machine's IP
(`ipconfig getifaddr en0` on macOS) and visit `http://<that-ip>:8787`.

### Installing it as an app

It is a PWA, so it installs on every platform without an app store:

- **iPhone / iPad** — open in Safari, Share → *Add to Home Screen*.
- **Android** — open in Chrome, menu → *Install app*. Once installed you can also
  **share a Google Maps link straight into it** from the Android share sheet.
- **Desktop** — Chrome/Edge show an install icon in the address bar, or use the
  *Install app* button in the header.

Installed, it keeps working offline for importing, analysing and exporting GPX
files. Routing and elevation still need a connection.

---

## Getting a route in

| Source | How |
|---|---|
| **Google Maps** | Share a route, or copy the URL from the address bar of a directions page. Short `maps.app.goo.gl` links work too. |
| **Apple Maps** | Share → Copy Link. |
| **OpenStreetMap, Bing, Waze, BRouter** | Paste the link. |
| **Komoot, Strava, RideWithGPS, plotaroute** | Export GPX there, then drag the file onto the window. |
| **A GPX/KML/TCX/GeoJSON file** | Drag it anywhere onto the page. |
| **Coordinates or place names** | One per line, e.g. `45.9237, 6.8694` or `Chamonix`. |
| **By hand** | Click the map to drop points; drag them to adjust; click the route line to insert a via point. |

### Why it re-routes instead of copying Google's line

Neither Google nor Apple offers a route-export API, and scraping their directions
output would breach their terms. What the app does instead is read **the waypoints
you yourself put in the link** — those coordinates are sitting right there in the
URL — and re-plan the route on OpenStreetMap.

For cycling this is an upgrade, not a compromise: the result can use cycleways,
quiet lanes and gravel that a car-oriented router will never suggest, and it comes
with elevation and surface data attached.

---

## Routing engines

Switchable at any time; two of the three need no account.

| Engine | Key? | Notes |
|---|---|---|
| **BRouter** *(default)* | No | Cycling-first profiles (trekking, fast, safety, gravel-ish, steep-tolerant). Returns elevation with the route. |
| **OSRM** — FOSSGIS bike server | No | Fast and dependable; the one `openstreetmap.org` itself uses. One generic bike profile, elevation fetched separately. |
| **OpenRouteService** | Yes — free | Best profiles (road / mountain / e-bike) and the only engine that returns **surface and road-type data with the route**. Get a key at `openrouteservice.org/dev/#/signup` (2 000 routes/day) and paste it into Settings. |
| **Straight lines** | No | No routing at all. For open terrain or debugging. |

---

## What the analysis does

### Total ascent is a choice, not a fact

Sum every wiggle in raw terrain data over a 100 km route and you can invent
several hundred metres of climbing that does not exist. The pipeline is
deliberate:

1. **Resample** to a uniform 10 m spacing, so densely-cornered sections stop
   counting for more than straight ones.
2. **Despike** with a median filter, which removes bad terrain cells outright.
   A moving average cannot do this — it smears one bad sample across the whole
   window, turning a spike into a sustained ramp.
3. **Smooth** what remains over a 150 m window.
4. **Accumulate** with a 3 m hysteresis threshold — reversals smaller than that
   are noise, not hills.

Both figures are always shown: *"Ascent filtered at 3 m (raw sum would be
1,240 m)"*. On Alpe d'Huez this yields **1,114 m** against BRouter's own
**1,130 m**, where the unfiltered sum claims 1,240 m.

All three parameters are adjustable in Settings. Setting the threshold to 0 gives
you the raw number.

### Why the default smoothing is 150 m

On switchbacks a 30–90 m elevation model cannot resolve the road: two points
300 m apart along the tarmac sit only tens of metres apart horizontally, so the
model reads the mountainside falling away between the bends. The profile then
oscillates around the true gradient.

Measured on Alpe d'Huez — a climb that never once descends — the share of the
profile falsely reading as *downhill* falls from 4.3% to 0% moving from a 75 m to
a 150 m window. Total ascent moves by 5 m across that entire range, which is why
the hysteresis threshold, not the smoothing, is what protects the headline
numbers.

### Gradients are reported as a high percentile, not a maximum

The same hairpin problem has one consequence that no amount of filtering can fix.
Where a road switchbacks tightly on a steep face, the true road elevation is
simply **absent** from the data, so every terrain model makes the same mistake.

On one test route the worst point was checked against OpenStreetMap directly: it
sits on an asphalt secondary road, the Route de la Forclaz, whose real maximum is
about 12–13%. Copernicus and SRTM *independently* both claim over 28% there.

So "steepest 100 m" is reported as the 98th percentile of sustained 100 m
gradients rather than the outright maximum. That ignores the handful of
unresolvable points while still reflecting genuinely steep sections. On the same
route it brings the figure to 12.7% — matching the real climb — without changing
the synthetic test cases, where the known answer is still returned exactly.

### Climbs

Climbs are found by locating summits with real vertical prominence, then merging
stepped ramps — a col reached in two pitches with a dip between them is one climb
to a rider, not two.

Each climb reports length, gain, average and maximum sustained gradient, summit
altitude, estimated time and VAM, and two difficulty scores:

- **Category** — the Strava scheme (length × gradient, with a 3% / 500 m floor):
  Cat 4 / 3 / 2 / 1 / HC.
- **FIETS index** — gradient-weighted, so a short wall and a long drag with the
  same gain do not score alike. Alpe d'Huez scores ~9; the app gives it 9.9.

### Gradient, surface and time

- **Gradient breakdown** — distance in each band from −12% to +15%, colouring both
  the map line and the profile.
- **Surface & road type** — free with OpenRouteService; otherwise one click asks
  OpenStreetMap directly. Reports paved / gravel / dirt shares and cycleway vs.
  main road, and is honest about how much was *inferred* from road class rather
  than tagged.
- **Ride time** — a real power model (rolling resistance, gravity, aerodynamic
  drag with air density falling as you climb), solved for speed segment by
  segment. Pick a bike and position, set your mass and sustainable power. Loose
  surfaces raise rolling resistance automatically.

---

## The GPX it writes

Validated against the official GPX 1.1 schema.

- A `<trk>` course, with `<ele>` on every point.
- **Climb waypoints** — start and summit of each climb, named `Cat 2 3 start`,
  with length, gradient and gain in the description. These show up as course
  points on most head units.
- Your own waypoints.
- A human-readable summary in `<desc>` — this is what Garmin Connect, Strava and
  Komoot display under the route name.
- Full machine-readable statistics in a namespaced `<extensions>` block: ascent,
  descent, unfiltered ascent, every climb with its category and score, the
  gradient distribution, surface shares and the time estimate.

**Timestamps are off by default.** A `<time>` on every point makes several Garmin
Edge units import the file as a *completed activity* rather than a course to
follow. Turn them on only if you want a pace target to ride against.

### Device presets

Each preset carries a point budget, and the track is simplified to fit rather
than letting the device truncate it silently.

| Preset | Budget |
|---|---|
| Universal *(default)* | 10 000 |
| Garmin Edge — modern | 10 000 |
| Garmin Edge — 500/510/800/810 | 4 000 |
| Wahoo ELEMNT / BOLT / ROAM | 15 000 |
| Hammerhead Karoo | 20 000 |
| Maximum detail | no limit |

Simplification protects the elevation profile as well as the map line. A plain
line-simplification pass would reduce a dead-straight road over a mountain pass to
two points and throw the entire climb away, so a second pass bounds the *vertical*
error independently.

---

## How it is put together

```
server.js              Static host + short-link resolver + allowlisted proxy
public/
  index.html
  css/style.css
  js/
    app.js             Controller: state, UI wiring, the pipeline
    parsers.js         Map links, pasted text, GPX/KML/TCX/GeoJSON
    routing.js         BRouter / OSRM / ORS / direct, behind one interface
    elevation.js       DEM sampling, provider fallback, rate limiting
    analysis.js        Ascent, climb detection, categorisation, gradient bands
    surface.js         Surface + road type from ORS extras or Overpass
    timemodel.js       Power/speed physics
    gpx.js             GPX 1.1 writer, device presets, simplification
    profile.js         Elevation chart (canvas)
    map.js             Leaflet wrapper
    net.js             Transport, proxy detection, error messages
    util.js            Geometry, resampling, smoothing, formatting
```

The server is deliberately thin. All the real work happens in the browser, so
`public/` can also be dropped on any static host and still work — you only lose
short-link expansion, which needs a server to follow the redirect.

The proxy is **host-allowlisted**, not open, so it cannot be turned into an SSRF
vector against your network. Your OpenRouteService key is stored only in your own
browser and is never logged.

---

## Credits and limits

Map data © OpenStreetMap contributors. Elevation from Copernicus DEM (via
Open-Meteo) and SRTM/ASTER (via OpenTopoData). Routing by BRouter, FOSSGIS OSRM
and OpenRouteService. Tiles from CyclOSM, OpenStreetMap and OpenTopoMap.

These are free, donated services with rate limits. The app paces its requests and
backs off when throttled, but a very long route analysed repeatedly may need a
minute's patience. An OpenRouteService key removes most of that pressure.

Elevation is modelled terrain, not surveyed road height. On bridges, in tunnels
and on tight switchbacks it will disagree with a barometric altimeter — that is a
property of the underlying data, not something any post-processing can fully
repair. Where the routing engine supplies its own elevation (BRouter and
OpenRouteService both do) that is used in preference, because it is sampled along
the way geometry rather than looked up per point.
