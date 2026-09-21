// Route geometry: projecting a live position onto the route to work out how far
// along it we are, and how much is left.
//
// Shared by the live map and by the importer, which has to build the same
// indexed route document out of whatever GPX or KML the walker hands it.

const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export function haversine(aLat, aLon, bLat, bLon) {
  const p1 = aLat * DEG, p2 = bLat * DEG;
  const dp = p2 - p1, dl = (bLon - aLon) * DEG;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}

export function formatDistance(m) {
  if (m == null || !isFinite(m)) return '–';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

/** Distance split into number and unit, so the unit can be set smaller. */
export function splitDistance(m) {
  if (m == null || !isFinite(m)) return { value: '–', unit: '' };
  if (m < 1000) return { value: String(Math.round(m)), unit: 'm' };
  return { value: (m / 1000).toFixed(m < 10000 ? 2 : 1), unit: 'km' };
}

export function formatDuration(sec) {
  if (sec == null || !isFinite(sec) || sec <= 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

/**
 * An indexed route. Coordinates are projected to a local metre grid once, so
 * per-fix work is a plain loop over segments — fast enough to run every second
 * on a phone, which is why the importer thins the track before it gets here.
 */
export class Route {
  constructor(doc) {
    this.doc = doc;
    this.points = doc.points;                 // [[lat, lon, ele], …]
    this.cumulative = doc.cumulative;         // metres from start, per point
    this.total = doc.totalDistance;
    this.isLoop = !!doc.isLoop;

    const lat0 = (doc.bounds.minLat + doc.bounds.maxLat) / 2;
    this.mLat = 110574;
    this.mLon = 111320 * Math.cos(lat0 * DEG);
    this.xy = this.points.map(p => [p[1] * this.mLon, p[0] * this.mLat]);
  }

  latLngs() {
    return this.points.map(p => [p[0], p[1]]);
  }

  /**
   * Nearest point on the route to (lat, lon).
   *
   * `hintAlong` disambiguates a looping/doubling-back route: where two parts of
   * the route pass close together, prefer the candidate nearest to where the
   * walker already was. Without it, walking a loop that doubles back on itself
   * makes progress jump between the outbound and return legs.
   */
  project(lat, lon, hintAlong = null, hintWindow = 600) {
    const px = lon * this.mLon, py = lat * this.mLat;
    let best = null, bestHinted = null;

    for (let i = 0; i < this.xy.length - 1; i++) {
      const [ax, ay] = this.xy[i];
      const [bx, by] = this.xy[i + 1];
      const dx = bx - ax, dy = by - ay;
      const seg2 = dx * dx + dy * dy;
      let t = seg2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / seg2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      const along = this.cumulative[i] + t * (this.cumulative[i + 1] - this.cumulative[i]);
      const cand = { d2, along, lat: cy / this.mLat, lon: cx / this.mLon };

      if (!best || d2 < best.d2) best = cand;
      if (hintAlong != null && this._withinHint(along, hintAlong, hintWindow)) {
        if (!bestHinted || d2 < bestHinted.d2) bestHinted = cand;
      }
    }

    // Only trust the hinted match while it is a plausible fix (within ~120 m of
    // the route); otherwise fall back to the globally nearest point.
    const pick = (bestHinted && Math.sqrt(bestHinted.d2) < 120) ? bestHinted : best;
    return { along: pick.along, offset: Math.sqrt(pick.d2), lat: pick.lat, lon: pick.lon };
  }

  _withinHint(along, hint, window) {
    let d = Math.abs(along - hint);
    if (this.isLoop) d = Math.min(d, this.total - d); // wrap at the start/finish
    return d <= window;
  }

  /** Position on the route at `metres` from the start. */
  atDistance(metres) {
    const d = Math.max(0, Math.min(this.total, metres));
    const c = this.cumulative;
    let lo = 0, hi = c.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= d) lo = mid; else hi = mid;
    }
    const seg = c[hi] - c[lo];
    const t = seg === 0 ? 0 : (d - c[lo]) / seg;
    const a = this.points[lo], b = this.points[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
}

/**
 * Turns a stream of GPS fixes into a progress reading.
 *
 * `maxOffRoute` is how far from the line still counts as "on route". It is
 * deliberately generous: under canopy a phone fix can wander a long way, and
 * trails often run close enough together that a walker on the right path can
 * project a couple of hundred metres off it.
 *
 * A single fix that projects backwards is ignored; progress only gives ground
 * once the retreat persists across fixes or is too large to be noise. That
 * keeps "distance to finish" from flickering under canopy while still tracking
 * a genuine turnaround. Call reset() when a walker restarts the route.
 */
export class ProgressTracker {
  constructor(route, { maxOffRoute = 500 } = {}) {
    this.route = route;
    this.maxOffRoute = maxOffRoute;
    this.reset();
  }

  reset() {
    this.along = null;
    this.offset = null;
    this.onRoute = false;
    this.startedAt = null;
    this._backwards = 0;
    this._movingMs = 0;
    this._lastFixAt = null;
  }

  /**
   * The part of the state worth keeping across a reload: how far along, when
   * the walk began, and how long it has been in motion. The phone will kill
   * the tab at some point in a four-hour walk, and without this every reload
   * restarts the walker at zero with no ETA.
   */
  snapshot() {
    if (this.along == null) return null;
    return { along: this.along, startedAt: this.startedAt, movingMs: this._movingMs };
  }

  restore(snap) {
    if (!snap || typeof snap.along !== 'number' || !isFinite(snap.along)) return false;
    this.along = Math.max(0, Math.min(this.route.total, snap.along));
    this.startedAt = snap.startedAt ?? null;
    this._movingMs = snap.movingMs || 0;
    this._backwards = 0;
    // no fix yet: the gap since the last saved fix must not count as moving time
    this._lastFixAt = null;
    return true;
  }

  /** @returns {{along:number, remaining:number, fraction:number, offset:number, onRoute:boolean, speed:number|null, eta:number|null}} */
  update(lat, lon, at = Date.now()) {
    const fix = this.route.project(lat, lon, this.along);
    const onRoute = fix.offset <= this.maxOffRoute;
    const total = this.route.total;
    let candidate = fix.along;

    if (!onRoute) {
      // A fix this far from the line says nothing useful about progress: the
      // nearest point on a route that doubles back could be anywhere. Report
      // the walker as still at the start, so the walked/remaining split on the
      // line stays meaningful rather than jumping about. The last on-route
      // value is held internally, so stepping back onto the path resumes from
      // where they actually were.
      this.offset = fix.offset;
      this.onRoute = false;
      return {
        along: 0,
        remaining: total,
        fraction: 0,
        offset: fix.offset,
        onRoute: false,
        atStart: true,
        // Where they would rejoin the route. Progress above is deliberately
        // zeroed, but this point is still the right anchor for "how far to the
        // nearest toilet": off the route every walk starts by getting back to
        // the path, so distances measured from here are comparable with each
        // other, which straight lines from the walker are not.
        nearestAlong: fix.along,
        snapped: [fix.lat, fix.lon],
        speed: null,
        eta: null,
      };
    }

    if (this.route.isLoop) {
      // Start and finish are the same place, so a fix there projects equally well
      // to either end of the line. Resolve the tie by where the walker already is.
      if (this.along == null) {
        // opening the app on the start line must not read as "finished"
        if (candidate > total - 100) candidate = 0;
      } else if (this.along > total * 0.75 && candidate < total * 0.25) {
        candidate = total;              // closing the loop: this is the finish
      } else if (this.along < total * 0.25 && candidate > total * 0.75) {
        candidate = 0;                  // milling about behind the start line
      }
    }

    if (this.along == null) {
      this.along = candidate;
      this.startedAt = at;
    } else if (candidate >= this.along) {
      this.along = candidate;
      this._backwards = 0;
    } else {
      // Accept a backwards move only once it has persisted (a genuine turnaround
      // or a corrected fix), not on a single jittery sample.
      this._backwards++;
      if (this._backwards >= 3 || candidate - this.along < -150) {
        this.along = candidate;
        this._backwards = 0;
      }
    }

    if (this._lastFixAt != null) this._movingMs += Math.min(at - this._lastFixAt, 30000);
    this._lastFixAt = at;

    this.offset = fix.offset;
    this.onRoute = onRoute;

    const elapsed = this._movingMs / 1000;
    const speed = elapsed > 60 && this.along > 50 ? this.along / elapsed : null; // m/s
    const remaining = Math.max(0, this.route.total - this.along);

    return {
      along: this.along,
      remaining,
      fraction: this.route.total ? this.along / this.route.total : 0,
      offset: fix.offset,
      onRoute,
      snapped: [fix.lat, fix.lon],
      speed,
      eta: speed && speed > 0.15 ? remaining / speed : null,
    };
  }
}

// ── building a route document from raw points ────────────────────────
// The reference app shipped one route, indexed ahead of time by a Python
// script. Here the route arrives as a file on the walker's phone, so the same
// indexing has to happen in the browser — cumulative distances, bounds, the
// elevation profile and whether the thing is a loop.

/** Two points this close together are the same place: a loop, not an A-to-B. */
const LOOP_TOLERANCE_M = 60;

/**
 * Drop points that add nothing.
 *
 * A watch logging once a second produces tens of thousands of points for a day
 * on the hill, most of them within a metre of the line between their
 * neighbours. Ramer–Douglas–Peucker at a few metres keeps every bend that shows
 * on a map at zoom 19 and throws away the rest, which is what makes projecting
 * a fix onto the route cheap enough to run every second on a phone.
 *
 * Elevation rides along with the point it belongs to, so the profile survives.
 */
export function simplify(points, toleranceM = 4) {
  if (points.length < 3) return points.slice();
  const lat0 = points[0][0] * DEG;
  const mLat = 110574, mLon = 111320 * Math.cos(lat0);
  const xy = points.map(p => [p[1] * mLon, p[0] * mLat]);
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  // iterative, so a 100k-point track cannot blow the call stack
  const stack = [[0, points.length - 1]];
  const tol2 = toleranceM * toleranceM;
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [ax, ay] = xy[lo];
    const [bx, by] = xy[hi];
    const dx = bx - ax, dy = by - ay;
    const seg2 = dx * dx + dy * dy;
    let worst = -1, worstD2 = 0;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = xy[i];
      let t = seg2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / seg2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx) ** 2 + (py - cy) ** 2;
      if (d2 > worstD2) { worstD2 = d2; worst = i; }
    }
    if (worstD2 > tol2) {
      keep[worst] = 1;
      stack.push([lo, worst], [worst, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Every `stepM` metres along the route, as [lat, lon] — for corridor queries. */
export function sampleEvery(points, cumulative, stepM) {
  const out = [];
  const total = cumulative[cumulative.length - 1];
  let target = 0, i = 0;
  while (target <= total) {
    while (i < cumulative.length - 2 && cumulative[i + 1] < target) i++;
    const span = cumulative[i + 1] - cumulative[i];
    const t = span === 0 ? 0 : (target - cumulative[i]) / span;
    const a = points[i], b = points[i + 1] || points[i];
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    target += stepM;
  }
  const last = points[points.length - 1];
  out.push([last[0], last[1]]);
  return out;
}

/**
 * Total ascent, with the noise taken out.
 *
 * Barometric and GPS altitude both wander by a metre or two while standing
 * still, and summing every rise in a 10,000-point track turns that jitter into
 * hundreds of metres of imaginary climbing. Only a sustained gain of at least
 * `thresholdM` counts, which is what every GPS platform does.
 */
export function elevationGain(points, thresholdM = 5) {
  let gain = 0, anchor = null;
  for (const p of points) {
    const ele = p[2];
    if (ele == null || !isFinite(ele)) continue;
    if (anchor == null) { anchor = ele; continue; }
    if (ele > anchor + thresholdM) { gain += ele - anchor; anchor = ele; }
    else if (ele < anchor) anchor = ele;
  }
  return gain;
}

/**
 * Index raw [lat, lon, ele?] points into the document the app runs on.
 *
 * This is the browser-side equivalent of the reference app's build script: the
 * same fields, worked out from the walker's own file.
 */
export function buildRouteDoc(rawPoints, meta = {}) {
  const points = rawPoints
    .filter(p => isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180)
    .map(p => [
      Math.round(p[0] * 1e6) / 1e6,
      Math.round(p[1] * 1e6) / 1e6,
      p[2] == null || !isFinite(p[2]) ? null : Math.round(p[2] * 10) / 10,
    ]);
  if (points.length < 2) throw new Error('The file has fewer than two track points.');

  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    const step = haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    cumulative.push(cumulative[i - 1] + step);
  }
  const total = cumulative[cumulative.length - 1];
  if (!(total > 0)) throw new Error('Every point in the file is in the same place.');

  const lats = points.map(p => p[0]);
  const lons = points.map(p => p[1]);
  const eles = points.map(p => p[2]).filter(e => e != null);
  const endGap = haversine(points[0][0], points[0][1],
    points[points.length - 1][0], points[points.length - 1][1]);

  return {
    name: meta.name || 'Imported route',
    source: meta.source || '',
    format: meta.format || '',
    importedAt: Date.now(),
    totalDistance: Math.round(total * 10) / 10,
    // A loop only if the ends meet *and* the route is long enough that meeting
    // ends mean something; a 200 m out-and-back is not a loop.
    isLoop: endGap < LOOP_TOLERANCE_M && total > 500,
    bounds: {
      minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLon: Math.min(...lons), maxLon: Math.max(...lons),
    },
    elevation: eles.length
      ? { min: Math.round(Math.min(...eles) * 10) / 10,
          max: Math.round(Math.max(...eles) * 10) / 10,
          gain: Math.round(elevationGain(points)),
          source: meta.elevationSource || 'file' }
      : { min: null, max: null, gain: null, source: null },
    cumulative: cumulative.map(c => Math.round(c * 10) / 10),
    points,
  };
}

/**
 * Project a point onto a route document without building a whole Route.
 *
 * The importer needs this for every facility and landmark that comes back from
 * OpenStreetMap, before there is a live map to hang a Route off.
 */
export function projectOnto(doc, lat, lon) {
  const lat0 = (doc.bounds.minLat + doc.bounds.maxLat) / 2 * DEG;
  const mLat = 110574, mLon = 111320 * Math.cos(lat0);
  const px = lon * mLon, py = lat * mLat;
  let bestD2 = Infinity, bestAlong = 0;
  const pts = doc.points, cum = doc.cumulative;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * mLon, ay = pts[i][0] * mLat;
    const bx = pts[i + 1][1] * mLon, by = pts[i + 1][0] * mLat;
    const dx = bx - ax, dy = by - ay;
    const seg2 = dx * dx + dy * dy;
    let t = seg2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / seg2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx, cy = ay + t * dy;
    const d2 = (px - cx) ** 2 + (py - cy) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestAlong = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return { offset: Math.sqrt(bestD2), along: bestAlong };
}
