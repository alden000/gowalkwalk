// GoWalkWalk — bring your own route.
//
// Upload a GPX or KML, and the app finds the AEDs, toilets, drinking water,
// drink vending machines, shelters and car parks along it, turns the landmarks
// it passes into checkpoints, tracks progress against it and shows the weather
// where it actually is. The start and the finish are the first and last point
// of the file, as drawn.
//
// Built on the UMS Walk & Hike 2026 app, which did all of this for one fixed
// route with the data baked in at build time. The difference here is that
// nothing is known until somebody hands the app a file.

import {
  Route, ProgressTracker, haversine, formatDistance, splitDistance, formatDuration, sampleEvery,
} from './geo.js';
import { CATEGORY, poiIcon, legendIcon, checkpointIcon, clusterIcon, meIcon, weatherIcon } from './icons.js';
import { loadWeather, cachedWeather, psiBand, pm25Band, uvBand, aqiBand } from './weather.js';
import { basemapsFor, tileUrl } from './basemaps.js';
import { readRouteFile } from './routefile.js';
import { fetchPlaces, fetchTrails, MAX_OFFSET_M } from './overpass.js';
import { fillElevation } from './elevation.js';
import { buildCheckpoints } from './checkpoints.js';
import {
  routeId, saveRoute, savePlaces, loadRoute, listRoutes, deleteRoute,
  saveTrails, loadTrails, storageUse, lastRouteId, setLastRouteId, progressKey,
} from './store.js';

const $ = sel => document.querySelector(sel);

// Panning and zooming are confined to the route plus this much breathing room.
const CORRIDOR_M = 2000;
// how many zoom levels beyond the corridor fit the user may zoom out
const ZOOM_OUT_SLACK = 1;
const FOLLOW_INTERVAL_MS = 1000;
// how much of each compass reading to take; the rest is the previous value
const HEADING_SMOOTHING = 0.25;
// after this long without a compass reading, GPS course may drive the arrow again
const COMPASS_STALE_MS = 6000;

// Battery saver: instead of holding the GPS on continuously, ask for one fix
// this often. Android powers the receiver down between requests.
const SAVER_POLL_MS = 30 * 1000;
// a fix under canopy can take a while; give it this long before giving up
const SAVER_FIX_TIMEOUT_MS = 25 * 1000;

// Progress is written to storage this often while on route, and a saved walk
// older than this is treated as a previous day's and discarded on start-up.
const PROGRESS_SAVE_MS = 5 * 1000;
const PROGRESS_MAX_AGE_MS = 8 * 60 * 60 * 1000;

// ── saving the map for the trail ─────────────────────────────────────
// How wide a strip either side of the route to download, and how far in to
// zoom. Each zoom level is four times the tiles of the one above, so the depth
// is chosen against the length of the route rather than fixed: a 10 km loop can
// afford z19, a 90 km trail plainly cannot, and quietly queueing forty thousand
// requests on somebody's mobile data would be the wrong answer to both.
const SAVE_CORRIDOR_M = 400;
const SAVE_ZOOMS = [13, 14, 15, 16, 17, 18, 19];
// beyond this many tiles, the deepest zoom is dropped and the count re-checked
const SAVE_TILE_BUDGET = 6000;
const SAVED_KEY = 'gww-saved-maps';
const CONTACT_KEY = 'gww-contact';

const WEATHER_REFRESH_MS = 5 * 60 * 1000;

// Where the app is served from over HTTPS, for the insecure-origin notice.
const SECURE_HOME = 'https://alden000.github.io/gowalkwalk/';

const state = {
  // the open route
  id: null,
  record: null,
  map: null,
  route: null,
  tracker: null,
  checkpoints: [],
  pois: {},
  layers: {},
  baseLayers: {},
  basemaps: [],
  activeBase: null,
  marker: null,
  accuracyRing: null,
  doneLine: null,
  lastFix: null,
  lastProgress: null,
  lastAccuracy: null,
  wxFailures: 0,
  wxRetry: null,
  hudAutoMinimised: false,
  following: false,
  followTimer: null,
  watchId: null,
  weatherTimer: null,
  heading: null,          // smoothed bearing, degrees clockwise from true north
  headingCss: null,       // the same angle left unwrapped, for the CSS rotation
  compassAt: null,
  compassOn: false,
  compassNeedsGesture: false,
  wakeLock: null,
  batterySaver: false,
  gpsMode: null,          // 'watch' | 'poll' | null
  gpsReady: false,
  pollTimer: null,
  lastFixAt: null,
  progressSavedAt: 0,
  restored: false,
  saving: false,
  trailsLoading: false,
  importAbort: null,
};

// ── boot ─────────────────────────────────────────────────────────────
boot().catch(err => {
  console.error(err);
  showHome();
  homeError(err.message || 'Something went wrong starting the app.');
});

async function boot() {
  wireHome();
  registerServiceWorker();
  startCompass();

  await renderRouteList();

  // Deep link first (a shared or bookmarked route), then whatever was open
  // last: opening the app at the trailhead should land on the map, not on a
  // list with one item in it.
  const wanted = location.hash.replace(/^#\/?route\//, '').trim() || lastRouteId();
  if (wanted) {
    const record = await loadRoute(wanted);
    if (record) {
      await openRoute(record);
      return;
    }
    setLastRouteId(null);
  }
  showHome();
}

// ── the route library ────────────────────────────────────────────────

function showHome() {
  document.body.classList.add('no-route');
  $('#home').hidden = false;
  $('#home').scrollTop = 0;
  closePanels();
  location.hash = '';
}

function homeError(msg) {
  const el = $('#home-err');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

function wireHome() {
  const input = $('#file');
  const drop = $('#drop');

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    // Reset first: choosing the same file twice in a row fires no change event
    // otherwise, which looks exactly like the app ignoring the second attempt.
    input.value = '';
    if (file) importFile(file);
  });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, ev => {
      ev.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('over'));
  }
  drop.addEventListener('drop', ev => {
    ev.preventDefault();
    const file = ev.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });
  // a file dropped anywhere else would otherwise navigate away from the app
  document.addEventListener('dragover', ev => ev.preventDefault());
  document.addEventListener('drop', ev => ev.preventDefault());

  $('#imp-cancel').addEventListener('click', () => {
    state.importAbort?.abort();
  });
  $('#btn-home').addEventListener('click', () => leaveRoute());
}

async function renderRouteList() {
  const rows = await listRoutes().catch(() => []);
  const block = $('#recent-block');
  block.hidden = rows.length === 0;
  if (!rows.length) return;

  $('#routes').innerHTML = rows.map(r => `
    <li>
      <button type="button" class="route-open" data-id="${escapeHtml(r.id)}">
        <span class="route-n">${escapeHtml(r.name)}</span>
        <span class="route-m">${(r.totalDistance / 1000).toFixed(2)} km${r.isLoop ? ' loop' : ''}
          · ${r.checkpointCount} checkpoints · ${r.facilityCount} facilities${
  r.elevationGain != null ? ` · ${r.elevationGain} m ascent` : ''}</span>
        <span class="route-s">${escapeHtml(r.source || r.format.toUpperCase())} · opened ${ago(r.lastOpenedAt)}</span>
      </button>
      <button type="button" class="route-del icon-btn small" data-del="${escapeHtml(r.id)}"
              title="Remove ${escapeHtml(r.name)}" aria-label="Remove ${escapeHtml(r.name)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </li>`).join('');

  for (const btn of document.querySelectorAll('.route-open')) {
    btn.addEventListener('click', async () => {
      homeError('');
      const record = await loadRoute(btn.dataset.id);
      if (!record) { homeError('That route could not be read back from storage.'); return; }
      openRoute(record);
    });
  }
  for (const btn of document.querySelectorAll('[data-del]')) {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.del;
      const row = rows.find(r => r.id === id);
      if (!confirm(`Remove “${row?.name || 'this route'}” and everything saved with it?`)) return;
      await deleteRoute(id);
      await renderRouteList();
    });
  }

  const est = await storageUse();
  $('#storage-note').textContent = est?.usage
    ? `${rows.length} route${rows.length === 1 ? '' : 's'} on this device · `
      + `${(est.usage / 1048576).toFixed(1)} MB used, including saved maps.`
    : `${rows.length} route${rows.length === 1 ? '' : 's'} on this device.`;
}

