// Reading the walker's own route file.
//
// The reference app shipped a single route, indexed by a build script before
// the app was ever opened. Here the route is whatever GPX or KML somebody
// exported from their watch, from Strava, Komoot, AllTrails, Google Earth or
// Gaia, so the parsing has to be forgiving: namespaces vary, coordinate
// separators vary, elevation is often missing, and a "route" may arrive as a
// track, a route, or a line drawn in Google Earth.
//
// Everything here runs in the browser. Nothing is uploaded anywhere — the file
// is read with the File API and stays on the device.

import { buildRouteDoc, haversine, simplify } from './geo.js';

// Tracks logged once a second are mostly redundant points; this is the tolerance
// the line is thinned to. At 4 m it is invisible at the deepest zoom the map
// offers and keeps the per-fix projection loop short.
const SIMPLIFY_M = 4;
// A track with more points than this is thinned harder: some watch exports run
// to 100k points, and every one of them is walked on every GPS fix.
const BIG_TRACK = 12000;
const BIG_SIMPLIFY_M = 8;

// A waypoint this close to an end of the track is that end, named by the file.
const ENDPOINT_SNAP_M = 80;

/** Names a file uses for the beginning and the end of the route. */
const START_WORDS = /^(start|begin|beginning|startpunt|depart|départ|flag.?off|trailhead|start\s*[/|-]?\s*finish|start\s*point)$/i;
const FINISH_WORDS = /^(finish|end|endpoint|end\s*point|final|goal|arrivee|arrivée|ziel|finish\s*line)$/i;

const localName = el => el.localName || el.nodeName.replace(/^.*:/, '');

/**
 * Every descendant with this local name, whatever namespace it carries.
 *
 * The namespace wildcard matters: GPX files come with the topografix
 * namespace, Garmin and Strava add their own extensions on top, KML may or may
 * not declare the gx: extension its own <gx:Track> lives in, and a file saved
 * out of a text editor may declare nothing at all. Matching on the local name
 * treats all of them the same.
 */
function tags(root, name) {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function textOf(parent, name) {
  for (const child of parent.children) {
    if (localName(child) === name) return (child.textContent || '').trim();
  }
  return '';
}

/**
 * A number, or null.
 *
 * The empty string matters here: `Number('')` is 0, and a GPX point with no
 * <ele> — or an empty one, which several exporters write — would otherwise
 * arrive as "at sea level" rather than "unknown". Every point then reads as
 * flat, the ascent comes out as 0 m, and the terrain lookup that would have
 * filled it in never runs because the elevation looks present.
 */
function num(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ── the entry point ──────────────────────────────────────────────────

/**
 * Read a .gpx, .kml or .kmz file into a route document plus its waypoints.
 *
 * @param {File|Blob} file
 * @returns {Promise<{doc: object, waypoints: Array, warnings: string[]}>}
 */
export async function readRouteFile(file) {
  const name = (file.name || '').toLowerCase();
  let text;
  let format;

  if (name.endsWith('.kmz') || (await looksLikeZip(file))) {
    text = await readKmzEntry(file);
    format = 'kmz';
  } else {
    text = await file.text();
    format = name.endsWith('.kml') ? 'kml' : name.endsWith('.gpx') ? 'gpx' : '';
  }

  // Strip a byte-order mark: XML parsers reject it as content before the
  // declaration, and Windows tools emit it constantly.
  text = text.replace(/^﻿/, '').trim();
  if (!text) throw new Error('The file is empty.');

  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const bad = doc.querySelector('parsererror');
  if (bad) throw new Error('That file is not valid XML — it may be damaged or not a GPX/KML file.');

  const root = doc.documentElement;
  const rootName = localName(root).toLowerCase();
  if (!format) format = rootName === 'gpx' ? 'gpx' : rootName === 'kml' ? 'kml' : '';

  const parsed = rootName === 'gpx' ? parseGpx(doc)
    : rootName === 'kml' ? parseKml(doc)
      : null;
  if (!parsed) {
    throw new Error(`Unrecognised file: the document starts with <${localName(root)}>, `
      + 'but a route file starts with <gpx> or <kml>.');
  }

  const warnings = parsed.warnings;
  if (!parsed.points.length) {
    throw new Error(format === 'gpx'
      ? 'No track or route points in that GPX — it may be a waypoint-only file.'
      : 'No line found in that KML — a route needs a path (LineString or Track), not just pins.');
  }

  const raw = dedupe(parsed.points);
  const tol = raw.length > BIG_TRACK ? BIG_SIMPLIFY_M : SIMPLIFY_M;
  const points = simplify(raw, tol);
  if (raw.length - points.length > 50) {
    warnings.push(`Thinned ${raw.length.toLocaleString()} track points to `
      + `${points.length.toLocaleString()} — the line is unchanged on the map.`);
  }

  const routeDoc = buildRouteDoc(points, {
    name: parsed.name || fileStem(file.name) || 'Imported route',
    source: file.name || '',
    format,
  });
  routeDoc.rawPointCount = raw.length;

  const waypoints = attachWaypoints(parsed.waypoints, routeDoc);
  return { doc: routeDoc, waypoints, warnings };
}

function fileStem(name = '') {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
}

/** Consecutive points in the same place add nothing but work. */
function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && haversine(last[0], last[1], p[0], p[1]) < 0.5) continue;
    out.push(p);
  }
  return out;
}

