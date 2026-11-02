// Nightly backup to the owner's own Google Drive.
// The owner connects once (Google sign-in). The app may only see files it creates (drive.file scope).
// Each night: one backup file of every record, plus any photos not copied yet.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const T = require('./time');

const SCOPES = 'openid email https://www.googleapis.com/auth/drive.file';
const KEEP_DAYS = 90;           // older backup files are deleted from Drive
const PHOTOS_PER_RUN = 300;     // big catch-ups spread over a few nights

const enabled = () => !!(config.google.clientId && config.google.clientSecret);
const redirectUri = () => `${config.appUrl}/api/admin/google/callback`;

/* --------------------------- secrets at rest --------------------------- */
const key = () => crypto.createHash('sha256').update('gdrive:' + config.secret).digest();
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function open(sealed) {
  const [iv, tag, enc] = String(sealed).split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
/** A signed, short-lived "state" for the Google sign-in round trip (stops forged callbacks). */
function makeState(companyId) {
  const body = `${companyId}.${Date.now() + 10 * 60e3}.${crypto.randomBytes(8).toString('hex')}`;
  return body + '.' + crypto.createHmac('sha256', key()).update(body).digest('hex').slice(0, 32);
}
function checkState(state, companyId) {
  const parts = String(state || '').split('.');
  if (parts.length !== 4) return false;
  const body = parts.slice(0, 3).join('.'), sig = crypto.createHmac('sha256', key()).update(body).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[3].padEnd(32).slice(0, 32))) && Number(parts[0]) === companyId && Number(parts[1]) > Date.now();
}

/* ------------------------------ Google API ------------------------------ */
async function google(url, opts = {}) {
  const r = await fetch(url, opts);
  if (r.status === 204) return null;
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = text; }
  if (!r.ok) {
    const msg = (body && body.error && (body.error.message || body.error_description || body.error)) || body.error_description || r.statusText;
    const err = new Error('Google said: ' + (typeof msg === 'string' ? msg : JSON.stringify(msg)));
    err.status = r.status; err.code = body && body.error; throw err;
  }
  return body;
}
const form = o => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

function authUrl(companyId) {
  const q = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: makeState(companyId) });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
}

/** Finish the sign-in: swap the code for tokens, remember who connected. */
async function finishConnect(companyId, code, state) {
  if (!checkState(state, companyId)) throw new Error('That Google sign-in link expired. Try Connect Google Drive again.');
  const t = await google('https://oauth2.googleapis.com/token', form({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
    redirect_uri: redirectUri(), grant_type: 'authorization_code' }));
  if (!t.refresh_token) throw new Error("Google didn't give the app lasting access. Remove Crew Hours under your Google Account → Security → Third-party access, then connect again.");
  let email = '';
  try { email = JSON.parse(Buffer.from(String(t.id_token).split('.')[1], 'base64url').toString()).email || ''; } catch (e) {}
  await db.q('UPDATE companies SET gdrive_token=$1, gdrive_email=$2, gdrive_folder=NULL, gdrive_photos_folder=NULL, gdrive_error=NULL WHERE id=$3',
    [seal(t.refresh_token), email, companyId]);
  await db.q('DELETE FROM gdrive_uploaded WHERE company_id=$1', [companyId]);   // a new Drive gets every photo
}

async function disconnect(companyId) {
  const c = await db.one('SELECT gdrive_token FROM companies WHERE id=$1', [companyId]);
  if (c && c.gdrive_token) { try { await google('https://oauth2.googleapis.com/revoke', form({ token: open(c.gdrive_token) })); } catch (e) {} }
  await db.q('UPDATE companies SET gdrive_token=NULL, gdrive_email=NULL, gdrive_folder=NULL, gdrive_photos_folder=NULL, gdrive_error=NULL, gdrive_last_at=NULL WHERE id=$1', [companyId]);
  await db.q('DELETE FROM gdrive_uploaded WHERE company_id=$1', [companyId]);
}

async function accessToken(c) {
  const t = await google('https://oauth2.googleapis.com/token', form({ refresh_token: open(c.gdrive_token), client_id: config.google.clientId,
    client_secret: config.google.clientSecret, grant_type: 'refresh_token' }));
  return t.access_token;
}

const API = 'https://www.googleapis.com/drive/v3/files';
async function folderOk(tok, id) {
  if (!id) return false;
  try { const f = await google(`${API}/${id}?fields=id,trashed`, { headers: { Authorization: 'Bearer ' + tok } }); return f && !f.trashed; }
  catch (e) { if (e.status === 404) return false; throw e; }
}
const makeFolder = (tok, name, parent) => google(`${API}?fields=id`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }) }).then(f => f.id);

