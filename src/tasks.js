// Tasks: the boss gives the crew jobs to do; the crew marks them done with notes and photos.
const db = require('./db');
const T = require('./time');
const V = require('./validate');
const config = require('./config');
const { send, esc, layout } = require('./email');
const R = require('./reports');

const MAX_PHOTOS = 6;                 // per task
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const TYPES = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };

const COLS = `t.id, t.title, t.details, t.assigned_to AS "assignedTo", a.name AS "assignedName", to_char(t.due, 'YYYY-MM-DD') AS due,
  t.status, t.cost, t.created_at AS "createdAt", t.created_by AS "createdBy", cb.name AS "createdByName", t.done_at AS "doneAt", d.name AS "doneByName", t.done_notes AS "doneNotes",
  COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM task_photos p WHERE p.task_id=t.id), '[]') AS photos`;
const FROM = 'FROM tasks t LEFT JOIN crew a ON a.id=t.assigned_to LEFT JOIN crew d ON d.id=t.done_by LEFT JOIN crew cb ON cb.id=t.created_by';

/** The boss's list: everything open, plus what was finished in the last 60 days. */
const kindOf = k => (k === 'repair' || k === 'order' ? k : 'task');   // task | repair (water leaks) | order (needs to order)
const forOwner = (companyId, kind) => db.q(`SELECT ${COLS} ${FROM} WHERE t.company_id=$1 AND t.kind=$2 AND (t.status='open' OR t.done_at > now() - interval '60 days')
  ORDER BY t.status='done', CASE WHEN t.status='open' THEN t.due END NULLS LAST, t.done_at DESC NULLS LAST, t.id DESC`, [companyId, kindOf(kind)]);

/** A crew member sees open tasks for them or for anyone, and what they finished in the last 14 days. */
const forCrew = (companyId, crewId, kind) => db.q(`SELECT ${COLS} ${FROM} WHERE t.company_id=$1 AND t.kind=$3 AND
  ((t.status='open' AND (t.assigned_to IS NULL OR t.assigned_to=$2)) OR (t.status='done' AND t.done_by=$2 AND t.done_at > now() - interval '14 days'))
  ORDER BY t.status='done', t.due NULLS LAST, t.done_at DESC NULLS LAST, t.id DESC`, [companyId, crewId, kindOf(kind)]);

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
    cost: b.cost !== undefined ? roughCost(b.cost) : (cur.cost == null ? null : Number(cur.cost))
  };
  if (v.due && !T.isDate(v.due)) V.bad('Pick a valid due date.');
  if (v.assigned && !(await db.one('SELECT 1 FROM crew WHERE id=$1 AND company_id=$2', [v.assigned, companyId]))) V.bad('Pick someone from your crew.');
  return v;
}

async function create(companyId, b) {
  const v = await fields(companyId, b, { details: '', due: null, assigned_to: null });
  const n = await db.one("SELECT count(*)::int AS n FROM tasks WHERE company_id=$1 AND status='open'", [companyId]);
  if (n.n >= 500) V.bad('That is a lot of open tasks. Finish or delete some first.');
  const photos = (Array.isArray(b.photos) ? b.photos : []).map(photoBytes);
  if (photos.length > MAX_PHOTOS) V.bad(`Up to ${MAX_PHOTOS} photos.`);
  await db.tx(async t => {
    const r = await t.one('INSERT INTO tasks (company_id, title, details, due, assigned_to, kind, cost) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [companyId, v.title, v.details, v.due, v.assigned, kindOf(b.kind), v.cost]);
    for (const p of photos) await t.q('INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [r.id, companyId, p.mime, p.buf]);
  });
}

async function update(companyId, id, b) {
  const cur = await db.one('SELECT *, to_char(due, \'YYYY-MM-DD\') AS due FROM tasks WHERE id=$1 AND company_id=$2', [id, companyId]);
  if (!cur) V.bad('That task was not found.');
  const v = await fields(companyId, b, cur);
  await db.q('UPDATE tasks SET title=$1, details=$2, due=$3, assigned_to=$4, cost=$5 WHERE id=$6', [v.title, v.details, v.due, v.assigned, v.cost, id]);
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
  await db.tx(async t => {
    const r = await t.one('INSERT INTO tasks (company_id, title, details, due, assigned_to, created_by, kind, cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [company.id, title, details, due, b.forMe ? crew.id : null, crew.id, kind, roughCost(b.cost)]);
    for (const p of photos) await t.q('INSERT INTO task_photos (task_id, company_id, mime, data) VALUES ($1,$2,$3,$4)', [r.id, company.id, p.mime, p.buf]);
  });
  notifyNew(company, crew.name, title, details, !!b.forMe, kind, due, roughCost(b.cost)).catch(() => {});   // logged in email.js
}

/** Crew can delete a task they added, while it's still open. */
async function removeByCrew(company, crew, id) {
  const t = await db.one("SELECT 1 FROM tasks WHERE id=$1 AND company_id=$2 AND created_by=$3 AND status='open'", [id, company.id, crew.id]);
  if (!t) V.bad('You can only delete open tasks you added yourself.');
  await db.q('DELETE FROM tasks WHERE id=$1', [id]);
}

async function notifyNew(company, who, title, details, forMe, kind, due, cost) {
  const to = await R.recipients(company);
  if (!to || !to.length) return;
  const repair = kind === 'repair', order = kind === 'order';
  await send({ to, subject: order ? `Needs to order: ${title} (from ${who})` : repair ? `Water system problem reported by ${who}: ${title}` : `New task from ${who}: ${title}`,
    html: layout(order ? `Needs to order: ${esc(title)}` : repair ? `Water system: ${esc(title)}` : `New task: ${esc(title)}`,
      `<p><b>${esc(who)}</b> ${order ? 'added something that needs ordering' + (due ? ', needed by <b>' + esc(due) + '</b>' : '') + (cost != null ? ', about <b>$' + cost.toLocaleString('en-US') + '</b>' : '') : repair ? 'reported a leak or repair' : 'added a task'}${forMe && !order ? ' and will handle it' : ''}.</p>` +
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

module.exports = { kindOf, kindOfTask, kindOfTaskPhoto, forOwner, forCrew, create, update, remove, createByCrew, removeByCrew, complete, photo, photoBytes, MAX_PHOTOS };
