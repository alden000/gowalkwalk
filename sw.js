// Service worker: makes the app usable out on the trail, where coverage drops
// out.
//
//   app shell        precached, served cache-first
//   map tiles        network first on a 1.5 s deadline, then the saved map,
//                    then the browsing cache
//   live data        network-only: the forecast, the OpenStreetMap search and
//                    the elevation lookup all have their own copies on the
//                    device (localStorage and IndexedDB), and a stale cached
//                    answer masquerading as a fresh one would be worse than no
//                    answer at all
//
// The routes themselves are not here. They live in IndexedDB, written as they
// are imported, which is what makes a route usable offline — not this cache.

const VERSION = 'v2';
const SHELL_CACHE = `gww-shell-${VERSION}`;
const TILE_CACHE = `gww-tiles-${VERSION}`;
const MAX_TILES = 1200;

// Tiles the walker deliberately saved for the trail, kept apart from the ones
// cached in passing. Two reasons: the browsing cache is trimmed oldest-first,
// so a saved map would be the first thing evicted by an afternoon of panning
// about; and the name carries no VERSION, so shipping an app update does not
// throw away a map somebody downloaded on wi-fi the night before.
const OFFLINE_CACHE = 'gww-offline';
// enough parallel requests to keep the link busy without hammering the servers
const SAVE_CONCURRENCY = 6;
// A save is a couple of thousand requests over a few minutes, usually on mobile
// data. Both things that go wrong mid-save — a carrier blip and a tile server
// deciding the rate is too high — are temporary, so a request that fails is
// retried rather than leaving a hole in the pack that nobody discovers until
// they are standing on the trail with no signal.
const SAVE_RETRIES = 3;
const SAVE_BLIP_MS = 700;         // a dropped connection: come back quickly
const SAVE_THROTTLE_MS = 2000;    // a 429: the server wants a real pause
const SAVE_MAX_WAIT_MS = 20000;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const THROTTLE_STATUS = new Set([429, 503]);
// If a server keeps turning us away, grinding through the remaining couple of
// thousand tiles would be both useless and rude, so the save stops and says so.
const THROTTLE_GIVE_UP = 12;
// how long a tile fetch may take before a cached copy is served instead
const TILE_NET_TIMEOUT_MS = 1500;

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/basemaps.js',
  'js/checkpoints.js',
  'js/elevation.js',
  'js/geo.js',
  'js/icons.js',
  'js/net.js',
  'js/overpass.js',
  'js/routefile.js',
  'js/store.js',
  'js/weather.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/markercluster.js',
  'vendor/markercluster.css',
  'vendor/marker-shadow.png',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

// Every host the base maps fetch tiles from. OpenTopoMap is served from three
// subdomains, so this is matched as a suffix rather than by equality.
const TILE_HOSTS = [
  'server.arcgisonline.com',
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'www.onemap.gov.sg',
];

const isTileHost = host => TILE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));