function ago(at) {
  if (!at) return 'never';
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// ── importing a route ────────────────────────────────────────────────
// Four steps, each one shown as it runs, because the OpenStreetMap search is
// the slow one and a spinner that says nothing for fifteen seconds reads as a
// hang. Only the first step can fail fatally: a route with no facilities found
// is still a route, and the app says so rather than refusing to open it.

function importStep(name, status, detail) {
  for (const li of document.querySelectorAll('#imp-steps li')) {
    if (li.dataset.step !== name) continue;
    li.dataset.status = status;
    li.dataset.detail = detail || '';
  }
  const order = ['read', 'places', 'elevation', 'build'];
  const done = order.filter(s =>
    ['done', 'skipped', 'failed'].includes(
      document.querySelector(`#imp-steps li[data-step="${s}"]`)?.dataset.status)).length;
  $('#imp-fill').style.width = `${Math.round((done / order.length) * 100)}%`;
  if (detail) $('#imp-note').textContent = detail;
}

async function importFile(file) {
  homeError('');
  const abort = new AbortController();
  state.importAbort = abort;

  $('#import').hidden = false;
  $('#imp-file').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
  $('#imp-note').textContent = 'This takes a few seconds and only happens once per route.';
  for (const li of document.querySelectorAll('#imp-steps li')) li.dataset.status = '';
  $('#imp-fill').style.width = '0%';

  try {
    // ── 1. the file ──
    importStep('read', 'active');
    const { doc, waypoints, warnings } = await readRouteFile(file);
    const id = routeId(doc);
    importStep('read', 'done',
      `${doc.name} · ${(doc.totalDistance / 1000).toFixed(2)} km${doc.isLoop ? ' loop' : ''}`);

    // An identical route already on the device keeps everything found for it
    // last time; re-uploading the same export should not mean searching again.
    const existing = await loadRoute(id);
    if (existing) {
      importStep('places', 'skipped', 'Already searched — opening your saved copy.');
      importStep('elevation', 'skipped');
      importStep('build', 'done');
      $('#import').hidden = true;
      state.importAbort = null;
      await openRoute(existing);
      toast('You already had this route — opened your saved copy');
      return;
    }

    const record = {
      id,
      doc,
      waypoints,
      warnings,
      facilities: {},
      landmarks: [],
      checkpoints: buildCheckpoints(doc, waypoints, []),
      placesFetchedAt: null,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    // Saved before the search runs, so a route survives a cancelled or failed
    // lookup: the walker keeps the line and can search again from the map.
    await saveRoute(record);

    // ── 2. what is on the ground ──
    importStep('places', 'active');
    try {
      const places = await fetchPlaces(doc, {
        signal: abort.signal,
        onProgress: (done, total) => importStep('places', 'active',
          total > 1 ? `Searching OpenStreetMap… section ${Math.min(done + 1, total)} of ${total}`
            : 'Searching OpenStreetMap along the route…'),
      });
      record.facilities = places.facilities;
      record.landmarks = places.landmarks;
      record.placesFetchedAt = places.fetchedAt;
      const n = Object.values(places.facilities).reduce((sum, list) => sum + list.length, 0);
      importStep('places', 'done',
        `${n} facilities and ${places.landmarks.length} landmarks along the route`);
    } catch (err) {
      if (abort.signal.aborted) throw err;
      console.warn('places', err);
      importStep('places', 'failed',
        'OpenStreetMap did not answer — you can search again from the map.');
    }

    // ── 3. the climbing ──
    if (doc.elevation.gain == null) {
      importStep('elevation', 'active', 'The file has no elevation — sampling the terrain…');
      try {
        await fillElevation(doc, { signal: abort.signal });
        importStep('elevation', 'done', `${doc.elevation.gain} m of ascent`);
      } catch (err) {
        if (abort.signal.aborted) throw err;
        console.warn('elevation', err);
        importStep('elevation', 'failed', 'No elevation available for this route.');
      }
    } else {
      importStep('elevation', 'skipped', `${doc.elevation.gain} m of ascent, from the file`);
    }

    // ── 4. checkpoints ──
    importStep('build', 'active');
    record.checkpoints = buildCheckpoints(doc, waypoints, record.landmarks);
    await saveRoute(record);
    importStep('build', 'done');

    $('#import').hidden = true;
    state.importAbort = null;
    await openRoute(record);
    if (warnings.length) toast(warnings[0]);
  } catch (err) {
    $('#import').hidden = true;
    state.importAbort = null;
    if (abort.signal.aborted) {
      toast('Import cancelled');
      await renderRouteList();
      return;
    }
    // A file the app cannot read is the walker's problem, not a fault: it is
    // reported on the screen they are looking at, and logged as a warning so
    // it does not read as a crash in the console.
    console.warn('import', err);
    homeError(err.message || 'That file could not be read.');
  }
}

// ── opening and leaving a route ──────────────────────────────────────
// The map is built fresh for each route and torn down on the way out. A single
// long-lived map would have to have every layer, fence, tracker and timer
// unpicked and rebuilt anyway, and leaving one of them behind would show up as
// a ghost marker from the last route — which is exactly the kind of bug nobody
// finds until they are standing in a forest.

async function openRoute(record) {
  teardownRoute();

  state.id = record.id;
  state.record = record;
  state.route = new Route(record.doc);
  state.tracker = new ProgressTracker(state.route);
  state.pois = record.facilities || {};
  state.checkpoints = record.checkpoints || [];

  document.body.classList.remove('no-route');
  $('#home').hidden = true;
  homeError('');
  setLastRouteId(record.id);
  location.hash = `#/route/${record.id}`;
  document.title = `${record.doc.name} · GoWalkWalk`;

  buildMap(record.doc);
  buildRoute();
  buildCheckpointMarkers();
  buildPois();
  buildLayerUI();
  wireControls();
  wireSos();
  renderProgress(null);
  restoreProgress();

  startLocating();
  startWeather();

  if (!record.placesFetchedAt) {
    toast('No facilities found yet — search again from the layers panel');
  }
}

async function leaveRoute() {
  teardownRoute();
  document.title = 'GoWalkWalk';
  // The list is refreshed before the screen appears rather than after, so a
  // walker coming back from a route they have just imported, renamed by the
  // search or deleted never sees the previous version of it for a frame.
  await renderRouteList();
  showHome();
}

function teardownRoute() {
  stopGps();
  state.gpsReady = false;
  clearInterval(state.followTimer);
  clearInterval(state.weatherTimer);
  clearTimeout(state.wxRetry);
  state.followTimer = state.weatherTimer = state.wxRetry = null;
  keepAwake(false);
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  Object.assign(state, {
    id: null, record: null, route: null, tracker: null, checkpoints: [], pois: {},
    layers: {}, baseLayers: {}, basemaps: [], activeBase: null, marker: null,
    accuracyRing: null, doneLine: null, lastFix: null, lastProgress: null,
    lastAccuracy: null, following: false, restored: false, saving: false,
    cluster: null, markersByCategory: null, trailsLoading: false,
  });
  closePanels();
}

function closePanels() {
  if ($('#layers')) {
    $('#layers').hidden = true;
    $('#btn-layers').setAttribute('aria-pressed', 'false');
  }
  if ($('#sos')) {
    $('#sos').hidden = true;
    $('#btn-sos').setAttribute('aria-pressed', 'false');
  }
}

// ── map ──────────────────────────────────────────────────────────────

// The picker shows a real tile from each base map rather than a flat colour, so
// it previews what the map will actually look like. Taking it from the middle
// of the route means it is usually already in the tile cache, and it comes from
// the same URL template the layer itself uses — one source of truth, so a
// thumbnail cannot drift from the map it stands for. `tint` is only the colour
// behind the image while it loads, or if it never does.
const THUMB_ZOOM = 14;

function thumbUrl(spec, lat, lon) {
  const [x, y] = tileAt(lat, lon, THUMB_ZOOM);
  return tileUrl(spec, THUMB_ZOOM, x, y);
}

function buildMap(routeDoc) {
  const b = routeDoc.bounds;
  // the corridor around the route, converted to degrees at this latitude
  const dLat = CORRIDOR_M / 110574;
  const dLon = CORRIDOR_M / (111320 * Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180));
  const limit = L.latLngBounds(
    [b.minLat - dLat, b.minLon - dLon],
    [b.maxLat + dLat, b.maxLon + dLon],
  );
  state.limitBounds = limit;
  state.routeBounds = L.latLngBounds([b.minLat, b.minLon], [b.maxLat, b.maxLon]);

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    maxBounds: limit,
    maxBoundsViscosity: 1,      // hard wall: the map cannot be dragged outside
    maxZoom: 19,
    zoomSnap: 0.25,
    tap: false,
  });
  state.map = map;
  map.attributionControl.setPrefix('');

  state.basemaps = basemapsFor(b);
  for (const spec of state.basemaps) state.baseLayers[spec.id] = L.tileLayer(spec.tiles, spec.opts);

  // The footpath overlay is fetched on demand, so it starts empty and fills in
  // the first time somebody asks for it.
  state.layers.trails = L.layerGroup();

  map.fitBounds(state.routeBounds, { padding: [30, 30] });
  applyBounds();
  // the fence depends on how much of the world the viewport covers, so it is
  // re-derived whenever that changes
  map.on('resize zoomend', applyBounds);
  // panning by hand means the walker wants to look elsewhere; zooming does not
  map.on('dragstart', () => {
    if (state.following && !state.programmaticMove) setFollowing(false, true);
  });

  const saved = localStorage.getItem('gww-basemap');
  setBasemap(state.basemaps.some(s => s.id === saved) ? saved : state.basemaps[0].id);
}

/**
 * Re-derive the zoom floor and the panning fence for the current viewport.
 *
 * `getBoundsZoom(..., true)` is the zoom at which the viewport still fits inside
 * the corridor; we allow one level further out so the whole route and its
 * surroundings can be taken in at a glance.
 *
 * The fence needs a second look. A route can be far wider than it is deep — or
 * the other way round — so on a tall phone, fitting its width can make the
 * viewport taller than the corridor. Leaflet then clamps the centre and the map
 * cannot be dragged vertically *at all*, which also stops popups panning clear
 * of the header. A fence smaller than the screen is not a fence anyway, so in
 * that case it is grown to just over the viewport: nothing new becomes visible,
 * the map simply stops being frozen.
 */
function applyBounds() {
  const map = state.map;
  if (!map) return;
  const corridor = state.limitBounds;

  const fit = map.getBoundsZoom(corridor, true);
  map.setMinZoom(Math.max(2, Math.floor(fit * 4) / 4 - ZOOM_OUT_SLACK));

  // Slack big enough that any marker can be brought into the clear band between
  // the panels — measured from the panels themselves, not guessed.
  const slackPx = Math.max(
    300,                                    // enough for a tall popup
    $('#hud').offsetHeight + $('#wx-toggle').offsetHeight + 140,
  );
  const origin = map.containerPointToLatLng([0, 0]);
  const padded = map.containerPointToLatLng([-slackPx, -slackPx]);
  const slackLat = Math.abs(padded.lat - origin.lat);
  const slackLon = Math.abs(origin.lng - padded.lng);

  const view = map.getBounds();
  const centre = corridor.getCenter();
  const halfLat = Math.max(
    corridor.getNorth() - corridor.getSouth(),
    (view.getNorth() - view.getSouth()) + 2 * slackLat,
  ) / 2;
  const halfLon = Math.max(
    corridor.getEast() - corridor.getWest(),
    (view.getEast() - view.getWest()) + 2 * slackLon,
  ) / 2;
  map.setMaxBounds(L.latLngBounds(
    [centre.lat - halfLat, centre.lng - halfLon],
    [centre.lat + halfLat, centre.lng + halfLon],
  ));
}

function setBasemap(id) {
  if ($('#save-note')) setTimeout(renderSaveState, 0);
  const spec = state.basemaps.find(s => s.id === id) || state.basemaps[0];
  if (state.activeBase === spec.id) return;
  for (const layer of Object.values(state.baseLayers)) state.map.removeLayer(layer);
  state.baseLayers[spec.id].addTo(state.map);
  state.baseLayers[spec.id].bringToBack();
  state.activeBase = spec.id;

  localStorage.setItem('gww-basemap', spec.id);
  $('#basemap-note').textContent = spec.note;
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.id === spec.id));
  }
}

// ── route, checkpoints, markers ──────────────────────────────────────
function buildRoute() {
  const pts = state.route.latLngs();
  L.polyline(pts, { color: '#000', weight: 9, opacity: 0.25, interactive: false }).addTo(state.map);
  state.routeLine = L.polyline(pts, {
    color: '#ff5a3c', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round',
  }).addTo(state.map);
  // the part already walked, drawn over the top
  state.doneLine = L.polyline([], {
    color: '#35d39a', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round', interactive: false,
  }).addTo(state.map);

  // Kilometre markers every km on a short route; on a long one that is a
  // string of beads nobody can read, so the spacing opens out with the distance.
  const total = state.route.total;
  const spacing = total > 60000 ? 10000 : total > 25000 ? 5000 : 1000;
  state.kmSpacing = spacing;
  const km = L.layerGroup();
  for (let d = spacing; d < total; d += spacing) {
    const [lat, lon] = state.route.atDistance(d);
    L.circleMarker([lat, lon], {
      radius: 4.5, color: '#fff', weight: 2, fillColor: '#ff5a3c', fillOpacity: 1,
    }).bindTooltip(`${d / 1000} km`, { direction: 'top', offset: [0, -5] }).addTo(km);
  }
  state.layers.km = km.addTo(state.map);
}

/**
 * A photo for a popup, where OpenStreetMap had one, with the credit its licence
 * requires.
 *
 * Loaded lazily and only when the popup opens, so the images cost nothing until
 * someone actually taps a checkpoint — and a broken or blocked one removes
 * itself rather than leaving a grey box where a summit should be.
 */
