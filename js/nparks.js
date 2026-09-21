// What the parks authority knows that the map does not.
//
// OpenStreetMap is thin exactly where a hiking app needs to be thick. A probe
// of the MacRitchie corridor returned eight tagged elements in total. NParks'
// own register has ninety-seven shelters and huts by name across the same
// reserves — Chemperai Hut, Drongo Hut, Bangkit Shelter — with the toilets, the
// car parks, the observation towers and the wartime remains alongside them.
//
// Unlike the AED register this one is not national: it describes the central
// reserves and the southern ridges, and it is consulted only for a route that
// touches that ground. Everywhere else in Singapore, and everywhere else in the
// world, OpenStreetMap remains the source.
//
// Park amenities © National Parks Board, via data.gov.sg, under the Singapore
// Open Data Licence. Built by tools/fetch_nparks.py.

import { projectOnto } from './geo.js';
import { MAX_OFFSET_M, LANDMARK_OFFSET_M } from './overpass.js';

const DATA_URL = 'data/nparks-sg.json';

let registerPromise = null;

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

/** Bounds of the ground this register describes, once it has been read. */
let coverage = null;

/**
 * Might this route touch the reserves?
 *
 * An overlap test, not a containment one: a walk that starts in the reserve and
 * finishes on a road outside it is still a walk through the reserve, and the
 * huts it passes are still worth having. The register is fetched once to learn
 * its own extent, so the answer is only definitive after that; before it, the
 * generous guess is Singapore, which costs one 8 KB request to correct.
 */
export async function touchesReserves(bounds, { signal } = {}) {
  if (!coverage) {
    const data = await register({ signal });
    coverage = data.bounds;
  }
  return bounds.minLat <= coverage.maxLat && bounds.maxLat >= coverage.minLat
    && bounds.minLon <= coverage.maxLon && bounds.maxLon >= coverage.minLon;
}

/**
 * The register's facilities and landmarks along this route.
 *
 * The same corridor radii the OpenStreetMap search uses, so a hut from NParks
 * and a hut from OSM are judged by one rule and the map does not quietly become
 * more generous about one source than the other.
 */
export async function nparksAlong(doc, { signal } = {}) {
  const data = await register({ signal });
  coverage = data.bounds;

  const facilities = {};
  for (const [lat, lon, category, name, detail] of data.places) {
    const limit = MAX_OFFSET_M[category];
    if (limit == null) continue;
    const { offset, along } = projectOnto(doc, lat, lon);
    if (offset > limit) continue;
    (facilities[category] ||= []).push({
      id: `nparks${Math.round(lat * 1e6)}_${Math.round(lon * 1e6)}`,
      name,
      detail: detail || '',
      source: 'nparks',
      lat,
      lon,
      offset: Math.round(offset),
      along: Math.round(along),
    });
  }
  for (const list of Object.values(facilities)) list.sort((a, b) => a.along - b.along);

  const landmarks = [];
  for (const [lat, lon, rank, name, kind] of data.landmarks) {
    const { offset, along } = projectOnto(doc, lat, lon);
    if (offset > LANDMARK_OFFSET_M) continue;
    landmarks.push({
      id: `nparks${Math.round(lat * 1e6)}_${Math.round(lon * 1e6)}`,
      name,
      kind,
      note: kind,
      rank,
      source: 'nparks',
      lat,
      lon,
      offset: Math.round(offset),
      along: Math.round(along),
    });
  }
  landmarks.sort((a, b) => a.along - b.along);

  return { facilities, landmarks, attribution: data.attribution };
}