// ── GPX ──────────────────────────────────────────────────────────────
// Track first, route second. A file with both is normally a recorded track
// alongside the plan that produced it, and the recording is the better line.

function parseGpx(doc) {
  const warnings = [];
  const points = [];

  const trkpts = tags(doc, 'trkpt');
  if (trkpts.length) {
    const segments = tags(doc, 'trkseg').length;
    if (segments > 1) {
      warnings.push(`The track has ${segments} segments (a paused recording); `
        + 'they are joined end to end in the order the file lists them.');
    }
    for (const pt of trkpts) points.push(gpxPoint(pt));
  } else {
    for (const pt of tags(doc, 'rtept')) points.push(gpxPoint(pt));
    if (points.length) warnings.push('Read from the file\'s <rte> route — it has no recorded track.');
  }

  const waypoints = tags(doc, 'wpt').map((wpt, i) => ({
    id: `wpt${i + 1}`,
    name: textOf(wpt, 'name') || `Waypoint ${i + 1}`,
    note: textOf(wpt, 'desc') || textOf(wpt, 'cmt') || '',
    sym: textOf(wpt, 'sym') || '',
    lat: num(wpt.getAttribute('lat')),
    lon: num(wpt.getAttribute('lon')),
  })).filter(w => w.lat != null && w.lon != null);

  const meta = tags(doc, 'metadata')[0];
  const name = (meta && textOf(meta, 'name'))
    || (tags(doc, 'trk')[0] && textOf(tags(doc, 'trk')[0], 'name'))
    || (tags(doc, 'rte')[0] && textOf(tags(doc, 'rte')[0], 'name'))
    || '';

  return { points: points.filter(Boolean), waypoints, name, warnings };
}

function gpxPoint(pt) {
  const lat = num(pt.getAttribute('lat'));
  const lon = num(pt.getAttribute('lon'));
  if (lat == null || lon == null) return null;
  const ele = num(textOf(pt, 'ele'));
  return [lat, lon, ele];
}

// ── KML ──────────────────────────────────────────────────────────────
// Three shapes carry a line: <LineString> (Google Earth, most exporters),
// <gx:Track> (Google's recorded-track extension, one coordinate per <gx:coord>)
// and <LinearRing>, which is what a closed loop drawn as a polygon comes out as.

function parseKml(doc) {
  const warnings = [];
  let points = [];
  let lineName = '';

  const tracks = tags(doc, 'Track');
  const lines = tags(doc, 'LineString');
  const rings = tags(doc, 'LinearRing');

  if (tracks.length) {
    for (const track of tracks) {
      for (const coord of tags(track, 'coord')) {
        const [lon, lat, ele] = (coord.textContent || '').trim().split(/\s+/).map(num);
        if (lat != null && lon != null) points.push([lat, lon, ele ?? null]);
      }
    }
    lineName = placemarkName(tracks[0]);
  }

  if (!points.length && lines.length) {
    // Several placemarks each holding a leg is common in hand-drawn KML; they
    // are joined in document order, which is the order they were drawn.
    const usable = lines
      .map(line => ({ line, coords: parseCoordinates(line) }))
      .filter(entry => entry.coords.length >= 2);
    if (usable.length > 1) {
      warnings.push(`The file holds ${usable.length} separate lines; `
        + 'they are joined end to end in the order the file lists them.');
    }
    for (const entry of usable) points = points.concat(entry.coords);
    if (usable[0]) lineName = placemarkName(usable[0].line);
  }

  if (!points.length && rings.length) {
    points = parseCoordinates(rings[0]);
    lineName = placemarkName(rings[0]);
    if (points.length) warnings.push('Read from a closed shape (LinearRing) — treated as a loop.');
  }

  // Pins: a Placemark whose only geometry is a Point.
  const waypoints = [];
  tags(doc, 'Placemark').forEach((pm, i) => {
    const point = tags(pm, 'Point')[0];
    if (!point) return;
    const coords = parseCoordinates(point);
    if (!coords.length) return;
    waypoints.push({
      id: `pin${i + 1}`,
      name: textOf(pm, 'name') || `Point ${waypoints.length + 1}`,
      note: stripHtml(textOf(pm, 'description')),
      sym: '',
      lat: coords[0][0],
      lon: coords[0][1],
    });
  });

  const docEl = tags(doc, 'Document')[0];
  const name = (docEl && textOf(docEl, 'name')) || lineName || '';
  return { points, waypoints, name, warnings };
}

