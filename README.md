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
   route — and if OpenStreetMap's mirrors are busy, **Open the map anyway** gets
   you straight to the route and leaves the facilities for later.
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

| | Category | Within | Source |
| --- | --- | --- | --- |
| ❤ | AEDs | 1000 m | `emergency=defibrillator`, `amenity=defibrillator` — **plus SCDF's official register in Singapore, see below** |
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
3. **In Singapore, the NParks and STB registers** over the same 350 m, on the
   same ranking — an STB attraction scores exactly what OpenStreetMap's
   `tourism=attraction` scores, so the tie is broken on distance from the route
   rather than on which source the app happens to prefer. Each marker names the
   register it came from.

Where OpenStreetMap carries a `wikimedia_commons` or `image` tag — mappers
regularly do on summits, viewpoints, monuments and huts — the photograph appears
in the popup, which is as close as an uploaded route can get to the reference
app's hand-curated checkpoint photos.

Landmarks are ranked (a summit outranks a named flowerbed) and thinned greedily
by rank, so a cluster of three benches at the trailhead cannot crowd out the
viewpoint, and they stay spread along the route. The spacing and the clearance
at each end are relative to the route's length: a flat 150 m dead zone is right
for a 13 km event route and eats a quarter of a 1.2 km loop round a park.

### Official Singapore sources

OpenStreetMap is the backbone everywhere, and in Singapore four government
registers fill gaps it cannot. All four ship with the app, are consulted only
over the ground they describe, and are merged with the OpenStreetMap results
rather than replacing them — de-duplicated at 40 m, with the official record
winning because it carries the name on the sign.

| Register | What it adds | Where |
| --- | --- | --- |
| **SCDF, Public Access AEDs** | 9,644 defibrillators with opening hours | Singapore |
| **NParks, Central Nature Reserve Amenities** | 97 shelters and huts by name, 18 toilets, 18 car parks, towers and wartime remains | The central reserves and southern ridges |
| **STB, Tourist Attractions** | 106 attractions, each with a sentence saying what it is | The city and the parks |
| **NParks, Central Nature Reserve Hiking Trails** | 170 km of trail with no network round trip, and the route numbers on the signposts | The central reserves and southern ridges |

`.github/workflows/refresh-aed.yml` checks all four daily and rebuilds only
what has actually changed.

### Defibrillators in Singapore

