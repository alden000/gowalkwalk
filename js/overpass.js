// Finding what is on the ground around the walker's route.
//
// The reference app had its facilities baked into a JSON file by a build script
// that ran once, months before the walk. A route that arrives on the phone
// cannot be pre-built, so the same search runs live against OpenStreetMap's
// Overpass API and the answer is kept on the device.
//
// Everything asked for here is the same set the reference app plotted — AEDs,
// toilets, drinking water, vending machines, shelters and parking — plus the
// landmarks and attractions the route passes, which that app curated by hand.
//
// Data © OpenStreetMap contributors, ODbL.

import { projectOnto, sampleEvery } from './geo.js';
import { cancelled, fetchWithTimeout } from './net.js';

// Mirrors, tried in order. The main instance is the most complete and the most
// often busy; the others are public mirrors that run the same software and the
// same data, so a 429 from one is not the end of the search.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// How far off the route something may be and still be "along the route". These
// are the reference app's own radii: an AED is worth a detour, a shelter on the
// far side of the hill is not.
export const MAX_OFFSET_M = {
  aed: 1000, toilet: 800, water: 800, vending: 800, shelter: 400, parking: 1000,
};
export const LANDMARK_OFFSET_M = 350;

// The corridor is described to Overpass as a string of points along the route.
// Every point is a separate spatial lookup on the server, so they are spaced
// out and the query is split into chunks a public mirror will actually finish.
const SAMPLE_STEP_M = 200;
const MAX_POINTS_PER_QUERY = 140;
const SEARCH_RADIUS_M = 1000;
const TRAIL_RADIUS_M = 300;
// What the server is told to spend on the query itself, once it starts work.
const TIMEOUT_S = 90;

// What *we* are willing to wait for an answer.
//
// A busy mirror does not turn a query away — it accepts the connection and
// queues it, and without a deadline the app waits for that queue for ever. Two
// rounds: a short one that moves briskly through all three mirrors and finds
// whichever is healthy right now, then a patient one for the case where they
// are all merely slow. Worst case, with every mirror hanging, is a bounded two
// minutes during which the card names a different host every few seconds and
// Cancel works throughout — rather than an unbounded wait saying nothing.
const ROUND_TIMEOUTS_MS = [12000, 30000];
// A pause between rounds, so a second pass is not simply the first pass again.
const ROUND_PAUSE_MS = 1200;

// Whichever mirror last answered, tried first next time.
//
// A long route is split into several queries, and without this each one starts
// the sweep again at a mirror already known to be dead — paying the same 12 s
// over and over, so a trail long enough to need six chunks wastes over a minute
// on a host that answered none of the first five.
let preferred = null;

/** The mirrors, with the one that last worked at the front. */
function mirrors() {
  if (!preferred) return ENDPOINTS;
  return [preferred, ...ENDPOINTS.filter(e => e !== preferred)];
}

/** OSM tags → one of our categories, or null to ignore. Mirrors the reference app. */
function classify(t) {
  const amenity = t.amenity || '';
  if (t.emergency === 'defibrillator' || amenity === 'defibrillator') return 'aed';
  if (amenity === 'toilets') return 'toilet';
  if (amenity === 'drinking_water' || amenity === 'water_point') return 'water';
  if (t.man_made === 'water_tap' && t.drinking_water !== 'no') return 'water';
  if (amenity === 'vending_machine') {
    const vending = t.vending || '';
    // drink machines are the ask; food machines almost always sell drinks too
    if (!vending || /drink|water|beverage|food/.test(vending)) return 'vending';
    return null;
  }
  if (amenity === 'shelter') {
    // a bus-stop shelter is not a shelter hut
    if (t.shelter_type === 'public_transport') return null;
    return 'shelter';
  }
  if (t.tourism === 'wilderness_hut' || t.building === 'hut' || t.building === 'pavilion') return 'shelter';
  if (t.leisure === 'picnic_shelter') return 'shelter';
  if (amenity === 'parking') {
    // a private staff yard is no use to a walker looking for somewhere to leave the car
    if (t.access === 'private' || t.access === 'no') return null;
    return 'parking';
  }
  return null;
}

/**
 * Is this worth sending a walker to look at, and how much so?
 *
 * The reference app's checkpoints were eleven landmarks chosen by a person who
 * knew the route. Nobody is choosing them here, so the ranking does it: a
 * summit or a waterfall outranks a named flowerbed, and the score decides what
 * survives when a route passes more named things than a walker can use.
 */
