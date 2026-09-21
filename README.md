# GoWalkWalk

Bring your own route. Get the facilities on it.

Upload a **GPX or KML** of a walk, hike or trail run, and GoWalkWalk turns it
into a live trail map: the **AEDs, toilets, drinking water, drink vending
machines, shelters and car parks** along it, the **landmarks and attractions**
it passes as checkpoints, progress tracking against the line, the weather where
the route actually is, an emergency card, and an offline map you can download
before you set off.

The **start and the finish come from the file** — the first and last point of
the line as it was drawn — so a loop starts and ends where the organiser put
it, and an A-to-B route does not pretend to be a loop.

It is a static progressive web app. There is no server, no account and no
upload: the route file is read on the device with the File API and stays there.

This is a generalisation of [UMS Walk & Hike
2026](https://github.com/alden000/UMS-Walk-Hike-2026), which did all of this for
one fixed route with the data baked in by a build script. Everything that app
does, this one does for whatever route you hand it.

---

## Using it

1. Open the app and choose a `.gpx`, `.kml` or `.kmz` file, or drop one on the
   page.
2. It reads the line, searches OpenStreetMap along it, fills in the climbing if
   the file has none, and works out the checkpoints. A few seconds, once per
   route.
3. The route is then **on the device**. It opens instantly next time, works with
   the radio off, and appears in the list on the home screen.

The app opens straight onto the last route you had open, which is what you want
at a trailhead. The button at the top left goes back to the list.

### What it reads

| Format | What it takes |
| --- | --- |
| **GPX** | `<trk>` first, falling back to `<rte>`. Multiple `<trkseg>`s (a paused recording) are joined in file order. `<wpt>` pins become checkpoints. `<ele>` is used where present. |
| **KML** | `<gx:Track>`, `<LineString>` or `<LinearRing>`. Several line placemarks are joined in document order. `<Point>` placemarks become checkpoints. |
| **KMZ** | The zip is read directly and the `doc.kml` inside it inflated with the browser's own `DecompressionStream` — no zip library. |

Namespaces are matched on local names, so files from Garmin, Strava, Komoot,
AllTrails, Gaia, Google Earth and a text editor all parse the same way.

A pin in the file sitting on the first or last point of the line **names** that
end rather than becoming a checkpoint of its own: a GPX whose start waypoint is
called "Flag-off, Venus Drive" gets that on the start flag.

A track logged once a second is thinned with Ramer–Douglas–Peucker at 4 m, which
is invisible at the deepest zoom the map offers and is what keeps projecting a
GPS fix onto the route cheap enough to run every second on a phone.

---

## What is on the map

### Facilities

Searched live from OpenStreetMap through the Overpass API, within a radius that
depends on what the thing is — an AED is worth a detour, a shelter on the far
side of the hill is not:

| | Category | Within | OSM tags |
| --- | --- | --- | --- |
| ❤ | AEDs | 1000 m | `emergency=defibrillator`, `amenity=defibrillator` |
| 🚻 | Toilets | 800 m | `amenity=toilets` |
| 💧 | Drinking water | 800 m | `amenity=drinking_water`, `water_point`, `man_made=water_tap` |
| 🥤 | Vending machines | 800 m | `amenity=vending_machine` selling drinks, water or food |
| ⛺ | Shelters & huts | 400 m | `amenity=shelter` (not bus stops), `tourism=wilderness_hut`, `leisure=picnic_shelter`, `building=hut\|pavilion` |
| 🅿 | Car parks | 1000 m | `amenity=parking`, public only |

Facilities bunch up — a ranger station has a toilet, a water point and an AED
within ten metres of each other — so they share one cluster group, and a cluster
shows *which kinds* of facility it holds rather than an anonymous count. Tapping
it lists them.

### Checkpoints

The reference app had eleven checkpoints typed out by someone who had walked the
route. Here they are assembled, in this order of trust:

1. **Pins in your own file.** A waypoint somebody placed is a deliberate choice
   and is always kept.
2. **Named landmarks from OpenStreetMap** within 350 m of the line: viewpoints,
   summits, waterfalls, cave entrances, monuments, memorials, ruins, towers,
   museums, nature reserves and the like.

Landmarks are ranked (a summit outranks a named flowerbed) and thinned greedily
by rank, so a cluster of three benches at the trailhead cannot crowd out the
viewpoint, and they stay spread along the route. Anything within 150 m of either
end is dropped — it is that end of the route under another name.

### Trails

The surrounding footpath network is a separate, much heavier search — a city
route crosses thousands of pavements — so it is fetched only when you turn the
overlay on, and then kept for offline.

---

## Progress

A GPS fix is projected onto the route to give distance done, distance left,
percentage, pace, a finish estimate and the distance to the next checkpoint. The
walked part of the line is drawn over the top in green.

- **Doubling back.** Where two parts of the route pass close together, the
  projection prefers the candidate nearest to where you already were, so walking
  a loop does not make progress jump between the outbound and return legs.
- **Jitter.** A single fix that projects backwards is ignored; progress only
  gives ground once the retreat persists or is too large to be noise.
- **The start line on a loop.** Start and finish are the same place, so a fix
  there projects equally well to either end. Opening the app on the start line
  reads as 0%, and closing the loop reads as finished.
- **Surviving a reload.** Progress is saved every five seconds, per route, and
  restored on start-up. Sooner or later in a four-hour walk the phone kills the
  tab; without this, coming back would restart you at zero.

---

## Weather

Two providers behind one model, chosen by where the route is:

- **NEA (data.gov.sg)** for a route in Singapore — the two-hour area nowcast,
  live station temperature, humidity, wind and rainfall, the 24-hour forecast,
  PSI, PM2.5 and UV.
- **Open-Meteo** everywhere else — the hourly forecast from the national weather
  service covering the route, so the +2/+4/+6 h temperatures are real forecast
  values rather than estimates, plus CAMS surface PM2.5 and the European AQI.

If NEA fails on a Singapore route, Open-Meteo answers instead rather than
leaving the card blank.

The card reduces all of it to one verdict. Lightning outranks everything: on an
exposed ridge, a boardwalk or an observation tower it is the one hazard that
kills, so a thunderstorm now or within two hours is surfaced as severe. Heavy
rain, showers, haze, high PSI or PM2.5, high UV, and heat or cold measured as
*apparent* temperature all raise a warning. NEA publishes temperature and
humidity but no apparent temperature, so the heat index is computed — 32 °C at
80% humidity is what a walker feels as 41 °C.

---

## Emergency card

One tap for the moment nobody wants: who to call, where you are in a form you
can read out or paste into a message, and the nearest AED, water, toilet and
shelter.

Distances **follow the route**, not the crow. A loop round a reservoir means a
toilet 1.4 km across the water is 3.6 km of walking, and the marker that looks
nearest on the map is regularly not the nearest one to reach. On a loop both
directions are measured and the shorter wins. Off the route, everything is
measured from the point where you would rejoin the path, because that is where
every walk from there actually starts.

Who to call is the part a one-route app can hard-code and this one cannot. 112
is the honest default — the GSM standard number. Where the route lies wholly
inside a country with a better-known number the local one is offered too
(Singapore, North America, the UK and Ireland, Australia, New Zealand, Japan).
The number that actually matters on an organised walk is the marshal's, which
only you can supply, so the card takes one and keeps it on the device.

---

## Offline

- **The app and the route.** The service worker precaches the app shell; routes
  live in IndexedDB, written as they are imported. Both survive with no signal.
- **The map.** Tiles are cached as you view them, which quietly means "offline"
  only covers ground you have already scrolled past. *Save map for offline*
  downloads every tile within 400 m of the route instead.

How deep the save goes depends on the route. Tiles go up fourfold per zoom
level, so an afternoon loop can afford zoom 19 and a long-distance trail plainly
cannot; the depth is trimmed until the pack fits a budget, and the tile count is
shown before you start. You can stop it part-way and keep what it has.

Two of the base maps are run on donated infrastructure whose usage policy asks
apps not to bulk-download tiles — OpenStreetMap's standard layer and
OpenTopoMap. They stay browsable and are simply not offered for the save. Esri's
topographic and satellite layers are, and OneMap is where the route is in
Singapore.

---

## Base maps

| Map | Why |
| --- | --- |
| **Topographic** (Esri World Topo) | Contours, paths and place names worldwide, to zoom 19, and savable. The default. |
| **OpenTopoMap** | Contours, hillshading and marked hiking routes. Zooms to 17. |
| **Satellite** (Esri World Imagery) | Settles what the ground actually is. |
| **Street** (OpenStreetMap) | The same data the facility markers come from. |
| **OneMap (SLA)** | Singapore only — park connectors, trails and nature-reserve paths. Offered when the route is inside its coverage. |

---

## Privacy

- The route file is read on the device. It is never uploaded.
- Routes, facilities, trails and progress are stored in IndexedDB and
  localStorage on the device, and removing a route removes them.
- Outbound requests go to Overpass (a corridor of coordinates along the route),
  the weather service (one point), the elevation service (route points, only
  when the file has no elevation) and the tile servers. None is told who is
  asking.
- Position is used on the device only. Nothing is transmitted anywhere.

---

## Limitations, honestly

- **OpenStreetMap coverage varies.** An empty facility list can mean nobody has
  mapped them yet, not that they are not there. The layers panel says so rather
  than showing a confident zero.
- **Overpass mirrors shed load** by returning 429 and 504 at peak. Three mirrors
  are tried with backoff; if all refuse, the route still imports and you can
  search again from the map.
- **Landmarks are ranked by tags**, which is a proxy for interest, not a
  substitute for someone who knows the route. Your own waypoints always win.
- **Terrain elevation** (when the file has none) comes from a 90 m DEM sampled
  along the route, so the ascent figure is indicative. It is labelled
  "(terrain)" where that is what it is.
- **GPS under canopy** wanders. "On route" is deliberately generous at 500 m, and
  progress is smoothed rather than reported raw.
- **Emergency numbers** outside the six regions listed fall back to 112. Set your
  own contact.

---

## Development

Static files, no build step. Serve the directory over HTTP:

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000/>. Note that GPS, the compass, the service
worker and offline storage all require a secure context: `localhost` counts, a
plain-HTTP LAN address does not, and the app says so rather than letting it look
like a denied permission.

```
index.html            the shell: route library, import card, map chrome
css/app.css
js/app.js             the app itself — screens, map, controls, progress, SOS
js/routefile.js       GPX / KML / KMZ parsing
js/overpass.js        the OpenStreetMap searches and the tag → category rules
js/checkpoints.js     landmarks + file pins → the ordered checkpoint list
js/geo.js             route indexing, projection, progress tracking, simplify
js/elevation.js       terrain sampling where the file has no elevation
js/store.js           IndexedDB: routes, facilities, trails
js/weather.js         NEA and Open-Meteo behind one model
js/basemaps.js        the base map list and tile URL handling
js/icons.js           inline SVG markers and weather glyphs
sw.js                 precache, tile strategy, the offline map download
tools/                icon artwork and its rasteriser
test/                 end-to-end test
```

### Tests

The end-to-end test serves the app, stubs every outbound call — OpenStreetMap,
both weather providers, the elevation lookup and the tiles — and drives a real
browser through importing GPX, KML and KMZ, the facilities that come back, the
checkpoints built from them, the emergency card, progress from a fed GPS
position, both weather paths, the route library, and a reload landing back on
the route.

```sh
npm --prefix test install
npx playwright install chromium      # or set CHROME_PATH to one you have
node test/e2e.js
```

Stubbing the network is the point: what is under test is the app, not whether a
public Overpass mirror happens to be up.

### The icon

```sh
python3 tools/make_icon.py           # writes icons/icon.svg, icon-maskable.svg
pip install cairosvg
python3 tools/rasterise.py           # writes the three PNGs
```

---

## Attribution

- Facilities, landmarks and trails: © [OpenStreetMap](https://www.openstreetmap.org/copyright)
  contributors, ODbL, via the Overpass API.
- Weather and air quality: [NEA](https://data.gov.sg/) via data.gov.sg in
  Singapore; [Open-Meteo](https://open-meteo.com/) elsewhere.
- Elevation: Copernicus DEM via Open-Meteo.
- Map tiles: Esri, OpenTopoMap (CC-BY-SA), OpenStreetMap, and the Singapore Land
  Authority's OneMap.
- [Leaflet](https://leafletjs.com/) and Leaflet.markercluster, vendored in
  `vendor/`.
