// Tasks: the boss gives the crew jobs to do; the crew marks them done with notes and photos.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const config = require('./config');
const { send, esc, layout } = require('./email');
const R = require('./reports');

const MAX_PHOTOS = 12;                // per task, progress photos included
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

const COLS = `t.id, t.title, t.details, t.assigned_to AS "assignedTo", a.name AS "assignedName", to_char(t.due, 'YYYY-MM-DD') AS due,
  t.status, t.cost, t.qty, t.created_at AS "createdAt", t.created_by AS "createdBy", cb.name AS "createdByName", t.done_at AS "doneAt", d.name AS "doneByName", t.done_notes AS "doneNotes",
  t.address, t.owner, t.owner_phone AS "ownerPhone",
  COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM task_photos p WHERE p.task_id=t.id AND p.update_id IS NULL), '[]') AS photos,
  COALESCE((SELECT json_agg(json_build_object('id', u.id, 'at', u.created_at, 'by', u.by_name, 'crewId', u.crew_id, 'note', u.note,
      'photos', COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM task_photos p WHERE p.update_id=u.id), '[]')) ORDER BY u.id)
    FROM task_updates u WHERE u.task_id=t.id), '[]') AS updates`;
const FROM = 'FROM tasks t LEFT JOIN crew a ON a.id=t.assigned_to LEFT JOIN crew d ON d.id=t.done_by LEFT JOIN crew cb ON cb.id=t.created_by';

/** The boss's list: everything open, plus what was finished in the last 60 days. */
const kindOf = k => (k === 'repair' || k === 'order' ? k : 'task');   // task | repair (water leaks) | order (needs to order)
const forOwner = async (companyId, kind) => (kindOf(kind) === 'repair' && await fillOwners(companyId), db.q(`SELECT ${COLS} ${FROM} WHERE t.company_id=$1 AND t.kind=$2 AND (t.status='open' OR t.done_at > now() - interval '60 days')
  ORDER BY t.status='done', CASE WHEN t.status='open' THEN t.due END NULLS LAST, t.done_at DESC NULLS LAST, t.id DESC`, [companyId, kindOf(kind)]));

/** A crew member sees open tasks for them or for anyone, and what they finished in the last 14 days. */
const forCrew = async (companyId, crewId, kind) => (kindOf(kind) === 'repair' && await fillOwners(companyId), db.q(`SELECT ${COLS} ${FROM} WHERE t.company_id=$1 AND t.kind=$3 AND
  ((t.status='open' AND (t.assigned_to IS NULL OR t.assigned_to=$2)) OR (t.status='done' AND t.done_by=$2 AND t.done_at > now() - interval '14 days'))
  ORDER BY t.status='done', t.due NULLS LAST, t.done_at DESC NULLS LAST, t.id DESC`, [companyId, crewId, kindOf(kind)]));

