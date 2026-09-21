// Inline SVG icon set: one distinct shape + colour per marker category, plus
// weather glyphs. Inline so the whole app works offline with no sprite fetch,
// and so a pin can be drawn into a popup or a list row as plain markup.

export const CATEGORY = {
  aed:     { label: 'AED',              colour: '#ff3b4e', plural: 'AEDs' },
  toilet:  { label: 'Toilet',           colour: '#3b8cff', plural: 'Toilets' },
  water:   { label: 'Drinking water',   colour: '#17c5e0', plural: 'Water points' },
  vending: { label: 'Vending machine',  colour: '#c06bff', plural: 'Vending machines' },
  shelter: { label: 'Shelter hut',      colour: '#3fc46a', plural: 'Shelters & huts' },
  parking: { label: 'Car park',         colour: '#f5a524', plural: 'Car park' },
};

// Glyph paths are drawn inside a 24×24 box, centred on the pin head at (12, 10).
const GLYPHS = {
  // heart with a lightning bolt
  aed: '<path d="M12 15.6s-4.3-2.8-4.3-5.6a2.3 2.3 0 014.3-1.2 2.3 2.3 0 014.3 1.2c0 2.8-4.3 5.6-4.3 5.6z" fill="#fff"/>' +
       '<path d="M12.6 9.1l-1.7 2.2h1.3l-.8 1.9 1.9-2.3h-1.3z" fill="#ff3b4e"/>',
  // WC sign
  toilet: '<path d="M9.2 6.3a1.15 1.15 0 110 2.3 1.15 1.15 0 010-2.3zm-1.6 3h3.2l.9 4h-1.1v3.4H7.8V13.3H6.7zM14.8 6.3a1.15 1.15 0 110 2.3 1.15 1.15 0 010-2.3zm-2.1 3h4.2l-1.1 4.1h-.8v3.3h-2.2v-3.3h-.9z" fill="#fff"/>',
  // droplet
  water: '<path d="M12 5.4c2.5 3 3.8 5 3.8 6.7a3.8 3.8 0 11-7.6 0c0-1.7 1.3-3.7 3.8-6.7z" fill="#fff"/>' +
         '<path d="M10.2 12.4a1.8 1.8 0 001.8 1.8" stroke="#17c5e0" stroke-width="1.1" fill="none" stroke-linecap="round"/>',
  // vending machine cabinet
  vending: '<rect x="7.4" y="4.9" width="9.2" height="11.2" rx="1.3" fill="#fff"/>' +
           '<rect x="8.8" y="6.3" width="3.6" height="5.2" rx=".5" fill="#c06bff"/>' +
           '<path d="M13.8 6.5h1.6M13.8 8.2h1.6M13.8 9.9h1.6" stroke="#c06bff" stroke-width="1" stroke-linecap="round"/>' +
           '<rect x="8.8" y="12.9" width="6.6" height="1.9" rx=".5" fill="#c06bff"/>',
  // hut / shelter roof
  shelter: '<path d="M12 5.3l6.1 4.6h-1.6v5.6H7.5V9.9H5.9z" fill="#fff"/>' +
           '<path d="M10.5 15.5v-3.1h3v3.1z" fill="#3fc46a"/>',
  // parking "P"
  parking: '<text x="12" y="15.4" text-anchor="middle" font-size="12.5" font-weight="700"' +
           ' font-family="system-ui, sans-serif" fill="#fff">P</text>',
};

function pinSvg(colour, glyph) {
  return `<svg viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 29.2C12 29.2 21.6 18.4 21.6 11.6A9.6 9.6 0 002.4 11.6C2.4 18.4 12 29.2 12 29.2Z"
          fill="${colour}" stroke="rgba(0,0,0,.35)" stroke-width="1"/>
    ${glyph}
  </svg>`;
}

/** Leaflet divIcon for a POI category. */
export function poiIcon(category) {
  const meta = CATEGORY[category];
  return L.divIcon({
    className: 'pin',
    html: pinSvg(meta.colour, GLYPHS[category]),
    iconSize: [28, 35],
    iconAnchor: [14, 34],
    popupAnchor: [0, -30],
  });
}