// Live data that must never be served from a cache. Overpass answers are kept
// in IndexedDB by the app itself, the forecast keeps its own timestamped copy,
// and both would be actively misleading if a cached response came back looking
// current.
const LIVE_HOSTS = [
  'data.gov.sg',
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // one failing entry must not abort the whole install
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(err => console.warn('precache', url, err))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, TILE_CACHE, OFFLINE_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // never cache the live feeds
  if (LIVE_HOSTS.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`))) return;

  if (isTileHost(url.hostname)) {
    event.respondWith(tile(event));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(shellFirst(request));
  }
});

/** Cache-first for the shell, with a background refresh so updates land. */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then(res => {
      if (res.ok) cache.put(request, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;          // the background refresh above updates the cache
  const res = await network;
  if (res) return res;

  // navigations fall back to the app shell so the PWA still opens offline
  if (request.mode === 'navigate') {
    const shell = await cache.match('index.html');
    if (shell) return shell;
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

/**
 * Tiles: the live map wins where there is signal, the saved one where there is
 * not.
 *
 * Network first, but on a deadline. Plain network-first is fine when the
 * network is either working or plainly gone — both answer quickly. A forest or a
 * valley gives neither: a bar of signal under canopy leaves a request hanging for
 * half a minute before it fails, and waiting that out for every tile while a
 * perfect copy sits on the device would make the map feel broken exactly where
 * it is needed most. So the fetch races a short timer, and a cached tile is
 * served the moment the network looks slow. The fetch is not abandoned — it
 * runs on under waitUntil and refreshes the cache for next time.
 */
async function tile(event) {
  const request = event.request;
  // The tile layers set crossOrigin, so tile requests are CORS requests, and an
  // opaque response cannot answer one: the browser rejects it and the tile
  // renders black. A cached opaque tile therefore counts as a miss and is
  // fetched again, rather than being handed back for ever. Every tile cached by
  // a build from before crossOrigin was set is opaque, which turned the whole
  // map black on the next start for anyone who had used the app already.
  const wantsCors = request.mode === 'cors';
  const usable = res => !!res && !(wantsCors && res.type === 'opaque');

  const saved = await caches.open(OFFLINE_CACHE);
  const cache = await caches.open(TILE_CACHE);
  // the deliberately saved map is the better fallback, so it is checked first
  let fallback = await saved.match(request);
  if (!usable(fallback)) fallback = await cache.match(request);
  if (!usable(fallback)) fallback = null;

  const network = fetch(request)
    .then(res => {
      // Only responses this app can actually use again are kept. Storing an
      // opaque one poisons the cache for the next load, and Cache Storage pads
      // it by megabytes into the bargain — see saveTiles(). The saved pack is
      // left alone: it is a snapshot the walker asked for, not a scratch area.
      if (res.ok) {
        // a full tile cache must not break tile loading
        cache.put(request, res.clone()).then(() => trimTiles(cache)).catch(() => {});
      }
      return res;
    })
    .catch(() => null);

  if (!fallback) {
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'Tile unavailable' });
  }

  event.waitUntil(network);          // keep refreshing even once we answer
  const raced = await Promise.race([
    network,
    new Promise(resolve => setTimeout(() => resolve(null), TILE_NET_TIMEOUT_MS)),
  ]);
  return usable(raced) && raced.ok ? raced : fallback;
}

// ── saving a map for the trail ───────────────────────────────────────
// The page works out which tiles the route needs and sends the list here. The
// worker does the fetching because its own fetch() does not pass through the
// fetch handler above, so nothing lands in the browsing cache as a side effect
// and gets counted twice.

// Set by a cancel message. On a poor connection a save is minutes of work, and
// a walker who started one by mistake at the trailhead needs a way out of it.
let saveCancelled = false;

self.addEventListener('message', event => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === 'save-tiles') event.waitUntil(saveTiles(msg.urls || [], event.source));
  if (msg.type === 'cancel-save') saveCancelled = true;
  if (msg.type === 'forget-tiles') event.waitUntil(forgetTiles(msg.urls || [], event.source));
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// When a server throttles us it is telling the whole save to slow down, not
// just the one worker that happened to get the 429. Holding the pause here,
// shared, means all six back off together and the pressure actually drops —
// six independent backoffs would keep five workers hammering regardless.
let throttledUntil = 0;

// Retry-After would be the polite thing to obey, and it is read here in case a
// provider ever permits it, but in practice it is invisible: it is not a
// CORS-safelisted response header, so script cannot see it cross-origin unless
// the server sends Access-Control-Expose-Headers, and none of the three tile
// hosts does. Measured, all three: no expose header, so the value reads null.
// The doubling below is therefore what actually paces a throttled save.
function backoffMs(res, attempt, throttled) {
  const header = res && res.headers.get('Retry-After');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, SAVE_MAX_WAIT_MS);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), SAVE_MAX_WAIT_MS);
  }
  const base = throttled ? SAVE_THROTTLE_MS : SAVE_BLIP_MS;
  return Math.min(base * 2 ** attempt, SAVE_MAX_WAIT_MS);
}

/**
 * Fetch one tile, retrying what is worth retrying.
 * Returns { res } on success, or { res: null, throttled } when it gave up.
 */
async function fetchTile(req) {
  for (let attempt = 0; ; attempt++) {
    const hold = throttledUntil - Date.now();
    if (hold > 0) await sleep(hold);
    if (saveCancelled) return { res: null, throttled: false };

    let res = null;
    try {
      res = await fetch(req);
    } catch {
      // offline for a moment, DNS hiccup, connection reset: worth another go
    }
    if (res && res.ok) return { res };

    const throttled = !!res && THROTTLE_STATUS.has(res.status);
    // a 404 or a 403 will say the same thing however often it is asked
    if (res && !RETRY_STATUS.has(res.status)) return { res: null, throttled: false };
    if (attempt >= SAVE_RETRIES) return { res: null, throttled };

    const wait = backoffMs(res, attempt, throttled);
    // A throttle is aimed at the whole save, so the pause is shared and every
    // worker observes it; a one-off blip only delays the worker that saw it.
    if (throttled) throttledUntil = Math.max(throttledUntil, Date.now() + wait);
    else await sleep(wait);
  }
}

async function saveTiles(urls, client) {
  const cache = await caches.open(OFFLINE_CACHE);
  const total = urls.length;
  let done = 0, saved = 0, failed = 0, quota = false, blocked = false;
  let throttleStreak = 0;
  saveCancelled = false;
  throttledUntil = 0;

  const post = extra => client && client.postMessage(
    { type: 'save-progress', done, total, saved, failed, quota, blocked, ...extra });

  let next = 0;
  async function worker() {
    while (next < total && !quota && !blocked && !saveCancelled) {
      const url = urls[next++];
      const req = new Request(url);      // CORS, deliberately — see below
      try {
        if (await cache.match(req)) {
          saved++;                       // already held from an earlier save
        } else {
          // Fetched as CORS rather than no-cors, which matters far more than it
          // looks. An opaque response is padded in Cache Storage accounting so
          // its true size cannot be probed cross-origin, and Chrome's padding is
          // about 7 MB per response: saving this route opaquely charged 1 GB of
          // quota for 3 MB of tiles and died part-way through. All three tile
          // hosts send Access-Control-Allow-Origin, so a CORS response is
          // readable, is accounted at its real size, and still renders for the
          // plain <img> requests Leaflet makes, because a cache entry is keyed
          // on URL and not on the mode it was fetched with.
          const { res, throttled } = await fetchTile(req);
          if (res) {
            await cache.put(req, res);
            saved++;
            throttleStreak = 0;
          } else {
            failed++;
            if (throttled) { if (++throttleStreak >= THROTTLE_GIVE_UP) blocked = true; }
            else throttleStreak = 0;
          }
        }
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') quota = true;
        failed++;
      }
      done++;
      if (done % 5 === 0 || done === total) post();
    }
  }

  await Promise.all(Array.from({ length: SAVE_CONCURRENCY }, worker));
  post({ finished: true, cancelled: saveCancelled });
  saveCancelled = false;
}

async function forgetTiles(urls, client) {
  const cache = await caches.open(OFFLINE_CACHE);
  if (urls.length) {
    for (const url of urls) await cache.delete(url);
  } else {
    await caches.delete(OFFLINE_CACHE);   // no list: drop the lot
  }
  if (client) client.postMessage({ type: 'save-progress', done: 0, total: 0, saved: 0, failed: 0, finished: true, cleared: true });
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      // oldest first — Cache Storage preserves insertion order
      for (const key of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(key);
    }
  } finally {
    trimming = false;
  }
}
