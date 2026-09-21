// Synthetic route files for the end-to-end test.
//
// A loop in Singapore, so the NEA weather path is exercised, and a climb in the
// Alps, so the Open-Meteo one is. Both are generated rather than checked in:
// they are geometry, and geometry a test can describe in ten lines should not
// be a binary blob nobody can read a diff of.
//
//   node test/fixtures.js     writes them to test/tmp/
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'tmp');

function loop({ lat0 = 1.3565, lon0 = 1e-9 + 103.8195, n = 240, r = 0.007, ele = true } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    const lat = lat0 + r * Math.sin(a) * 0.8;
    const lon = lon0 + r * Math.cos(a);
    pts.push([lat, lon, ele ? 30 + 40 * Math.sin(a * 2) : null]);
  }
  return pts;
}

// A zigzagging climb rather than a straight line: a straight line simplifies
// down to its two endpoints, which would make the ascent test meaningless.
function line({ lat0 = 46.5, lon0 = 7.9, n = 120 } = {}) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    pts.push([lat0 + t * 0.03 + 0.0012 * Math.sin(t * 14), lon0 + t * 0.022, null]);
  }
  return pts;
}

function gpx(pts, { name = 'Test Loop', wpts = [] } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${name}</name></metadata>
${wpts.map(w => `<wpt lat="${w[0]}" lon="${w[1]}"><name>${w[2]}</name></wpt>`).join('\n')}
<trk><name>${name}</name><trkseg>
${pts.map(p => `<trkpt lat="${p[0]}" lon="${p[1]}">${p[2] != null ? `<ele>${p[2]}</ele>` : ''}</trkpt>`).join('\n')}
</trkseg></trk></gpx>`;
}

function kml(pts, { name = 'Test KML' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${name}</name>
<Placemark><name>Water point</name><Point><coordinates>${pts[10][1]},${pts[10][0]},0</coordinates></Point></Placemark>
<Placemark><name>${name}</name><LineString><coordinates>
${pts.map(p => `${p[1]},${p[0]},${p[2] ?? 0}`).join(' ')}
</coordinates></LineString></Placemark>
</Document></kml>`;
}

/** A minimal zip holding one deflated doc.kml — a real .kmz. */
function kmz(kmlText) {
  const name = Buffer.from('doc.kml');
  const raw = Buffer.from(kmlText, 'utf8');
  const body = zlib.deflateRawSync(raw);
  const crc = zlib.crc32 ? zlib.crc32(raw) : crc32(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10); local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(0, 12);
  central.writeUInt32LE(crc >>> 0, 16); central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(0, 42);
  const offset = local.length + name.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, name, body, central, name, eocd]);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

module.exports = { loop, line, gpx, kml, kmz, OUT };

function write() {
  fs.mkdirSync(OUT, { recursive: true });
  const pts = loop();
  fs.writeFileSync(path.join(OUT, 'loop.gpx'), gpx(pts, { wpts: [[pts[0][0], pts[0][1], 'Flag-off, Venus Drive']] }));
  fs.writeFileSync(path.join(OUT, 'loop.kml'), kml(loop({ lat0: 1.3520, r: 0.006 }), { name: 'Test KML' }));
  fs.writeFileSync(path.join(OUT, 'loop.kmz'), kmz(kml(loop({ lat0: 1.3600 }), { name: 'Zipped route' })));
  fs.writeFileSync(path.join(OUT, 'alps.gpx'), gpx(line(), { name: 'Alpine Traverse' }));
  // a distinct route, so the hanging-mirror test cannot be answered from a
  // route already saved on the device
  // Distinct geometry, so it gets its own route id and cannot be answered from
  // the saved copy of the first loop — but the same neighbourhood, so the
  // stubbed facilities still fall inside its corridor.
  fs.writeFileSync(path.join(OUT, 'hang.gpx'),
    gpx(loop({ r: 0.005, n: 200 }), { name: 'Hang probe' }));
  // and one more, for the case where every mirror hangs
  fs.writeFileSync(path.join(OUT, 'stuck.gpx'),
    gpx(loop({ r: 0.0058, n: 180 }), { name: 'Stuck probe' }));
  fs.writeFileSync(path.join(OUT, 'cancel.gpx'),
    gpx(loop({ r: 0.0062, n: 160 }), { name: 'Cancel probe' }));
  // ~39 km, so it needs more than one Overpass query and the sweep's memory of
  // which mirror answered can be tested. Routed through the same neighbourhood
  // as the loop, so the stubbed facilities still fall in its corridor.
  const longPts = [];
  for (let i = 0; i <= 400; i++) {
    const t = i / 400;
    longPts.push([1.20 + t * 0.35, 103.8195 + 0.004 * Math.sin(t * 18), null]);
  }
  fs.writeFileSync(path.join(OUT, 'long.gpx'), gpx(longPts, { name: 'Long trail' }));
  console.log(`fixtures written to ${OUT}`);
}

module.exports.write = write;
if (require.main === module) write();
