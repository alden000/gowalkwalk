// Keeping routes on the device.
//
// A route that has to be re-uploaded, re-searched and re-downloaded every time
// the app opens is no use at a trailhead with one bar of signal. Everything a
// route needs — the line itself, the facilities found around it, the
// checkpoints, the footpath overlay — is written to IndexedDB the moment it is
// worked out, so the second opening is instant and works with the radio off.
//
// Nothing leaves the phone. There is no account and no server: the route file
// is read locally, the only outbound requests are to OpenStreetMap, the weather
// service and the map tiles, and none of them are told who is asking.

const DB_NAME = 'gowalkwalk';
const DB_VERSION = 1;
// Summary row per route (the list on the home screen) …
const ROUTES = 'routes';
// … and the bulky parts, fetched only when a route is actually opened.
const DATA = 'data';
// The footpath overlay is the heaviest thing here and the least often wanted,
// so it lives on its own and is fetched on demand.
const TRAILS = 'trails';

const LAST_KEY = 'gww-last-route';
const PROGRESS_PREFIX = 'gww-progress-';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROUTES)) db.createObjectStore(ROUTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(TRAILS)) db.createObjectStore(TRAILS, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, stores, mode) {
  const t = db.transaction(stores, mode);
  return {
    t,
    store: name => t.objectStore(name),
    done: new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    }),
  };
}

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/**
 * A stable id for a route.
 *
 * Derived from the geometry rather than the filename, so re-exporting the same
 * walk from the same app lands on the same record and keeps its facilities and
 * its progress, while a genuinely different route gets its own. FNV-1a over a
 * fixed sample of the line: cheap, and collisions between two routes a single
 * person has saved are not a realistic concern.
 */
export function routeId(doc) {
  let h = 0x811c9dc5;
  const feed = s => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  const n = doc.points.length;
  for (let i = 0; i < 64; i++) {
    const p = doc.points[Math.floor((i / 64) * n)];
    feed(`${p[0].toFixed(5)},${p[1].toFixed(5)};`);
  }
  feed(`|${Math.round(doc.totalDistance)}|${n}`);
  return (h >>> 0).toString(36);
}

function summarise(record) {
  const { doc } = record;
  return {
    id: record.id,
    name: doc.name,
    source: doc.source,
    format: doc.format,
    totalDistance: doc.totalDistance,
    isLoop: doc.isLoop,
    bounds: doc.bounds,
    elevationGain: doc.elevation?.gain ?? null,
    pointCount: doc.points.length,
    checkpointCount: (record.checkpoints || []).length,
    facilityCount: Object.values(record.facilities || {}).reduce((n, list) => n + list.length, 0),
    placesFetchedAt: record.placesFetchedAt || null,
    createdAt: record.createdAt || Date.now(),
    lastOpenedAt: record.lastOpenedAt || Date.now(),
  };
}

/** Write a route and everything worked out about it. */
export async function saveRoute(record) {
  const db = await openDb();
  const { store, done } = tx(db, [ROUTES, DATA], 'readwrite');
  store(ROUTES).put(summarise(record));
  store(DATA).put({
    id: record.id,
    doc: record.doc,
    waypoints: record.waypoints || [],
    facilities: record.facilities || {},
    landmarks: record.landmarks || [],
    checkpoints: record.checkpoints || [],
    placesFetchedAt: record.placesFetchedAt || null,
    warnings: record.warnings || [],
  });
  await done;
  return record.id;
}

/** Update the facilities, landmarks and checkpoints of a route already saved. */
export async function savePlaces(id, places) {
  const db = await openDb();
  const { store, done } = tx(db, [ROUTES, DATA], 'readwrite');
  const data = await request(store(DATA).get(id));
  if (!data) { await done; return null; }
  Object.assign(data, places);
  store(DATA).put(data);
  const row = await request(store(ROUTES).get(id));
  if (row) {
    row.facilityCount = Object.values(data.facilities || {})
      .reduce((n, list) => n + list.length, 0);
    row.checkpointCount = (data.checkpoints || []).length;
    row.placesFetchedAt = data.placesFetchedAt || null;
    row.elevationGain = data.doc?.elevation?.gain ?? row.elevationGain;
    store(ROUTES).put(row);
  }
  await done;
  return data;
}

export async function loadRoute(id) {
  const db = await openDb();
  const { store, done } = tx(db, [ROUTES, DATA], 'readwrite');
  const data = await request(store(DATA).get(id));
  if (!data) { await done; return null; }
  const row = await request(store(ROUTES).get(id));
  if (row) {
    row.lastOpenedAt = Date.now();
    store(ROUTES).put(row);
  }
  await done;
  return data;
}

export async function listRoutes() {
  const db = await openDb();
  const { store, done } = tx(db, [ROUTES], 'readonly');
  const rows = await request(store(ROUTES).getAll());
  await done;
  return rows.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0));
}

export async function deleteRoute(id) {
  const db = await openDb();
  const { store, done } = tx(db, [ROUTES, DATA, TRAILS], 'readwrite');
  store(ROUTES).delete(id);
  store(DATA).delete(id);
  store(TRAILS).delete(id);
  await done;
  try {
    localStorage.removeItem(PROGRESS_PREFIX + id);
    if (lastRouteId() === id) localStorage.removeItem(LAST_KEY);
  } catch { /* private mode */ }
}

export async function saveTrails(id, trails) {
  const db = await openDb();
  const { store, done } = tx(db, [TRAILS], 'readwrite');
  store(TRAILS).put({ id, ...trails });
  await done;
}

export async function loadTrails(id) {
  const db = await openDb();
  const { store, done } = tx(db, [TRAILS], 'readonly');
  const rec = await request(store(TRAILS).get(id));
  await done;
  return rec || null;
}

/** How much of the device's storage budget the saved routes are using. */
export async function storageUse() {
  if (!navigator.storage?.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}

// ── the small stuff, which localStorage does better ──────────────────

export function lastRouteId() {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

export function setLastRouteId(id) {
  try {
    if (id) localStorage.setItem(LAST_KEY, id);
    else localStorage.removeItem(LAST_KEY);
  } catch { /* private mode: the app just opens on the route list */ }
}

export function progressKey(id) {
  return PROGRESS_PREFIX + id;
}