function landmarkRank(t) {
  if (t.tourism === 'viewpoint') return 10;
  if (t.natural === 'peak' || t.natural === 'volcano') return 10;
  if (t.natural === 'waterfall' || t.natural === 'cave_entrance' || t.natural === 'arch') return 9;
  if (t.tourism === 'attraction' || t.tourism === 'theme_park' || t.tourism === 'zoo') return 9;
  if (t.man_made === 'tower' || t.man_made === 'lighthouse' || t.man_made === 'obelisk') return 8;
  if (t.historic === 'memorial' || t.historic === 'monument' || t.historic === 'castle'
    || t.historic === 'ruins' || t.historic === 'archaeological_site' || t.historic === 'fort') return 8;
  if (t.historic) return 7;
  if (t.tourism === 'museum' || t.tourism === 'artwork' || t.tourism === 'gallery') return 7;
  if (t.natural === 'spring' || t.natural === 'beach' || t.natural === 'bay') return 6;
  if (t.leisure === 'bird_hide' || t.leisure === 'nature_reserve') return 6;
  if (t.amenity === 'place_of_worship' || t.amenity === 'fountain') return 5;
  if (t.leisure === 'garden' || t.leisure === 'park') return 4;
  if (t.natural === 'tree' && t.denotation) return 4;   // a tagged landmark tree
  if (t.waterway === 'waterfall') return 9;
  return 0;
}

/** A one-line description under the name, from whatever the tags offer. */
function detailFor(cat, t) {
  const bits = [];
  if (cat === 'aed') {
    const loc = t['defibrillator:location'] || t.location;
    if (loc && loc !== t.name) bits.push(loc);
    if (t.indoor === 'no') bits.push('Outdoor unit');
    if (t.opening_hours) bits.push(t.opening_hours);
  }
  if (cat === 'toilet') {
    if (t.fee === 'no') bits.push('Free');
    if (t.fee === 'yes') bits.push('Paid');
    if (t.wheelchair === 'yes') bits.push('Wheelchair accessible');
    if (t['toilets:handwashing'] === 'yes') bits.push('Handwashing');
    if (t.changing_table === 'yes') bits.push('Changing table');
    if (t.opening_hours) bits.push(t.opening_hours);
  }
  if (cat === 'water') {
    if (t.bottle === 'yes') bits.push('Bottle filling');
    if (t.fountain === 'bubbler') bits.push('Bubbler');
    if (t.man_made === 'water_tap') bits.push('Tap');
    if (t.drinking_water === 'yes') bits.push('Drinkable');
  }
  if (cat === 'vending') {
    const v = t.vending || '';
    if (/drink/.test(v)) bits.push('Drinks');
    if (/water/.test(v)) bits.push('Water');
    if (/food|sweets|snack/.test(v)) bits.push('Snacks');
    if (t['payment:coins'] === 'yes') bits.push('Coins');
    if (t['payment:cards'] === 'yes' || t['payment:contactless'] === 'yes') bits.push('Card');
  }
  if (cat === 'shelter') {
    const st = (t.shelter_type || '').replace(/_/g, ' ');
    if (st) bits.push(st[0].toUpperCase() + st.slice(1));
    if (t.building === 'pavilion') bits.push('Pavilion');
  }
  if (cat === 'parking') {
    if (t.fee === 'no') bits.push('Free');
    if (t.fee === 'yes') bits.push('Paid');
    if (t.capacity) bits.push(`${t.capacity} lots`);
    if (t.parking) bits.push(String(t.parking).replace(/_/g, ' '));
    if (t.opening_hours) bits.push(t.opening_hours);
  }
  if (t.operator && !bits.includes(t.operator)) bits.push(t.operator);
  return bits.join(' · ');
}

/**
 * A photo of the place, where OpenStreetMap carries one.
 *
 * The reference app showed a photograph of each checkpoint in its popup, from a
 * file curated for that one route. Nobody can curate an uploaded route, but
 * mappers regularly tag `wikimedia_commons` or `image` on exactly the things
 * that become checkpoints here — summits, viewpoints, monuments, huts — so the
 * feature survives for the places that have one.
 *
 * Commons files go through Special:FilePath, which is the documented stable
 * redirect to the current file and takes a width, so a popup does not pull down
 * a 12 megapixel original. An `image` URL is somebody's own hosting and is only
 * taken over HTTPS: the app is served over HTTPS and a plain-HTTP image is
 * blocked as mixed content anyway.
 */
