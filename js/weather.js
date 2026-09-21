// Weather and air quality for the route.
//
// The reference app read NEA's Singapore feeds, which are the best data there
// is for a walk in Singapore: a nowcast per forecast area, live station
// readings and the national PSI. An uploaded route can be anywhere, so there
// are two providers behind one model:
//
//   NEA (data.gov.sg)   used when the route is in Singapore — area nowcast,
//                       station observations, PSI, PM2.5, UV
//   Open-Meteo          everywhere else — hourly forecast from the national
//                       weather service for the region, plus its air-quality
//                       API for PM2.5 and the regional AQI
//
// Both are open, keyless and CORS-enabled, and both are reduced to the same
// model so nothing downstream has to know which one answered. If NEA fails on
// a Singapore route, Open-Meteo answers instead rather than leaving the card
// blank.

import { haversine } from './geo.js';

const NEA_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
const OM_AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const CACHE_KEY = 'gww-wx-cache-v1';
const CACHE_MAX_AGE = 30 * 60 * 1000;   // show stale data for up to 30 min offline

// Singapore, with enough margin for a route that runs to the shoreline.
const SG_BOUNDS = { minLat: 1.13, maxLat: 1.50, minLon: 103.58, maxLon: 104.12 };

export function inSingapore(lat, lon) {
  return lat >= SG_BOUNDS.minLat && lat <= SG_BOUNDS.maxLat
    && lon >= SG_BOUNDS.minLon && lon <= SG_BOUNDS.maxLon;
}

// Forecast codes that mean lightning is possible, heavy rain, or rain at all.
// The Open-Meteo path maps WMO codes onto this same vocabulary, so the risk
// rules below are written once.
const STORM_CODES = new Set(['TL', 'HT', 'HG']);
const HEAVY_CODES = new Set(['HR', 'HS', 'SR', 'SK']);
const WET_CODES = new Set(['RA', 'SH', 'PS', 'LS', 'LR', 'DR', 'WR', 'WS']);

/** NEA forecast wording → the icon code used by the 24-hour forecast API. */
function codeFromText(text = '') {
  const t = text.toLowerCase();
  if (t.includes('gusty')) return 'HG';
  if (t.includes('heavy thundery')) return 'HT';
  if (t.includes('thundery')) return 'TL';
  if (t.includes('heavy rain')) return 'HR';
  if (t.includes('heavy showers')) return 'HS';
  if (t.includes('moderate rain')) return 'RA';
  if (t.includes('light rain')) return 'LR';
  if (t.includes('light showers')) return 'LS';
  if (t.includes('passing showers')) return 'PS';
  if (t.includes('showers')) return 'SH';
  if (t.includes('drizzle')) return 'DR';
  if (t.includes('rain')) return 'RA';
  if (t.includes('slightly hazy')) return 'LH';
  if (t.includes('hazy') || t.includes('haze')) return 'HZ';
  if (t.includes('mist')) return 'BR';
  if (t.includes('fog')) return 'FG';
  if (t.includes('windy')) return 'WD';
  if (t.includes('strong winds')) return 'SW';
  if (t.includes('overcast')) return 'OC';
  if (t.includes('cloudy') && t.includes('partly')) return t.includes('night') ? 'PN' : 'PC';
  if (t.includes('cloudy')) return 'CL';
  if (t.includes('fair') || t.includes('sunny')) return t.includes('night') ? 'FN' : 'FA';
  return 'CL';
}

/**
 * WMO weather code → the same icon vocabulary, plus wording.
 *
 * Snow and freezing rain have no NEA equivalent, so they borrow the nearest
 * glyph and say plainly what they are in the text — a walker in the Alps needs
 * the words more than the picture.
 */
const WMO = {
  0: ['FA', 'Clear'],
  1: ['FA', 'Mainly clear'],
  2: ['PC', 'Partly cloudy'],
  3: ['OC', 'Overcast'],
  45: ['FG', 'Fog'],
  48: ['FG', 'Freezing fog'],
  51: ['DR', 'Light drizzle'],
  53: ['DR', 'Drizzle'],
  55: ['LR', 'Heavy drizzle'],
  56: ['DR', 'Freezing drizzle'],
  57: ['LR', 'Freezing drizzle'],
  61: ['LR', 'Light rain'],
  63: ['RA', 'Rain'],
  65: ['HR', 'Heavy rain'],
  66: ['RA', 'Freezing rain'],
  67: ['HR', 'Heavy freezing rain'],
  71: ['LS', 'Light snow'],
  73: ['SH', 'Snow'],
  75: ['HS', 'Heavy snow'],
  77: ['LS', 'Snow grains'],
  80: ['LS', 'Light showers'],
  81: ['SH', 'Showers'],
  82: ['HS', 'Violent showers'],
  85: ['LS', 'Snow showers'],
  86: ['HS', 'Heavy snow showers'],
  95: ['TL', 'Thunderstorm'],
  96: ['HT', 'Thunderstorm with hail'],
  99: ['HG', 'Severe thunderstorm with hail'],
};

