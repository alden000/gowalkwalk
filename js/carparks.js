// Where to leave the car, and whether there is room in it right now.
//
// This register comes in two halves, published separately, and they are used
// differently on purpose.
//
// **Where** — HDB's 2,272 car parks, republished monthly, shipped with the app.
// They barely move, and a walker deciding where to park should not wait for a
// download to find out that a car park exists. Positions are converted from
// SVY21 by tools/fetch_carparks.py, checked against OneMap to the centimetre.
//
// **How full** — the same authority's live feed, a minute old at most, 300 KB
// for the whole country and no way to ask about one car park. So it is never
// fetched on the walker's behalf: it is fetched when they ask, and the number
// it produces always says how old it is. A stale occupancy presented as fact
// is worse than no occupancy at all.
//
// Car parks and live availability © Housing & Development Board, via
// data.gov.sg, under the Singapore Open Data Licence.

import { projectOnto } from './geo.js';
import { MAX_OFFSET_M } from './overpass.js';
import { fetchJson } from './net.js';

const DATA_URL = 'data/carparks-sg.json';

/**
 * How far apart two HDB car parks have to be to be worth showing as two.
 *
 * This register is exhaustive where OpenStreetMap is selective: a route
 * through a housing estate passes fifty-four of them inside the usual
 * kilometre, which buries the defibrillators under a drift of parking pins.
 * Two car parks 250 m apart are a three-minute walk apart and a real choice;
 * closer than that and the walker is choosing between decks of the same
 * estate, which is not a decision the map should spend a pin on.
 */
const CROWDING_M = 250;

/** Live availability is a claim about now. Past this it is described as old. */
const STALE_MS = 15 * 60 * 1000;

const LIVE_TIMEOUT_MS = 20000;

let registerPromise = null;
let coverage = null;

function register({ signal } = {}) {
  if (!registerPromise) {
    registerPromise = fetch(DATA_URL, { signal })
      .then(res => {
        if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
        return res.json();
      })
      .catch(err => {
        registerPromise = null;
        throw err;
      });
  }
  return registerPromise;
}

/** Does this route pass any of them? */
export async function coversCarparks(bounds, { signal } = {}) {
  if (!coverage) coverage = (await register({ signal })).bounds;
  return bounds.minLat <= coverage.maxLat && bounds.maxLat >= coverage.minLat
    && bounds.minLon <= coverage.maxLon && bounds.maxLon >= coverage.minLon;
}

/** The HDB car parks along this route, nearest to the path first, thinned. */
export async function hdbCarparksAlong(doc, { signal } = {}) {
  const data = await register({ signal });
  coverage = data.bounds;
  const limit = MAX_OFFSET_M.parking;

  const near = [];
  for (const [no, lat, lon, address, type, free, night] of data.carparks) {
    const { offset, along } = projectOnto(doc, lat, lon);
    if (offset > limit) continue;
    near.push({
      id: `hdb${no}`,
      no,
      name: address || `Car park ${no}`,
      detail: [type, free, night ? '' : 'No overnight parking'].filter(Boolean).join(' · '),
      source: 'hdb',
      lat,
      lon,
      offset: Math.round(offset),
      along: Math.round(along),
    });
  }

  // Nearest to the path wins its patch of ground: of two car parks serving the
  // same blocks, the one the walker passes is the one worth naming.
  near.sort((a, b) => a.offset - b.offset);
  const kept = [];
  for (const spot of near) {
    if (kept.some(k => metres(k, spot) < CROWDING_M)) continue;
    kept.push(spot);
  }
  kept.sort((a, b) => a.along - b.along);
  return { carparks: kept, crowded: near.length - kept.length, attribution: data.attribution };
}

function metres(a, b) {
  const DEG = Math.PI / 180;
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG * Math.cos((a.lat + b.lat) / 2 * DEG);
  return Math.sqrt(dLat * dLat + dLon * dLon) * 6371008.8;
}

/**
 * How full every HDB car park is, right now.
 *
 * One request for the whole country, because the feed has no way to ask about
 * one car park, and 300 KB is not something to spend without being asked. The
 * caller decides when; this only reports what came back and when it was true.
 */
export async function liveAvailability({ signal } = {}) {
  const data = await register({ signal });
  const body = await fetchJson(data.live, { signal, timeoutMs: LIVE_TIMEOUT_MS });
  const item = body?.items?.[0];
  if (!item) throw new Error('carpark availability: no reading in the feed');

  const lots = new Map();
  for (const park of item.carpark_data || []) {
    // lot_type C is cars; Y is motorcycles and H heavy vehicles, which are not
    // what somebody parking at a trailhead is counting.
    const cars = (park.carpark_info || []).find(i => i.lot_type === 'C');
    if (!cars) continue;
    const free = Number(cars.lots_available);
    const total = Number(cars.total_lots);
    if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) continue;
    lots.set(park.carpark_number, { free, total });
  }
  const at = Date.parse(item.timestamp);
  return { lots, at: Number.isFinite(at) ? at : Date.now() };
}

/**
 * The one line a walker reads off a car park marker.
 *
 * Says the number and says how old it is, in that order, because a count with
 * no timestamp is a promise the app cannot keep. `full` is a finding too, so
 * it is spelled out rather than shown as a zero.
 */
export function lotsLine(live, now = Date.now()) {
  if (!live) return null;
  const age = now - live.at;
  const when = age < 90000 ? 'just now'
    : age < STALE_MS ? `${Math.round(age / 60000)} min ago`
      : `${Math.round(age / 60000)} min ago — probably stale`;
  const count = live.free === 0
    ? `Full — 0 of ${live.total} lots`
    : `${live.free} of ${live.total} lots free`;
  return { text: `${count} · ${when}`, open: live.free > 0, stale: age >= STALE_MS };
}