/** Upload one file (multipart: metadata + bytes). */
function upload(tok, name, mime, data, parent) {
  const boundary = 'crewhours' + crypto.randomBytes(8).toString('hex');
  const meta = JSON.stringify({ name, parents: [parent] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
    Buffer.isBuffer(data) ? data : Buffer.from(data), Buffer.from(`\r\n--${boundary}--`)]);
  return google('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
}

/* ------------------------------- the backup ------------------------------- */
/** Every record for one company (photos are copied separately as image files). */
async function companyDump(id) {
  const one = (sql) => db.q(sql, [id]);
  return {
    exportedAt: new Date().toISOString(), app: config.productName,
    // every company setting, minus the Google sign-in itself
    company: (({ gdrive_token, ...rest }) => rest)((await one('SELECT * FROM companies WHERE id=$1'))[0]),
    slugRedirects: await one('SELECT old_slug FROM slug_redirects WHERE company_id=$1'),
    crew: await one('SELECT id, name, active, is_manager, features, created_at FROM crew WHERE company_id=$1 ORDER BY id'),
    entries: await one('SELECT * FROM entries WHERE company_id=$1 ORDER BY day, crew_id'),
    approvals: await one('SELECT * FROM approvals WHERE company_id=$1 ORDER BY week_start'),
    tasks: await one('SELECT * FROM tasks WHERE company_id=$1 ORDER BY id'),
    members: await one('SELECT data FROM members WHERE company_id=$1 ORDER BY position, id'),
    roads: await one('SELECT id, kind, name, position, active, length_mi, p_road, p_ditch, p_trees, surface, notes, reading_ids FROM roads WHERE company_id=$1 ORDER BY kind, position'),
    roadChecks: await one("SELECT id, road_id, crew_id, to_char(day, 'YYYY-MM-DD') AS day, notes, created_at FROM road_mows WHERE company_id=$1 ORDER BY id"),
    readingTypes: await one('SELECT * FROM reading_types WHERE company_id=$1 ORDER BY position'),
    readings: await one('SELECT * FROM readings WHERE company_id=$1 ORDER BY taken_at'),
    meters: await one('SELECT * FROM meters WHERE company_id=$1 ORDER BY seq'),
    meterReads: await one('SELECT * FROM meter_reads WHERE company_id=$1 ORDER BY meter_id, month')
  };
}

const safe = s => String(s || '').replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 60);
const ext = m => (m === 'image/png' ? 'png' : m === 'image/webp' ? 'webp' : 'jpg');

/** Photos not copied to this Drive yet, oldest first. */
const newPhotos = id => db.q(`SELECT * FROM (
    SELECT 'task' AS kind, p.id, p.mime, t.id || '-' || t.title AS label, p.created_at FROM task_photos p JOIN tasks t ON t.id=p.task_id WHERE p.company_id=$1
    UNION ALL SELECT 'day', p.id, p.mime, to_char(p.day, 'YYYY-MM-DD') || '-' || c.name, p.created_at FROM day_photos p JOIN crew c ON c.id=p.crew_id WHERE p.company_id=$1
    UNION ALL SELECT 'check', p.id, p.mime, to_char(m.day, 'YYYY-MM-DD') || '-' || r.name, m.created_at FROM road_mow_photos p JOIN road_mows m ON m.id=p.mow_id JOIN roads r ON r.id=m.road_id WHERE p.company_id=$1
  ) x WHERE NOT EXISTS (SELECT 1 FROM gdrive_uploaded u WHERE u.company_id=$1 AND u.kind=x.kind AND u.photo_id=x.id)
  ORDER BY created_at LIMIT ${PHOTOS_PER_RUN}`, [id]);
const photoData = (kind, id) => db.one(`SELECT data FROM ${kind === 'task' ? 'task_photos' : kind === 'day' ? 'day_photos' : 'road_mow_photos'} WHERE id=$1`, [id]);

/** Run one backup for a company. Returns what was copied. */
async function backupNow(companyId) {
  const c = await db.one('SELECT * FROM companies WHERE id=$1', [companyId]);
  if (!c || !c.gdrive_token) throw new Error('Google Drive is not connected.');
  try {
    const tok = await accessToken(c);
    let folder = c.gdrive_folder, photos = c.gdrive_photos_folder;
    if (!(await folderOk(tok, folder))) { folder = await makeFolder(tok, `Crew Hours Backups (${c.name})`); photos = null; await db.q('DELETE FROM gdrive_uploaded WHERE company_id=$1', [c.id]); }
    if (!(await folderOk(tok, photos))) { photos = await makeFolder(tok, 'Photos', folder); await db.q('DELETE FROM gdrive_uploaded WHERE company_id=$1', [c.id]); }
    await db.q('UPDATE companies SET gdrive_folder=$1, gdrive_photos_folder=$2 WHERE id=$3', [folder, photos, c.id]);

    const today = T.localNow(c.timezone).date;
    await upload(tok, `crewhours-backup-${today}.json`, 'application/json', JSON.stringify(await companyDump(c.id)), folder);

    let copied = 0;
    for (const p of await newPhotos(c.id)) {
      const d = await photoData(p.kind, p.id); if (!d) continue;
      await upload(tok, `${p.kind}-${safe(p.label)}-${p.id}.${ext(p.mime)}`, p.mime, d.data, photos);
      await db.q('INSERT INTO gdrive_uploaded (company_id, kind, photo_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [c.id, p.kind, p.id]);
      copied++;
    }
    // Keep the last 90 days of backup files.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
    const old = await google(`${API}?` + new URLSearchParams({ q: `'${folder}' in parents and name contains 'crewhours-backup-' and createdTime < '${cutoff}' and trashed = false`, fields: 'files(id)', pageSize: '100' }),
      { headers: { Authorization: 'Bearer ' + tok } });
    for (const f of (old && old.files) || []) await google(`${API}/${f.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } });

    await db.q('UPDATE companies SET gdrive_last_at=now(), gdrive_error=NULL WHERE id=$1', [c.id]);
    return { photos: copied, file: `crewhours-backup-${today}.json` };
  } catch (e) {
    const msg = e.code === 'invalid_grant' ? 'Google Drive access was removed or expired. Click Connect Google Drive again.' : e.message;
    await db.q('UPDATE companies SET gdrive_error=$1 WHERE id=$2', [String(msg).slice(0, 500), companyId]);
    throw new Error(msg);
  }
}

const status = c => ({ available: enabled(), connected: !!c.gdrive_token, email: c.gdrive_email || '', lastAt: c.gdrive_last_at, error: c.gdrive_error || '' });

module.exports = { enabled, authUrl, finishConnect, disconnect, backupNow, status, companyDump, seal, open, makeState, checkState };
