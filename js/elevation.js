// Filling in the climbing.
//
// "How much ascent is left" is one of the few numbers a walker on a hill
// actually acts on, and plenty of route files cannot answer it: a route drawn
// in Google Earth or exported from a planner often carries no elevation at all,
// and a phone-logged GPX carries GPS altitude, which is noisy enough to invent
// a few hundred metres of imaginary climbing over a long day.
//
// Where the file has no elevation, it is sampled from Open-Meteo's open
// elevation service (Copernicus DEM, 90 m). Keyless, CORS-enabled, and the
// result is stored with the route so it is fetched once.

import { elevationGain } from './geo.js';

const API = 'https://api.open-meteo.com/v1/elevation';
// The service takes up to 100 coordinates per request.
const BATCH = 100;
// Six requests is enough shape for an ascent figure; beyond that the DEM's own
// 90 m resolution is the limit, not the sampling.
const MAX_SAMPLES = 600;

/**
 * Sample terrain height along the route and write it into the document.
 *
 * Mutates and returns `doc`. A failure is not an error the walker needs to see:
 * the map, the progress bar and every facility work exactly the same without an
 * ascent figure, so the caller simply carries on.
 */
export async function fillElevation(doc, { signal } = {}) {
  const n = doc.points.length;
  const step = Math.max(1, Math.ceil(n / MAX_SAMPLES));
  const indices = [];
  for (let i = 0; i < n; i += step) indices.push(i);
  if (indices[indices.length - 1] !== n - 1) indices.push(n - 1);

  const heights = [];
  for (let i = 0; i < indices.length; i += BATCH) {
    const slice = indices.slice(i, i + BATCH);
    const url = `${API}?latitude=${slice.map(j => doc.points[j][0].toFixed(5)).join(',')}`
      + `&longitude=${slice.map(j => doc.points[j][1].toFixed(5)).join(',')}`;
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`elevation: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.elevation)) throw new Error('elevation: unexpected response');
    heights.push(...body.elevation);
  }
  if (heights.length !== indices.length) throw new Error('elevation: short response');

  // Write the sampled heights onto their own points, then straight-line between
  // them. The gain calculation ignores anything under its threshold, so the
  // interpolation cannot manufacture climbing that is not there.
  for (let k = 0; k < indices.length; k++) {
    const height = heights[k];
    if (height == null || !isFinite(height)) continue;
    doc.points[indices[k]][2] = Math.round(height * 10) / 10;
    if (k === 0) continue;
    const a = indices[k - 1], b = indices[k];
    const from = doc.points[a][2];
    if (from == null) continue;
    for (let j = a + 1; j < b; j++) {
      doc.points[j][2] = Math.round((from + (height - from) * ((j - a) / (b - a))) * 10) / 10;
    }
  }

  const eles = doc.points.map(p => p[2]).filter(e => e != null);
  if (!eles.length) throw new Error('elevation: nothing usable came back');
  doc.elevation = {
    min: Math.round(Math.min(...eles) * 10) / 10,
    max: Math.round(Math.max(...eles) * 10) / 10,
    gain: Math.round(elevationGain(doc.points)),
    source: 'dem',
  };
  return doc;
}