function photoHtml(photo) {
  if (!photo?.src) return '';
  return `<figure class="pop-photo">
    <img src="${escapeHtml(photo.src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
         onerror="this.closest('figure').remove()">
    ${photo.credit ? `<figcaption>${escapeHtml(photo.credit)}</figcaption>` : ''}
  </figure>`;
}

function buildCheckpointMarkers() {
  const group = L.layerGroup();
  state.checkpoints.forEach((cp, i) => {
    const isStart = cp.id === 'start';
    const isFinish = cp.id === 'finish';
    const kind = isStart ? 'start' : isFinish ? 'finish' : 'cp';
    const label = isStart || isFinish ? '' : String(i);
    const remaining = state.route.total - cp.along;
    L.marker([cp.lat, cp.lon], { icon: checkpointIcon(kind, label), zIndexOffset: 600 })
      .bindPopup(
        photoHtml(cp.photo) +
        `<div class="pop-t">${label ? `${label}. ` : ''}${escapeHtml(cp.name)}</div>` +
        (cp.note ? `<div class="pop-d">${escapeHtml(cp.note)}</div>` : '') +
        `<div class="pop-m">km ${(cp.along / 1000).toFixed(2)} · ${formatDistance(remaining)} to finish` +
        (cp.offset > 40 ? ` · ${cp.offset} m off the path` : '') +
        (cp.source === 'file' ? ' · from your file' : '') + '</div>',
        { maxWidth: cp.photo ? 280 : 300 })
      .addTo(group);
  });
  state.layers.checkpoints = group.addTo(state.map);

  const ticks = $('#bar-ticks');
  ticks.innerHTML = state.checkpoints
    .filter(cp => cp.along > 0 && cp.along < state.route.total)
    .map(cp => `<i style="left:${(cp.along / state.route.total * 100).toFixed(2)}%"></i>`)
    .join('');

  renderHudNote();
}

function renderHudNote() {
  const doc = state.record.doc;
  const middle = state.checkpoints.length - 2;
  const bits = [
    `${(state.route.total / 1000).toFixed(2)} km${doc.isLoop ? ' loop' : ''}`,
    `${middle} checkpoint${middle === 1 ? '' : 's'}`,
  ];
  if (doc.elevation.gain != null) {
    bits.push(`${doc.elevation.gain} m ascent${doc.elevation.source === 'dem' ? ' (terrain)' : ''}`);
  }
  $('#hud-name').textContent = doc.name;
  $('#hud-name').title = doc.source ? `From ${doc.source}` : '';
  $('#hud-note').textContent = bits.join(' · ');
}

/**
 * Facility markers, in one cluster group.
 *
 * Facilities bunch up: a ranger station has a toilet, a water point and an AED
 * within ten metres of each other, and the pins hide one another completely.
 * They all live in a single cluster group so overlaps *between* categories
 * collapse too, and the cluster shows which kinds of facility it holds rather
 * than an anonymous count. Categories stay individually toggleable by adding
 * and removing their markers from the group.
 */
function buildPois() {
  const cluster = L.markerClusterGroup({
    maxClusterRadius: 46,          // px: only pins that genuinely overlap
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    zoomToBoundsOnClick: false,    // handled below, so a tap always shows the list
    disableClusteringAtZoom: 18,   // close in, every pin stands on its own
    spiderLegPolylineOptions: { weight: 1.4, color: '#93a6a1', opacity: 0.7 },
    iconCreateFunction(c) {
      const counts = {};
      for (const m of c.getAllChildMarkers()) {
        counts[m.options.category] = (counts[m.options.category] || 0) + 1;
      }
      return clusterIcon(counts, c.getChildCount());
    },
  });
  state.cluster = cluster;
  state.markersByCategory = {};

  for (const [cat, meta] of Object.entries(CATEGORY)) {
    const markers = (state.pois[cat] || []).map(p =>
      L.marker([p.lat, p.lon], {
        icon: poiIcon(cat),
        category: cat,
        zIndexOffset: cat === 'aed' ? 500 : 0,
      }).bindPopup(
        photoHtml(p.photo) +
        `<div class="pop-t">${escapeHtml(p.name === meta.label ? meta.label : p.name)}</div>` +
        (p.detail ? `<div class="pop-d">${escapeHtml(p.detail)}</div>` : '') +
        (p.note ? `<div class="pop-n">${escapeHtml(p.note)}</div>` : '') +
        `<div class="pop-m">km ${(p.along / 1000).toFixed(2)} on route · ${p.offset} m off the path</div>`,
        { maxWidth: (p.note || p.photo) ? 280 : 300 }));

    state.markersByCategory[cat] = markers;
    cluster.addLayers(markers);
  }

  // A tap on a cluster lists what is inside, which is more use than zooming and
  // hunting. The list links each entry to its own marker.
  cluster.on('clusterclick', ev => {
    const children = ev.layer.getAllChildMarkers()
      .slice()
      .sort((a, b) => a.options.category.localeCompare(b.options.category));
    const rows = children.map((m, i) => {
      const cat = m.options.category;
      const title = m.getPopup().getContent().match(/class="pop-t">([^<]*)</)?.[1] || CATEGORY[cat].label;
      const detail = m.getPopup().getContent().match(/class="pop-d">([^<]*)</)?.[1] || '';
      return `<li><button type="button" data-i="${i}">
        ${legendIcon(cat)}
        <span><b>${title}</b>${detail ? `<em>${detail}</em>` : ''}</span>
      </button></li>`;
    }).join('');

    const popup = L.popup({ maxWidth: 290, className: 'cluster-popup' })
      .setLatLng(ev.layer.getLatLng())
      .setContent(`<div class="pop-t">${children.length} facilities here</div><ul class="cl-list">${rows}</ul>`)
      .openOn(state.map);

    // hand off to the individual marker when a row is chosen
    const el = popup.getElement();
    el?.querySelectorAll('button[data-i]').forEach(btn => {
      btn.addEventListener('click', () => {
        const marker = children[Number(btn.dataset.i)];
        state.map.closePopup(popup);
        state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
      });
    });
  });

  cluster.addTo(state.map);
  state.layers.facilities = cluster;
}

// ── layer / marker UI ────────────────────────────────────────────────
function buildLayerUI() {
  const mid = state.routeBounds.getCenter();
  $('#basemaps').innerHTML = state.basemaps.map(spec =>
    `<button type="button" role="radio" data-id="${spec.id}" aria-checked="false">
       <img class="sw" src="${thumbUrl(spec, mid.lat, mid.lng)}" alt="" aria-hidden="true"
            decoding="async" style="background:${spec.tint}">
       <span class="nm">${escapeHtml(spec.name)}</span>
       <span class="pick" aria-hidden="true"></span>
     </button>`).join('');
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.addEventListener('click', () => setBasemap(btn.dataset.id));
  }
  const active = state.basemaps.find(s => s.id === state.activeBase) || state.basemaps[0];
  $('#basemap-note').textContent = active.note;
  for (const btn of document.querySelectorAll('#basemaps button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.id === state.activeBase));
  }

  $('#overlays').innerHTML = Object.entries(CATEGORY).map(([cat, meta]) => {
    const n = (state.pois[cat] || []).length;
    return `<label${n ? '' : ' class="empty"'}>
      <input type="checkbox" data-layer="${cat}" checked${n ? '' : ' disabled'}>
      ${legendIcon(cat)}
      <span class="n">${meta.plural}</span><span class="c">${n}</span>
    </label>`;
  }).join('');
  renderPoiNote();

  $('#route-overlays').innerHTML = `
    <label><input type="checkbox" data-layer="checkpoints" checked>
      <span class="n">Checkpoints</span><span class="c">${state.checkpoints.length}</span></label>
    <label><input type="checkbox" data-layer="km" checked>
      <span class="n">Distance markers</span><span class="c">every ${state.kmSpacing / 1000} km</span></label>
    <label><input type="checkbox" id="chk-trails" data-layer="trails">
      <span class="n">Trails &amp; footpaths</span><span class="c" id="trails-c">on demand</span></label>
    <label><input type="checkbox" id="chk-saver">
      <span class="n">Battery saver GPS</span><span class="c">fix every ${SAVER_POLL_MS / 1000} s</span></label>
    <label><input type="checkbox" id="chk-follow">
      <span class="n">Follow me</span><span class="c">1 s</span></label>
    <button type="button" id="btn-reset" class="btn subtle">Reset progress to the start</button>`;

  for (const box of document.querySelectorAll('[data-layer]')) {
    box.addEventListener('change', () => {
      const key = box.dataset.layer;
      const markers = state.markersByCategory?.[key];
      if (markers) {
        // facility categories live inside the shared cluster group
        if (box.checked) state.cluster.addLayers(markers);
        else state.cluster.removeLayers(markers);
        return;
      }
      if (key === 'trails' && box.checked) { enableTrails(box); return; }
      const layer = state.layers[key];
      if (!layer) return;
      if (box.checked) layer.addTo(state.map); else state.map.removeLayer(layer);
    });
  }
  $('#chk-follow').addEventListener('change', e => setFollowing(e.target.checked));
  $('#chk-saver').addEventListener('change', e => setBatterySaver(e.target.checked));
  setBatterySaver(localStorage.getItem('gww-saver') === '1');

  // #btn-reset lives in the markup this function just rewrote, so it is a new
  // element each time; the buttons below are in the page from the start and
  // would collect a second handler on every route opened.
  $('#btn-reset').addEventListener('click', () => {
    if (confirm('Reset progress and start tracking from the start again?')) resetProgress();
  });
  wireOnce('layer-buttons', () => {
    $('#btn-save-map').addEventListener('click', () => {
      if (state.saving) {
        navigator.serviceWorker.controller?.postMessage({ type: 'cancel-save' });
        renderSaveState('Stopping…');
      } else {
        saveMapOffline();
      }
    });
    $('#btn-clear-map').addEventListener('click', () => {
      // One cache holds the saved tiles for every route, so say so: somebody
      // clearing space before a trip should not discover afterwards that they
      // wiped tomorrow's map along with last month's.
      if (confirm('Delete the saved offline maps for every route from this device?')) clearSavedMaps();
    });
    $('#btn-refresh-pois').addEventListener('click', refreshPlaces);
    $('#btn-export').addEventListener('click', exportGpx);
    $('#btn-delete-route').addEventListener('click', async () => {
      if (!confirm(`Remove “${state.record.doc.name}” and everything saved with it?`)) return;
      await deleteRoute(state.id);
      await leaveRoute();
    });
  });
  $('#btn-save-map').disabled = false;
  $('#btn-refresh-pois').disabled = false;
  $('#btn-refresh-pois').textContent = 'Search OpenStreetMap again';
  renderSaveState();
  renderRouteNote();
}

function renderPoiNote() {
  const total = Object.values(state.pois).reduce((n, list) => n + list.length, 0);
  const radii = Object.values(MAX_OFFSET_M);
  $('#poi-note').textContent = total
    ? `Within ${Math.min(...radii)}–${Math.max(...radii)} m of the route, depending on the kind. `
      + 'Data © OpenStreetMap contributors.'
    // An empty list is worth a sentence: it is as likely to mean nobody has
    // mapped this valley as it is to mean there is no water on the route, and
    // a walker planning round it should know which claim the app is making.
    : 'Nothing found yet. OpenStreetMap coverage varies — an empty list can mean the search '
      + 'failed, or that nobody has mapped these yet.';
}

