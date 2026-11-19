// Gate log: guards check cars in at the gate: the address they're going to (from the Members list),
// what kind of visit (renter, visitor, contractor, marina/tiki), a photo of the tag and a short description of the vehicle.
const db = require('./db');
const V = require('./validate');

const KINDS = { renter: 'Renter', visitor: 'Visitor', contractor: 'Contractor', marina: 'Marina / Tiki' };
const kindLabel = k => KINDS[k] || k;

/** Every Deerfield address on the Members list with its owner, for the guard's address search (works offline once loaded). */
async function addresses(companyId) {
  const rows = await db.q(`SELECT id, data FROM members WHERE company_id=$1 AND COALESCE(data->>'Deerfield address','')<>''
    AND COALESCE(data->>'Status','Active') NOT ILIKE 'inactive%' ORDER BY position, id`, [companyId]);
  return rows.map(({ id, data: d }) => ({ id, address: d['Deerfield address'],
    owner: [d['First name(s)'], d['Last name']].filter(Boolean).join(' ') || d['Trust or LLC'] || '', lot: d['Lot'] || d['Lot #'] || '' }));
}

const out = r => ({ id: r.id, at: r.at, address: r.address, owner: r.owner, kinds: r.kinds, kindLabels: r.kinds.map(kindLabel),
  description: r.description, guard: r.guard, photo: !!r.has_photo, member_id: r.member_id });
const COLS = 'id, at, address, owner, kinds, description, guard, member_id, (photo IS NOT NULL) AS has_photo';

/** A guard checks a car in. b: { address, member_id, kinds[], description, photo (data URL), clientRef, at } */
async function create(company, crew, b, photoBytes) {
  const address = String(b.address || '').trim().replace(/\s+/g, ' ');
  if (!address) V.bad('Type the address they are going to.');
  if (address.length > 200) V.bad('That address is too long.');
  const kinds = [...new Set((Array.isArray(b.kinds) ? b.kinds : []).map(String))].filter(k => KINDS[k]);
  if (!kinds.length) V.bad('Tick renter, visitor, contractor or marina/tiki.');
  const description = String(b.description || '').trim().slice(0, 300);
  let memberId = null, owner = '';
  if (b.member_id) {
    const m = await db.one('SELECT id, data FROM members WHERE id=$1 AND company_id=$2', [Number(b.member_id) || 0, company.id]);
    if (m) { memberId = m.id; owner = [m.data['First name(s)'], m.data['Last name']].filter(Boolean).join(' ') || m.data['Trust or LLC'] || ''; }
  }
  const photo = b.photo ? photoBytes(b.photo) : null;
  const ref = b.clientRef ? String(b.clientRef).slice(0, 80) : null;
  // a car checked in with no signal keeps the time the guard saved it
  let at = new Date();
  if (b.at) { const t = new Date(b.at); if (!isNaN(t) && t <= at && at - t < 7 * 864e5) at = t; }
  const r = await db.q(`INSERT INTO gate_entries (company_id, crew_id, guard, at, address, member_id, owner, kinds, description, photo, photo_mime, client_ref)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (company_id, client_ref) DO NOTHING RETURNING id`,
    [company.id, crew ? crew.id : null, crew ? crew.name : '', at, address, memberId, owner, kinds, description, photo && photo.buf, photo && photo.mime, ref]);
  return { id: r.length ? r[0].id : null };
}

/** Cars checked in, newest first. Filters: from/to (YYYY-MM-DD, company time), q (address, owner, description, guard), kind. */
async function list(company, { from, to, q, kind, limit } = {}) {
  const args = [company.id, company.timezone || 'America/New_York'], where = ['company_id=$1', '$2::text IS NOT NULL'];
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { args.push(from); where.push(`(at AT TIME ZONE $2::text)::date >= $${args.length}::date`); }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { args.push(to); where.push(`(at AT TIME ZONE $2::text)::date <= $${args.length}::date`); }
  if (kind && KINDS[kind]) { args.push(kind); where.push(`$${args.length} = ANY(kinds)`); }
  String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6).forEach(w => {
    args.push('%' + w.replace(/[\\%_]/g, m => '\\' + m) + '%');
    where.push(`lower(address || ' ' || owner || ' ' || description || ' ' || guard) LIKE $${args.length}`);
  });
  args.push(Math.min(Number(limit) || 500, 5000));
  const rows = await db.q(`SELECT ${COLS} FROM gate_entries WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT $${args.length}`, args);
  return rows.map(out);
}

/** The guard's screen: today's cars (all guards, so the next shift sees them) and the address list. */
async function today(company) {
  const T = require('./time');
  const { date } = T.localNow(company.timezone);
  return { day: date, entries: await list(company, { from: date, to: date, limit: 300 }), addresses: await addresses(company.id), kinds: KINDS };
}

async function photo(companyId, id) {
  return db.one('SELECT photo AS data, photo_mime AS mime FROM gate_entries WHERE id=$1 AND company_id=$2 AND photo IS NOT NULL', [id, companyId]);
}
const remove = (companyId, id) => db.q('DELETE FROM gate_entries WHERE id=$1 AND company_id=$2', [id, companyId]);

/** Spreadsheet-friendly CSV of the log. */
async function csv(company, filters) {
  const rows = await list(company, { ...filters, limit: 5000 });
  const tz = company.timezone || 'America/New_York';
  const q = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lines = [['Date & time', 'Address', 'Owner', 'Type', 'Vehicle', 'Guard', 'Tag photo'].map(q).join(',')]
    .concat(rows.map(r => [fmt.format(new Date(r.at)), r.address, r.owner, r.kindLabels.join(', '), r.description, r.guard, r.photo ? 'Yes' : ''].map(q).join(',')));
  return '﻿' + lines.join('\r\n');
}

module.exports = { KINDS, addresses, create, list, today, photo, remove, csv };
