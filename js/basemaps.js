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

// Phones draw two or three device pixels for every CSS pixel, and a 256 px tile
// stretched across 256 CSS pixels is therefore stretched across 768 device
// pixels — which is exactly as sharp as it sounds. `detectRetina` makes Leaflet
// fetch the next zoom level down and draw it at half size, so a tile's own
// pixels land roughly one-for-one on the screen's.
//
// It costs four times as many tile requests, which is a real price on mobile
// data and the reason it is not free. It is worth paying: this app's whole
// proposition is reading a map outdoors on a phone, and none of the rest of it
// matters if the map is mush.
//
// The zoom bookkeeping matters. `detectRetina` lowers a layer's own maxZoom by
// one, and a layer whose maxZoom is under the map's goes *blank* at the deepest
// zooms rather than scaling up. So each layer declares maxNativeZoom — the
// deepest the provider actually publishes — and a maxZoom one above it, leaving
// room for the decrement while maxNativeZoom keeps requests inside what exists.
const RETINA = { detectRetina: true, crossOrigin: 'anonymous' };

export const BASEMAPS = [
  {
    id: 'topo-esri',
    name: 'Topographic',
    note: 'Esri World Topo — contours, paths and place names worldwide, and the best of these to save for offline.',
    tint: '#e9e4d8',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    opts: { ...RETINA, maxNativeZoom: 19, maxZoom: 20, attribution: ESRI_TOPO_ATTR },
  },
  {
    id: 'opentopo',
    name: 'OpenTopoMap',
    note: 'Contour lines, hillshading and marked hiking routes, drawn from OpenStreetMap. Zooms to 17.',
    tint: '#f0ece1',
    tiles: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    opts: {
      // maxZoom is the map's, not the provider's: a layer whose maxZoom is
      // below the map's disappears at deeper zooms instead of scaling its last
      // real tiles up, which is a blank screen where a slightly soft one would
      // do. maxNativeZoom is what stops it asking for tiles nobody publishes.
      ...RETINA, maxNativeZoom: 17, maxZoom: 20, subdomains: 'abc',
      attribution: `${OSM_ATTR}, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    },
    noSave: OTM_NO_SAVE,
  },
  {
    id: 'satellite',
    name: 'Satellite',
    note: 'Esri World Imagery. Canopy hides the trail surface in closed forest, but it settles what the ground is.',
    tint: '#3f5340',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    opts: { ...RETINA, maxNativeZoom: 19, maxZoom: 20,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' },
  },
  {
    id: 'osm',
    name: 'Street (OSM)',
    note: 'OpenStreetMap standard — the same data the facility markers come from.',
    tint: '#f2efe9',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    opts: { ...RETINA, maxNativeZoom: 19, maxZoom: 20, attribution: OSM_ATTR },
    noSave: OSM_NO_SAVE,
  },
  {
    id: 'onemap',
    name: 'OneMap (SLA)',
    note: 'Official SLA national basemap — park connectors, trails and nature-reserve paths.',
    tint: '#e8e3d8',
    tiles: 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png',
    opts: { ...RETINA, minZoom: 11, maxNativeZoom: 19, maxZoom: 20, attribution: ONEMAP_ATTR },
    // The tiles cover Singapore and a thin margin of Johor; anywhere else they
    // come back blank, so the map is not offered for a route outside that.
    onlyWithin: { minLat: 1.13, maxLat: 1.50, minLon: 103.58, maxLon: 104.12 },
  },
];

/**
 * The base maps worth offering for a route in these bounds, best first.
 *
 * A national mapping agency's own basemap beats a global one over the ground it
 * covers — OneMap has the park connectors, the nature-reserve paths and the
 * block numbers that no worldwide basemap carries — so where one applies it
 * leads the list and becomes the default. Everywhere else the global
 * topographic map does.
 */
export function basemapsFor(bounds) {
  const within = box => bounds.minLat >= box.minLat && bounds.maxLat <= box.maxLat
    && bounds.minLon >= box.minLon && bounds.maxLon <= box.maxLon;
  const offered = BASEMAPS.filter(spec => !spec.onlyWithin || within(spec.onlyWithin));
  const regional = offered.filter(spec => spec.onlyWithin);
  return [...regional, ...offered.filter(spec => !spec.onlyWithin)];
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