function renderRouteNote() {
  const rec = state.record;
  const when = rec.placesFetchedAt
    ? new Date(rec.placesFetchedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  $('#route-note').textContent = [
    rec.doc.source ? `From ${rec.doc.source}` : `Imported ${ago(rec.doc.importedAt)}`,
    when ? `facilities searched ${when}` : 'facilities not searched yet',
    `${rec.doc.points.length.toLocaleString()} points`,
  ].join(' · ');
}

/** Fetch the footpath network the first time somebody asks to see it. */
async function enableTrails(box) {
  if (state.layers.trails.getLayers().length) {
    state.layers.trails.addTo(state.map);
    return;
  }
  if (state.trailsLoading) return;

  const cached = await loadTrails(state.id);
  if (cached?.ways?.length) {
    drawTrails(cached.ways);
    return;
  }

  state.trailsLoading = true;
  $('#trails-c').textContent = 'loading…';
  try {
    const trails = await fetchTrails(state.record.doc, {
      onProgress: (done, total) => {
        $('#trails-c').textContent = total > 1 ? `${done}/${total}` : 'loading…';
      },
    });
    await saveTrails(state.id, trails);
    drawTrails(trails.ways);
    toast(`${trails.ways.length} paths drawn — kept for offline`);
  } catch (err) {
    console.warn('trails', err);
    $('#trails-c').textContent = 'failed';
    box.checked = false;
    toast('Could not reach OpenStreetMap for the footpaths');
  } finally {
    state.trailsLoading = false;
  }
}

function drawTrails(ways) {
  const group = state.layers.trails;
  group.clearLayers();
  for (const way of ways) {
    L.polyline(way.pts, {
      color: way.kind === 'steps' ? '#8d6e4a' : '#a4744a',
      weight: 1.6,
      opacity: 0.75,
      dashArray: way.kind === 'steps' ? '3 3' : null,
      interactive: false,
    }).addTo(group);
  }
  group.addTo(state.map);
  $('#trails-c').textContent = String(ways.length);
  const box = $('#chk-trails');
  if (box) box.checked = true;
}

/** Search OpenStreetMap again — coverage improves, and a failed import can retry. */
async function refreshPlaces() {
  const btn = $('#btn-refresh-pois');
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = 'Searching…';
  try {
    const places = await fetchPlaces(state.record.doc, {
      onProgress: (done, total) => {
        btn.textContent = total > 1 ? `Searching… ${done}/${total}` : 'Searching…';
      },
    });
    const checkpoints = buildCheckpoints(state.record.doc, state.record.waypoints, places.landmarks);
    await savePlaces(state.id, {
      facilities: places.facilities,
      landmarks: places.landmarks,
      checkpoints,
      placesFetchedAt: places.fetchedAt,
    });
    const record = await loadRoute(state.id);
    const n = Object.values(places.facilities).reduce((sum, list) => sum + list.length, 0);
    await openRoute(record);
    toast(`${n} facilities and ${places.landmarks.length} landmarks along the route`);
  } catch (err) {
    console.warn('refresh', err);
    toast('OpenStreetMap did not answer — try again in a moment');
    btn.disabled = false;
    btn.textContent = 'Search OpenStreetMap again';
  }
}

/**
 * Hand the route back as a GPX.
 *
 * The line is the one the app actually uses — thinned, with terrain elevation
 * filled in where the original had none — and the checkpoints come out as
 * waypoints, so a route that arrived as a hand-drawn KML leaves as something a
 * watch will accept.
 */
function exportGpx() {
  const doc = state.record.doc;
  const esc = s => escapeHtml(s).replace(/&#39;/g, "'");
  const pts = doc.points.map(p =>
    `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}</trkpt>`).join('\n');
  const wpts = state.checkpoints.map(cp =>
    `<wpt lat="${cp.lat}" lon="${cp.lon}">`
    + `<name>${esc(cp.name)}</name>`
    + (cp.note ? `<desc>${esc(cp.note)}</desc>` : '')
    + '</wpt>').join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GoWalkWalk" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${esc(doc.name)}</name><time>${new Date().toISOString()}</time></metadata>
${wpts}
<trk><name>${esc(doc.name)}</name><trkseg>
${pts}
</trkseg></trk>
</gpx>`;

  const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${doc.name.replace(/[^\w\s-]/g, '').trim() || 'route'}.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('GPX saved to your downloads');
}

// ── controls ─────────────────────────────────────────────────────────
// The panels, the buttons and the weather card outlive any one route: they are
// in the page from the start and are still there after a walker goes back to
// the list and opens something else. So their handlers are attached once, and
// the per-map ones — which die with the map — are attached every time a route
// opens.

const wired = new Set();
function wireOnce(key, fn) {
  if (wired.has(key)) return;
  wired.add(key);
  fn();
}

function wireControls() {
  wireOnce('controls', () => {
    $('#btn-zoom-in').addEventListener('click', () => state.map?.zoomIn(1));
    $('#btn-zoom-out').addEventListener('click', () => state.map?.zoomOut(1));
    $('#btn-fit').addEventListener('click', () => {
      setFollowing(false);
      state.map?.flyToBounds(state.routeBounds, { padding: [30, 30], duration: 0.6 });
    });
    $('#btn-locate').addEventListener('click', centreOnMe);
    $('#btn-follow').addEventListener('click', () => setFollowing(!state.following));

    const layersBtn = $('#btn-layers');
    layersBtn.addEventListener('click', () => {
      const open = $('#layers').hidden;
      if (open && window.innerWidth <= 720 && weatherOpen()) setWeatherOpen(false);
      $('#layers').hidden = !open;
      layersBtn.setAttribute('aria-pressed', String(open));
    });

    $('#hud-toggle').addEventListener('click', () => setHudOpen(!hudOpen()));

    $('#wx-refresh').addEventListener('click', ev => {
      ev.stopPropagation();
      refreshWeather(true);
    });

    // Collapsing the weather panel hands the space back to the map. The summary
    // bar and any risk banner stay visible and keep refreshing.
    $('#wx-toggle').addEventListener('click', () => setWeatherOpen(!weatherOpen()));

    // The control stack lives in the band between the HUD and the weather panel.
    // Both change height with their content, so measure them and publish the
    // results as CSS variables.
    //
    // Only the summary bar and its risk banner count towards --wx-h: the
    // expanded forecast body is an overlay. Measuring the whole panel instead
    // would push the control stack up into the HUD whenever the forecast is
    // open on a phone.
    const measure = () => {
      const root = document.documentElement.style;
      const bar = $('#wx-toggle').offsetHeight
        + ($('#wx-alert').hidden ? 0 : $('#wx-alert').offsetHeight);
      const hud = $('#hud').offsetHeight;
      root.setProperty('--wx-h', `${Math.round(bar)}px`);
      root.setProperty('--hud-h', `${Math.round(hud)}px`);

      // Popups auto-pan into view on open; without this they slide under the HUD
      // or the weather bar. Instances inherit these from the prototype, so
      // updating it here applies to every popup, including ones already bound.
      L.Popup.prototype.options.autoPanPaddingTopLeft = L.point(14, Math.round(hud) + 22);
      L.Popup.prototype.options.autoPanPaddingBottomRight = L.point(14, Math.round(bar) + 22);
    };
    state.measurePanels = measure;
    measure();
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(measure);
      ro.observe($('#wx-toggle'));
      ro.observe($('#wx-alert'));
      ro.observe($('#hud'));
    } else {
      window.addEventListener('resize', measure);
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.route) {
        refreshWeather(false);
        if (state.following) keepAwake(true);
      }
      applyGpsMode();
    });
    // coverage drops in and out along the trail; grab fresh data the moment it returns
    window.addEventListener('online', () => { if (state.route) refreshWeather(false); });

    // both bars start minimised so the map gets the screen; the choice is then
    // remembered per device
    setWeatherOpen(localStorage.getItem('gww-wx-open') === '1', true);
    if (localStorage.getItem('gww-hud-open') !== '1') setHudOpen(false, true);
  });

  // ── per-map ──
  // A marker near the top of the corridor cannot be panned clear of the HUD —
  // maxBounds stops the map moving that far — and Leaflet's popup pane cannot
  // be raised above the panels, since the fixed-position map is its own
  // stacking context. So the HUD folds itself away while a popup covers it,
  // and springs back when the popup closes.
  state.map.on('popupopen', e => {
    if (!hudOpen()) return;
    const popup = e.popup.getElement();
    const hud = $('#hud').getBoundingClientRect();
    if (!popup) return;
    const box = popup.getBoundingClientRect();
    const overlaps = !(box.bottom <= hud.top || box.top >= hud.bottom
      || box.right <= hud.left || box.left >= hud.right);
    if (overlaps) {
      state.hudAutoMinimised = true;
      setHudOpen(false);
      // the HUD has shrunk, but the popup does not re-pan itself: nudge the map
      // so the popup clears the smaller header (maxBounds may absorb some of it)
      requestAnimationFrame(() => {
        const safeTop = $('#hud').getBoundingClientRect().bottom + 12;
        const top = popup.getBoundingClientRect().top;
        if (top < safeTop) state.map.panBy([0, top - safeTop], { animate: true, duration: 0.25 });
      });
    }
  });
  state.map.on('popupclose', () => {
    if (!state.hudAutoMinimised) return;
    state.hudAutoMinimised = false;
    setHudOpen(true);
  });
}

function hudOpen() {
  return $('#hud-toggle').getAttribute('aria-expanded') === 'true';
}

/** Fold the stat tiles away; the progress bar and status line always stay. */
function setHudOpen(open, initial = false) {
  $('#hud-toggle').setAttribute('aria-expanded', String(open));
  $('#hud-body').hidden = !open;
  // minimised, the status line carries the numbers, so re-render it now
  if (state.route) renderProgress(state.lastProgress ?? null, state.lastAccuracy);
  state.measurePanels?.();
  // an automatic fold for a popup must not overwrite the walker's own choice
  if (!initial && !state.hudAutoMinimised) {
    localStorage.setItem('gww-hud-open', open ? '1' : '0');
  }
}

function centreOnMe() {
  if (!state.lastFix) {
    toast('Waiting for a GPS fix…');
    return;
  }
  moveMap(state.lastFix, Math.max(state.map.getZoom(), 17));
}

// ── saving the map for the trail ─────────────────────────────────────
// The app caches tiles as they are viewed, which quietly means "offline" only
// covers ground already scrolled past. Out on a hill, where coverage drops out,
// that is the difference between a map and a blank screen. This walks the
// route, works out every tile within SAVE_CORRIDOR_M of it at each zoom, and
// hands the list to the service worker to fetch and keep.

/** Tile column/row containing (lat, lon) at zoom z, Web Mercator. */
function tileAt(lat, lon, z) {
  const n = 2 ** z;
  const rad = lat * Math.PI / 180;
  return [
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n),
  ];
}

/**
 * How deep a save this route can afford.
 *
 * Tiles go up fourfold per zoom level, so the honest answer depends on the
 * route: 19 for an afternoon loop, rather less for a long-distance trail whose
 * deepest level alone would be tens of thousands of requests. The depth is
 * trimmed until the whole pack fits the budget, and what that worked out to is
 * then said plainly rather than left as a surprise on mobile data.
 */
function saveZooms() {
  const spec = state.basemaps.find(b => b.id === state.activeBase) || state.basemaps[0];
  const ceiling = spec?.opts.maxNativeZoom || spec?.opts.maxZoom || 19;
  let zooms = SAVE_ZOOMS.filter(z => z <= ceiling);
  while (zooms.length > 2 && countTiles(zooms) > SAVE_TILE_BUDGET) zooms = zooms.slice(0, -1);
  return zooms;
}

/** The tiles covering the route corridor at these zooms, as {z,x,y} triples. */
function corridorTiles(zooms) {
  const out = [];
  // Sampling the line every 100 m rather than walking its own vertices: a
  // simplified route can have a kilometre between points on a straight, and a
  // box round each end would leave a hole in the middle of the pack.
  const along = sampleEvery(state.record.doc.points, state.record.doc.cumulative, 100);
  for (const z of zooms) {
    const seen = new Set();
    for (const [lat, lon] of along) {
      const dLat = SAVE_CORRIDOR_M / 110574;
      const dLon = SAVE_CORRIDOR_M / (111320 * Math.cos(lat * Math.PI / 180));
      const [x0, y0] = tileAt(lat + dLat, lon - dLon, z);
      const [x1, y1] = tileAt(lat - dLat, lon + dLon, z);
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          const key = `${x}/${y}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push([z, x, y]);
        }
      }
    }
  }
  return out;
}

