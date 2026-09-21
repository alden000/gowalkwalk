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

// A genuine 256x256 tile: the size the servers actually return, so a
// sharpness measurement has something real to measure.
const PNG = fixtures.tilePng(256);

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
let hungCalls = 0;
let hangingMirrors = [];
let emptyResults = false;
let weatherProvider = null;

async function stub(context, { lat, lon }) {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(`http://localhost:${PORT}`)) return route.continue();

    if (url.includes('overpass')) {
      // A mirror that accepts the query and never answers — the failure mode
      // that used to leave the import card frozen on "Searching…" for ever.
      if (hangingMirrors.some(h => url.includes(h))) {
        hungCalls++;
        return new Promise(() => {});
      }
      overpassCalls++;
      const body = route.request().postData() || '';
      // a corridor OpenStreetMap simply has nothing mapped in
      if (emptyResults && !body.includes('highway')) {
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ elements: [] }) });
      }
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
    // Tiles and anything else. The CORS header matters: the tile layers set
    // crossOrigin, so a response without it is rejected by the browser and the
    // map stays blank — which silently weakens any check that looks at tiles.
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG,
      headers: { 'access-control-allow-origin': '*' } });
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
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text());
    if (process.env.DEBUG) console.log(`  [${m.type()}]`, m.text().slice(0, 200)); });

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
  check('OpenStreetMap AEDs kept alongside the register', counts.aed >= 2, JSON.stringify(counts));
  // The route sits inside the NParks reserves, so the totals above include
  // official amenities too. These assertions are about what the OpenStreetMap
  // search itself produced, so they count only what came from it.
  const osmOnly = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    return Object.fromEntries(Object.entries(rec.facilities).map(([cat, list]) =>
      [cat, list.filter(p => !p.source || p.source === 'osm').length]));
  });
  check('toilet found by the search', osmOnly.toilet === 1, JSON.stringify(osmOnly));
  check('water found by the search', osmOnly.water === 1);
  check('vending found by the search', osmOnly.vending === 1);
  check('bus shelter excluded, picnic shelter kept', osmOnly.shelter === 1);
  check('car park found by the search', osmOnly.parking === 1);

  // a checkpoint OpenStreetMap has a photograph of shows it in its popup
  const photo = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    return rec.checkpoints.find(c => c.name === 'Little Hill')?.photo || null;
  });
  check('Commons photo kept for a landmark that has one',
    photo?.src === 'https://commons.wikimedia.org/wiki/Special:FilePath/A_little_hill.jpg?width=560',
    JSON.stringify(photo));

  // ── the official SCDF register, for a route inside Singapore ──
  const reg = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    const aed = rec.facilities.aed || [];
    return {
      total: aed.length,
      scdf: aed.filter(a => a.source === 'scdf').length,
      osm: aed.filter(a => a.source !== 'scdf').length,
      withHours: aed.filter(a => Array.isArray(a.hoursWeek)).length,
      sample: aed.filter(a => a.source === 'scdf')[0] || null,
    };
  });
  check('SCDF AEDs are merged in for a Singapore route', reg.scdf > 10,
    `${reg.scdf} from SCDF, ${reg.osm} from OSM`);
  check('the register brings opening hours', reg.withHours >= reg.scdf,
    `${reg.withHours} of ${reg.total} have hours`);
  check('a register AED carries where to find it',
    !!reg.sample && !!reg.sample.name && typeof reg.sample.detail === 'string',
    JSON.stringify(reg.sample));
  // a route saved before the register was refreshed picks the new AEDs up on
  // its own, which is what makes a scheduled data update worth having
  check('a saved route re-derives its official data when reopened', await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const id = m.lastRouteId();
    const rec = await m.loadRoute(id);
    const osmOnly = (rec.facilities.aed || []).filter(a => a.source !== 'scdf');
    await m.savePlaces(id, { facilities: { ...rec.facilities, aed: osmOnly } });
    const stripped = await m.loadRoute(id);
    if ((stripped.facilities.aed || []).some(a => a.source === 'scdf')) return false;
    // reopen the route the way the button does
    document.querySelector('#btn-home').click();
    await new Promise(r => setTimeout(r, 900));
    document.querySelector('#routes .route-open').click();
    await new Promise(r => setTimeout(r, 2500));
    const after = await m.loadRoute(m.lastRouteId());
    return (after.facilities.aed || []).filter(a => a.source === 'scdf').length > 10;
  }));

  const park = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    const all = Object.entries(rec.facilities).flatMap(([cat, list]) =>
      list.filter(p => p.source === 'nparks').map(p => `${cat}:${p.name}`));
    return { n: all.length, sample: all.slice(0, 4),
      landmarks: (rec.landmarks || []).filter(l => l.source === 'nparks').map(l => l.name).slice(0, 4) };
  });
  check('NParks amenities are merged in for a route in the reserves',
    park.n > 5, `${park.n}: ${park.sample.join(', ')}`);
  check('NParks landmarks come through too',
    park.landmarks.length > 0, park.landmarks.join(', '));
  check('the layers panel credits NParks',
    /National Parks Board/.test(await page.textContent('#poi-note')),
    (await page.textContent('#poi-note')).slice(-90));

  check('the layers panel credits SCDF',
    /Singapore Civil Defence Force/.test(await page.textContent('#poi-note')),
    (await page.textContent('#poi-note')).slice(-70));

  const cps = await page.evaluate(() => document.querySelectorAll('#bar-ticks i').length);
  check('landmarks became checkpoints', cps === 4, `${cps} intermediate checkpoints`);

  // ── trails on demand ──
  // the AED re-derivation check above went home and back, which closes the
  // layers drawer the earlier checks had left open
  if (await page.isHidden('#layers')) await page.click('#btn-layers');
  await page.waitForSelector('#chk-trails');
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
  check('the nearest-help rows stay inside the card',
    await page.evaluate(() => {
      const panel = document.querySelector('#sos').getBoundingClientRect();
      return [...document.querySelectorAll('#sos-near li')].every(li => {
        const r = li.getBoundingClientRect();
        return r.right <= panel.right + 1 && r.left >= panel.left - 1;
      });
    }),
    await page.evaluate(() => {
      const panel = document.querySelector('#sos').getBoundingClientRect();
      const li = document.querySelector('#sos-near li')?.getBoundingClientRect();
      return li ? `row ${Math.round(li.left)}–${Math.round(li.right)} in card `
        + `${Math.round(panel.left)}–${Math.round(panel.right)}` : 'no rows';
    }));
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

  // ── STB's attractions, on a route through town ──
  // The MacRitchie loop passes none of them, so this is the only route in the
  // suite that exercises the register at all.
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  await page.setInputFiles('#file', path.join(TMP, 'civic.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const stb = await page.evaluate(async () => {
    const m = await import('/js/store.js');
    const rec = await m.loadRoute(m.lastRouteId());
    const mine = (rec.landmarks || []).filter(l => l.source === 'stb');
    return {
      n: mine.length,
      names: mine.map(l => l.name),
      described: mine.filter(l => /\w\s\w/.test(l.note)).length,
      approximate: mine.filter(l => l.approximate).length,
      seo: mine.filter(l => /Singapore:|YourSingapore|Things to Do/i.test(l.name)).length,
      mojibake: mine.filter(l => /â€|â„/.test(l.name + l.note)).length,
      // the same three, under the titles STB actually publishes, are
      // "Civic District, Singapore", "The Cenotaph - a Singapore War Memorial
      // Landmark" and "Merlion Park, Singapore: Attractions & Things to Do"
      cleaned: ['Civic District', 'The Cenotaph', 'Merlion Park']
        .filter(n => mine.some(l => l.name === n)).length,
      // mojibake in reverse: the apostrophe in St Andrew's arrives as "â€™",
      // so a real one proves the repair ran rather than the string being ASCII
      curly: mine.filter(l => /[\u2018\u2019\u201c\u201d\u2013]/.test(l.name + l.note)).length,
      checkpoints: (rec.checkpoints || []).filter(c => c.source === 'stb').length,
    };
  });
  check('STB attractions are merged in for a route through town',
    stb.n > 10, `${stb.n}: ${stb.names.slice(0, 4).join(', ')}`);
  check('every attraction carries a sentence about itself',
    stb.n > 10 && stb.described === stb.n, `${stb.described} of ${stb.n}`);
  check('an attraction on the published coordinate says it is approximate',
    stb.approximate > 0 && stb.approximate < stb.n, `${stb.approximate} of ${stb.n}`);
  check('the search-engine subtitles are gone from the names',
    stb.cleaned === 3 && stb.seo === 0,
    `${stb.cleaned}/3 cleaned; leftovers: ${stb.names.filter(n => /Singapore:|Things to Do/i.test(n)).join(' | ')}`);
  check('the mojibake is gone from the names and the descriptions',
    stb.curly > 0 && stb.mojibake === 0,
    `${stb.curly} carry real typography, ${stb.mojibake} still mangled`);
  check('attractions became checkpoints', stb.checkpoints > 2,
    `${stb.checkpoints} of ${stb.n}`);
  // the pin's own caveat and its provenance, on the marker where they are read
  const pop = await page.evaluate(async () => {
    const el = [...document.querySelectorAll('.leaflet-marker-icon')]
      .find(e => /^[1-9]$/.test(e.textContent.trim()));
    el?.click();
    await new Promise(r => setTimeout(r, 500));
    return document.querySelector('.leaflet-popup-content')?.textContent || '';
  });
  check('an attraction checkpoint names the register it came from',
    /Singapore Tourism Board/.test(pop), pop.slice(0, 120));
  await page.keyboard.press('Escape');
  await page.click('#btn-layers');
  await page.waitForSelector('#route-note');
  const credit = await page.textContent('#route-note');
  check('the layers panel credits the Tourism Board',
    /Singapore Tourism Board/.test(credit), credit.slice(0, 110));
  // leave the drawer closed and the route open: the next section goes home
  await page.click('#btn-layers');

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

  // ── an AED behind a locked door is not an AED ──
  const hoursLogic = await page.evaluate(async () => {
    const { openAt, todayLabel, mergeAeds } = await import('/js/aed.js');
    const always = [[0, 1440], [0, 1440], [0, 1440], [0, 1440], [0, 1440], [0, 1440], [0, 1440]];
    const school = Array.from({ length: 7 }, () => [420, 1020]);   // 07:00-17:00
    const shut = [null, null, null, null, null, null, null];
    const overnight = Array.from({ length: 7 }, () => [1320, 300]); // 22:00-05:00
    const at = h => new Date(2026, 8, 21, h, 0);                    // a Monday
    return {
      alwaysOpen: openAt(always, at(3)),
      schoolDay: openAt(school, at(12)),
      schoolNight: openAt(school, at(21)),
      shut: openAt(shut, at(12)),
      unknown: openAt(null, at(12)),
      overnightLate: openAt(overnight, at(23)),
      overnightEarly: openAt(overnight, at(2)),
      overnightNoon: openAt(overnight, at(12)),
      label: todayLabel(school, at(12)),
      labelAlways: todayLabel(always, at(12)),
      // an OSM AED on top of a register one is the same machine
      merged: mergeAeds(
        [{ lat: 1.3, lon: 103.8, along: 0, source: 'osm' }],
        [{ lat: 1.3001, lon: 103.8, along: 0, source: 'scdf' }]).length,
      mergedApart: mergeAeds(
        [{ lat: 1.31, lon: 103.8, along: 0, source: 'osm' }],
        [{ lat: 1.30, lon: 103.8, along: 0, source: 'scdf' }]).length,
    };
  });
  check('an always-open AED reads open at 3am', hoursLogic.alwaysOpen === true);
  check('a school AED is open at noon and shut at 9pm',
    hoursLogic.schoolDay === true && hoursLogic.schoolNight === false, JSON.stringify(hoursLogic));
  check('a never-open AED reads shut', hoursLogic.shut === false);
  check('unknown hours are not treated as shut', hoursLogic.unknown === null);
  check('hours running past midnight are handled',
    hoursLogic.overnightLate === true && hoursLogic.overnightEarly === true
    && hoursLogic.overnightNoon === false, JSON.stringify(hoursLogic));
  check('the hours read as words', hoursLogic.label === '07:00–17:00 today'
    && hoursLogic.labelAlways === '24 hours', `${hoursLogic.label} / ${hoursLogic.labelAlways}`);
  check('the same AED from both sources is one pin', hoursLogic.merged === 1);
  check('two AEDs a kilometre apart stay two', hoursLogic.mergedApart === 2);

  // ── checkpoint spacing has to scale with the route ──
  // A fixed 150 m dead zone at each end is right for a 13 km event route and
  // swallows a quarter of a 1.2 km loop round a park.
  const spacing = await page.evaluate(async () => {
    const geo = await import('/js/geo.js');
    const { buildCheckpoints } = await import('/js/checkpoints.js');
    const make = (spanKm) => {
      const pts = [];
      const n = 200;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * 2 * Math.PI;
        const r = spanKm / 111 / (2 * Math.PI);
        pts.push([1.45 + r * Math.sin(a), 103.78 + r * Math.cos(a), null]);
      }
      const doc = geo.buildRouteDoc(pts, { name: `${spanKm} km` });
      // one landmark 70 m along, which is "just after the start" on a long
      // route and a quarter of the way round a short one
      const at = geo.projectOnto(doc, ...(() => {
        const p = doc.points[Math.round(doc.points.length * (70 / doc.totalDistance))];
        return [p[0], p[1]];
      })());
      const lm = [{ id: 'n1', name: 'Near the start', kind: 'Viewpoint', note: '', rank: 10,
        lat: 0, lon: 0, offset: 0, along: Math.round(at.along) }];
      return buildCheckpoints(doc, [], lm).length - 2;
    };
    return { short: make(1.2), long: make(13) };
  });
  check('a short loop keeps a landmark near its start', spacing.short === 1, JSON.stringify(spacing));
  check('a long route still clears its start and finish', spacing.long === 0, JSON.stringify(spacing));

  // ── a mirror that hangs must not hang the import ──
  // Overpass instances shed load by queueing rather than refusing, so the first
  // mirror can accept a query and simply never answer. Before the request
  // deadline existed, that left this card frozen with no way forward.
  // the junk-file check above left the app on the home screen already
  await page.waitForSelector('#home:not([hidden])');
  hangingMirrors = ['overpass-api.de'];
  hungCalls = 0;
  const hangStarted = Date.now();
  await page.setInputFiles('#file', path.join(TMP, 'hang.gpx'));
  const survived = await page.waitForSelector('body:not(.no-route)', { timeout: 60000 })
    .then(() => true).catch(() => false);
  const hangSeconds = (Date.now() - hangStarted) / 1000;
  check('a hanging mirror does not hold up a healthy one',
    survived && hangSeconds < 25,
    `${hangSeconds.toFixed(1)}s, ${hungCalls} hung request(s)`);
  check('the healthy mirror still supplies the facilities',
    await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon').length) > 3);

  // ── every mirror hanging: the card must keep moving, and Cancel must work ──
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  hangingMirrors = ['overpass-api.de', 'kumi.systems', 'private.coffee'];
  const hosts = new Set();
  await page.setInputFiles('#file', path.join(TMP, 'stuck.gpx'));
  await page.waitForSelector('#import:not([hidden])');
  for (let i = 0; i < 45; i++) {
    const note = await page.textContent('#imp-note').catch(() => '');
    const host = /asking (\S+)/.exec(note)?.[1];
    if (host) hosts.add(host);
    if (hosts.size >= 3) break;
    await page.waitForTimeout(1000);
  }
  check('all mirrors hanging: the card works through them',
    hosts.size >= 3, [...hosts].join(', '));
  check('"Open the map anyway" is offered once the file is read',
    await page.isVisible('#imp-skip'),
    `import hidden=${await page.getAttribute('#import', 'hidden') !== null}, `
    + `note=${await page.textContent('#imp-note').catch(() => '-')}, `
    + `body=${await page.getAttribute('body', 'class')}`);
  await page.click('#imp-skip');
  await page.waitForSelector('body:not(.no-route)', { timeout: 15000 });
  check('skipping the search still opens the route',
    (await page.textContent('#hud-name')) === 'Stuck probe');
  check('the route header says the facilities are missing',
    await page.isVisible('#route-alert')
    && /not searched yet/i.test(await page.textContent('#route-alert')),
    (await page.textContent('#route-alert')).replace(/\s+/g, ' ').trim());
  check('a job cannot be dismissed, only done',
    await page.evaluate(() => document.querySelector('#route-alert-dismiss').hidden));
  check('a skipped route keeps its start and finish from the file',
    await page.evaluate(async () => {
      const m = await import('/js/store.js');
      const rec = await m.loadRoute(m.lastRouteId());
      const last = rec.doc.points[rec.doc.points.length - 1];
      const finish = rec.checkpoints[rec.checkpoints.length - 1];
      // not a count: a skipped route inside the reserves still picks up the
      // official landmarks, which is the point of shipping them
      return rec.checkpoints[0].along === 0
        && finish.id === 'finish'
        && finish.lat === last[0] && finish.lon === last[1];
    }));
  hangingMirrors = [];

  // and the facilities can be filled in later, from the row itself, without
  // throwing away where the walker had got the map to
  hangingMirrors = [];
  // Drag the map somewhere deliberate first. Without this the pane transform is
  // translate3d(0,0,0) on both sides of the search and the check would pass
  // whether or not the view was thrown away.
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 - 70, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  // The map pane's transform is Leaflet's own record of where the view sits.
  const viewBefore = await page.evaluate(
    () => document.querySelector('.leaflet-map-pane').style.transform);
  check('the map was actually moved, so the next check means something',
    viewBefore !== 'translate3d(0px, 0px, 0px)', viewBefore);
  await page.click('#route-alert-go');
  await page.waitForFunction(
    () => document.querySelector('#route-alert').hidden
      || /did not answer/i.test(document.querySelector('#route-alert').textContent),
    null, { timeout: 30000 });
  await page.waitForTimeout(500);
  check('searching again from the row fills in what the skip left out',
    await page.evaluate(() => document.querySelectorAll('.leaflet-marker-icon').length) > 3);
  check('the row removes itself once the facilities are there',
    await page.evaluate(() => document.querySelector('#route-alert').hidden));
  check('re-searching does not reset the map view',
    (await page.evaluate(() => document.querySelector('.leaflet-map-pane').style.transform))
      === viewBefore, viewBefore)

  check('re-searching keeps the layers the walker had turned off', await page.evaluate(async () => {
    // turn the car parks off, search again, and see whether they stay off
    document.querySelector('#btn-layers').click();
    const box = document.querySelector('[data-layer="parking"]');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    document.querySelector('#btn-layers').click();
    document.querySelector('#route-alert-go')?.click();
    document.querySelector('#btn-refresh-pois').click();
    await new Promise(r => setTimeout(r, 2500));
    return document.querySelector('[data-layer="parking"]').checked === false;
  }));
  check('leaving the route mid-search does not break anything', await page.evaluate(async () => {
    document.querySelector('#btn-refresh-pois').click();
    document.querySelector('#btn-home').click();
    await new Promise(r => setTimeout(r, 2500));
    return !document.querySelector('#home').hidden;
  }));
  await page.waitForSelector('#routes .route-open');
  await page.click('#routes .route-open:has-text("Stuck probe")');
  await page.waitForSelector('body:not(.no-route)', { timeout: 20000 });
  await page.waitForTimeout(300);


  // ── Cancel, on a fresh file, goes back to the library ──
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  hangingMirrors = ['overpass-api.de', 'kumi.systems', 'private.coffee'];
  await page.setInputFiles('#file', path.join(TMP, 'cancel.gpx'));
  await page.waitForSelector('#import:not([hidden])');
  await page.click('#imp-cancel');
  await page.waitForSelector('#import', { state: 'hidden', timeout: 10000 });
  check('Cancel gets you out of a stuck search', await page.isVisible('#drop'));
  hangingMirrors = [];

  // ── a long route must not pay the dead mirror's timeout per chunk ──
  // Reloaded first, so the sweep starts with no memory of which mirror works —
  // otherwise this would pass without the memory ever being exercised.
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector('body:not(.no-route)', { timeout: 20000 });
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  hangingMirrors = ['overpass-api.de'];
  hungCalls = 0;
  overpassCalls = 0;
  await page.setInputFiles('#file', path.join(TMP, 'long.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 90000 });
  check('a long route needs several queries', overpassCalls >= 2, `${overpassCalls} queries`);
  check('the dead mirror is tried once, not once per chunk',
    hungCalls === 1, `${hungCalls} hung request(s) across ${overpassCalls} queries`);
  hangingMirrors = [];

  // back to a route with everything on it, for the offline check below
  await page.click('#btn-home');
  await page.waitForSelector('#routes .route-open');
  await page.click('#routes .route-open[data-id]:has-text("Test Loop")').catch(async () => {
    await page.click('#routes .route-open');
  });
  await page.waitForSelector('body:not(.no-route)', { timeout: 20000 });

  // ── nothing mapped here: a finding, said plainly, and dismissable ──
  await page.click('#btn-home');
  await page.waitForSelector('#home:not([hidden])');
  emptyResults = true;
  await page.setInputFiles('#file', path.join(TMP, 'empty.gpx'));
  await page.waitForSelector('body:not(.no-route)', { timeout: 40000 });
  await page.waitForTimeout(600);
  check('an empty result is stated, not left as a blank map',
    await page.isVisible('#route-alert')
    && /nothing mapped/i.test(await page.textContent('#route-alert')),
    (await page.textContent('#route-alert')).replace(/\s+/g, ' ').trim());
  check('the layers panel agrees about the count', await page.evaluate(async () => {
    document.querySelector('#btn-layers').click();
    return /0 facilities/.test(document.querySelector('#route-note').textContent);
  }), await page.textContent('#route-note'));
  await page.click('#btn-layers');
  check('the Singapore register does not follow a route abroad',
    await page.evaluate(async () => {
      const m = await import('/js/store.js');
      const rec = await m.loadRoute(m.lastRouteId());
      return (rec.facilities.aed || []).length === 0;
    }));
  check('information can be dismissed', await page.isVisible('#route-alert-dismiss'));
  await page.click('#route-alert-dismiss');
  await page.waitForTimeout(200);
  check('dismissing hides it', await page.evaluate(() => document.querySelector('#route-alert').hidden));
  // and it stays gone when the route is opened again
  await page.click('#btn-home');
  await page.waitForSelector('#routes .route-open');
  await page.click('#routes .route-open');
  await page.waitForSelector('body:not(.no-route)', { timeout: 20000 });
  await page.waitForTimeout(400);
  check('and stays dismissed next time the route is opened',
    await page.evaluate(() => document.querySelector('#route-alert').hidden));

  // the emergency card must say what is missing, not leave the row out
  await page.click('#btn-sos');
  await page.waitForSelector('#sos:not([hidden])');
  await page.waitForTimeout(600);
  const empties = await page.evaluate(() =>
    [...document.querySelectorAll('#sos-near li.none-row')].map(li =>
      li.querySelector('.t').textContent.replace(/\s+/g, ' ').trim()));
  check('the emergency card names every category it has nothing for',
    empties.length === 4
    && empties.some(t => t.startsWith('No AED on this route'))
    && empties.some(t => t.startsWith('No drinking water on this route'))
    && empties.every(t => /none is mapped/i.test(t)),
    empties.join(' | '));
  await page.click('#sos-close');
  emptyResults = false;

  // back to the fully-populated route, so the offline check below is testing
  // that facilities and checkpoints come back from the device — not that an
  // empty route is still empty
  await page.click('#btn-home');
  await page.waitForSelector('#routes .route-open');
  await page.click('#routes .route-open:has-text("Test Loop")');
  await page.waitForSelector('body:not(.no-route)', { timeout: 20000 });
  await page.waitForTimeout(400);

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
    // Whichever route was open last: what is being tested is that the line,
    // its facilities and its checkpoints all came back from the device.
    check('route opens with the radio off', !!offline.name && offline.markers > 3,
      JSON.stringify(offline));
    await context.setOffline(false);
  }

  // ── the map itself: sharpness and the deepest zoom ──
  // Its own context: these need a retina display, and a service worker, once it
  // takes control, serves tiles outside Playwright's routing where they cannot
  // be inspected.
  {
    const tileCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      serviceWorkers: 'block',
    });
    await stub(tileCtx, SG);
    const tilePage = await tileCtx.newPage();
    await tilePage.goto(`http://localhost:${PORT}/`);
    await tilePage.waitForSelector('#drop');
    await tilePage.setInputFiles('#file', path.join(TMP, 'loop.gpx'));
    await tilePage.waitForSelector('body:not(.no-route)', { timeout: 40000 });
    await tilePage.waitForTimeout(2500);

    const base = await tilePage.evaluate(() => ({
      active: [...document.querySelectorAll('#basemaps button')]
        .find(b => b.getAttribute('aria-checked') === 'true')?.innerText.trim(),
      first: document.querySelector('#basemaps button')?.innerText.trim(),
    }));
    check('a Singapore route opens on OneMap',
      base.active === 'OneMap (SLA)' && base.first === 'OneMap (SLA)', JSON.stringify(base));

    const sharp = await tilePage.evaluate(() => {
      const img = [...document.querySelectorAll('.leaflet-tile')].find(i => i.naturalWidth > 0);
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return { natural: img.naturalWidth, css: Math.round(r.width), dpr: devicePixelRatio };
    });
    check('tiles are fetched at the screen\u2019s real resolution',
      !!sharp && sharp.css === 128 && sharp.natural === 256,
      sharp ? `${sharp.natural}px tile drawn at ${sharp.css} CSS px, DPR ${sharp.dpr} `
        + `= ${((sharp.css * sharp.dpr) / sharp.natural).toFixed(2)} device px per tile px` : 'no tile');

    // every base map must still have tiles at the deepest zoom the map allows:
    // Leaflet clamps to maxNativeZoom before adding the retina offset, so a
    // careless setting asks for a zoom the servers do not publish
    const names = await tilePage.evaluate(() =>
      [...document.querySelectorAll('#basemaps button')].map(b => b.innerText.trim()));
    const deep = {};
    for (const name of names) {
      await tilePage.evaluate(n => [...document.querySelectorAll('#basemaps button')]
        .find(b => b.innerText.trim() === n)?.click(), name);
      await tilePage.waitForTimeout(350);
      for (let i = 0; i < 9; i++) { await tilePage.click('#btn-zoom-in'); await tilePage.waitForTimeout(90); }
      await tilePage.waitForTimeout(900);
      deep[name] = await tilePage.evaluate(() => {
        const imgs = [...document.querySelectorAll('.leaflet-tile')];
        return {
          loaded: imgs.filter(i => i.naturalWidth > 0).length,
          n: imgs.length,
          z: Number((imgs[0]?.src || '').match(/\/(\d+)\/\d+\/\d+/)?.[1] ?? -1),
        };
      });
      for (let i = 0; i < 9; i++) { await tilePage.click('#btn-zoom-out'); await tilePage.waitForTimeout(70); }
    }
    check('no base map goes blank at the deepest zoom',
      Object.values(deep).every(d => d.n > 0 && d.loaded === d.n),
      JSON.stringify(deep));
    check('no base map asks for a zoom its server does not publish',
      Object.entries(deep).every(([n, d]) => d.z <= (n === 'OpenTopoMap' ? 17 : 19)),
      Object.entries(deep).map(([n, d]) => `${n}:z${d.z}`).join(' '));
    await tileCtx.close();
  }

  const real = errors.filter(e => !/favicon|Failed to load resource|sw\.js|ServiceWorker/i.test(e));
  check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));

  await browser.close();
  await new Promise(r => server.close(r));

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