/** Small standalone glyph for legends and layer lists. */
export function legendIcon(category) {
  return `<svg class="ico" viewBox="0 0 24 30">${pinSvg(CATEGORY[category].colour, GLYPHS[category]).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`;
}

/** Start / finish flag, or a numbered checkpoint disc. */
export function checkpointIcon(kind, label) {
  const colour = kind === 'start' ? '#35d39a' : kind === 'finish' ? '#ffb648' : '#ffffff';
  const ink = '#062018';
  const html = kind === 'start' || kind === 'finish'
    ? `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
         <circle cx="12" cy="12" r="10.4" fill="${colour}" stroke="rgba(0,0,0,.4)" stroke-width="1.1"/>
         <path d="M9 5.6v13" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>
         <path d="M9.9 6.6h6.4l-1.5 2.6 1.5 2.6H9.9z" fill="${ink}"/>
       </svg>`
    : `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
         <circle cx="12" cy="12" r="10.4" fill="${colour}" stroke="rgba(0,0,0,.4)" stroke-width="1.1"/>
         <text x="12" y="16.3" text-anchor="middle" font-size="12.5" font-weight="700"
               font-family="system-ui, sans-serif" fill="${ink}">${label}</text>
       </svg>`;
  // Facility pins are teardrops whose tip marks the spot, so their body sits
  // *above* it. Checkpoint discs therefore hang just *below* their spot: the
  // disc's top edge is the true position, and the two never collide even when a
  // checkpoint and a facility share a location, which they routinely do — a
  // named hut is both a landmark and a shelter.
  return L.divIcon({
    className: 'pin pin-cp',
    html,
    iconSize: [23, 23],
    iconAnchor: [11.5, -2],
    popupAnchor: [0, -2],
  });
}

/**
 * Icon for a cluster of facilities sitting on top of each other.
 *
 * Rather than an anonymous count bubble, it shows which kinds of facility are
 * in there: up to four category glyphs in a grid, so "toilet + water + AED" at
 * the ranger station reads at a glance without zooming in.
 */
export function clusterIcon(counts, total) {
  const order = Object.keys(CATEGORY).filter(c => counts[c]);
  const shown = order.slice(0, 4);
  const extra = total - shown.reduce((n, c) => n + counts[c], 0);
  const cols = shown.length <= 1 ? 1 : 2;
  const size = shown.length <= 1 ? 32 : 38;

  const cells = shown.map(cat => `
    <span class="cl-cell" style="background:${CATEGORY[cat].colour}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${GLYPHS[cat]}</svg>
      ${counts[cat] > 1 ? `<i>${counts[cat]}</i>` : ''}
    </span>`).join('');

  // Anchored bottom-centre, like the teardrop pins: the tile sits above its
  // location, leaving the space below free for a checkpoint disc.
  return L.divIcon({
    className: 'cluster',
    html: `<div class="cl-grid" style="grid-template-columns:repeat(${cols},1fr)">${cells}</div>` +
          (extra > 0 ? `<b class="cl-more">+${extra}</b>` : ''),
    iconSize: [size, size],
    iconAnchor: [size / 2, size + 2],
    popupAnchor: [0, -size],
  });
}

/** Pulsing "you are here" dot. */
// The facing arrow. It lives in its own layer inside the icon so it can be
// rotated on its own: Leaflet drives the marker element's own transform to
// position it, and writing a rotation there would fight the map.
const FACING = '<svg viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">'
  + '<path d="M8 1.5 14.3 12.3H1.7z" fill="#3b8cff" stroke="#fff" stroke-width="1.9"'
  + ' stroke-linejoin="round"/></svg>';