// The geometry is the same for every base map, so a count is cached per depth.
let tileCountCache = {};
function countTiles(zooms) {
  const key = `${state.id}:${zooms.join(',')}`;
  if (tileCountCache[key] == null) tileCountCache[key] = corridorTiles(zooms).length;
  return tileCountCache[key];
}

function savedMaps() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}'); } catch { return {}; }
}

function renderSaveState(text) {
  const note = $('#save-note');
  const btn = $('#btn-save-map');
  const clear = $('#btn-clear-map');
  if (!note || !state.route) return;

  if (text) { note.textContent = text; return; }
  // a base map switch or any other re-render must not wipe the running count
  if (state.saving) { btn.disabled = false; btn.textContent = 'Stop saving'; return; }

  if (!navigator.serviceWorker || !window.isSecureContext) {
    btn.disabled = true;
    clear.hidden = true;
    note.textContent = 'Needs HTTPS — offline storage is not available on a plain-HTTP address.';
    return;
  }

  const saved = savedMaps()[state.id] || {};
  // a save that was stopped part-way is still useful, but saying "saved" flat
  // out would promise cover it does not have
  const entries = Object.keys(saved)
    .map(id => ({ spec: state.basemaps.find(b => b.id === id), rec: saved[id] || {} }))
    .filter(e => e.spec);
  const names = entries.map(e => e.rec.partial ? `${e.spec.name} (part)` : e.spec.name);
  const active = state.basemaps.find(b => b.id === state.activeBase);
  const zooms = saveZooms();

  btn.textContent = `Save “${active ? active.name : 'map'}” for offline`;
  btn.disabled = !!(active && active.noSave);
  clear.hidden = !names.length;
  if (active && active.noSave) {
    const savable = state.basemaps.find(b => !b.noSave);
    note.textContent = `${active.noSave}${savable ? ` Switch to ${savable.name} to save one for the trail.` : ''}`
      + (names.length ? ` Already saved for this route: ${names.join(', ')}.` : '');
    return;
  }
  note.textContent = names.length
    ? `Saved for this route: ${names.join(', ')}. The route and ${SAVE_CORRIDOR_M} m either side, `
      + `zoom ${zooms[0]}–${zooms[zooms.length - 1]}. Closer in than that still needs signal.`
    : `Nothing saved yet — tiles are only kept as you view them, so anywhere you have not scrolled `
      + `over will be blank with no signal. About ${countTiles(zooms).toLocaleString()} tiles for this `
      + `route at zoom ${zooms[0]}–${zooms[zooms.length - 1]}, a few minutes on wi-fi. You can stop it `
      + 'part-way and keep what it has.';
}

function recordSave(spec, tiles, partial, depth) {
  const maps = savedMaps();
  maps[state.id] = maps[state.id] || {};
  maps[state.id][spec.id] = { tiles, at: Date.now(), depth, ...(partial ? { partial: true } : {}) };
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(maps)); } catch { /* ignore */ }
}

async function saveMapOffline() {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) {
    toast('Offline saving needs the app to be installed or reloaded once');
    return;
  }
  const spec = state.basemaps.find(b => b.id === state.activeBase);
  if (!spec || state.saving) return;
  if (spec.noSave) { toast(spec.noSave); return; }

  const zooms = saveZooms();
  const urls = corridorTiles(zooms).map(([z, x, y]) => tileUrl(spec, z, x, y));
  state.saving = true;
  $('#btn-save-map').textContent = 'Stop saving';
  $('#btn-clear-map').hidden = true;
  renderSaveState(`Saving ${spec.name}… 0 of ${urls.length} tiles`);

  const onMessage = ev => {
    const m = ev.data;
    if (!m || m.type !== 'save-progress') return;
    if (m.finished) {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      state.saving = false;
      const depth = zooms[zooms.length - 1];
      if (m.quota) {
        toast('Ran out of storage — free some space and try again');
      } else if (m.blocked) {
        // keep what did come down: a part-saved map beats none, and the note
        // will show it as "(part)" so the cover is not over-promised
        if (m.saved) recordSave(spec, m.saved, true, depth);
        toast(`The map server is limiting requests — ${m.saved} tiles kept. Try again in a few minutes.`);
      } else if (m.cancelled) {
        if (m.saved) recordSave(spec, m.saved, true, depth);
        toast(`Stopped — ${m.saved} tiles kept`);
      } else {
        recordSave(spec, m.saved, false, depth);
        toast(m.failed
          ? `Saved ${m.saved} tiles, ${m.failed} failed — try again on a better connection`
          : `${spec.name} saved — ${m.saved} tiles ready offline`);
      }
      renderSaveState();
    } else {
      renderSaveState(`Saving ${spec.name}… ${m.done} of ${m.total} tiles`);
    }
  };
  navigator.serviceWorker.addEventListener('message', onMessage);
  sw.postMessage({ type: 'save-tiles', urls });
}

function clearSavedMaps() {
  const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
  if (!sw) return;
  sw.postMessage({ type: 'forget-tiles', urls: [] });
  localStorage.removeItem(SAVED_KEY);
  renderSaveState();
  toast('Saved maps cleared');
}

// ── emergency card ───────────────────────────────────────────────────
// One tap for the moment nobody wants: who to call, where you are in a form you
// can read out or paste into a message, and the nearest defibrillator, water,
// toilet and shelter from your last fix. The AED data was already on the map;
// nobody should be hunting through markers with an incident in front of them.
//
// Who to call is the part the reference app could hard-code and this one
// cannot. 112 is the honest default — it is the GSM standard number, reaches
// the local service across Europe and is redirected to it on most networks
// elsewhere — and where the route is plainly inside a country with a
// better-known number, that one is offered alongside it. The number that
// actually matters on an organised walk is the marshal's, which only the walker
// can supply, so the card takes one and keeps it.

const REGIONS = [
  { box: [1.13, 1.50, 103.58, 104.12], calls: [
    { tel: '995', label: 'Call 995', sub: 'SCDF ambulance / fire', primary: true },
    { tel: '999', label: 'Call 999', sub: 'Police' },
    { tel: '1800-471-7300', label: 'NParks helpline', sub: 'Parks and nature reserves' },
  ] },
  { box: [24, 72, -170, -52], calls: [
    { tel: '911', label: 'Call 911', sub: 'Emergency services', primary: true },
  ] },
  { box: [49.8, 61, -11, 2], calls: [
    { tel: '999', label: 'Call 999', sub: 'Emergency services', primary: true },
    { tel: '112', label: 'Call 112', sub: 'Works the same here' },
  ] },
  { box: [-44, -9, 112, 154], calls: [
    { tel: '000', label: 'Call 000', sub: 'Emergency services', primary: true },
    { tel: '112', label: 'Call 112', sub: 'From a mobile' },
  ] },
  { box: [-48, -34, 166, 179], calls: [
    { tel: '111', label: 'Call 111', sub: 'Emergency services', primary: true },
  ] },
  { box: [24, 46, 122, 154], calls: [
    { tel: '119', label: 'Call 119', sub: 'Ambulance / fire', primary: true },
    { tel: '110', label: 'Call 110', sub: 'Police' },
  ] },
];

function storedContact() {
  try { return JSON.parse(localStorage.getItem(CONTACT_KEY) || 'null'); } catch { return null; }
}

