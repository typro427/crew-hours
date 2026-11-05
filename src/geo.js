// Map math for the roads driven checklist: is a road covered by the route someone drove, and road shapes from
// OpenStreetMap. Shapes are lists of lines, each line a list of [lat, lon].
const config = require('./config');

const R = 6371000;
/** Metres between two [lat, lon] points. */
function dist(a, b) {
  const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const lineLength = line => line.reduce((a, p, i) => (i ? a + dist(line[i - 1], p) : 0), 0);

/** Points along a line every `step` metres (the ends included). */
function resample(line, step) {
  if (!line.length) return [];
  const out = [line[0]];
  let carry = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], d = dist(a, b);
    let t = step - carry;
    while (t <= d) { out.push([a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d]); t += step; }
    carry = (carry + d) % step;
  }
  const last = line[line.length - 1];
  if (dist(out[out.length - 1], last) > step / 4) out.push(last);
  return out;
}

/**
 * A lookup of where someone drove: the route filled in every few metres, in a grid.
 * near(p) is true when p is within `within` metres of the route.
 */
function routeIndex(lines, within = 35) {
  const pts = [];
  lines.forEach(l => { if (l.length === 1) pts.push(l[0]); else pts.push(...resample(l, within / 3)); });
  if (!pts.length) return { near: () => false, empty: true };
  const lat0 = pts[0][0], kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const cell = p => [Math.floor(p[1] * kx / within), Math.floor(p[0] * ky / within)];
  const grid = new Map();
  pts.forEach(p => { const [x, y] = cell(p), k = x + ',' + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(p); });
  return {
    near(p) {
      const [x, y] = cell(p);
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const g = grid.get((x + i) + ',' + (y + j));
        if (g && g.some(q => dist(p, q) <= within)) return true;
      }
      return false;
    }
  };
}

/** How much of a road (0..1) lies along the route. */
function coverage(shape, index) {
  if (index.empty) return 0;
  let n = 0, hit = 0;
  shape.forEach(line => resample(line, 20).forEach(p => { n++; if (index.near(p)) hit++; }));
  return n ? hit / n : 0;
}

/* ---------------------------- road names ---------------------------- */
const SUFFIX = { rd: 'road', ln: 'lane', dr: 'drive', ct: 'court', cir: 'circle', cr: 'circle', trl: 'trail', tr: 'trail', pl: 'place', blvd: 'boulevard',
  ave: 'avenue', av: 'avenue', st: 'street', hwy: 'highway', pkwy: 'parkway', pt: 'point', ter: 'terrace', terr: 'terrace', cv: 'cove', xing: 'crossing', vw: 'view', hts: 'heights',
  n: 'north', s: 'south', e: 'east', w: 'west', mt: 'mount', mtn: 'mountain' };
const ENDINGS = new Set(['road', 'lane', 'drive', 'court', 'circle', 'trail', 'place', 'boulevard', 'avenue', 'street', 'way', 'terrace', 'cove', 'loop', 'run', 'point', 'view', 'pike', 'parkway', 'highway', 'crossing']);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).map(w => SUFFIX[w] || w).join(' ');
const stem = s => { const w = s.split(' '); return w.length > 1 && ENDINGS.has(w[w.length - 1]) ? w.slice(0, -1).join(' ') : s; };

/** Match our road names to OpenStreetMap ways by name. Returns { [roadId]: shape }. */
function matchWays(roads, ways) {
  const byName = new Map();
  ways.forEach(w => {
    if (!w.name || !w.line || w.line.length < 2) return;
    const n = norm(w.name);
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(w.line);
  });
  const out = {};
  roads.forEach(r => {
    const n = norm(r.name);
    if (byName.has(n)) { out[r.id] = byName.get(n); return; }
    // "Deer Meadow" = "Deer Meadow Drive", "Deer Run" = "Deer Run Road": only when exactly one street fits
    const fits = [...byName.keys()].filter(k => stem(k) === n || stem(k) === stem(n) || k === stem(n));
    if (fits.length === 1) out[r.id] = byName.get(fits[0]);
  });
  return out;
}

/** Named roads within `radius` metres of a point, from OpenStreetMap (Overpass). */
async function osmWays(lat, lon, radius) {
  const q = `[out:json][timeout:40];way["highway"]["name"](around:${Math.round(radius)},${lat},${lon});out geom;`;
  const r = await fetch(config.geo.overpass, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': `Crew Hours (${config.appUrl})` },
    body: 'data=' + encodeURIComponent(q) });
  if (!r.ok) throw new Error('OpenStreetMap said ' + r.status);
  const j = await r.json();
  return (j.elements || []).filter(e => e.type === 'way' && e.geometry).map(e => ({ name: e.tags && e.tags.name, line: e.geometry.map(g => [g.lat, g.lon]) }));
}

module.exports = { dist, lineLength, resample, routeIndex, coverage, norm, matchWays, osmWays };
