// The base maps under the route.
//
// The reference app was built around one route in one country, so it could lean
// on OneMap, Singapore's official national basemap. A route file can land
// anywhere, so the list here is global first: a topographic map for the hill, an
// aerial for the ground truth, and the street map the facility data itself comes
// from. OneMap is still offered, but only when the route is actually in
// Singapore, where it remains the best map of the park connectors and the
// nature-reserve paths by some distance.

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_TOPO_ATTR = 'Tiles &copy; Esri — Esri, DeLorme, NAVTEQ, TomTom, USGS, NRCAN and the GIS user community';
const ONEMAP_ATTR =
  'Map data &copy; <a href="https://www.onemap.gov.sg/">OneMap</a> / Singapore Land Authority';

// Bulk-downloading is a different thing from browsing, and two of these maps
// are run on donated infrastructure whose usage policy says so in as many
// words. They stay browsable and are simply not offered for the offline save.
const OSM_NO_SAVE =
  'OpenStreetMap asks apps not to bulk-download its tiles, so this one stays online-only.';
const OTM_NO_SAVE =
  'OpenTopoMap is a volunteer-run server with a strict fair-use policy, so it stays online-only.';

export const BASEMAPS = [
  {
    id: 'topo-esri',
    name: 'Topographic',
    note: 'Esri World Topo — contours, paths and place names worldwide, and the best of these to save for offline.',
    tint: '#e9e4d8',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, attribution: ESRI_TOPO_ATTR, crossOrigin: 'anonymous' },
  },
  {
    id: 'opentopo',
    name: 'OpenTopoMap',
    note: 'Contour lines, hillshading and marked hiking routes, drawn from OpenStreetMap. Zooms to 17.',
    tint: '#f0ece1',
    tiles: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opts: {
      maxZoom: 17, maxNativeZoom: 17, subdomains: 'abc',
      attribution: `${OSM_ATTR}, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
      crossOrigin: 'anonymous',
    },
    noSave: OTM_NO_SAVE,
  },
  {
    id: 'satellite',
    name: 'Satellite',
    note: 'Esri World Imagery. Canopy hides the trail surface in closed forest, but it settles what the ground is.',
    tint: '#3f5340',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics', crossOrigin: 'anonymous' },
  },
  {
    id: 'osm',
    name: 'Street (OSM)',
    note: 'OpenStreetMap standard — the same data the facility markers come from.',
    tint: '#f2efe9',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { maxZoom: 19, attribution: OSM_ATTR, crossOrigin: 'anonymous' },
    noSave: OSM_NO_SAVE,
  },
  {
    id: 'onemap',
    name: 'OneMap (SLA)',
    note: 'Official SLA national basemap — park connectors, trails and nature-reserve paths.',
    tint: '#e8e3d8',
    tiles: 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
    opts: { minZoom: 11, maxZoom: 19, attribution: ONEMAP_ATTR, crossOrigin: 'anonymous' },
    // The tiles cover Singapore and a thin margin of Johor; anywhere else they
    // come back blank, so the map is not offered for a route outside that.
    onlyWithin: { minLat: 1.13, maxLat: 1.50, minLon: 103.58, maxLon: 104.12 },
  },
];

/** The base maps worth offering for a route in these bounds. */
export function basemapsFor(bounds) {
  return BASEMAPS.filter(spec => {
    const box = spec.onlyWithin;
    if (!box) return true;
    return bounds.minLat >= box.minLat && bounds.maxLat <= box.maxLat
      && bounds.minLon >= box.minLon && bounds.maxLon <= box.maxLon;
  });
}

/**
 * One concrete tile URL from a template.
 *
 * Used by the layer picker's thumbnails and by the offline save, neither of
 * which goes through Leaflet, so both need the {s} subdomain placeholder
 * resolved the same way Leaflet would.
 */
export function tileUrl(spec, z, x, y) {
  const subdomains = spec.opts.subdomains || 'abc';
  const s = typeof subdomains === 'string' ? subdomains[(x + y) % subdomains.length]
    : subdomains[(x + y) % subdomains.length];
  return spec.tiles
    .replace('{s}', s)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y);
}

/** Every hostname the base maps fetch from, for the service worker's tile rules. */
export function tileHosts() {
  return [...new Set(BASEMAPS.map(spec => {
    const url = spec.tiles.replace('{s}', 'a');
    return new URL(url).hostname;
  }))];
}