/** The call buttons for wherever this route is, plus the walker's own contact. */
function emergencyCalls() {
  const b = state.record.doc.bounds;
  const mid = [(b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2];
  const region = REGIONS.find(r =>
    // the whole route has to be inside, not just its midpoint: a number that is
    // wrong for half the walk is worse than the international one
    b.minLat >= r.box[0] && b.maxLat <= r.box[1] && b.minLon >= r.box[2] && b.maxLon <= r.box[3]);

  const calls = region
    ? region.calls.slice()
    : [{ tel: '112', label: 'Call 112', sub: 'International emergency number', primary: true }];
  if (!calls.some(c => c.tel === '112')) {
    calls.push({ tel: '112', label: 'Call 112', sub: 'If 112 is what your phone knows' });
  }

  const contact = storedContact();
  if (contact?.tel) {
    calls.unshift({ tel: contact.tel, label: `Call ${contact.name || 'your contact'}`,
      sub: contact.tel, primary: !calls.some(c => c.primary) });
  }
  // Far enough from the equator for 112 alone to be a guess, so say where the
  // numbers came from rather than presenting them as local knowledge.
  state.callsNote = region ? '' : `Numbers not known for ${mid[0].toFixed(2)}, ${mid[1].toFixed(2)} — `
    + '112 is the international number. Add your own contact above.';
  return calls;
}

function wireSos() {
  wireOnce('sos', () => {
    $('#btn-sos').addEventListener('click', () => openSos($('#sos').hidden));
    $('#sos-close').addEventListener('click', () => openSos(false));
    $('#sos-copy').addEventListener('click', copyLocation);
    if (navigator.share) {
      const share = $('#sos-share');
      share.hidden = false;
      share.addEventListener('click', () => {
        navigator.share({ title: `${state.record.doc.name} — my location`, text: locationText() })
          .catch(() => {});
      });
    }
    $('#sos-edit').addEventListener('click', () => {
      const form = $('#sos-form');
      form.hidden = !form.hidden;
      if (!form.hidden) {
        const contact = storedContact();
        $('#sos-contact-name').value = contact?.name || '';
        $('#sos-contact-tel').value = contact?.tel || '';
        $('#sos-contact-name').focus();
      }
    });
    $('#sos-form').addEventListener('submit', ev => {
      ev.preventDefault();
      const name = $('#sos-contact-name').value.trim();
      const tel = $('#sos-contact-tel').value.trim();
      if (!tel) { toast('A number is needed to add a contact'); return; }
      try { localStorage.setItem(CONTACT_KEY, JSON.stringify({ name, tel })); } catch { /* ignore */ }
      $('#sos-form').hidden = true;
      renderCalls();
      toast('Contact saved on this device');
    });
    $('#sos-contact-clear').addEventListener('click', () => {
      try { localStorage.removeItem(CONTACT_KEY); } catch { /* ignore */ }
      $('#sos-contact-name').value = '';
      $('#sos-contact-tel').value = '';
      $('#sos-form').hidden = true;
      renderCalls();
      toast('Contact removed');
    });
  });
  renderCalls();
}

function renderCalls() {
  const calls = emergencyCalls();
  $('#sos-calls').innerHTML = calls.filter(c => c.tel).map(c =>
    `<a href="tel:${escapeHtml(c.tel.replace(/\s/g, ''))}"${c.primary ? '' : ' class="secondary"'}>
       <span>${escapeHtml(c.label)}</span><small>${escapeHtml(c.sub)}</small>
     </a>`).join('');
}

function openSos(open) {
  const panel = $('#sos');
  panel.hidden = !open;
  $('#btn-sos').setAttribute('aria-pressed', String(open));
  if (open) {
    // one panel at a time on the map
    if (!$('#layers').hidden) {
      $('#layers').hidden = true;
      $('#btn-layers').setAttribute('aria-pressed', 'false');
    }
    if (window.innerWidth <= 720 && weatherOpen()) setWeatherOpen(false);
    renderSos();
  }
}

/** Plain text of where the walker is, for reading out or pasting into a message. */
function locationText() {
  if (!state.lastFix) return 'No GPS fix yet.';
  const [lat, lon] = state.lastFix;
  const p = state.lastProgress;
  const along = p && p.onRoute ? p.along : null;
  const parts = [`I'm at ${lat.toFixed(5)}, ${lon.toFixed(5)}`];
  if (state.lastAccuracy) parts[0] += ` (±${Math.round(state.lastAccuracy)} m)`;
  parts.push(`https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`);
  if (along != null) {
    const near = nearestCheckpoint(lat, lon, { along, detached: 0 });
    // "past" and "before" read better than "back" and "ahead" for a marshal
    // being told where to come: it is the landmark that is fixed, not them.
    parts.push(`On the ${state.record.doc.name} route at km ${(p.along / 1000).toFixed(2)}`
      + (near ? `, ${formatDistance(near.d)} ${near.dir === 'back' ? 'past' : 'before'} ${near.cp.name}` : ''));
  }
  return parts.join('\n');
}

/**
 * How far it is to walk to something at `target` metres along the route, and
 * which way to set off.
 *
 * Straight-line distance is close to useless here. A loop round a reservoir or
 * a valley means a toilet 1.4 km across the water is 3.6 km of walking, and the
 * marker that looks nearest on the map is regularly not the nearest one to
 * reach. On a loop either direction is fair game, so both are measured and the
 * shorter wins; `off` is the walk from the path to the thing itself.
 */
function routeWalk(target, along, off = 0) {
  const total = state.route.total;
  const raw = target - along;
  let fwd, back;
  if (state.route.isLoop) {
    fwd = ((raw % total) + total) % total;
    back = (total - fwd) % total;
  } else {
    fwd = raw >= 0 ? raw : Infinity;
    back = raw < 0 ? -raw : Infinity;
  }
  const ahead = fwd <= back;
  return { d: (ahead ? fwd : back) + off, dir: ahead ? 'ahead' : 'back' };
}

/**
 * Where to measure from, and how to describe the result.
 *
 * On the route that is simply the walker's position. Off it, straight lines
 * from the walker rank badly in two ways at once. They ignore the walk from the
 * path to the thing itself, so a toilet 600 m off the path through a housing
 * estate beats the one beside the start by 400 m of crow-flies; and because
 * every candidate sits at roughly the same bearing once you are any distance
 * away, differences of a few tens of metres — noise — decide each category
 * separately, so the card offers an AED at one end of the route, a toilet in a
 * private estate and a shelter at the other end. Nothing anyone could act on.
 *
 * Off the route every walk starts the same way, by getting back to the path, so
 * the honest anchor is the point where you would rejoin it. Measured from
 * there the categories agree with each other, the off-path walk counts, and the
 * numbers stay comparable. `detached` is the straight line back to that point,
 * added to every row so the figure covers the whole journey, not its last leg.
 */
function sosAnchor() {
  const p = state.lastProgress;
  if (!p) return { along: null, detached: 0 };
  if (p.onRoute) return { along: p.along, detached: 0 };
  if (typeof p.nearestAlong !== 'number') return { along: null, detached: 0 };
  return { along: p.nearestAlong, detached: p.offset || 0, rejoin: true };
}

function measureTo(lat, lon, targetLat, targetLon, targetAlong, off, anchor) {
  if (!anchor || anchor.along == null || targetAlong == null) {
    return { d: haversine(lat, lon, targetLat, targetLon), dir: null };
  }
  const m = routeWalk(targetAlong, anchor.along, off);
  // before rejoining the path, "ahead" and "back" name a direction the walker
  // is not travelling in yet, so a bare distance is the only honest label
  return anchor.rejoin ? { d: m.d + anchor.detached, dir: null } : m;
}

function nearestCheckpoint(lat, lon, anchor) {
  let best = null;
  for (const cp of state.checkpoints) {
    // on a loop the finish is the same place as the start, so it adds nothing
    if (cp.id === 'finish' && state.route.isLoop) continue;
    const m = measureTo(lat, lon, cp.lat, cp.lon, cp.along, 0, anchor);
    if (!best || m.d < best.d) best = { cp, ...m };
  }
  return best;
}

function nearestPoi(cat, lat, lon, anchor) {
  let best = null;
  (state.pois[cat] || []).forEach((p, i) => {
    const m = measureTo(lat, lon, p.lat, p.lon, p.along, p.offset, anchor);
    if (!best || m.d < best.d) best = { p, i, ...m };
  });
  return best;
}

function renderSos() {
  const where = $('#sos-where');
  const list = $('#sos-near');

  if (!state.lastFix) {
    where.textContent = 'Waiting for a GPS fix… The numbers below will fill in as soon as there is one.';
    list.innerHTML = '<li class="none">Nearest help is worked out from your position once there is a fix.</li>';
    $('#sos-note').textContent = state.callsNote
      || 'Distances follow the route once there is a fix.';
    return;
  }

  const [lat, lon] = state.lastFix;
  const age = state.lastFixAt ? Math.round((Date.now() - state.lastFixAt) / 1000) : null;
  const p = state.lastProgress;
  const along = p && p.onRoute ? p.along : null;
  const anchor = sosAnchor();
  const near = nearestCheckpoint(lat, lon, anchor);
  where.innerHTML =
    `<b>${lat.toFixed(5)}, ${lon.toFixed(5)}</b>`
    + (state.lastAccuracy ? ` · ±${Math.round(state.lastAccuracy)} m` : '')
    + (age != null ? ` · ${age < 5 ? 'just now' : `${age} s ago`}` : '')
    + (along != null ? `<br>km ${(along / 1000).toFixed(2)} on the route` : '<br>Off the route')
    + (near ? `<br>${formatDistance(near.d)} ${near.dir === 'back' ? 'past' : near.dir === 'ahead' ? 'before' : 'from'} ${escapeHtml(near.cp.name)}` : '');

  const rows = [];
  for (const cat of ['aed', 'water', 'toilet', 'shelter']) {
    const hit = nearestPoi(cat, lat, lon, anchor);
    if (!hit) continue;
    const { p: poi, i } = hit;
    const label = CATEGORY[cat].label;
    rows.push(`<li data-cat="${cat}" data-i="${i}">
      ${legendIcon(cat)}
      <span class="t">${escapeHtml(poi.name === label ? label : poi.name)}
        <small>${escapeHtml([poi.name !== label ? label : '', poi.detail].filter(Boolean).join(' · '))}</small>
      </span>
      <span class="d">${formatDistance(hit.d)}${hit.dir ? `<small>${hit.dir}</small>` : ''}</span>
    </li>`);
  }
  if (near) {
    rows.push(`<li data-cp="${escapeHtml(near.cp.id)}">
      <span class="ico cp-ico" aria-hidden="true">★</span>
      <span class="t">${escapeHtml(near.cp.name)}<small>Nearest checkpoint — a landmark to describe</small></span>
      <span class="d">${formatDistance(near.d)}${near.dir ? `<small>${near.dir}</small>` : ''}</span>
    </li>`);
  }
  list.innerHTML = rows.join('')
    || '<li class="none">No facilities found along this route — search OpenStreetMap again from the layers panel.</li>';
  // the numbers mean something different off the route, so say which it is
  $('#sos-note').textContent = along != null
    ? 'Distances follow the route from your last fix, the shorter way round. Tap a row to see it on the map.'
    : anchor.along != null
      ? `Off the route: ${formatDistance(anchor.detached)} straight back to the path at km `
        + `${(anchor.along / 1000).toFixed(2)}, then along the route from there. Tap a row to see it on the map.`
      : 'Off the route, so these are straight-line distances — the walk may be much further. Tap a row to see it on the map.';

  for (const li of list.querySelectorAll('li[data-cat]')) {
    li.addEventListener('click', () => {
      const marker = state.markersByCategory[li.dataset.cat][Number(li.dataset.i)];
      openSos(false);
      setFollowing(false, true);
      state.cluster.zoomToShowLayer(marker, () => marker.openPopup());
    });
  }
  for (const li of list.querySelectorAll('li[data-cp]')) {
    li.addEventListener('click', () => {
      const cp = state.checkpoints.find(c => c.id === li.dataset.cp);
      openSos(false);
      setFollowing(false, true);
      moveMap([cp.lat, cp.lon], Math.max(state.map.getZoom(), 17));
    });
  }
}

async function copyLocation() {
  const text = locationText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Location copied — paste it into a message');
  } catch {
    // no clipboard (insecure origin, or denied): leave it selectable on screen
    const range = document.createRange();
    range.selectNodeContents($('#sos-where'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Could not copy automatically — the text is selected, copy it by hand');
  }
}

// ── keeping the screen on ────────────────────────────────────────────
// Follow mode means the phone is being used as a live map, and a phone that
// sleeps after thirty seconds also stops delivering GPS fixes. The lock is
// released by the browser whenever the page is hidden, so it is re-requested
// when the page comes back while still following.

async function keepAwake(on) {
  if (!('wakeLock' in navigator)) return;
  if (!on) {
    if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
    return;
  }
  if (state.wakeLock) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
  } catch {
    // low battery or a policy: the map still works, the screen just may sleep
  }
}

function moveMap(latlng, zoom) {
  state.programmaticMove = true;
  state.map.setView(latlng, zoom, { animate: true, duration: 0.35 });
  setTimeout(() => { state.programmaticMove = false; }, 500);
}

function setFollowing(on, silent = false) {
  state.following = on;
  $('#btn-follow').setAttribute('aria-pressed', String(on));
  const box = $('#chk-follow');
  if (box) box.checked = on;

  clearInterval(state.followTimer);
  state.followTimer = null;
  keepAwake(on);
  applyGpsMode();

  if (on) {
    if (!state.lastFix) toast('Following — waiting for a GPS fix…');
    else moveMap(state.lastFix, Math.max(state.map.getZoom(), 17));
    // re-centre once a second on the most recent fix
    state.followTimer = setInterval(() => {
      if (state.lastFix && state.map) moveMap(state.lastFix, state.map.getZoom());
    }, FOLLOW_INTERVAL_MS);
  } else if (!silent) {
    toast('Follow off');
  }
}

// ── location & progress ──────────────────────────────────────────────

function startLocating() {
  // Browsers hand out GPS only on a secure context. localhost is exempt, a LAN
  // address over plain HTTP is not, and the failure that comes back looks
  // exactly like a permission denial — which would send someone hunting through
  // phone settings for a problem that is not there. Say what is actually wrong.
  if (!window.isSecureContext) {
    const status = $('#hud-status');
    status.textContent = 'Opened over plain HTTP — GPS and offline need HTTPS';
    status.className = 'warn';
    status.title = `Tracking and offline caching only work on a secure origin. Open ${SECURE_HOME} instead.`;
    toast('No GPS over plain HTTP — open the https:// address for tracking');
    return;
  }

  if (!('geolocation' in navigator)) {
    $('#hud-status').textContent = 'This device has no location support';
    return;
  }
  state.gpsReady = true;
  applyGpsMode();
}

// ── GPS duty cycle ───────────────────────────────────────────────────
// A continuous high-accuracy watch holds the GPS receiver on for the whole
// walk, which is the single biggest drain on the phone. Battery saver swaps it
// for one fix every SAVER_POLL_MS, and the receiver sleeps in between. Follow
// mode always gets the continuous watch: re-centring once a second on a
// position that changes every thirty makes no sense. High accuracy stays on in
// both modes — a network fix is worthless under canopy.

function applyGpsMode() {
  if (!state.gpsReady) { stopGps(); return; }
  const want = document.hidden ? null
    : (state.batterySaver && !state.following) ? 'poll' : 'watch';
  if (want === state.gpsMode) return;
  stopGps();
  state.gpsMode = want;
  if (want === 'watch') {
    state.watchId = navigator.geolocation.watchPosition(onFix, onFixError, {
      enableHighAccuracy: true, maximumAge: 2000, timeout: 20000,
    });
  } else if (want === 'poll') {
    pollOnce();
    state.pollTimer = setInterval(pollOnce, SAVER_POLL_MS);
  }
}

function pollOnce() {
  navigator.geolocation.getCurrentPosition(onFix, onFixError, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: SAVER_FIX_TIMEOUT_MS,
  });
}

