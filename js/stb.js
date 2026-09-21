// The places worth crossing the road for.
//
// OpenStreetMap can tell you that the building on the corner of South Bridge
// Road is a Hindu temple. The Singapore Tourism Board's list knows it is Sri
// Mariamman, the oldest Hindu temple in the country, and says so in a sentence
// a walker can read while standing in front of it. A hundred and six places,
// each with a line of its own — which is the difference between a checkpoint
// that names something and a checkpoint that is worth walking to.
//
// They are landmarks only. STB does not survey toilets or defibrillators, and
// a register should be asked for what it knows.
//
// Positions: the published latitudes are rounded to three decimals, about a
// hundred metres, so tools/fetch_attractions.py re-geocodes each address
// through OneMap and keeps the answer when the two agree. Where it could not —
// an island, a stretch of river, a neighbourhood rather than an address — the
// published point stands and the marker says it is approximate, because a pin
// that might be a hundred metres out should not pretend otherwise.
//
// Attractions © Singapore Tourism Board, via data.gov.sg, under the Singapore
// Open Data Licence; positions refined with OneMap © Singapore Land Authority.
// Built by tools/fetch_attractions.py.

import { projectOnto } from './geo.js';
import { LANDMARK_OFFSET_M } from './overpass.js';

const DATA_URL = 'data/stb-sg.json';

/**
 * How good a checkpoint an STB attraction is.
 *
 * The same score OpenStreetMap's `tourism=attraction` earns, deliberately: STB
 * publishes no ranking of its own, and inventing one here would mean the app
 * quietly preferring whichever source it happened to like. Equal rank leaves
 * the tie to be broken on distance from the route, which is the walker's
 * question rather than the data's.
 */
const RANK = 9;

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

/**
 * Might this route pass any of them?
 *
 * An overlap test against the register's own extent, read from the file rather
 * than hard-coded, so the day STB adds somewhere new the bounds move with it.
 */
export async function touchesAttractions(bounds, { signal } = {}) {
  if (!coverage) coverage = (await register({ signal })).bounds;
  return bounds.minLat <= coverage.maxLat && bounds.maxLat >= coverage.minLat
    && bounds.minLon <= coverage.maxLon && bounds.maxLon >= coverage.minLon;
}

/** The attractions along this route, as landmarks. */
export async function attractionsAlong(doc, { signal } = {}) {
  const data = await register({ signal });
  coverage = data.bounds;

  const landmarks = [];
  for (const [lat, lon, name, overview, address, geocoded] of data.attractions) {
    const { offset, along } = projectOnto(doc, lat, lon);
    if (offset > LANDMARK_OFFSET_M) continue;
    landmarks.push({
      id: `stb${Math.round(lat * 1e6)}_${Math.round(lon * 1e6)}`,
      name,
      kind: 'Attraction',
      note: overview || address,
      // Said on the marker's own line rather than folded into the description:
      // it is a fact about the pin, not about the place, and a walker deciding
      // whether to cross a road for it should be able to see which.
      approximate: !geocoded,
      rank: RANK,
      source: 'stb',
      lat,
      lon,
      offset: Math.round(offset),
      along: Math.round(along),
    });
  }
  landmarks.sort((a, b) => a.along - b.along);

  return { landmarks, attribution: data.attribution };
}