OpenStreetMap has almost no AEDs mapped in Singapore. On a 1.2 km loop in
Woodlands it had **none** within a kilometre; SCDF's register had **161**, the
nearest 22 m from the path. For a card that promises the nearest defibrillator,
that is not a gap but a wrong answer, so routes inside Singapore also get
[Public Access AEDs](https://data.gov.sg/datasets?query=AED) — 9,644 of them,
published by the Singapore Civil Defence Force on data.gov.sg.

The register brings something OpenStreetMap rarely has: **opening hours**. An
AED behind a school gate at nine in the evening is not an AED, so the emergency
card's "nearest" prefers one that is open at the moment you ask, and labels a
closed one as closed rather than sending you to a locked door. Of the 9,644,
6,572 are open around the clock, 2,954 have hours and 111 are marked closed.

The data is **shipped with the app** rather than fetched. data.gov.sg's download
API is CORS-enabled but answers with a signed link to an S3 object that sends no
CORS headers, so a browser cannot follow it; shipping it also means it works
with the radio off. It is not precached — most walkers are not in Singapore —
but it is kept the first time a Singapore route asks for it.

`.github/workflows/refresh-aed.yml` checks daily whether SCDF have published a
new version, and rebuilds only when they have: the check costs a few hundred
bytes of metadata, the rebuild seven megabytes, and in practice SCDF publish
about once a year. Saved routes re-derive their AEDs from the shipped register
each time they are opened, so an update reaches a route imported months ago
without anyone having to press anything.

    python3 tools/fetch_aed.py               # rebuild now
    python3 tools/fetch_aed.py --if-changed  # rebuild only if SCDF have published

### Attractions in Singapore

OpenStreetMap can tell you the building on South Bridge Road is a Hindu temple.
The Singapore Tourism Board's list knows it is Sri Mariamman and says so in a
sentence you can read standing in front of it — which is the difference between
a checkpoint that names something and a checkpoint worth walking to. A lap of
the Civic District picks up twenty-two of them; six become checkpoints, each
with its own line of description.

The published file is a website's content export rather than a gazetteer, and
`tools/fetch_attractions.py` repairs four faults in it, all found by looking:

- **The latitudes are rounded to three decimals** — about 110 m — while the
  longitudes carry five or six. Each address is re-geocoded through OneMap's
  public search and the answer taken only when it agrees with the published
  point to within 300 m; 79 of 106 are refined this way. The rest keep the
  published point, and their markers say **position approximate**, because a
  pin that might be a hundred metres out should not pretend otherwise.
- **The text is mojibake** — UTF-8 read as Windows-1252, so apostrophes arrive
  as `â€™`. Repaired with a cp1252 round trip; latin-1 silently fails on
  exactly the characters that need it.
- **The titles are written for search engines** — "Sri Mariamman Temple: Hindu
  Temple in Singapore", "Kranji War Memorial Landmark in Singapore" — and a map
  label needs the name. Every rule was written against all 106 real titles and
  checked against all of them.
- **The same place is listed twice** under two titles, so near-identical names
  within 400 m are collapsed.

The images are dropped (their domain no longer resolves) and so are the opening
hours (free-form prose, last edited in 2015 — stale hours are worse than none).

    python3 tools/fetch_attractions.py               # rebuild now
    python3 tools/fetch_attractions.py --if-changed  # only if STB have published

### Trails

The surrounding footpath network is a separate, much heavier search — a city
route crosses thousands of pavements — so it is fetched only when you turn the
overlay on, and then kept for offline.

**Inside Singapore's nature reserves it is not searched at all.** NParks
publishes its own map of the trails, and 170 km of it ships with the app, so
the overlay draws instantly and with the radio off.

That is not because OpenStreetMap is thin here. Measured over the same box
across the Central Catchment, on the day this was written:

| | Ways | Length | Distinct names |
| --- | --- | --- | --- |
| OpenStreetMap | 1,746 | 263.2 km | 49 |
| NParks | 119 | 82.0 km | 51 |

and 72% of NParks' vertices already have an OpenStreetMap node within 15 m. The
crowd has done this ground properly, and swapping one for the other would throw
away a hundred and eighty kilometres of real path. The register is shipped for
two other things.

**It answers immediately.** The probe that produced the table above also
measured what the overlay costs today: 172 seconds from the mirror that
answered, and a 504 after 197 seconds from one that did not. That is the
slowest thing the app does, and it is asked for by somebody already in the
forest, on one bar, standing at a fork. So the official trails are drawn first
and **Add OpenStreetMap paths** fetches the rest when you ask for it — first the
answer, then the offer, never a wait nobody asked for. The two are drawn at
different weights, because 72% overlap means drawing them identically would
claim the map is twice as sure as it is.

**It carries the numbers on the signs.** MacRitchie is walked by route number —
the boards say "Route 3" — and OpenStreetMap has none of the six. Tapping a
named trail gives you its name, its route number and which of the two sources
drew it. Unnamed lines stay untappable, so the tap reaches the map.

The register writes a surveyor's shorthand — "Bt Peirce Track", "LP Resr Pk
Track", "MNT Route 6" — which is not what a signpost says, so it is expanded
from a table written against all 87 real names. `TRAIL_TYPE` is undocumented
and is deliberately left undecoded; what *is* read off the data is that a group
containing a segment named "MNT Route 6" lends that route to the rest of the
group.

    python3 tools/fetch_trails.py               # rebuild now
    python3 tools/fetch_trails.py --if-changed  # only if NParks have published

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

Where a national mapping agency covers the route, its own basemap leads the
list and is the default — it knows things no worldwide basemap does. Everywhere
else the global topographic map is.

Tiles are fetched at the screen's real resolution. A phone draws two or three
device pixels per CSS pixel, so a 256 px tile stretched across 256 CSS pixels is
stretched across up to 768 device pixels, which is exactly as sharp as it
sounds. Leaflet's `detectRetina` fetches the next level down and draws it at
half size: measured, 3.00 device pixels per tile pixel became 1.50 at DPR 3 and
1.00 at DPR 2. It costs four times the tile requests, which is the reason it is
not free and not the reason to skip it — the map is the product.

That has a trap in it. Leaflet clamps the zoom to `maxNativeZoom` and *then*
adds the retina offset, so a layer declaring the provider's true maximum asks
for one level deeper than exists. Measured against the servers: OneMap answers
z19 with a 5 KB tile and z20 with zero bytes; Esri answers z20 with a
2,521-byte "no data" placeholder. Left alone, the deepest zoom — where someone
is trying to find a door — would have gone blank, so the offset is taken off
`maxNativeZoom` when retina is actually in play.

| Map | Why |
| --- | --- |
| **Topographic** (Esri World Topo) | Contours, paths and place names worldwide, to zoom 19, and savable. The default outside Singapore. |
| **OpenTopoMap** | Contours, hillshading and marked hiking routes. Zooms to 17. |
| **Satellite** (Esri World Imagery) | Settles what the ground actually is. |
| **Street** (OpenStreetMap) | The same data the facility markers come from. |
| **OneMap (SLA)** | Singapore only — park connectors, trails, nature-reserve paths and block numbers. **The default for a route inside its coverage.** |

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
  mapped them yet, not that they are not there — a suburban loop may genuinely
  have no AEDs, vending machines or landmarks in it. The app says which it is:
  a row in the route header states *not searched yet*, *did not answer* or
  *nothing mapped along this route*, and re-runs the search on a tap. The
  layers panel carries the same counts, per category, rather than showing a
  confident zero.
- **Overpass mirrors shed load** in two ways, and the second is the nasty one:
  some refuse with 429 or 504, others accept the query and queue it, answering
  in their own time or never. Every request therefore has a deadline, and the
  three mirrors are swept twice — briskly, then patiently — with the import card
  naming whichever is being tried, and remembering whichever answered so a long
  route's later queries start with a mirror known to be alive rather than paying
  the dead one's deadline again. **Open the map anyway** abandons the search
  at any point and opens the route without it; the facilities can be filled in
  later with *Search OpenStreetMap again* in the layers panel.
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
js/net.js             fetch with a deadline on every request
js/aed.js             SCDF's Singapore AED register: opening hours, merging
js/nparks.js          NParks' reserve amenities and landmarks
js/stb.js             STB's attractions, as described landmarks
js/trails-sg.js       NParks' reserve trails and the corridor grid
data/aed-sg.json      those registers, built by tools/fetch_*.py
data/nparks-sg.json
data/stb-sg.json
data/trails-sg.json
js/store.js           IndexedDB: routes, facilities, trails
js/weather.js         NEA and Open-Meteo behind one model
js/basemaps.js        the base map list and tile URL handling
js/icons.js           inline SVG markers and weather glyphs
sw.js                 precache, tile strategy, the offline map download
tools/                the register builders, the icon artwork and its rasteriser
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
- Singapore AED locations: © Singapore Civil Defence Force, via
  [data.gov.sg](https://data.gov.sg/), under the Singapore Open Data Licence.
- Singapore park amenities: © National Parks Board, via
  [data.gov.sg](https://data.gov.sg/), under the Singapore Open Data Licence.
- Singapore reserve trails: © National Parks Board, via
  [data.gov.sg](https://data.gov.sg/), under the Singapore Open Data Licence.
- Singapore attractions: © Singapore Tourism Board, via
  [data.gov.sg](https://data.gov.sg/), under the Singapore Open Data Licence;
  their positions refined with © Singapore Land Authority's OneMap search.
- Weather and air quality: [NEA](https://data.gov.sg/) via data.gov.sg in
  Singapore; [Open-Meteo](https://open-meteo.com/) elsewhere.
- Elevation: Copernicus DEM via Open-Meteo.
- Map tiles: Esri, OpenTopoMap (CC-BY-SA), OpenStreetMap, and the Singapore Land
  Authority's OneMap.
- [Leaflet](https://leafletjs.com/) and Leaflet.markercluster, vendored in
  `vendor/`.
