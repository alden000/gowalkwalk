// The reserve trails, shipped rather than searched.
//
// Not because OpenStreetMap is thin here — measured over the same box across
// the Central Catchment, OpenStreetMap has 263 km of path to NParks' 82, and
// 72% of NParks' vertices already have an OpenStreetMap node within 15 m. The
// crowd has done this ground properly and nothing here replaces it.
//
// It is shipped for the two things the search cannot do.
//
// **It answers immediately, with the radio off.** The measurement that proved
// the coverage also measured the cost: 172 seconds from the mirror that
// answered, and a 504 after 197 seconds from one that did not. That is the
// slowest thing this app does, and it is asked for by somebody already in the
// forest on one bar of signal, standing at a fork. 159 KB that is already on
// the device answers that with no network at all.
//
// **It carries the numbers on the signposts.** MacRitchie is walked by route
// number — the boards say "Route 3" — and OpenStreetMap has none of the six.
//
// Trails © National Parks Board, via data.gov.sg, under the Singapore Open
// Data Licence. Built by tools/fetch_trails.py.

const DATA_URL = 'data/trails-sg.json';

// The same corridor the OpenStreetMap trail search uses, so turning the
// overlay on shows the same width of world whichever source answered.
const TRAIL_RADIUS_M = 300;

// Wider than the corridor, so a point's own cell and its eight neighbours
// always contain every segment that could be within the radius.
const CELL_M = 400;

// A trail drawn as one long straight can put half a kilometre between two
// vertices, and testing only the vertices would miss a corridor the line
// passes straight through. Long gaps are walked at this spacing instead.
const STEP_M = 200;

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

/** Does this route touch the ground the register covers? */
export async function coversTrails(bounds, { signal } = {}) {
  if (!coverage) coverage = (await register({ signal })).bounds;
  return bounds.minLat <= coverage.maxLat && bounds.maxLat >= coverage.minLat
    && bounds.minLon <= coverage.maxLon && bounds.maxLon >= coverage.minLon;
}

/**
 * The register's trails within the route's corridor.
 *
 * A line is kept whole as soon as any part of it comes near the route: a trail
 * clipped at the corridor edge would stop in mid-forest, which reads on the map
 * as a dead end that is not there. Trimming saves a few kilobytes of drawing
 * and costs the walker the one thing the overlay is for.
 *
 * The question asked of each trail is only "does any of it come within 300 m",
 * which is why this does not use `projectOnto`. That function answers a harder
 * question — how far along the route the nearest point is — by walking every
 * segment of the route, and there are 7,544 trail vertices to ask about. On a
 * day-long recording at one fix a second it measured 2.8 seconds of frozen
 * screen for a checkbox. The grid below answers the easier question in constant
 * time per vertex and brings the same route under 90 ms.
 */
export async function sgTrailsAlong(doc, { signal } = {}) {
  const data = await register({ signal });
  coverage = data.bounds;

  const index = corridorIndex(doc);
  const ways = [];
  for (const [name, route, steps, pts] of data.ways) {
    // A cheap array comparison first: most of the register is nowhere near any
    // one route, and this rejects those without touching the grid at all.
    if (!nearBounds(doc.bounds, pts) || !nearRoute(index, pts)) continue;
    ways.push({
      name,
      route,
      kind: steps ? 'steps' : 'path',
      source: 'nparks',
      pts,
    });
  }
  return { ways, fetchedAt: Date.now(), attribution: data.attribution, source: 'nparks' };
}

/** Is any vertex within roughly the corridor of the route's bounding box? */
function nearBounds(bounds, pts) {
  const pad = TRAIL_RADIUS_M / 110540;          // degrees, generous in longitude
  return pts.some(([lat, lon]) =>
    lat >= bounds.minLat - pad && lat <= bounds.maxLat + pad
    && lon >= bounds.minLon - pad && lon <= bounds.maxLon + pad);
}

/**
 * The route's segments, bucketed by where they are.
 *
 * Metres on a local flat projection rather than degrees, so one cell is square
 * and the neighbour test is symmetrical. A segment goes in every cell its
 * bounding box touches, so a long one spanning several cells is found from all
 * of them. Built once per call and thrown away with it.
 */
function corridorIndex(doc) {
  const lat0 = (doc.bounds.minLat + doc.bounds.maxLat) / 2 * Math.PI / 180;
  const mLat = 110574, mLon = 111320 * Math.cos(lat0);
  const cells = new Map();
  const pts = doc.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * mLon, ay = pts[i][0] * mLat;
    const bx = pts[i + 1][1] * mLon, by = pts[i + 1][0] * mLat;
    const fromX = Math.floor(Math.min(ax, bx) / CELL_M);
    const toX = Math.floor(Math.max(ax, bx) / CELL_M);
    const fromY = Math.floor(Math.min(ay, by) / CELL_M);
    const toY = Math.floor(Math.max(ay, by) / CELL_M);
    for (let cx = fromX; cx <= toX; cx++) {
      for (let cy = fromY; cy <= toY; cy++) {
        const key = `${cx},${cy}`;
        let bucket = cells.get(key);
        if (!bucket) cells.set(key, bucket = []);
        bucket.push(ax, ay, bx, by);
      }
    }
  }
  return { cells, mLat, mLon };
}

/** Does this line pass within the corridor anywhere along its length? */
function nearRoute(index, pts) {
  for (let i = 0; i < pts.length; i++) {
    if (hits(index, pts[i][0], pts[i][1])) return true;
    if (i === pts.length - 1) break;
    // walk a long straight rather than jumping over the corridor
    const [aLat, aLon] = pts[i];
    const [bLat, bLon] = pts[i + 1];
    const span = Math.hypot((bLat - aLat) * index.mLat, (bLon - aLon) * index.mLon);
    for (let d = STEP_M; d < span; d += STEP_M) {
      const t = d / span;
      if (hits(index, aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t)) return true;
    }
  }
  return false;
}

/** Is this point within the corridor of any route segment? */
function hits(index, lat, lon) {
  const { cells, mLat, mLon } = index;
  const px = lon * mLon, py = lat * mLat;
  const cx = Math.floor(px / CELL_M), cy = Math.floor(py / CELL_M);
  const limit = TRAIL_RADIUS_M * TRAIL_RADIUS_M;
  for (let i = cx - 1; i <= cx + 1; i++) {
    for (let j = cy - 1; j <= cy + 1; j++) {
      const bucket = cells.get(`${i},${j}`);
      if (!bucket) continue;
      for (let k = 0; k < bucket.length; k += 4) {
        const ax = bucket[k], ay = bucket[k + 1];
        const dx = bucket[k + 2] - ax, dy = bucket[k + 3] - ay;
        const seg2 = dx * dx + dy * dy;
        let t = seg2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / seg2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const nx = ax + t * dx - px, ny = ay + t * dy - py;
        if (nx * nx + ny * ny <= limit) return true;
      }
    }
  }
  return false;
}