function fromWmo(code, isNight = false) {
  const [icon, text] = WMO[code] || ['CL', 'Cloudy'];
  if (isNight && icon === 'FA') return ['FN', text];
  if (isNight && icon === 'PC') return ['PN', text];
  return [icon, text];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Fetch one JSON feed, retrying a couple of times. */
async function getJSON(url, signal, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(400 * i);
    try {
      const res = await fetch(url, { signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Run jobs a few at a time rather than all at once.
 *
 * Firing every NEA feed simultaneously drops roughly one request in six — not
 * an HTTP error but a connection-level failure from too many requests to one
 * host at once.
 */
async function runPooled(jobs, limit = 3) {
  const results = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ── air quality bands ────────────────────────────────────────────────
export function psiBand(psi) {
  if (psi == null) return null;
  if (psi <= 50) return { label: 'Good', level: 'ok' };
  if (psi <= 100) return { label: 'Moderate', level: 'warn' };
  if (psi <= 200) return { label: 'Unhealthy', level: 'severe' };
  if (psi <= 300) return { label: 'Very unhealthy', level: 'severe' };
  return { label: 'Hazardous', level: 'severe' };
}

/**
 * PM2.5 bands.
 *
 * NEA's own 1-hour PM2.5 bands are far wider than the WHO guidance the rest of
 * the world reports against, so the scale follows whichever number is on
 * screen: NEA's for a Singapore route, the European AQI breakpoints elsewhere.
 */
export function pm25Band(pm, scale = 'nea') {
  if (pm == null) return null;
  if (scale === 'nea') {
    if (pm <= 55) return { label: 'Normal', level: 'ok' };
    if (pm <= 150) return { label: 'Elevated', level: 'warn' };
    if (pm <= 250) return { label: 'High', level: 'severe' };
    return { label: 'Very high', level: 'severe' };
  }
  if (pm <= 10) return { label: 'Good', level: 'ok' };
  if (pm <= 20) return { label: 'Fair', level: 'ok' };
  if (pm <= 25) return { label: 'Moderate', level: 'warn' };
  if (pm <= 50) return { label: 'Poor', level: 'warn' };
  if (pm <= 75) return { label: 'Very poor', level: 'severe' };
  return { label: 'Extremely poor', level: 'severe' };
}

export function uvBand(uv) {
  if (uv == null) return null;
  if (uv <= 2) return { label: 'Low', level: 'ok' };
  if (uv <= 5) return { label: 'Moderate', level: 'ok' };
  if (uv <= 7) return { label: 'High', level: 'warn' };
  if (uv <= 10) return { label: 'Very high', level: 'warn' };
  return { label: 'Extreme', level: 'severe' };
}

/** European AQI, the scale Open-Meteo reports for every region it covers. */
export function aqiBand(aqi) {
  if (aqi == null) return null;
  if (aqi <= 20) return { label: 'Good', level: 'ok' };
  if (aqi <= 40) return { label: 'Fair', level: 'ok' };
  if (aqi <= 60) return { label: 'Moderate', level: 'warn' };
  if (aqi <= 80) return { label: 'Poor', level: 'warn' };
  if (aqi <= 100) return { label: 'Very poor', level: 'severe' };
  return { label: 'Extremely poor', level: 'severe' };
}

/**
 * Turn the forecast and air-quality readings into a single walk-safety verdict.
 *
 * Lightning outranks everything: on an exposed ridge, a boardwalk or an
 * observation tower it is the one hazard that kills, so a thunderstorm code
 * anywhere in the next two hours is surfaced as severe.
 */
function assessRisk(nowCode, slots, air, now) {
  const alerts = [];
  const soon = slots.filter(s => s.hoursAhead <= 2).map(s => s.code);
  const later = slots.filter(s => s.hoursAhead > 2).map(s => s.code);

  if (STORM_CODES.has(nowCode) || soon.some(c => STORM_CODES.has(c))) {
    alerts.push({ level: 'severe', text: 'Lightning risk — thunderstorms now or within 2 h', key: 'storm' });
  } else if (later.some(c => STORM_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Thunderstorms forecast later today', key: 'storm-later' });
  }

  if (HEAVY_CODES.has(nowCode)) {
    alerts.push({ level: 'severe', text: 'Heavy rain — the path will be slippery', key: 'heavy' });
  } else if (soon.some(c => HEAVY_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Heavy rain expected within 2 h', key: 'heavy-soon' });
  } else if (WET_CODES.has(nowCode) || soon.some(c => WET_CODES.has(c))) {
    alerts.push({ level: 'warn', text: 'Showers about — expect a wet underfoot', key: 'wet' });
  }

  const pb = psiBand(air.psi);
  if (pb && pb.level !== 'ok') {
    alerts.push({ level: pb.level, text: `Haze — PSI ${air.psi} (${pb.label.toLowerCase()})`, key: 'psi' });
  }
  const mb = pm25Band(air.pm25, air.scale);
  if (mb && mb.level === 'severe') {
    alerts.push({ level: 'severe', text: `PM2.5 ${air.pm25} µg/m³ (${mb.label.toLowerCase()})`, key: 'pm25' });
  } else if (air.psi == null && mb && mb.level === 'warn') {
    alerts.push({ level: 'warn', text: `Air quality ${mb.label.toLowerCase()} — PM2.5 ${air.pm25} µg/m³`, key: 'pm25' });
  }
  const ub = uvBand(air.uv);
  if (ub && ub.level !== 'ok') {
    alerts.push({ level: ub.level, text: `UV index ${air.uv} (${ub.label.toLowerCase()})`, key: 'uv' });
  }

  // Heat and cold. A route file can land anywhere, and the hazard at the two
  // ends of the thermometer is as real as the rain: the apparent temperature
  // is what the walker's body deals with, so it is what gets judged.
  const feels = now.feelsLikeC ?? now.tempC;
  if (feels != null) {
    if (feels >= 40) alerts.push({ level: 'severe', text: `Dangerous heat — feels like ${Math.round(feels)}°C`, key: 'heat' });
    else if (feels >= 33) alerts.push({ level: 'warn', text: `Hot — feels like ${Math.round(feels)}°C, carry water`, key: 'heat' });
    else if (feels <= -5) alerts.push({ level: 'severe', text: `Severe cold — feels like ${Math.round(feels)}°C`, key: 'cold' });
    else if (feels <= 2) alerts.push({ level: 'warn', text: `Near freezing — feels like ${Math.round(feels)}°C`, key: 'cold' });
  }

  const level = alerts.some(a => a.level === 'severe') ? 'severe'
    : alerts.length ? 'warn' : 'ok';
  alerts.sort((a, b) => (b.level === 'severe') - (a.level === 'severe'));
  return { level, alerts };
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.fetchedAt > CACHE_MAX_AGE) return null;
    return cached;
  } catch { return null; }
}

function writeCache(model) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(model)); } catch { /* quota / private mode */ }
}

/**
 * Build the weather + air-quality model for the route.
 *
 * @param {{lat:number, lon:number}} at       where to read conditions (walker, or route centre)
 * @param {Array<[number,number]>}   samples  points along the route, for area coverage
 */
export async function loadWeather(at, samples, { signal } = {}) {
  if (inSingapore(at.lat, at.lon)) {
    try {
      return await loadNea(at, samples, { signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('NEA unavailable, falling back to Open-Meteo', err);
    }
  }
  return loadOpenMeteo(at, { signal });
}

// ── Open-Meteo: anywhere ─────────────────────────────────────────────
// One forecast call and one air-quality call. The forecast is the national
// weather service's own model for wherever the route is, downscaled by
// Open-Meteo, so the +2/+4/+6 h temperatures are real forecast values rather
// than the estimate the NEA path has to make.

async function loadOpenMeteo(at, { signal } = {}) {
  const coords = `latitude=${at.lat.toFixed(4)}&longitude=${at.lon.toFixed(4)}`;
  const forecastUrl = `${OM_FORECAST}?${coords}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,'
    + 'weather_code,wind_speed_10m,wind_gusts_10m,is_day'
    + '&hourly=temperature_2m,apparent_temperature,weather_code,precipitation_probability,uv_index'
    + '&daily=temperature_2m_max,temperature_2m_min,uv_index_max'
    + '&timezone=auto&forecast_days=2&wind_speed_unit=kn';
  const airUrl = `${OM_AIR}?${coords}&current=pm2_5,pm10,european_aqi,uv_index&timezone=auto`;

  const [forecast, air] = await runPooled([
    () => getJSON(forecastUrl, signal),
    () => getJSON(airUrl, signal).catch(() => null),
  ], 2);

  if (!forecast?.current) {
    const cached = readCache();
    if (cached) return { ...cached, stale: true };
    throw new Error('No weather data available');
  }

  const cur = forecast.current;
  const isNight = cur.is_day === 0;
  const [nowCode, nowText] = fromWmo(cur.weather_code, isNight);

  // The hourly arrays are local-time strings for the route's own timezone, so
  // "now" is found by matching the current hour rather than by arithmetic on a
  // timezone the phone may not be in.
  const hours = forecast.hourly?.time || [];
  const nowIso = (cur.time || '').slice(0, 13);
  let base = hours.findIndex(t => t.slice(0, 13) === nowIso);
  if (base < 0) base = 0;

  const slots = [2, 4, 6].map(h => {
    const i = Math.min(base + h, hours.length - 1);
    const code = forecast.hourly.weather_code?.[i];
    const hourOfDay = Number((hours[i] || '').slice(11, 13));
    const night = hourOfDay < 7 || hourOfDay >= 19;
    const [icon, text] = fromWmo(code, night);
    const pop = forecast.hourly.precipitation_probability?.[i];
    return {
      label: `+${h}h`,
      hoursAhead: h,
      at: hours[i] || null,
      code: icon,
      text: pop != null && pop >= 30 ? `${text} · ${pop}% rain` : text,
      tempC: forecast.hourly.temperature_2m?.[i] ?? null,
      estimated: false,
    };
  });

  const airCur = air?.current || {};
  const airModel = {
    scale: 'eu',
    psi: null,
    pm25: airCur.pm2_5 ?? null,
    pm10: airCur.pm10 ?? null,
    pm25Day: null,
    aqi: airCur.european_aqi ?? null,
    uv: round1(airCur.uv_index ?? forecast.hourly?.uv_index?.[base] ?? null),
    region: forecast.timezone_abbreviation || forecast.timezone || 'local',
    updatedAt: airCur.time || null,
    trend: null,
    stale: false,
  };

  const now = {
    code: nowCode,
    text: nowText,
    tempC: cur.temperature_2m ?? null,
    feelsLikeC: cur.apparent_temperature ?? null,
    tempStation: null,
    humidity: cur.relative_humidity_2m ?? null,
    rainfallMm: cur.precipitation ?? null,
    windKt: cur.wind_speed_10m ?? null,
    gustKt: cur.wind_gusts_10m ?? null,
    observedAt: cur.time || null,
    validPeriod: 'next hour',
    areas: [],
  };

  const model = {
    provider: 'open-meteo',
    providerName: 'Open-Meteo',
    fetchedAt: Date.now(),
    stale: false,
    risk: assessRisk(nowCode, slots, airModel, now),
    now,
    slots,
    air: airModel,
    day: {
      low: round1(forecast.daily?.temperature_2m_min?.[0] ?? null),
      high: round1(forecast.daily?.temperature_2m_max?.[0] ?? null),
      text: '',
      region: forecast.timezone || 'local',
      validPeriod: 'today',
    },
  };
  writeCache(model);
  return model;
}

const round1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);

// ── NEA: Singapore ───────────────────────────────────────────────────

/** Value from the station nearest to (lat, lon), or null if none reported. */
function nearestReading(payload, lat, lon) {
  if (!payload) return null;
  const stations = payload.stations || [];
  const reading = (payload.readings || [])[0];
  if (!reading) return null;
  const byId = new Map(stations.map(s => [s.id, s]));
  let best = null;
  for (const entry of reading.data) {
    const station = byId.get(entry.stationId);
    if (!station || entry.value == null) continue;
    const d = haversine(lat, lon, station.location.latitude, station.location.longitude);
    if (!best || d < best.d) best = { d, value: entry.value, station: station.name };
  }
  return best && { ...best, at: reading.timestamp, unit: payload.readingUnit };
}

/** The NEA forecast areas closest to a handful of points along the route. */
function areasAlongRoute(areaMetadata, samples) {
  const picked = new Set();
  for (const [lat, lon] of samples) {
    let best = null;
    for (const a of areaMetadata) {
      const d = haversine(lat, lon, a.label_location.latitude, a.label_location.longitude);
      if (!best || d < best.d) best = { d, name: a.name };
    }
    if (best) picked.add(best.name);
  }
  return [...picked];
}

/** Singapore's five forecast regions, from a point. */
function regionFor(lat, lon) {
  if (lat > 1.38) return 'north';
  if (lat < 1.29) return 'south';
  if (lon > 103.88) return 'east';
  if (lon < 103.72) return 'west';
  return 'central';
}

/**
 * Estimate the temperature `hoursAhead` from now.
 *
 * NEA publishes a daily high/low rather than an hourly temperature forecast, so
 * this walks the current observation along a standard diurnal curve bounded by
 * that forecast range. Flagged as an estimate in the UI.
 */
function estimateTemp(nowC, hoursAhead, low, high, now = new Date()) {
  if (nowC == null) return null;
  if (low == null || high == null) return nowC;
  const sgHour = Number(now.toLocaleString('en-GB', { timeZone: 'Asia/Singapore', hour: '2-digit', hour12: false }))
    + now.getMinutes() / 60;
  // Singapore's daily minimum sits near 06:00 and the maximum near 14:00.
  const shape = h => {
    const t = ((h % 24) + 24) % 24;
    return t >= 6 && t <= 14
      ? 0.5 - 0.5 * Math.cos(((t - 6) / 8) * Math.PI)
      : 0.5 + 0.5 * Math.cos(((((t - 14) + 24) % 24) / 16) * Math.PI);
  };
  const delta = (shape(sgHour + hoursAhead) - shape(sgHour)) * (high - low);
  return Math.max(low - 1, Math.min(high + 1, nowC + delta));
}

async function loadNea(at, samples, { signal } = {}) {
  const feeds = ['two-hr-forecast', 'air-temperature', 'twenty-four-hr-forecast',
    'psi', 'pm25', 'relative-humidity', 'wind-speed', 'rainfall', 'uv'];
  const fetched = await runPooled(
    feeds.map(name => () => getJSON(`${NEA_BASE}/${name}`, signal)
      .then(body => {
        if (body.code !== 0 && body.code !== undefined && body.errorMsg) throw new Error(body.errorMsg);
        return body.data;
      })
      .catch(() => null)), 3);
  const byName = Object.fromEntries(feeds.map((n, i) => [n, fetched[i]]));
  const twoHr = byName['two-hr-forecast'];
  const dayFc = byName['twenty-four-hr-forecast'];
  const temp = byName['air-temperature'];

  if (!twoHr && !dayFc && !temp) throw new Error('No NEA data available');

  const region = regionFor(at.lat, at.lon);
  const tempNow = nearestReading(temp, at.lat, at.lon);
  const humidityNow = nearestReading(byName['relative-humidity'], at.lat, at.lon);
  const rainNow = nearestReading(byName.rainfall, at.lat, at.lon);
  const windNow = nearestReading(byName['wind-speed'], at.lat, at.lon);

  // ── now: nowcast condition for the areas the route passes through ──
  const item = twoHr?.items?.[0];
  const areaNames = twoHr ? areasAlongRoute(twoHr.area_metadata, samples) : [];
  const areaForecasts = (item?.forecasts || []).filter(f => areaNames.includes(f.area));
  // worst (wettest) condition wins, so the card warns rather than reassures
  const severity = c => ['FA', 'SU', 'FN', 'PC', 'PN', 'CL', 'OC', 'BR', 'FG', 'HZ', 'LH', 'WD', 'SW',
    'DR', 'LR', 'LS', 'PS', 'SH', 'RA', 'HS', 'HR', 'TL', 'HT', 'HG'].indexOf(c);
  const nowcast = areaForecasts
    .map(f => ({ area: f.area, text: f.forecast, code: codeFromText(f.forecast) }))
    .sort((a, b) => severity(b.code) - severity(a.code))[0];

  // ── future slots from the 24-hour forecast ──
  const record = dayFc?.records?.[0];
  const low = record?.general?.temperature?.low ?? null;
  const high = record?.general?.temperature?.high ?? null;

  const slots = [2, 4, 6].map(h => {
    const when = new Date(Date.now() + h * 3600 * 1000);
    const period = (record?.periods || []).find(p =>
      when >= new Date(p.timePeriod.start) && when < new Date(p.timePeriod.end));
    const regional = period?.regions?.[region];
    // within the first two hours the nowcast is the better source
    const text = (h <= 2 && nowcast?.text) || regional?.text || record?.general?.forecast?.text || '—';
    return {
      label: `+${h}h`,
      hoursAhead: h,
      at: when.toISOString(),
      code: (h <= 2 && nowcast?.code) || regional?.code || codeFromText(text),
      text,
      tempC: estimateTemp(tempNow?.value ?? null, h, low, high),
      estimated: true,
    };
  });

  // ── air quality ──
  const psiReadings = byName.psi?.items?.[0]?.readings;
  const pmReadings = byName.pm25?.items?.[0]?.readings;
  const previous = readCache();
  const air = {
    scale: 'nea',
    psi: psiReadings?.psi_twenty_four_hourly?.[region] ?? null,
    pm25: pmReadings?.pm25_one_hourly?.[region] ?? null,
    pm25Day: psiReadings?.pm25_twenty_four_hourly?.[region] ?? null,
    pm10: null,
    aqi: null,
    uv: byName.uv?.records?.[0]?.index?.[0]?.value ?? null,
    region,
    updatedAt: byName.psi?.items?.[0]?.updatedTimestamp
      || byName.pm25?.items?.[0]?.updatedTimestamp || null,
  };

  // Any one feed can fail on its own (a transient 5xx answers without CORS
  // headers, and coverage on the trail is patchy). Rather than blanking the
  // tile, fall back to the last good reading and say how old it is.
  let airStale = false;
  if (previous?.air && previous.provider === 'nea') {
    for (const key of ['psi', 'pm25', 'pm25Day', 'uv']) {
      if (air[key] == null && previous.air[key] != null) {
        air[key] = previous.air[key];
        airStale = true;
      }
    }
    if (!air.updatedAt) air.updatedAt = previous.air.updatedAt;
  }
  air.stale = airStale;

  // NEA publishes no PSI/PM2.5 forecast feed. Comparing the 1-hour PM2.5
  // against its own 24-hour average is the honest short-range signal: above it
  // the air is getting worse right now, below it the haze is clearing.
  if (air.pm25 != null && air.pm25Day != null) {
    const diff = air.pm25 - air.pm25Day;
    air.trend = Math.abs(diff) < 4 ? 'steady' : diff > 0 ? 'rising' : 'easing';
  } else {
    air.trend = null;
  }

  const nowCode = nowcast?.code || codeFromText(record?.general?.forecast?.text || '');
  const now = {
    code: nowCode,
    text: nowcast?.text || record?.general?.forecast?.text || 'No nowcast',
    tempC: tempNow?.value ?? null,
    feelsLikeC: heatIndex(tempNow?.value ?? null, humidityNow?.value ?? null),
    tempStation: tempNow?.station || null,
    humidity: humidityNow?.value ?? null,
    rainfallMm: rainNow?.value ?? null,
    windKt: windNow?.value ?? null,
    gustKt: null,
    observedAt: tempNow?.at || item?.timestamp || null,
    validPeriod: item?.valid_period?.text || '',
    areas: areaNames,
  };
  // a station feed that failed on its own keeps its last good value, so the
  // temperature never falls back to a dash while everything else is fine
  if (previous?.now && previous.provider === 'nea') {
    for (const key of ['tempC', 'humidity', 'windKt']) {
      if (now[key] == null && previous.now[key] != null) {
        now[key] = previous.now[key];
        now.carried = true;
      }
    }
    if (now.observedAt == null) now.observedAt = previous.now.observedAt;
  }

  const model = {
    provider: 'nea',
    providerName: 'NEA Singapore',
    fetchedAt: Date.now(),
    stale: false,
    risk: assessRisk(nowCode, slots, air, now),
    now,
    slots,
    air,
    day: {
      low, high,
      text: record?.general?.forecast?.text || '',
      region,
      validPeriod: record?.general?.validPeriod?.text || '',
    },
  };
  writeCache(model);
  return model;
}

/**
 * Apparent temperature in the heat, Rothfusz's formula.
 *
 * NEA reports temperature and humidity but no apparent temperature, and in a
 * tropical afternoon the difference between the two is the whole story: 32 °C
 * at 80% humidity is what a walker feels as 41 °C. Below 27 °C the formula does
 * not apply and the air temperature is the honest answer.
 */
function heatIndex(tempC, rh) {
  if (tempC == null || rh == null) return tempC;
  if (tempC < 27) return tempC;
  const t = tempC * 9 / 5 + 32;
  const hi = -42.379 + 2.04901523 * t + 10.14333127 * rh
    - 0.22475541 * t * rh - 0.00683783 * t * t - 0.05481717 * rh * rh
    + 0.00122874 * t * t * rh + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;
  return Math.round(((hi - 32) * 5 / 9) * 10) / 10;
}

export { readCache as cachedWeather };