export function meIcon() {
  return L.divIcon({
    className: 'me-dot',
    html: `<div class="ping"></div><div class="heading">${FACING}</div><div class="core"></div>`,
    // roomy enough for the arrow to swing clear of the dot; the dot itself is
    // still drawn at its old 22 px, centred in the box
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}

// ── weather glyphs ───────────────────────────────────────────────────
const SUN = '<circle cx="12" cy="12" r="4.4" fill="#ffc83d"/><g stroke="#ffc83d" stroke-width="1.8" stroke-linecap="round"><path d="M12 3v2.4M12 18.6V21M21 12h-2.4M5.4 12H3M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7M18.4 18.4l-1.7-1.7M7.3 7.3L5.6 5.6"/></g>';
const MOON = '<path d="M15.6 15.2A6.3 6.3 0 019.1 6a7 7 0 106.5 9.2z" fill="#cbd8ff"/>';
const CLOUD = '<path d="M7.6 18.4a4 4 0 01-.4-8 5.5 5.5 0 0110.5 1.3 3.4 3.4 0 01-.5 6.7z" fill="#c9d6e2"/>';
const CLOUD_DARK = '<path d="M7.6 18.4a4 4 0 01-.4-8 5.5 5.5 0 0110.5 1.3 3.4 3.4 0 01-.5 6.7z" fill="#8fa3b5"/>';
const rain = n => {
  const xs = n === 1 ? [12] : n === 2 ? [9.6, 14.4] : [8.4, 12, 15.6];
  return `<g stroke="#4fa8ff" stroke-width="1.9" stroke-linecap="round">${
    xs.map(x => `<path d="M${x} 19.4l-1 2.6"/>`).join('')}</g>`;
};
const BOLT = '<path d="M12.7 17.6l-2.9 3.9h2.2l-1.3 3.4" fill="none"/><path d="M13.4 17.2l-3.6 4.5h2.3l-.7 2.6 3.6-4.7h-2.3z" fill="#ffc83d"/>';
const WIND = '<g stroke="#a9bccd" stroke-width="1.8" stroke-linecap="round" fill="none"><path d="M3.5 9.5h9.2a2.4 2.4 0 10-2.4-2.4"/><path d="M3.5 14h12a2.4 2.4 0 11-2.4 2.4"/></g>';
const MIST = '<g stroke="#b6c6d4" stroke-width="1.9" stroke-linecap="round"><path d="M4 9h16M4 13h16M4 17h11"/></g>';
const HAZE = `${SUN.replace(/r="4.4"/, 'r="3.6"')}<g stroke="#d6b06a" stroke-width="1.8" stroke-linecap="round"><path d="M4 17h16M6.5 20.5h11"/></g>`;

// NEA forecast codes → glyph. See the two-hour / 24-hour forecast API docs.
const WX = {
  BR: MIST, FG: MIST, HZ: HAZE, LH: HAZE,
  CL: CLOUD, OC: CLOUD_DARK,
  FA: SUN, SU: SUN, FN: MOON,
  PC: CLOUD + '<circle cx="16.6" cy="7.6" r="3.2" fill="#ffc83d"/>',
  PN: CLOUD + '<path d="M18.6 9.1a3.2 3.2 0 01-3.3-4.6 3.5 3.5 0 103.3 4.6z" fill="#cbd8ff"/>',
  DR: CLOUD + rain(1), LR: CLOUD + rain(1), LS: CLOUD + rain(1), PS: CLOUD + rain(1),
  RA: CLOUD_DARK + rain(2), SH: CLOUD + rain(2),
  HR: CLOUD_DARK + rain(3), HS: CLOUD_DARK + rain(3),
  TL: CLOUD_DARK + BOLT, HT: CLOUD_DARK + BOLT + rain(2), HG: CLOUD_DARK + BOLT + rain(2),
  WD: WIND, SW: WIND, WC: CLOUD + WIND,
  WF: SUN, WR: CLOUD_DARK + rain(2), WS: CLOUD + rain(2), SR: CLOUD_DARK + rain(3), SK: CLOUD_DARK + rain(2),
  SN: MIST,
};

/** SVG markup for a NEA forecast code (falls back to a plain cloud). */
export function weatherIcon(code) {
  return `<svg class="wx-ico" viewBox="0 0 24 24" aria-hidden="true">${WX[code] || CLOUD}</svg>`;
}
