// Defibrillators, from the source that actually has them.
//
// OpenStreetMap is the app's backbone everywhere, but in Singapore it has
// almost no AEDs in it: measured on a 1.2 km loop in Woodlands, OSM had none
// within a kilometre while SCDF's register had 161, the nearest 22 m from the
// path. For a card that promises the nearest defibrillator that is not a gap,
// it is a wrong answer.
//
// So for routes inside Singapore the register is used as well, and it brings
// something OSM rarely carries: opening hours. An AED behind a school gate at
// nine in the evening is not an AED, and the emergency card has to know the
// difference rather than sending somebody to a locked door.
//
// AED locations © Singapore Civil Defence Force, via data.gov.sg, under the
// Singapore Open Data Licence. Built by tools/fetch_aed.py; see that file for
// why it is shipped rather than fetched.

import { projectOnto } from './geo.js';
import { inSingapore } from './weather.js';

const DATA_URL = 'data/aed-sg.json';
// How far off the route an AED may be, matching the OpenStreetMap radius.
const MAX_OFFSET_M = 1000;
// An OSM defibrillator this close to an SCDF one is the same machine described
// twice; the register wins, because it carries the floor and the hours.
const DUPLICATE_M = 40;

let registerPromise = null;

/** The register, fetched once per session and then held. */
function register({ signal } = {}) {
  if (!registerPromise) {
    registerPromise = fetch(DATA_URL, { signal })
      .then(res => {
        if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
        return res.json();
      })
      .catch(err => {
        registerPromise = null;      // a failed load must not poison the session
        throw err;
      });
  }
  return registerPromise;
}

/** Is this route somewhere the register covers? */
export function coversRoute(bounds) {
  return inSingapore(bounds.minLat, bounds.minLon) && inSingapore(bounds.maxLat, bounds.maxLon);
}

/**
 * Is an AED reachable at this moment?
 *
 * @returns {true|false|null} null where the register gives no hours, which is
 * not the same as closed — an AED wrongly called closed is one a walker will
 * not go to.
 */
export function openAt(week, at = new Date()) {
  if (!Array.isArray(week)) return null;
  const day = at.getDay();
  const minutes = at.getHours() * 60 + at.getMinutes();
  const today = week[day];
  if (today) {
    const [open, close] = today;
    // a window whose close is before its open runs past midnight
    if (close >= open ? (minutes >= open && minutes < close)
      : (minutes >= open || minutes < close)) return true;
  }
  // a window opened yesterday may still be running
  const yesterday = week[(day + 6) % 7];
  if (yesterday && yesterday[1] < yesterday[0] && minutes < yesterday[1]) return true;
  return false;
}

function floorPrefix(floor, where) {
  if (!floor) return where;
  const said = new RegExp(`^level\\s*${floor}\\b`, 'i').test(where.trim());
  if (said) return where;
  return [`Level ${floor}`, where].filter(Boolean).join(' · ');
}

const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "24 hours", "07:00–17:00 today", "closed today" — what today looks like. */
export function todayLabel(week, at = new Date()) {
  if (!Array.isArray(week)) return '';
  const today = week[at.getDay()];
  if (!today) return 'closed today';
  if (today[0] === 0 && today[1] >= 1440) return '24 hours';
  return `${hhmm(today[0])}–${hhmm(today[1])} today`;
}

/**
 * The AEDs from the register that lie along this route.
 *
 * Filtered by bounding box before anything is projected: projecting all 9,644
 * onto a long route would be tens of millions of segment tests for an answer
 * that a rectangle settles in one pass.
 */
export async function sgAedsAlong(doc, { signal } = {}) {
  const data = await register({ signal });
  const b = doc.bounds;
  const dLat = MAX_OFFSET_M / 110574;
  const dLon = MAX_OFFSET_M / (111320 * Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180));
  const minLat = b.minLat - dLat, maxLat = b.maxLat + dLat;
  const minLon = b.minLon - dLon, maxLon = b.maxLon + dLon;

  const out = [];
  for (const [lat, lon, hi, name, where, floor] of data.aed) {
    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) continue;
    const { offset, along } = projectOnto(doc, lat, lon);
    if (offset > MAX_OFFSET_M) continue;
    const week = data.hoursWeek[hi];
    out.push({
      id: `scdf${Math.round(lat * 1e6)}_${Math.round(lon * 1e6)}_${floor || ''}`,
      name: name || 'AED',
      // The floor and the description are what turns "there is an AED in that
      // building" into something someone can run to. The register usually
      // opens the description with the level as well — "Level 1 Block 7
      // Opposite Security Counter" — so the prefix is only added when it is
      // not already being said.
      detail: floorPrefix(floor, where),
      hoursText: data.hoursText[hi] || '',
      hoursWeek: Array.isArray(week) ? week : null,
      source: 'scdf',
      lat,
      lon,
      offset: Math.round(offset),
      along: Math.round(along),
    });
  }
  out.sort((a, b2) => a.along - b2.along);
  return { aeds: out, attribution: data.attribution, fetchedAt: data.fetchedAt };
}

/**
 * Merge the register into whatever OpenStreetMap found.
 *
 * Both are kept: OSM has AEDs in places the register does not reach, such as
 * inside the nature reserves, and the register has the ten thousand the map
 * has never heard of. Only the ones that are plainly the same machine are
 * collapsed, and the register's copy is the one that survives.
 */
export function mergeAeds(osmAeds = [], registerAeds = []) {
  const kept = registerAeds.slice();
  const R = 6371008.8, DEG = Math.PI / 180;
  for (const a of osmAeds) {
    const duplicate = kept.some(b => {
      const dLat = (b.lat - a.lat) * DEG, dLon = (b.lon - a.lon) * DEG;
      const x = dLon * Math.cos((a.lat + b.lat) / 2 * DEG);
      return Math.sqrt(x * x + dLat * dLat) * R < DUPLICATE_M;
    });
    if (!duplicate) kept.push(a);
  }
  return kept.sort((a, b) => a.along - b.along);
}
