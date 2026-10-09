// Owner logins (email + password, cookie) and crew logins (company link + 4-digit PIN, bearer token).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const db = require('./db');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');

/** PINs are stored as a keyed hash so the database never holds them in plain text. */
const pinHmac = (companyId, pin) => crypto.createHmac('sha256', config.secret).update(companyId + ':' + pin).digest('hex');

const hashPassword = pw => bcrypt.hash(pw, 11);
const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

/* ------------------------- simple in-memory rate limits ------------------------- */
const buckets = new Map();
/** true when this key has had `max` failures in the last `windowMs`. */
function limited(key, max, windowMs) {
  const b = buckets.get(key);
  if (!b || b.until < Date.now()) return false;
  return b.count >= max;
}
function fail(key, windowMs) {
  const b = buckets.get(key);
  if (!b || b.until < Date.now()) buckets.set(key, { count: 1, until: Date.now() + windowMs });
  else b.count++;
}
function clearFails(key) { buckets.delete(key); }
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.until < now) buckets.delete(k); }, 60000).unref();

/* ---------------------------------- owners ---------------------------------- */
const OWNER_COOKIE = 'ch_owner';
const OWNER_DAYS = 30;

async function startOwnerSession(res, ownerId) {
  const token = newToken();
  await db.q('INSERT INTO owner_sessions (token_hash, owner_id, expires_at) VALUES ($1,$2, now() + $3::interval)',
    [sha(token), ownerId, OWNER_DAYS + ' days']);
  res.cookie(OWNER_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: OWNER_DAYS * 864e5, path: '/' });
}

async function endOwnerSession(req, res) {
  const token = req.cookies[OWNER_COOKIE];
  if (token) await db.q('DELETE FROM owner_sessions WHERE token_hash=$1', [sha(token)]);
  res.clearCookie(OWNER_COOKIE, { path: '/' });
}

/** Middleware: loads req.owner and req.company or answers 401. */
async function requireOwner(req, res, next) {
  try {
    const token = req.cookies[OWNER_COOKIE];
    if (!token) return res.status(401).json({ error: 'Please log in.' });
    const row = await db.one(
      `SELECT o.id, o.email, o.name, o.company_id FROM owner_sessions s JOIN owners o ON o.id = s.owner_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`, [sha(token)]);
    if (!row) return res.status(401).json({ error: 'Please log in.' });
    req.owner = row;
    req.company = await db.one('SELECT * FROM companies WHERE id=$1', [row.company_id]);
    next();
  } catch (e) { next(e); }
}

/* ----------------------------------- crew ----------------------------------- */
const CREW_HOURS = 12;

async function startCrewSession(crewId) {
  const token = newToken();
  await db.q('INSERT INTO crew_sessions (token_hash, crew_id, expires_at) VALUES ($1,$2, now() + $3::interval)',
    [sha(token), crewId, CREW_HOURS + ' hours']);
  return token;
}

/** Middleware for /api/c/:slug/*: loads req.company, req.crew (must belong to that company). */
async function requireCrew(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'SESSION_EXPIRED' });
    const row = await db.one(
      `SELECT c.* FROM crew_sessions s JOIN crew c ON c.id = s.crew_id
       WHERE s.token_hash=$1 AND s.expires_at > now() AND c.active`, [sha(m[1])]);
    if (!row || row.company_id !== req.company.id) return res.status(401).json({ error: 'SESSION_EXPIRED' });
    req.crew = row;
    next();
  } catch (e) { next(e); }
}

module.exports = {
  sha, newToken, pinHmac, hashPassword, checkPassword, limited, fail, clearFails,
  startOwnerSession, endOwnerSession, requireOwner, startCrewSession, requireCrew
};