// ---- Who owns the place with the leak: look the address up on the members list. ----
const M = require('./meters');
const ADDR_IN_TEXT = /\b[0-9]{2,5}[a-z]?\b(?:[ ,.#-]+[a-z0-9]+){1,6}/gi;   // "141 Deer Meadow Dr", "470 Deerfield Landing #2"

async function activeMembers(companyId) {
  const rows = await db.q(`SELECT data FROM members WHERE company_id=$1 AND COALESCE(data->>'Status','Active')='Active'
    AND COALESCE(data->>'Deerfield address','')<>'' ORDER BY position, id`, [companyId]);
  // "202 Deer Ridge Lane (Hirsch Vista Lot 7R)", "499 Deerfield Landing & Hangar combined": just the address part
  const plain = a => a.replace(/\([^)]*\)?/g, ' ').split('&')[0];
  return rows.map(({ data: d }) => ({ k: M.addrKey(plain(d['Deerfield address'])), street: M.streetOf(plain(d['Deerfield address'])),
    name: [d['First name(s)'], d['Last name']].filter(Boolean).join(' ') || d['Trust or LLC'] || '',
    phone: d['Cell phone 1'] || d['Home phone'] || d['Deerfield phone'] || d['Cell phone 2'] || '' }));
}

/** Owner(s) at an address. The whole street name must appear, so "141 Deer Meadow" never matches "141 Deer Run". */
function ownerAt(members, text) {
  const tries = text ? [text, ...(String(text).match(ADDR_IN_TEXT) || [])] : [];
  for (const t of tries) {
    const k = M.addrKey(t), street = M.streetOf(t);
    if (!k.house) continue;
    const hit = members.filter(m => m.street && street.includes(m.street) && M.sameProperty(k, m.k));
    if (!hit.length) continue;
    const names = [...new Set(hit.map(m => m.name).filter(Boolean))];
    return { owner: names.length > 3 ? names.slice(0, 3).join(', ') + ` +${names.length - 3} more` : names.join(', '),
      phone: (hit.find(m => m.phone) || {}).phone || '' };
  }
  return { owner: '', phone: '' };
}

/** Fill in the owner on leaks & repairs that haven't been looked up yet. */
async function fillOwners(companyId) {
  const todo = await db.q("SELECT id, title, details, address FROM tasks WHERE company_id=$1 AND kind='repair' AND NOT owner_checked LIMIT 500", [companyId]);
  if (!todo.length) return;
  const members = await activeMembers(companyId);
  for (const t of todo) {
    let o = ownerAt(members, t.address);
    if (!o.owner) o = ownerAt(members, [t.title, t.details].join(' \n '));
    await db.q('UPDATE tasks SET owner=$1, owner_phone=$2, owner_checked=TRUE WHERE id=$3', [o.owner, o.phone, t.id]);
  }
}
/** Look everything up again (after a new members list is imported). */
const recheckOwners = companyId => db.q("UPDATE tasks SET owner_checked=FALSE WHERE company_id=$1 AND kind='repair'", [companyId]);
const cleanQty = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, 30);
const cleanAddress = v => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 200);

/** "$1,200" / "1200" / "" -> 1200 / null */
function roughCost(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > 1e8) V.bad('The rough cost must be a dollar amount, like 250.');
  return Math.round(n * 100) / 100;
}

async function fields(companyId, b, cur) {
  const v = {
    title: b.title !== undefined ? V.str(b.title, 'a task name', 1, 120) : cur.title,
    details: b.details !== undefined ? String(b.details || '').trim().slice(0, 2000) : cur.details,
    due: b.due !== undefined ? (b.due ? b.due : null) : cur.due,
    assigned: b.assignedTo !== undefined ? (b.assignedTo ? Number(b.assignedTo) : null) : cur.assigned_to,
    cost: b.cost !== undefined ? roughCost(b.cost) : (cur.cost == null ? null : Number(cur.cost)),
    address: b.address !== undefined ? cleanAddress(b.address) : (cur.address || ''),
    qty: b.qty !== undefined ? cleanQty(b.qty) : (cur.qty || '')
  };
  if (v.due && !T.isDate(v.due)) V.bad('Pick a valid due date.');
  if (v.assigned && !(await db.one('SELECT 1 FROM crew WHERE id=$1 AND company_id=$2', [v.assigned, companyId]))) V.bad('Pick someone from your crew.');
  return v;
}

