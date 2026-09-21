// Turning a route into checkpoints.
//
// The reference app had eleven checkpoints typed out by someone who had walked
// the route. An uploaded route has nobody to do that, so the list is assembled
// from two sources, in this order of trust:
//
//   the file's own pins   a waypoint in the GPX or KML is a deliberate choice
//                         by whoever drew the route, so it is always kept
//   the landmark search   the named things the route passes, wherever they were
//                         found: OpenStreetMap everywhere, and in Singapore the
//                         NParks and STB registers alongside it
//
// Start and finish always come from the route file itself, as the first and
// last point of the line — never from a search, and never guessed.

import { projectOnto } from './geo.js';

// Beyond this many, the progress bar becomes a row of ticks and the "next
// checkpoint" tile changes every two minutes.
const MAX_LANDMARKS = 24;

/**
 * How far apart two checkpoints have to be to be worth being two.
 *
 * Length-relative, which a fixed figure cannot be. 250 m is right for an event
 * route of ten or twenty kilometres and absurd on a 1.2 km loop round a park,
 * where it would leave room for four checkpoints in total; equally, 250 m on a
 * forty-kilometre trail would allow a hundred and sixty of them. So it is
 * roughly an eighth of the route, floored so that a very short walk still
 * separates things a walker would see as separate, and allowed to grow on a
 * long one so the list stays readable.
 */
function minGap(total) {
  return Math.max(Math.min(250, total / 8), total / 60, 60);
}

/**
 * How much of each end is "the start" or "the finish".
 *
 * A landmark inside this is that end of the route under another name, and its
 * disc would sit on top of the flag. The same reasoning as the gap applies: a
 * flat 150 m is a tenth of a 1.5 km loop at each end — nearly a quarter of the
 * route ruled out — so it scales, with a floor for very short walks.
 */
function endpointClear(total) {
  return Math.max(30, Math.min(150, total * 0.04));
}

/**
 * Build the ordered checkpoint list for a route.
 *
 * @param {object} doc          route document
 * @param {Array}  waypoints    pins from the route file (readRouteFile)
 * @param {Array}  landmarks    ranked landmarks from Overpass
 */
export function buildCheckpoints(doc, waypoints = [], landmarks = []) {
  const total = doc.totalDistance;
  const first = doc.points[0];
  const last = doc.points[doc.points.length - 1];

  const namedStart = waypoints.find(w => w.role === 'start')
    || waypoints.find(w => w.role === 'start-named');
  const namedFinish = waypoints.find(w => w.role === 'finish')
    || waypoints.find(w => w.role === 'finish-named');

  const start = {
    id: 'start',
    name: namedStart?.name || (doc.isLoop ? 'Start / Finish' : 'Start'),
    note: namedStart?.note || 'From the route file',
    along: 0,
    offset: 0,
    lat: first[0],
    lon: first[1],
  };
  const finish = {
    id: 'finish',
    name: namedFinish?.name || 'Finish',
    note: namedFinish?.note || (doc.isLoop ? 'Back at the start' : 'From the route file'),
    along: Math.round(total),
    offset: 0,
    lat: last[0],
    lon: last[1],
  };

  // ── the walker's own pins ──
  const used = new Set([namedStart, namedFinish].filter(Boolean).map(w => w.id));
  const candidates = [];
  for (const w of waypoints) {
    if (used.has(w.id)) continue;
    const { offset, along } = projectOnto(doc, w.lat, w.lon);
    candidates.push({
      id: w.id,
      name: w.name,
      note: w.note || 'From the route file',
      source: 'file',
      rank: 100,                 // a pin somebody placed outranks anything found
      along: Math.round(along),
      offset: Math.round(offset),
      lat: w.lat,
      lon: w.lon,
    });
  }

  // ── landmarks found along the way ──
  for (const l of landmarks) {
    candidates.push({
      id: l.id,
      name: l.name,
      note: l.note || l.kind || '',
      photo: l.photo || null,
      source: l.source || 'osm',
      approximate: l.approximate || false,
      rank: l.rank,
      along: l.along,
      offset: l.offset,
      lat: l.lat,
      lon: l.lon,
    });
  }

  const picked = thin(candidates, total);
  picked.sort((a, b) => a.along - b.along);

  return [start, ...picked, finish];
}

/**
 * Keep the interesting ones, spread along the route.
 *
 * Greedy by rank rather than by position: taking them in order along the route
 * would let a cluster of three benches at the trailhead crowd out the summit.
 * Taking the best first and refusing anything too close to something already
 * taken keeps both the quality and the spacing.
 */
function thin(candidates, total) {
  const gap = minGap(total);
  const clear = endpointClear(total);
  const sorted = candidates.slice().sort((a, b) =>
    b.rank - a.rank || a.offset - b.offset || a.along - b.along);

  const kept = [];
  for (const c of sorted) {
    if (c.along < clear || c.along > total - clear) continue;
    // the file's own pins are never dropped for crowding; they were chosen
    if (c.source !== 'file' && kept.length >= MAX_LANDMARKS) continue;
    if (kept.some(k => Math.abs(k.along - c.along) < gap
      // two pins from the file may legitimately sit close together
      && !(k.source === 'file' && c.source === 'file'))) continue;
    if (kept.some(k => k.name && k.name === c.name)) continue;
    kept.push(c);
  }
  return kept;
}