function photoFor(t) {
  const commons = t.wikimedia_commons || t.image_commons;
  if (commons && /^File:/i.test(commons)) {
    const file = encodeURIComponent(commons.replace(/^File:/i, '').replace(/ /g, '_'));
    return {
      src: `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=560`,
      credit: 'Wikimedia Commons',
    };
  }
  if (t.image && /^https:\/\//.test(t.image)) {
    return { src: t.image, credit: hostOf(t.image) };
  }
  return null;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const FALLBACK_NAME = {
  aed: 'AED', toilet: 'Toilet', water: 'Drinking water',
  vending: 'Vending machine', shelter: 'Shelter', parking: 'Car park',
};

function nameFor(cat, t) {
  if (t.name) return t.name;
  if (cat === 'aed') return t['defibrillator:location'] || t.location || 'AED';
  return FALLBACK_NAME[cat] || 'Facility';
}

/** What a landmark is, in a couple of words, when the tags do not say it outright. */
function landmarkKind(t) {
  const pairs = [
    ['tourism', t.tourism], ['historic', t.historic], ['natural', t.natural],
    ['man_made', t.man_made], ['leisure', t.leisure], ['amenity', t.amenity],
    ['waterway', t.waterway === 'waterfall' ? 'waterfall' : null],
  ];
  for (const [, value] of pairs) {
    if (!value) continue;
    const words = String(value).replace(/_/g, ' ');
    return words[0].toUpperCase() + words.slice(1);
  }
  return 'Landmark';
}

// ── talking to Overpass ──────────────────────────────────────────────

/** The route as a flat "lat,lon,lat,lon,…" list, chunked so no query is enormous. */
function corridorChunks(doc) {
  const samples = sampleEvery(doc.points, doc.cumulative, SAMPLE_STEP_M);
  const chunks = [];
  for (let i = 0; i < samples.length; i += MAX_POINTS_PER_QUERY) {
    // one point of overlap, so nothing falls through the seam between chunks
    const slice = samples.slice(Math.max(0, i - 1), i + MAX_POINTS_PER_QUERY);
    chunks.push(slice.map(([lat, lon]) => `${lat.toFixed(5)},${lon.toFixed(5)}`).join(','));
  }
  return chunks;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Run one Overpass query, moving on when a mirror will not answer.
 *
 * Public Overpass instances shed load in two different ways, and both have to
 * be handled or a walker at a trailhead gets nothing. Some turn a query away
 * with 429 or 504, which fails fast and is easy. Others accept it and queue it
 * behind everything else, answering in their own time or not at all — and that
 * one, left alone, is what makes the app look hung.
 *
 * Every attempt therefore has a deadline, and the mirrors are swept twice: a
 * brisk pass that finds whichever is healthy right now, then a patient pass for
 * when they are all merely slow. `onAttempt` reports which host is being tried
 * so the screen can say so rather than sitting on one unchanging line.
 */
async function runQuery(body, { signal, onAttempt } = {}) {
  let lastError = null;
  for (let round = 0; round < ROUND_TIMEOUTS_MS.length; round++) {
    if (round) await sleep(ROUND_PAUSE_MS);
    for (const endpoint of mirrors()) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const host = new URL(endpoint).host;
      onAttempt?.(host, round);
      try {
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          body: new URLSearchParams({ data: body }),
          timeoutMs: ROUND_TIMEOUTS_MS[round],
          signal,
        });
        if (res.status === 429 || res.status === 503 || res.status === 504) {
          lastError = new Error(`${host} is busy (HTTP ${res.status})`);
          continue;
        }
        if (!res.ok) throw new Error(`${host}: HTTP ${res.status}`);
        const answer = await res.json();
        // Remembered only on a genuine answer, so the next chunk starts with a
        // mirror known to be alive rather than at the top of the list again.
        preferred = endpoint;
        return answer;
      } catch (err) {
        // The walker tapping Cancel is not a mirror failing; it stops everything.
        if (cancelled(err, signal)) throw err;
        lastError = err.name === 'TimeoutError'
          ? new Error(`${host} did not answer within `
            + `${ROUND_TIMEOUTS_MS[round] / 1000} s`)
          : err;
      }
    }
  }
  throw lastError || new Error('No OpenStreetMap mirror answered.');
}

/** Element → a position: nodes carry one, ways and relations get their centre. */
function positionOf(el) {
  if (el.type === 'node') return [el.lat, el.lon];
  if (el.center) return [el.center.lat, el.center.lon];
  if (el.geometry?.length) {
    const lat = el.geometry.reduce((s, g) => s + g.lat, 0) / el.geometry.length;
    const lon = el.geometry.reduce((s, g) => s + g.lon, 0) / el.geometry.length;
    return [lat, lon];
  }
  return null;
}

// ── the searches ─────────────────────────────────────────────────────

/**
 * Facilities and landmarks along the route.
 *
 * Both come back from one query per chunk: they are the same spatial lookup
 * with different tag filters, and asking twice would double the work the
 * mirrors do for no gain. They are separated again on the way out, because
 * facilities are map pins and landmarks are checkpoints.
 *
 * @param {object} doc      route document from buildRouteDoc()
 * @param {object} options  { signal, onProgress(done, total) }
 */