async function create(companyId, b) {
  const v = await fields(companyId, b, { details: '', due: null, assigned_to: null, address: '', qty: '' });
  const n = await db.one("SELECT count(*)::int AS n FROM tasks WHERE company_id=$1 AND status='open'", [companyId]);
  if (n.n >= 500) V.bad('That is a lot of open tasks. Finish or delete some first.');
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(photoBytes);
  if (photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos.`);
  const id = await db.tx(async t => {
    const r = await t.one('INSERT INTO tasks (company_id, title, details, due, assigned_to, kind, cost, address, qty) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id', [companyId, v.title, v.details, v.due, v.assigned, kindOf(b.kind), v.cost, v.address, v.qty]);
    for (const p of photos) await t.q('INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [r.id, companyId, p.mime, p.buf]);
    return r.id;
  });
  await fromMeter(companyId, b, id, b.quarter);
  return id;
}

/** A leak report made from a high meter reading: remember which reading it came from. */
async function fromMeter(companyId, b, taskId, quarter) {
  if (!b.meterId || kindOf(b.kind) !== 'repair' || !/^[0-9]{4}-Q[1-4]$/.test(String(quarter || ''))) return;
  await require('./meters').linkLeak(companyId, Number(b.meterId), quarter, taskId);
}
const cleanRef = v => { const s = String(v || '').trim(); return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null; };

async function update(companyId, id, b) {
  const cur = await db.one('SELECT *, to_char(due, \'YYYY-MM-DD\') AS due FROM tasks WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (!cur) V.bad('That task was not found.');
  const v = await fields(companyId, b, cur);
  const moved = v.title !== cur.title || v.details !== cur.details || v.address !== cur.address;   // look the owner up again
  await db.q('UPDATE tasks SET title=$1, details=$2, due=$3, assigned_to=$4, cost=$5, address=$6, qty=$7, owner_checked=owner_checked AND NOT $8 WHERE id=$9', [v.title, v.details, v.due, v.assigned, v.cost, v.address, v.qty, moved, id]);
  if (b.reopen) await db.q("UPDATE tasks SET status='open', done_at=NULL, done_by=NULL WHERE id=$1", [id]);
}

const remove = (companyId, id) => db.q('DELETE FROM tasks WHERE id=$1 AND company_id=$2', [id, companyId]);

/** A crew member adds a task: for themselves or for anyone. The boss gets an email. */
async function createByCrew(company, crew, b) {
  const title = V.str(b.title, 'a task name', 1, 120);
  const details = String(b.details || '').trim().slice(0, 2000);
  const due = b.due ? b.due : null;
  if (due && !T.isDate(due)) V.bad('Pick a valid due date.');
  const n = await db.one("SELECT count(*)::int AS n FROM tasks WHERE company_id=$1 AND status='open'", [company.id]);
  if (n.n >= 500) V.bad('There are a lot of open tasks. Ask the boss to clear some first.');
  const kind = kindOf(b.kind);
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(photoBytes);   // e.g. a picture of the part to order
  if (photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos.`);
  const ref = cleanRef(b.clientRef);
  if (ref && await db.one('SELECT 1 FROM tasks WHERE company_id=$1 AND client_ref=$2', [company.id, ref])) return;   // sent again from the phone's outbox
  const id = await db.tx(async t => {
    const r = await t.one('INSERT INTO tasks (company_id, title, details, due, assigned_to, created_by, kind, cost, address, qty, client_ref) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id',
      [company.id, title, details, due, b.forMe ? crew.id : null, crew.id, kind, roughCost(b.cost), cleanAddress(b.address), cleanQty(b.qty), ref]);
    for (const p of photos) await t.q('INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [r.id, company.id, p.mime, p.buf]);
    return r.id;
  });
  await fromMeter(company.id, b, id, require('./meters').quarterOf(company));
  notifyNew(company, crew.name, title, details, !!b.forMe, kind, due, roughCost(b.cost), cleanQty(b.qty)).catch(() => {});   // logged in email.js
}

/**
 * A progress update on an open job: a note and/or photos, without marking it done.
 * who = { crew } for a crew member (must be able to see the task), or { boss: name } for the dashboard.
 */
async function progress(companyId, id, who, b) {
  const t = await db.one(`SELECT * FROM tasks WHERE id=$1 AND company_id=$2 ${who.crew ? 'AND (assigned_to IS NULL OR assigned_to=$3)' : ''}`,
    who.crew ? [id, companyId, who.crew.id] : [id, companyId]);
  if (!t) V.bad('That job was not found. Pull down to refresh.');
  if (t.status !== 'open') V.bad('That job is already marked done.');
  const note = String((b && b.notes) || '').trim().slice(0, 2000);
  const photos = (Array.isArray(b && b.photos) ? b.photos : []).map(photoBytes);
  if (!note && !photos.length) V.bad('Add a photo or a few words.');
  const ref = cleanRef(b && b.clientRef);
  if (ref && await db.one('SELECT 1 FROM task_updates WHERE company_id=$1 AND client_ref=$2', [companyId, ref])) return;   // already got it
  const have = (await db.one('SELECT count(*)::int AS n FROM task_photos WHERE task_id=$1', [id])).n;
  if (have + photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos per job. This one has ${have}.`);
  const n = (await db.one('SELECT count(*)::int AS n FROM task_updates WHERE task_id=$1', [id])).n;
  if (n >= 50) V.bad('That job has a lot of updates already.');
  await db.tx(async q => {
    const u = await q.one('INSERT INTO task_updates (task_id, company_id, crew_id, by_name, note, client_ref) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [id, companyId, who.crew ? who.crew.id : null, who.crew ? who.crew.name : (who.boss || 'Boss'), note, ref]);
    for (const p of photos) await q.q('INSERT INTO task_photos (task_id, company_id, mime, data, update_id) VALUES ($1,$2,$3,$4,$5)', [id, companyId, p.mime, p.buf, u.id]);
  });
}

/** Remove a progress update: the crew member who posted it (same day), or the boss. */
async function removeProgress(companyId, updateId, crewId) {
  const u = await db.one(`SELECT 1 FROM task_updates WHERE id=$1 AND company_id=$2 ${crewId ? "AND crew_id=$3 AND created_at > now() - interval '24 hours'" : ''}`,
    crewId ? [updateId, companyId, crewId] : [updateId, companyId]);
  if (!u) V.bad(crewId ? 'You can only remove your own updates from the last 24 hours.' : 'That update was not found.');
  await db.q('DELETE FROM task_updates WHERE id=$1', [updateId]);
}
const kindOfUpdate = async (companyId, id) => { const r = await db.one('SELECT t.kind FROM task_updates u JOIN tasks t ON t.id=u.task_id WHERE u.id=$1 AND u.company_id=$2', [id, companyId]); return r && r.kind; };

/** Crew can delete a task they added, while it's still open. */
async function removeByCrew(company, crew, id) {
  const t = await db.one("SELECT 1 FROM tasks WHERE id=$1 AND company_id=$2 AND created_by=$3 AND status='open'", [id, company.id, crew.id]);
  if (!t) V.bad('You can only delete open tasks you added yourself.');
  await db.q('DELETE FROM tasks WHERE id=$1', [id]);
}

async function notifyNew(company, who, title, details, forMe, kind, due, cost, qty) {
  const to = await R.recipients(company);
  if (!to || !to.length) return;
  const repair = kind === 'repair', order = kind === 'order';
  await send({ to, subject: order ? `Needs to order: ${title} (from ${who})` : repair ? `Water system problem reported by ${who}: ${title}` : `New task from ${who}: ${title}`,
    html: layout(order ? `Needs to order: ${esc(title)}` : repair ? `Water system: ${esc(title)}` : `New task: ${esc(title)}`,
      `<p><b>${esc(who)}</b> ${order ? 'added something that needs ordering' + (qty ? ', quantity <b>' + esc(qty) + '</b>' : '') + (due ? ', needed by <b>' + esc(due) + '</b>' : '') + (cost != null ? ', about <b>$' + cost.toLocaleString('en-US') + '</b>' : '') : repair ? 'reported a leak or repair' : 'added a task'}${forMe && !order ? ' and will handle it' : ''}.</p>` +
      (details ? `<p style="white-space:pre-wrap">${esc(details)}</p>` : '') +
      `<p><a href="${config.appUrl}/admin#${order ? 'orders' : repair ? 'water' : 'tasks'}">See it in your dashboard</a></p>`) });
}

/** Turns "data:image/jpeg;base64,...." into checked bytes. */
function photoBytes(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) V.bad('Photos must be JPEG, PNG or WebP pictures.');
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO_BYTES) V.bad('One of the photos is too big. Try again; the app shrinks them first.');
  const sig = TYPES[m[1]];
  if (!sig.every((x, i) => buf[i] === x)) V.bad("One of the photos isn't a real picture file.");
  return { mime: m[1], buf };
}

/** Crew marks a task done (or adds to it), with notes and up to 6 photos. */
async function complete(company, crew, id, b) {
  const t = await db.one(`SELECT * FROM tasks WHERE id=$1 AND company_id=$2 AND (assigned_to IS NULL OR assigned_to=$3 OR done_by=$3)`, [id, company.id, crew.id]);
  if (!t) V.bad('That task was not found. Pull down to refresh.');
  if (t.status === 'done' && t.done_by !== crew.id) V.bad('Someone else already finished this task.');
  const notes = String(b.notes || '').trim().slice(0, 2000);
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(photoBytes);
  const have = (await db.one('SELECT count(*)::int AS n FROM task_photos WHERE task_id=$1', [id])).n;
  if (have + photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos per task.`);
  if (!notes && !photos.length && t.status === 'open') V.bad('Add a few words about what you did, or a photo.');
  const wasOpen = t.status === 'open';
  await db.tx(async q => {
    for (const p of photos) await q.q('INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [id, company.id, p.mime, p.buf]);
    await q.q("UPDATE tasks SET status='done', done_at=COALESCE(done_at, now()), done_by=$1, done_notes=$2 WHERE id=$3", [crew.id, notes || t.done_notes, id]);
  });
  if (wasOpen) notifyDone(company, t, crew.name, notes, have + photos.length).catch(() => {});   // logged in email.js
}

async function notifyDone(company, t, who, notes, photoCount) {
  const to = await R.recipients(company);
  if (!to || !to.length) return;
  const repair = t.kind === 'repair', order = t.kind === 'order';
  await send({ to, subject: order ? `Ordered: ${t.title} (${who})` : repair ? `Fixed: ${t.title} (${who})` : `Task done: ${t.title} (${who})`,
    html: layout(order ? `Ordered: ${esc(t.title)}` : repair ? `Fixed: ${esc(t.title)}` : `Task done: ${esc(t.title)}`, `<p><b>${esc(who)}</b> marked this ${order ? 'ordered' : repair ? 'repair fixed' : 'task done'}${photoCount ? ` with ${photoCount} photo${photoCount > 1 ? 's' : ''}` : ''}.</p>` +
      (notes ? `<p style="white-space:pre-wrap">${esc(notes)}</p>` : '') +
      `<p><a href="${config.appUrl}/admin#${order ? 'orders' : repair ? 'water' : 'tasks'}">See it in your dashboard</a></p>`) });
}

const kindOfTask = async (companyId, id) => { const r = await db.one('SELECT kind FROM tasks WHERE id=$1 AND company_id=$2', [id, companyId]); return r && r.kind; };
const kindOfTaskPhoto = async (companyId, id) => { const r = await db.one('SELECT t.kind FROM task_photos p JOIN tasks t ON t.id=p.task_id WHERE p.id=$1 AND p.company_id=$2', [id, companyId]); return r && r.kind; };

/** One photo, only for someone in the same company. */
const photo = (companyId, photoId) => db.one('SELECT mime, data FROM task_photos WHERE id=$1 AND company_id=$2', [photoId, companyId]);

module.exports = { progress, removeProgress, kindOfUpdate, fillOwners, recheckOwners, ownerAt, activeMembers, kindOf, kindOfTask, kindOfTaskPhoto, forOwner, forCrew, create, update, remove, createByCrew, removeByCrew, complete, photo, photoBytes, MAX_PHOTOS };
