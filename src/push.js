// Phone notifications for the crew app (Web Push: free, no accounts). Each phone that taps "Turn on notifications"
// is saved for that crew member. Sent for: weather reminders, a task from the boss, an urgent / high leak reported.
const crypto = require('crypto');
const webpush = require('web-push');
const db = require('./db');
const config = require('./config');
const F = require('./features');

/* ---- the app's own push keys (VAPID): made once, kept in the database; VAPID_* env vars win if set ---- */
const key = () => crypto.createHash('sha256').update('vapid:' + config.secret).digest();
function seal(t) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv); const e = Buffer.concat([c.update(t, 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(b => b.toString('base64')).join('.'); }
function unseal(s) { const [iv, tag, e] = String(s).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); }
let keys = null;
async function vapid() {
  if (keys) return keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  else {
    let row = await db.one("SELECT value FROM app_settings WHERE key='vapid'");
    if (!row) {
      const k = webpush.generateVAPIDKeys();
      await db.q("INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ publicKey: k.publicKey, privateKey: seal(k.privateKey) })]);
      row = await db.one("SELECT value FROM app_settings WHERE key='vapid'");
    }
    const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
    keys = { publicKey: v.publicKey, privateKey: unseal(v.privateKey) };
  }
  webpush.setVapidDetails(config.appUrl.startsWith('https') ? config.appUrl : 'mailto:no-reply@example.com', keys.publicKey, keys.privateKey);
  return keys;
}
const publicKey = async () => (await vapid()).publicKey;

/** Save this phone for this crew member. */
async function subscribe(company, crew, sub, ua) {
  const s = sub || {}, k = s.keys || {};
  if (!/^https:\/\/[^\s]{10,800}$/.test(String(s.endpoint || '')) || !k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100) {
    const e = new Error("That phone's notification setup didn't come through. Try again."); e.expose = true; e.status = 400; throw e;
  }
  await db.q(`INSERT INTO push_subs (company_id, crew_id, endpoint, p256dh, auth, ua) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (endpoint) DO UPDATE SET company_id=EXCLUDED.company_id, crew_id=EXCLUDED.crew_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, ua=EXCLUDED.ua, created_at=now()`,
    [company.id, crew.id, s.endpoint, k.p256dh, k.auth, String(ua || '').slice(0, 200)]);
}
const unsubscribe = (crewId, endpoint) => db.q('DELETE FROM push_subs WHERE crew_id=$1 AND endpoint=$2', [crewId, String(endpoint || '')]);
const countFor = async crewId => (await db.one('SELECT count(*)::int AS n FROM push_subs WHERE crew_id=$1', [crewId])).n;

/**
 * Send to some crew (ids), or to everyone active who can use `feature`. Never throws.
 * payload: { title, body, tab } - tab is the crew app tab to open when they tap it (tasks, water, orders...).
 */
async function notify(company, who, payload) {
  try {
    let ids = Array.isArray(who) ? who.filter(Boolean) : null;
    const crew = await db.q('SELECT id, features FROM crew WHERE company_id=$1 AND active', [company.id]);
    const feature = payload.feature === undefined ? 'tasks' : payload.feature;   // null = anyone
    ids = (ids && ids.length ? crew.filter(c => ids.includes(c.id)) : crew).filter(c => (!feature || F.can(c, feature)) && c.id !== payload.except).map(c => c.id);
    if (!ids.length) return 0;
    const subs = await db.q('SELECT id, endpoint, p256dh, auth FROM push_subs WHERE company_id=$1 AND crew_id = ANY($2::int[])', [company.id, ids]);
    if (!subs.length) return 0;
    await vapid();
    const body = JSON.stringify({ title: String(payload.title || '').slice(0, 120), body: String(payload.body || '').slice(0, 300),
      url: `/c/${company.slug}/${payload.tab ? '#' + payload.tab : ''}`, tag: payload.tag || undefined });
    let sent = 0;
    await Promise.all(subs.map(async s => {
      try {
        await (notify.sender || webpush.sendNotification)({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 12 * 3600, urgency: 'high' });
        sent++; await db.q('UPDATE push_subs SET last_ok=now() WHERE id=$1', [s.id]);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) await db.q('DELETE FROM push_subs WHERE id=$1', [s.id]);   // the phone turned them off
        else console.error('[push]', e.statusCode || '', e.message);
      }
    }));
    return sent;
  } catch (e) { console.error('[push]', e.message); return 0; }
}

module.exports = { publicKey, subscribe, unsubscribe, countFor, notify };