export async function fetchPlaces(doc, { signal, onProgress } = {}) {
  const chunks = corridorChunks(doc);
  const seen = new Set();
  const facilities = {};
  const landmarks = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const around = `(around:${SEARCH_RADIUS_M},${chunks[i]})`;
    const query = `[out:json][timeout:${TIMEOUT_S}];
(
  nwr${around}["amenity"~"^(toilets|drinking_water|water_point|vending_machine|shelter|parking|defibrillator)$"];
  nwr${around}["emergency"="defibrillator"];
  nwr${around}["man_made"="water_tap"];
  nwr${around}["leisure"="picnic_shelter"];
  nwr${around}["building"~"^(hut|pavilion)$"];
  nwr${around}["tourism"~"^(wilderness_hut|attraction|viewpoint|artwork|gallery|museum|theme_park|zoo)$"];
  nwr${around}["historic"];
  nwr${around}["natural"~"^(peak|volcano|waterfall|cave_entrance|arch|spring|beach|bay)$"];
  nwr${around}["waterway"="waterfall"];
  nwr${around}["man_made"~"^(tower|lighthouse|obelisk|watermill|windmill)$"]["name"];
  nwr${around}["leisure"~"^(park|garden|nature_reserve|bird_hide)$"]["name"];
  nwr${around}["amenity"~"^(place_of_worship|fountain)$"]["name"];
);
out center tags;`;

    const data = await runQuery(query, {
      signal,
      onAttempt: (host, round) => onProgress?.(i, chunks.length,
        round ? `${host} — second try` : host),
    });
    for (const el of data.elements || []) {
      const key = `${el.type}${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pos = positionOf(el);
      if (!pos) continue;
      const tags = el.tags || {};
      const { offset, along } = projectOnto(doc, pos[0], pos[1]);

      const cat = classify(tags);
      if (cat) {
        if (offset > MAX_OFFSET_M[cat]) continue;
        (facilities[cat] ||= []).push({
          id: key,
          name: nameFor(cat, tags),
          detail: detailFor(cat, tags),
          photo: photoFor(tags),
          lat: Math.round(pos[0] * 1e6) / 1e6,
          lon: Math.round(pos[1] * 1e6) / 1e6,
          offset: Math.round(offset),
          along: Math.round(along),
        });
        continue;
      }

      const rank = landmarkRank(tags);
      if (!rank || offset > LANDMARK_OFFSET_M) continue;
      // An unnamed thing makes a poor checkpoint: "the landmark at km 4.1"
      // tells a walker nothing they can recognise on the ground.
      if (!tags.name && rank < 9) continue;
      landmarks.push({
        id: key,
        name: tags.name || landmarkKind(tags),
        kind: landmarkKind(tags),
        note: [tags.name ? landmarkKind(tags) : '', tags.description, tags.inscription]
          .filter(Boolean).join(' · '),
        photo: photoFor(tags),
        rank,
        lat: Math.round(pos[0] * 1e6) / 1e6,
        lon: Math.round(pos[1] * 1e6) / 1e6,
        offset: Math.round(offset),
        along: Math.round(along),
      });
    }
  }
  onProgress?.(chunks.length, chunks.length);

  for (const cat of Object.keys(facilities)) facilities[cat].sort((a, b) => a.along - b.along);
  return {
    facilities,
    landmarks: landmarks.sort((a, b) => a.along - b.along),
    fetchedAt: Date.now(),
    attribution: '© OpenStreetMap contributors (ODbL)',
  };
}

/**
 * The footpath network around the route, for the trail-map overlay.
 *
 * Far heavier than the facility search — a city route can cross thousands of
 * pavements — so it is only fetched when the walker actually turns the overlay
 * on, and it is kept from then on.
 */
export async function fetchTrails(doc, { signal, onProgress } = {}) {
  const chunks = corridorChunks(doc);
  const seen = new Set();
  const ways = [];

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const query = `[out:json][timeout:${TIMEOUT_S}];
way(around:${TRAIL_RADIUS_M},${chunks[i]})["highway"~"^(path|footway|track|steps|cycleway|pedestrian|bridleway|living_street)$"];
out geom;`;
    const data = await runQuery(query, {
      signal,
      onAttempt: (host, round) => onProgress?.(i, chunks.length,
        round ? `${host} — second try` : host),
    });
    for (const el of data.elements || []) {
      if (seen.has(el.id) || !el.geometry || el.geometry.length < 2) continue;
      seen.add(el.id);
      ways.push({
        name: el.tags?.name || '',
        kind: el.tags?.highway === 'steps' ? 'steps' : 'path',
        pts: el.geometry.map(g => [Math.round(g.lat * 1e5) / 1e5, Math.round(g.lon * 1e5) / 1e5]),
      });
    }
  }
  onProgress?.(chunks.length, chunks.length);
  return { ways, fetchedAt: Date.now(), attribution: '© OpenStreetMap contributors (ODbL)' };
}