function placemarkName(el) {
  let node = el;
  while (node && localName(node) !== 'Placemark') node = node.parentElement;
  return node ? textOf(node, 'name') : '';
}

/**
 * KML coordinate lists: "lon,lat[,ele]" tuples separated by any whitespace.
 *
 * Exporters disagree about the separators — some put each tuple on its own
 * line, some run them together with spaces, and a few leave spaces after the
 * commas — so both are treated as separators and the tuples rebuilt.
 */
function parseCoordinates(el) {
  const node = tags(el, 'coordinates')[0] || (localName(el) === 'coordinates' ? el : null);
  if (!node) return [];
  const out = [];
  for (const chunk of (node.textContent || '').trim().split(/\s+/)) {
    if (!chunk) continue;
    const parts = chunk.split(',');
    if (parts.length < 2) continue;
    const lon = num(parts[0]), lat = num(parts[1]), ele = num(parts[2]);
    if (lat == null || lon == null) continue;
    out.push([lat, lon, ele]);
  }
  return out;
}

function stripHtml(s = '') {
  if (!s.includes('<')) return s.trim();
  const div = document.createElement('div');
  div.innerHTML = s;
  return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

// ── waypoints → checkpoints ──────────────────────────────────────────
// The start and the finish come from the route file, as asked: the first and
// last point of the line. Where the file also carries a pin sitting on one of
// those ends, its name is used — so "Flag-off, Marina Barrage" beats a bare
// "Start" — and the pin is not then repeated as a checkpoint of its own.

function attachWaypoints(waypoints, doc) {
  const first = doc.points[0];
  const last = doc.points[doc.points.length - 1];
  const out = [];

  for (const w of waypoints) {
    const dStart = haversine(w.lat, w.lon, first[0], first[1]);
    const dEnd = haversine(w.lat, w.lon, last[0], last[1]);
    let role = null;
    if (dStart <= ENDPOINT_SNAP_M && dStart <= dEnd) role = 'start';
    else if (dEnd <= ENDPOINT_SNAP_M) role = 'finish';
    // a pin named "Start" far from either end is a label, not an endpoint
    if (!role && START_WORDS.test(w.name.trim())) role = 'start-named';
    if (!role && FINISH_WORDS.test(w.name.trim())) role = 'finish-named';
    out.push({ ...w, role });
  }
  return out;
}

// ── KMZ ──────────────────────────────────────────────────────────────
// A KMZ is a zip holding one KML and whatever images it references. Rather
// than shipping a zip library for one file format, the archive is read
// directly: the central directory says where each entry starts and how it is
// stored, and the browser's own DecompressionStream inflates it.

async function looksLikeZip(file) {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

async function readKmzEntry(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);

  // End of central directory: fixed 22-byte record, possibly followed by a
  // comment, so it is found by scanning back from the end for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That .kmz is not a readable zip archive.');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressed, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Google Earth always names it doc.kml; other tools do not, so any .kml at
  // the shallowest depth wins.
  const kml = entries.find(e => e.name.toLowerCase() === 'doc.kml')
    || entries.filter(e => /\.kml$/i.test(e.name))
      .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!kml) throw new Error('That .kmz has no .kml inside it.');

  // The local header repeats the name and extra fields with its own lengths,
  // which are the ones that say where the data actually begins.
  const localNameLen = view.getUint16(kml.offset + 26, true);
  const localExtraLen = view.getUint16(kml.offset + 28, true);
  const start = kml.offset + 30 + localNameLen + localExtraLen;
  const body = buf.subarray(start, start + kml.compressed);

  if (kml.method === 0) return new TextDecoder().decode(body);
  if (kml.method !== 8) throw new Error(`That .kmz uses an unsupported compression method (${kml.method}).`);
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot unzip a .kmz — unzip it yourself and open the .kml inside.');
  }
  const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}
