// End-to-end test.
//
// Serves the app over HTTP, stubs every outbound call — OpenStreetMap, the two
// weather providers, the elevation lookup and the map tiles — and drives a real
// browser through the flows a walker actually uses: importing a GPX, a KML and
// a KMZ, the facilities that come back, the checkpoints built from them, the
// emergency card, progress against a fed GPS position, both weather paths, the
// route library, and a reload landing back on the route.
//
// Stubbing the network is the point. The app's own correctness is what is under
// test, not whether a public Overpass mirror happens to be up, and a test that
// hits live services fails for reasons that have nothing to do with the code.
//
//   npm --prefix test install
//   node test/e2e.js
//
// CHROME_PATH overrides the browser it drives.
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fixtures = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const TMP = fixtures.OUT;
const PORT = Number(process.env.PORT || 8099);

/** Where a Chromium this machine already has lives. */
function browserPath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  for (const dir of ['/opt/pw-browsers', path.join(process.env.HOME || '', '.cache/ms-playwright')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      candidates.push(path.join(dir, entry, 'chrome-linux/chrome'));
      candidates.push(path.join(dir, entry, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'));
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    try { candidates.push(execFileSync('which', [name], { encoding: 'utf8' }).trim()); } catch { /* not installed */ }
  }
  const found = candidates.find(c => c && fs.existsSync(c));
  if (!found) throw new Error('No Chromium found — set CHROME_PATH to one.');
  return found;
}
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// Two AEDs, a toilet, water, a vending machine, a shelter, a car park and two
// landmarks, all within the corridor of the test loop.
function overpassPayload(centreLat, centreLon) {
  const at = (dLat, dLon, tags, type = 'node', id = Math.floor(Math.random() * 1e9)) =>
    ({ type, id, lat: centreLat + dLat, lon: centreLon + dLon, tags });
  return {
    elements: [
      at(0.0055, 0.0000, { emergency: 'defibrillator', name: 'Ranger station AED', 'defibrillator:location': 'By the door' }),
      at(-0.0050, 0.0010, { amenity: 'defibrillator' }),
      at(0.0054, 0.0004, { amenity: 'toilets', fee: 'no', wheelchair: 'yes' }),
      at(0.0053, 0.0008, { amenity: 'drinking_water', bottle: 'yes' }),
      at(-0.0048, -0.0020, { amenity: 'vending_machine', vending: 'drinks', 'payment:coins': 'yes' }),
      at(0.0020, 0.0065, { amenity: 'shelter', shelter_type: 'picnic_shelter' }),
      at(0.0002, -0.0069, { amenity: 'parking', fee: 'no', capacity: '104' }),
      at(0.0056, 0.0012, { amenity: 'shelter', shelter_type: 'public_transport' }),  // must be ignored
      at(0.0000, -0.0070, { tourism: 'viewpoint', name: 'Bukit Kallang' }),
      at(-0.0055, 0.0003, { historic: 'memorial', name: 'Lim Bo Seng Memorial' }),
      at(0.0040, -0.0050, { natural: 'peak', name: 'Little Hill',
        wikimedia_commons: 'File:A little hill.jpg' }),
      at(0.0000, 0.5000, { amenity: 'toilets' }),                                     // far away: filtered out
      { type: 'way', id: 77, center: { lat: centreLat + 0.0050, lon: centreLon + 0.0025 },
        tags: { leisure: 'park', name: 'Reservoir Park' } },
    ],
  };
}

function trailsPayload(lat, lon) {
  return { elements: [{
    type: 'way', id: 1, tags: { highway: 'path', name: 'Side trail' },
    geometry: [{ lat, lon }, { lat: lat + 0.001, lon: lon + 0.001 }],
  }] };
}

const NEA_OK = { code: 0, data: {} };
let overpassCalls = 0;
let weatherProvider = null;

async function stub(context, { lat, lon }) {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(`http://localhost:${PORT}`)) return route.continue();

    if (url.includes('overpass')) {
      overpassCalls++;
      const body = route.request().postData() || '';
      const payload = body.includes('highway') ? trailsPayload(lat, lon) : overpassPayload(lat, lon);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    if (url.includes('api-open.data.gov.sg')) {
      weatherProvider = 'nea';
      const which = url.split('/api/')[1];
      const data = {
        'two-hr-forecast': { area_metadata: [{ name: 'Ang Mo Kio', label_location: { latitude: lat, longitude: lon } }],
          items: [{ timestamp: new Date().toISOString(), valid_period: { text: 'now to 2pm' },
            forecasts: [{ area: 'Ang Mo Kio', forecast: 'Thundery Showers' }] }] },
        'air-temperature': { stations: [{ id: 'S1', name: 'Test', location: { latitude: lat, longitude: lon } }],
          readings: [{ timestamp: new Date().toISOString(), data: [{ stationId: 'S1', value: 31.4 }] }], readingUnit: 'deg C' },
        'relative-humidity': { stations: [{ id: 'S1', name: 'Test', location: { latitude: lat, longitude: lon } }],
          readings: [{ timestamp: new Date().toISOString(), data: [{ stationId: 'S1', value: 82 }] }] },
        'twenty-four-hr-forecast': { records: [{ general: { temperature: { low: 26, high: 33 },
          forecast: { text: 'Thundery Showers' }, validPeriod: { text: 'today' } }, periods: [] }] },
        psi: { items: [{ updatedTimestamp: new Date().toISOString(),
          readings: { psi_twenty_four_hourly: { central: 48 }, pm25_twenty_four_hourly: { central: 12 } } }] },
        pm25: { items: [{ updatedTimestamp: new Date().toISOString(), readings: { pm25_one_hourly: { central: 18 } } }] },
        uv: { records: [{ index: [{ value: 8 }] }] },
      }[which] || {};
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...NEA_OK, data }) });
    }
    if (url.includes('air-quality-api.open-meteo')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        current: { time: '2026-09-21T10:00', pm2_5: 7.2, pm10: 12, european_aqi: 24, uv_index: 4.1 } }) });
    }
    if (url.includes('api.open-meteo.com/v1/elevation')) {
      const n = (new URL(url).searchParams.get('latitude') || '').split(',').length;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ elevation: Array.from({ length: n }, (_, i) => 400 + i * 3) }) });
    }
    if (url.includes('api.open-meteo.com')) {
      weatherProvider = 'open-meteo';
      const hours = Array.from({ length: 24 }, (_, i) => `2026-09-21T${String(i).padStart(2, '0')}:00`);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        timezone: 'Europe/Zurich', timezone_abbreviation: 'CEST',
        current: { time: '2026-09-21T10:00', temperature_2m: 9.5, relative_humidity_2m: 70,
          apparent_temperature: 7.1, precipitation: 0, weather_code: 61, wind_speed_10m: 12,
          wind_gusts_10m: 20, is_day: 1 },
        hourly: { time: hours, temperature_2m: hours.map(() => 10), apparent_temperature: hours.map(() => 8),
          weather_code: hours.map(() => 3), precipitation_probability: hours.map(() => 40),
          uv_index: hours.map(() => 3) },
        daily: { temperature_2m_max: [12], temperature_2m_min: [4], uv_index_max: [4] } }) });
    }
    // tiles and anything else
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${extra ? ` — ${extra}` : ''}`);
}

(async () => {
  await new Promise(r => server.listen(PORT, r));
  fixtures.write();
  const browser = await chromium.launch({ executablePath: browserPath(), args: ['--no-sandbox'] });

  const SG = { lat: 1.3565, lon: 103.8195 };
  const context = await browser.newContext({
    viewport: { width: 420, height: 860 },
    permissions: ['geolocation'],
    geolocation: { latitude: SG.lat + 0.0056, longitude: SG.lon },
  });
  await stub(context, SG);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('#drop');
  check('home screen opens', await page.isVisible('#drop'));

  // ── import a GPX ──
  await page.setInputFiles('#file', path.join(TMP, 'loop.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  await page.waitForTimeout(600);

  const name = await page.textContent('#hud-name');
  check('route name from the file', name === 'Test Loop', name);
  const note = await page.textContent('#hud-note');
  check('HUD note has distance, checkpoints, ascent',
    /km loop · \d+ checkpoints · \d+ m ascent/.test(note), note);

  const stats = await page.evaluate(() => ({
    left: document.querySelector('#st-left').textContent,
    markers: document.querySelectorAll('.leaflet-marker-icon').length,
    route: document.querySelectorAll('.leaflet-overlay-pane path').length,
  }));
  check('route line drawn', stats.route >= 3, `${stats.route} paths`);
  check('markers on the map', stats.markers > 3, `${stats.markers} markers`);

  const startCp = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    return rec.checkpoints[0];
  });
  check('start named by the file\u2019s own waypoint',
    startCp.name === 'Flag-off, Venus Drive' && startCp.along === 0, JSON.stringify(startCp));
  check('finish comes from the last point of the file',
    (await page.evaluate(async () => {
      const m = await import('/js/store.js');
      const rec = await m.loadRoute(m.lastRouteId());
      const last = rec.doc.points[rec.doc.points.length - 1];
      const fin = rec.checkpoints[rec.checkpoints.length - 1];
      return fin.id === 'finish' && fin.lat === last[0] && fin.lon === last[1];
    })));

  // ── layers panel: facility counts ──
  await page.click('#btn-layers');
  await page.waitForSelector('#overlays label');
  const counts = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('#overlays label')].map(l =>
      [l.querySelector('input').dataset.layer, Number(l.querySelector('.c').textContent)])));
  check('AEDs found', counts.aed === 2, JSON.stringify(counts));
  check('toilet found', counts.toilet === 1);
  check('water found', counts.water === 1);
  check('vending found', counts.vending === 1);
  check('bus shelter excluded, picnic shelter kept', counts.shelter === 1);
  check('car park found', counts.parking === 1);

  // a checkpoint OpenStreetMap has a photograph of shows it in its popup
  const photo = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    return rec.checkpoints.find(c => c.name === 'Little Hill')?.photo || null;
  });
  check('Commons photo kept for a landmark that has one',
    photo?.src === 'https://commons.wikimedia.org/wiki/Special:FilePath/A_little_hill.jpg?width=560',
    JSON.stringify(photo));

  const cps = await page.evaluate(() => document.querySelectorAll('#bar-ticks i').length);
  check('landmarks became checkpoints', cps === 4, `${cps} intermediate checkpoints`);

  // ── trails on demand ──
  await page.check('#chk-trails');
  await page.waitForFunction(
    () => ['1', 'failed'].includes(document.querySelector('#trails-c').textContent),
    null, { timeout: 20000 });
  check('trails fetched on demand', (await page.textContent('#trails-c')) === '1');
  check('trail polyline drawn',
    await page.evaluate(() => document.querySelectorAll('.leaflet-overlay-pane path').length) > 8);

  // ── SOS ──
  await page.click('#btn-layers');
  await page.click('#btn-sos');
  await page.waitForSelector('#sos:not([hidden])');
  await page.waitForTimeout(1200);
  const sos = await page.evaluate(() => ({
    calls: [...document.querySelectorAll('#sos-calls a')].map(a => a.getAttribute('href')),
    rows: document.querySelectorAll('#sos-near li').length,
    where: document.querySelector('#sos-where').textContent,
  }));
  check('Singapore emergency numbers', sos.calls.includes('tel:995'), sos.calls.join(' '));
  check('nearest help listed', sos.rows >= 4, `${sos.rows} rows`);
  check('position reported', /\d+\.\d+, \d+\.\d+/.test(sos.where), sos.where.slice(0, 60));
  check('contact form stays shut until asked for', !(await page.isVisible('#sos-form')));
  await page.click('#sos-edit');
  await page.fill('#sos-contact-name', 'Race control');
  await page.fill('#sos-contact-tel', '+65 9000 0000');
  await page.click('#sos-form button[type="submit"]');
  await page.waitForTimeout(200);
  check('own contact added at the top of the card',
    (await page.getAttribute('#sos-calls a', 'href')) === 'tel:+6590000000',
    await page.textContent('#sos-calls'));

  // ── progress from a GPS fix ──
  const progress = await page.evaluate(() => ({
    pct: document.querySelector('#st-pct').textContent,
    done: document.querySelector('#st-done').textContent,
    status: document.querySelector('#hud-status').textContent,
  }));
  check('progress tracked from the fix', progress.pct !== '0%' && progress.done !== '0m',
    JSON.stringify(progress));

  // ── weather (NEA path, with a lightning warning) ──
  await page.click('#sos-close');
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#wx-bar-txt').textContent),
    null, { timeout: 20000 });
  const wx = await page.evaluate(() => ({
    txt: document.querySelector('#wx-bar-txt').textContent,
    temp: document.querySelector('#wx-bar-temp').textContent,
    aq: document.querySelector('#wx-bar-aq').textContent,
    alert: document.querySelector('#wx-alert').textContent,
    risk: document.querySelector('#weather').dataset.risk,
  }));
  check('NEA nowcast shown', wx.txt === 'Thundery Showers', wx.txt);
  check('temperature shown', wx.temp === '31.4°C', wx.temp);
  check('PSI shown', wx.aq.includes('PSI 48'), wx.aq);
  check('lightning risk is severe', wx.risk === 'severe' && /Lightning/.test(wx.alert), wx.alert);

  // ── back to the library, and the route is remembered ──
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  await page.waitForSelector('#routes .route-open');
  const saved = await page.textContent('#routes');
  check('route saved to the library', /Test Loop/.test(saved) && /facilities/.test(saved));

  // ── a second route, in the Alps: the global weather path ──
  overpassCalls = 0;
  await page.setInputFiles('#file', path.join(TMP, 'alps.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  await page.waitForTimeout(800);
  const alps = await page.textContent('#hud-note');
  check('linear route not called a loop', !/loop/.test(alps), alps);
  check('elevation filled from the terrain API', /\d+ m ascent \(terrain\)/.test(alps)
    && !/ 0 m ascent/.test(alps), alps);
  await page.waitForFunction(() => !/Loading/.test(document.querySelector('#wx-bar-txt').textContent),
    null, { timeout: 20000 });
  const wx2 = await page.evaluate(() => ({
    txt: document.querySelector('#wx-bar-txt').textContent,
    aq: document.querySelector('#wx-bar-aq').textContent,
    note: document.querySelector('#wx-note').textContent,
  }));
  check('Open-Meteo used outside Singapore', /Open-Meteo/.test(wx2.note), wx2.note.slice(0, 80));
  check('WMO code mapped to words', wx2.txt === 'Light rain', wx2.txt);
  check('AQI shown where there is no PSI', wx2.aq.includes('AQI 24'), wx2.aq);
  await page.click('#btn-sos');
  await page.waitForTimeout(400);
  const alpineCalls = await page.evaluate(() =>
    [...document.querySelectorAll('#sos-calls a')].map(a => a.getAttribute('href')));
  check('international number outside a known region', alpineCalls.includes('tel:112'), alpineCalls.join(' '));
  await page.click('#sos-close');

  // ── KML and KMZ ──
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file', path.join(TMP, 'loop.kml'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  check('KML line read', (await page.textContent('#hud-name')) === 'Test KML');

  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file', path.join(TMP, 'loop.kmz'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  check('KMZ unzipped and read', (await page.textContent('#hud-name')) === 'Zipped route');

  // ── re-uploading a known route reuses the saved copy ──
  const before = overpassCalls;
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file', path.join(TMP, 'loop.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  await page.waitForTimeout(400);
  check('re-import reuses the saved route', overpassCalls === before, `${overpassCalls - before} extra calls`);

  // ── reload lands straight back on the route ──
  await page.reload();
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  check('reload reopens the last route', (await page.textContent('#hud-name')) === 'Test Loop');

  // ── export ──
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }).catch(() => null),
    (async () => { await page.click('#btn-layers'); await page.click('#btn-export'); })(),
  ]);
  check('GPX export offered', !!download, download ? download.suggestedFilename() : 'no download');

  // ── a file that is not a route ──
  await page.click('#btn-layers');
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  fs.writeFileSync(path.join(TMP, 'junk.gpx'), '<?xml version="1.0"?><gpx><wpt lat="1" lon="2"/></gpx>');
  await page.setInputFiles('#file', path.join(TMP, 'junk.gpx'));
  await page.waitForSelector('#home-err:not([hidden])', { timeout: 15000 });
  check('a track-less GPX is refused clearly',
    /No track or route points/.test(await page.textContent('#home-err')));

  // ── offline: the claim the whole app is built around ──
  // The service worker has to be controlling the page before this means
  // anything, so the page is reloaded once to let it take over.
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 20000 })
    .catch(() => {});
  const controlled = await page.evaluate(() => !!navigator.serviceWorker?.controller);
  check('service worker takes control', controlled);

  if (controlled) {
    await context.setOffline(true);
    await page.goto(`http://localhost:${PORT}/`).catch(() => {});
    await page.waitForSelector('body:not(.no-route)', { timeout: 20000 }).catch(() => {});
    const offline = await page.evaluate(() => ({
      name: document.querySelector('#hud-name')?.textContent,
      markers: document.querySelectorAll('.leaflet-marker-icon').length,
    }));
    check('route opens with the radio off', offline.name === 'Test Loop' && offline.markers > 3,
      JSON.stringify(offline));
    await context.setOffline(false);
  }

  const real = errors.filter(e => !/favicon|Failed to load resource|sw\.js|ServiceWorker/i.test(e));
  check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));

  await browser.close();
  await new Promise(r => server.close(r));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