function stopGps() {
  if (state.watchId != null) navigator.geolocation.clearWatch(state.watchId);
  clearInterval(state.pollTimer);
  state.watchId = null;
  state.pollTimer = null;
  state.gpsMode = null;
}

function setBatterySaver(on) {
  state.batterySaver = on;
  localStorage.setItem('gww-saver', on ? '1' : '0');
  const box = $('#chk-saver');
  if (box) box.checked = on;
  applyGpsMode();
  if (state.lastProgress) renderProgress(state.lastProgress, state.lastAccuracy);
}

function onFix(pos) {
  if (!state.route) return;          // a fix that arrived after the route closed
  const { latitude: lat, longitude: lon, accuracy, heading, speed } = pos.coords;
  state.lastFix = [lat, lon];
  state.lastFixAt = pos.timestamp || Date.now();

  // Course over ground, for devices with no usable compass. It only describes
  // the direction of travel, so it says nothing while standing still — and at a
  // standstill it is either null or drift. Ignore it below walking pace.
  if (heading != null && isFinite(heading) && (speed == null || speed > 0.5)) {
    setHeading(heading, 'gps');
  }

  if (!state.marker) {
    state.marker = L.marker([lat, lon], { icon: meIcon(), zIndexOffset: 1000, interactive: false })
      .addTo(state.map);
    state.accuracyRing = L.circle([lat, lon], {
      radius: accuracy, color: '#3b8cff', weight: 1, fillColor: '#3b8cff', fillOpacity: 0.1, interactive: false,
    }).addTo(state.map);
    applyHeading();   // the compass may well have been running before the first fix
  } else {
    state.marker.setLatLng([lat, lon]);
    state.accuracyRing.setLatLng([lat, lon]).setRadius(accuracy);
  }

  const progress = state.tracker.update(lat, lon, pos.timestamp || Date.now());
  state.lastProgress = progress;
  state.lastAccuracy = accuracy;
  state.restored = false;
  renderProgress(progress, accuracy);
  if (progress.onRoute) saveProgress();
  if (!$('#sos').hidden) renderSos();
}

// ── surviving a reload ───────────────────────────────────────────────
// Sooner or later in a four-hour walk the phone kills the tab. Without this,
// coming back restarts the walker at zero with no ETA — and, on a loop, a fix
// near the finish would be read as the start line. Progress is kept per route,
// so switching routes and back does not mix two walks up.

function saveProgress() {
  const now = Date.now();
  if (now - state.progressSavedAt < PROGRESS_SAVE_MS) return;
  const snap = state.tracker.snapshot();
  if (!snap) return;
  state.progressSavedAt = now;
  try {
    localStorage.setItem(progressKey(state.id), JSON.stringify({ ...snap, savedAt: now }));
  } catch { /* storage full or blocked: nothing to do but carry on */ }
}

function restoreProgress() {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(progressKey(state.id)) || 'null'); } catch { /* ignore */ }
  if (!snap) return;
  if (!snap.savedAt || Date.now() - snap.savedAt > PROGRESS_MAX_AGE_MS) {
    localStorage.removeItem(progressKey(state.id));        // a previous day's walk
    return;
  }
  if (!state.tracker.restore(snap)) return;
  state.restored = true;
  const along = state.tracker.along;
  const total = state.route.total;
  // show the saved numbers straight away rather than zeros until the first fix
  renderProgress({
    along, remaining: total - along, fraction: total ? along / total : 0,
    offset: 0, onRoute: true, speed: null, eta: null, restored: true,
  }, null);
}

function resetProgress() {
  state.tracker.reset();
  state.restored = false;
  localStorage.removeItem(progressKey(state.id));
  state.lastProgress = null;
  renderProgress(null);
  state.doneLine.setLatLngs([]);
  toast('Progress reset — tracking from the start again');
}

// ── which way the walker is facing ───────────────────────────────────
// The arrow on the position marker. Two sources, preferred in this order:
//
//   device compass   turns with the walker even when they are standing still,
//                    which is the point of the arrow
//   GPS course       needs no permission and no magnetometer, but only exists
//                    while actually moving (see onFix)
//
// A compass reading is relative to the top of the *device*, so it is corrected
// for how far the screen itself has been rotated. In portrait — how the phone
// will be held on the walk — that correction is zero.

function startCompass() {
  // Same secure-context rule as geolocation, so on a plain-HTTP LAN copy there
  // is no compass either; startLocating() already explains that to the walker.
  if (!window.isSecureContext || !('DeviceOrientationEvent' in window)) return;

  // iOS gates the compass behind a prompt that only a user gesture may raise,
  // so wait for the first tap rather than asking before the map is even drawn.
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    state.compassNeedsGesture = true;
    const ask = () => {
      document.removeEventListener('click', ask);
      document.removeEventListener('touchend', ask);
      requestCompass();
    };
    document.addEventListener('click', ask);
    document.addEventListener('touchend', ask, { passive: true });
    return;
  }
  attachCompass();
}

function requestCompass() {
  if (!state.compassNeedsGesture) return;
  state.compassNeedsGesture = false;
  DeviceOrientationEvent.requestPermission()
    .then(res => { if (res === 'granted') attachCompass(); })
    .catch(() => {});   // declining just leaves the arrow on GPS course
}

function attachCompass() {
  if (state.compassOn) return;
  state.compassOn = true;
  // `deviceorientationabsolute` is the true-north event where it is implemented;
  // Safari reports the same thing as webkitCompassHeading on plain
  // `deviceorientation`. Listen for both and use whichever the device sends.
  window.addEventListener('deviceorientationabsolute', onOrientation, true);
  window.addEventListener('deviceorientation', onOrientation, true);
}

function onOrientation(e) {
  let deg = null;
  if (typeof e.webkitCompassHeading === 'number' && isFinite(e.webkitCompassHeading)) {
    deg = e.webkitCompassHeading;          // already degrees clockwise from north
  } else if (e.absolute === true && typeof e.alpha === 'number') {
    deg = 360 - e.alpha;                   // alpha is measured anticlockwise
  }
  if (deg == null) return;

  const screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  setHeading(deg + screenAngle, 'compass');
}

/** Fold a new bearing into the displayed one. */
function setHeading(deg, source) {
  if (deg == null || !isFinite(deg)) return;
  deg = ((deg % 360) + 360) % 360;

  const now = Date.now();
  if (source === 'compass') {
    state.compassAt = now;
  } else if (state.compassAt && now - state.compassAt < COMPASS_STALE_MS) {
    return;                // a live compass beats course over ground
  }

  if (state.heading == null) {
    state.heading = deg;
    state.headingCss = deg;
  } else {
    // Always turn the short way. Without this a walker facing north makes the
    // arrow spin most of a circle every time the reading crosses 0°/360°, and
    // because the CSS angle is left unwrapped the animation follows the short
    // arc too rather than unwinding.
    const step = ((deg - state.heading + 540) % 360) - 180;
    const eased = source === 'compass' ? step * HEADING_SMOOTHING : step;
    state.heading = (state.heading + eased + 360) % 360;
    state.headingCss += eased;
  }
  applyHeading();
}

function applyHeading() {
  if (state.heading == null || !state.marker) return;
  const el = state.marker.getElement();
  const arrow = el && el.querySelector('.heading');
  if (!arrow) return;
  el.classList.add('has-heading');
  arrow.style.transform = `rotate(${state.headingCss.toFixed(1)}deg)`;
}

function onFixError(err) {
  if (!state.route) return;
  const msg = err.code === err.PERMISSION_DENIED
    ? 'Location permission denied — progress needs GPS'
    : err.code === err.POSITION_UNAVAILABLE
      ? 'No GPS signal yet — tree cover and buildings block it'
      : 'Waiting for GPS…';
  const el = $('#hud-status');
  el.textContent = msg;
  el.className = err.code === err.PERMISSION_DENIED ? 'warn' : '';
}

/** Write a distance into a stat tile, with the unit in a smaller span. */
function setStat(sel, metres) {
  const { value, unit } = splitDistance(metres);
  $(sel).innerHTML = `${escapeHtml(value)}${unit ? `<i>${unit}</i>` : ''}`;
}

function renderProgress(p, accuracy) {
  const status = $('#hud-status');

  if (!p) {
    status.textContent = 'Waiting for GPS…';
    setStat('#st-done', 0);
    setStat('#st-left', state.route.total);
    $('#st-pct').textContent = '0%';
    $('#st-next').textContent = '–';
    return;
  }

  setStat('#st-done', p.along);
  setStat('#st-left', p.remaining);
  $('#st-pct').textContent = `${Math.round(p.fraction * 100)}%`;

  const next = state.checkpoints.find(cp => cp.along > p.along + 5);
  if (next) {
    setStat('#st-next', next.along - p.along);
    $('#st-next-l').textContent = next.id === 'finish' ? 'to finish' : `to ${shortName(next.name)}`;
    $('#st-next-l').title = next.name;
  } else {
    $('#st-next').textContent = 'Done';
    $('#st-next-l').textContent = 'finished';
  }

  $('#bar-fill').style.width = `${(p.fraction * 100).toFixed(2)}%`;
  const me = $('#bar-me');
  me.classList.add('on');
  me.style.left = `${(p.fraction * 100).toFixed(2)}%`;

  state.doneLine.setLatLngs(walkedPath(p.along));

  const minimised = $('#hud-body').hidden;
  if (p.restored) {
    status.textContent = `Resumed at ${formatDistance(p.along)} · waiting for GPS…`;
    status.className = '';
  } else if (!p.onRoute) {
    status.textContent =
      `Off route — ${formatDistance(p.offset)} from the path · progress reset to the start`;
    status.className = 'warn';
  } else {
    const parts = [];
    // minimised, the status line is the only place the numbers can live
    if (minimised) parts.push(`${formatDistance(p.remaining)} to finish`,
      `${Math.round(p.fraction * 100)}%`);
    if (p.eta) parts.push(`${formatDuration(p.eta)} at this pace`);
    else if (p.speed) parts.push(`${(p.speed * 3.6).toFixed(1)} km/h avg`);
    else if (!minimised && accuracy) parts.push(`GPS accurate to ${Math.round(accuracy)} m`);
    if (state.gpsMode === 'poll') parts.push(`GPS every ${SAVER_POLL_MS / 1000} s`);
    status.textContent = parts.join(' · ') || 'On route';
    status.className = 'live';
  }
}

/** Route vertices up to `along`, so the walked portion can be drawn. */
function walkedPath(along) {
  const out = [];
  const { points, cumulative } = state.route;
  for (let i = 0; i < points.length; i++) {
    if (cumulative[i] <= along) out.push([points[i][0], points[i][1]]);
    else break;
  }
  out.push(state.route.atDistance(along));
  return out;
}

// ── weather ──────────────────────────────────────────────────────────
function startWeather() {
  const cached = cachedWeather();
  if (cached) renderWeather({ ...cached, stale: true });
  refreshWeather(false);
  state.weatherTimer = setInterval(() => refreshWeather(false), WEATHER_REFRESH_MS);
}

async function refreshWeather(manual) {
  if (!state.route) return;
  const btn = $('#wx-refresh');
  clearTimeout(state.wxRetry);
  btn.disabled = true;
  try {
    const centre = state.lastFix
      ? { lat: state.lastFix[0], lon: state.lastFix[1] }
      : centreOfRoute();
    // sample the route so a nowcast covers every area it passes through
    const samples = [0, 0.25, 0.5, 0.75].map(f => state.route.atDistance(f * state.route.total));
    const model = await loadWeather(centre, samples);
    if (!state.route) return;          // the walker left while it was in flight
    renderWeather(model);
    state.wxFailures = 0;
    if (manual) toast('Weather updated');
  } catch (err) {
    console.warn('weather', err);
    const cached = cachedWeather();
    if (cached) renderWeather({ ...cached, stale: true });
    else $('#wx-note').textContent = 'Weather unavailable — retrying…';
    if (manual) toast('Could not reach the forecast');

    // Come back quickly rather than waiting out the whole 5-minute cycle: a
    // failed load is usually a transient blip, and a blank card at the start
    // is exactly when it matters most.
    state.wxFailures = (state.wxFailures || 0) + 1;
    const wait = Math.min(60000, 5000 * state.wxFailures);
    state.wxRetry = setTimeout(() => refreshWeather(false), wait);
  } finally {
    btn.disabled = false;
  }
}

function centreOfRoute() {
  const b = state.route.doc.bounds;
  return { lat: (b.minLat + b.maxLat) / 2, lon: (b.minLon + b.maxLon) / 2 };
}

function weatherOpen() {
  return $('#wx-toggle').getAttribute('aria-expanded') === 'true';
}

function setWeatherOpen(open, initial = false) {
  $('#wx-toggle').setAttribute('aria-expanded', String(open));
  $('#wx-body').hidden = !open;
  // On a phone the open forecast is a bottom sheet covering most of the map, so
  // the control stack steps aside rather than sitting uselessly behind it.
  document.body.classList.toggle('wx-open', open);
  if (open) closeLayers();
  if (!initial) localStorage.setItem('gww-wx-open', open ? '1' : '0');
}

function closeLayers() {
  $('#layers').hidden = true;
  $('#btn-layers').setAttribute('aria-pressed', 'false');
}

function renderWeather(m) {
  const now = m.now;
  const risk = m.risk || { level: 'ok', alerts: [] };
  const air = m.air || {};

  // ── summary bar: the part that stays on screen when collapsed ──
  $('#weather').dataset.risk = risk.level;
  $('#wx-bar-ico').innerHTML = weatherIcon(now.code);
  $('#wx-bar-temp').textContent = now.tempC != null ? `${now.tempC.toFixed(1)}°C` : '–';
  $('#wx-bar-txt').textContent = now.text;

  const aq = [];
  if (air.psi != null) aq.push(`PSI ${air.psi}`);
  else if (air.aqi != null) aq.push(`AQI ${Math.round(air.aqi)}`);
  if (air.pm25 != null) aq.push(`PM2.5 ${Math.round(air.pm25)}`);
  $('#wx-bar-aq').textContent = aq.join(' · ');

  // The banner carries only the single most serious warning, so it stays one or
  // two lines on a phone. The rest are listed in the expanded panel.
  const alert = $('#wx-alert');
  if (risk.alerts.length) {
    const [lead, ...rest] = risk.alerts;
    alert.innerHTML =
      `${risk.level === 'severe' ? '⚠ ' : ''}${escapeHtml(lead.text)}` +
      (rest.length ? ` <span class="wx-more">+${rest.length} more</span>` : '');
    alert.title = risk.alerts.map(a => a.text).join('\n');
    alert.hidden = false;
  } else {
    alert.hidden = true;
    alert.removeAttribute('title');
  }
  state.measurePanels?.();

  // ── forecast cards ──
  $('#wx-cards').innerHTML = [
    `<div class="wx-card now">
       <span class="wx-when">Now</span>
       ${weatherIcon(now.code)}
       <span class="wx-temp">${now.tempC != null ? `${now.tempC.toFixed(1)}°C` : '–'}</span>
       <span class="wx-desc">${escapeHtml(now.text)}</span>
     </div>`,
    ...m.slots.map(s => `
      <div class="wx-card">
        <span class="wx-when">${s.label}</span>
        ${weatherIcon(s.code)}
        <span class="wx-temp">${s.tempC != null ? `${s.estimated ? '~' : ''}${Math.round(s.tempC)}°C` : '–'}</span>
        <span class="wx-desc">${escapeHtml(s.text)}</span>
      </div>`),
  ].join('');

  // ── air quality tiles ──
  const arrow = { rising: '↑', easing: '↓', steady: '→' }[air.trend] || '';
  const tile = (key, value, band, sub) => {
    if (value == null) return '';
    return `<div class="wx-aq" data-level="${band ? band.level : 'ok'}">
      <span class="wx-aq-k">${key}</span>
      <span class="wx-aq-v">${typeof value === 'number' ? Math.round(value * 10) / 10 : value}</span>
      <span class="wx-aq-b">${escapeHtml([band?.label, sub].filter(Boolean).join(' · '))}</span>
    </div>`;
  };
  $('#wx-air').innerHTML = [
    tile('PSI 24h', air.psi, psiBand(air.psi), ''),
    tile('AQI', air.aqi, aqiBand(air.aqi), 'European scale'),
    tile(air.scale === 'nea' ? 'PM2.5 1h' : 'PM2.5', air.pm25, pm25Band(air.pm25, air.scale),
      air.trend ? `${arrow} ${air.trend}` : 'µg/m³'),
    // UV reads 0 all night; the tile only earns its place in daylight
    air.uv ? tile('UV index', air.uv, uvBand(air.uv), '') : '',
  ].join('') || '<p class="fineprint">Air-quality data unavailable for this area.</p>';

  // ── every warning, in full, where there is room for them ──
  const list = $('#wx-alerts');
  if (risk.alerts.length > 1) {
    list.innerHTML = risk.alerts
      .map(a => `<li data-level="${a.level}">${escapeHtml(a.text)}</li>`).join('');
    list.hidden = false;
  } else {
    list.hidden = true;
  }

  // ── caption ──
  const bits = [];
  if (now.feelsLikeC != null && now.tempC != null && Math.abs(now.feelsLikeC - now.tempC) >= 1) {
    bits.push(`feels like ${Math.round(now.feelsLikeC)}°C`);
  }
  if (now.humidity != null) bits.push(`${Math.round(now.humidity)}% RH`);
  if (now.windKt != null) bits.push(`wind ${Math.round(now.windKt * 1.852)} km/h`);
  if (now.rainfallMm) bits.push(`rain ${now.rainfallMm} mm`);
  if (m.day.low != null && m.day.high != null) {
    bits.push(`today ${Math.round(m.day.low)}–${Math.round(m.day.high)}°C`);
  }
  const when = now.observedAt
    ? new Date(now.observedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
  bits.push(`${m.providerName || 'Forecast'} ${when || 'live'}`);
  if (air.stale) bits.push('air quality from last reading');
  if (m.stale) bits.push('offline copy');

  const note = $('#wx-note');
  note.textContent = bits.join(' · ');
  note.title = m.provider === 'nea'
    ? `Nowcast for ${now.areas?.length ? now.areas.join(', ') : 'the route'} `
      + `(${now.validPeriod || 'next 2 hours'}). +2/4/6 h conditions come from NEA's 24-hour forecast `
      + `for the ${m.day.region} region; their temperatures are estimated by tracking the current `
      + `reading along today's ${m.day.low}–${m.day.high}°C forecast range. PSI and PM2.5 are the `
      + `${air.region} region readings; NEA publishes no PSI forecast, so the trend compares the `
      + '1-hour PM2.5 against its own 24-hour average.'
    : 'Hourly forecast from Open-Meteo for the route\'s own location, drawn from the national '
      + `weather service covering it (${m.day.region}). The +2/4/6 h figures are real forecast `
      + 'values, not estimates. Air quality is the CAMS model\'s surface PM2.5 and European AQI '
      + 'for the same point.';
}

// ── misc ─────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2600);
}

/** Squeeze a landmark name into the narrow "next checkpoint" label. */
function shortName(name) {
  const trimmed = String(name)
    .replace(/^(The|La|Le|El)\s+/i, '')
    .replace(/\s+(Lookout|Viewpoint|Memorial|Monument|Station|Boardwalk|Ruins|Shelter|Hut)$/i, '');
  return trimmed.length > 15 ? `${trimmed.slice(0, 14)}…` : trimmed;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Service workers need a secure context: HTTPS, or any loopback address.
  if (!window.isSecureContext) return;
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW', err));
}
