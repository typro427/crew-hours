// Sign up, log in, log out, forgot / reset password.
const crypto = require('crypto');
const db = require('../db');
const A = require('../auth');
const V = require('../validate');
const config = require('../config');
const { send, esc, layout } = require('../email');

const r = require('../router')();

async function uniqueSlug(base, q) {
  for (let i = 0; i < 50; i++) {
    const slug = i === 0 ? base : `${base}-${crypto.randomBytes(2).toString('hex')}`;
    if (!(await q('SELECT 1 FROM companies WHERE slug=$1', [slug])).length) return slug;
  }
  throw new Error('Could not make a unique link.');
}

r.post('/signup', async (req, res) => {
  const ip = req.ip;
  if (A.limited('signup:' + ip, 10, 60 * 60e3)) return res.status(429).json({ error: 'Too many sign-ups from here. Try again later.' });
  const company = V.str(req.body.company, 'your company name', 1, 80);
  const name = V.str(req.body.name, 'your name', 1, 80);
  const email = V.email(req.body.email);
  const password = V.password(req.body.password);
  const tz = typeof req.body.timezone === 'string' && require('../time').validTimeZone(req.body.timezone) ? req.body.timezone : 'America/New_York';
  if (await db.one('SELECT 1 FROM owners WHERE email=$1', [email])) return res.status(400).json({ error: 'That email already has an account. Log in instead.' });
  const hash = await A.hashPassword(password);
  const owner = await db.tx(async t => {
    const slug = await uniqueSlug(V.slugify(company), t.q);
    const c = await t.one(`INSERT INTO companies (name, slug, timezone, trial_ends_at) VALUES ($1,$2,$3, now() + $4::interval) RETURNING id`,
      [company, slug, tz, config.trialDays + ' days']);
    return t.one('INSERT INTO owners (company_id, email, name, password_hash) VALUES ($1,$2,$3,$4) RETURNING id', [c.id, email, name, hash]);
  });
  A.fail('signup:' + ip, 60 * 60e3);   // counts sign-ups per IP, not failures
  await A.startOwnerSession(res, owner.id);
  res.json({ ok: true });
});

r.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const key = 'login:' + email + ':' + req.ip;
  if (A.limited(key, 8, 15 * 60e3)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  const o = await db.one('SELECT id, password_hash FROM owners WHERE email=$1', [email]);
  if (!o || !(await A.checkPassword(String(req.body.password || ''), o.password_hash))) {
    A.fail(key, 15 * 60e3);
    return res.status(400).json({ error: "That email and password don't match." });
  }
  A.clearFails(key);
  await A.startOwnerSession(res, o.id);
  res.json({ ok: true });
});

r.post('/logout', async (req, res) => { await A.endOwnerSession(req, res); res.json({ ok: true }); });

r.post('/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (A.limited('forgot:' + req.ip, 5, 60 * 60e3)) return res.status(429).json({ error: 'Too many requests. Try again later.' });
  A.fail('forgot:' + req.ip, 60 * 60e3);
  const o = await db.one('SELECT id, name FROM owners WHERE email=$1', [email]);
  if (o) {
    const token = A.newToken();
    await db.q("INSERT INTO password_resets (token_hash, owner_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [A.sha(token), o.id]);
    const link = `${config.appUrl}/reset#${token}`;
    send({ to: email, subject: `Reset your ${config.productName} password`,
      html: layout('Reset your password', `<p>Hi ${esc(o.name)}, use this link to choose a new password. It works for 1 hour.</p><p><a href="${link}">Choose a new password</a></p><p style="color:#777">If you didn't ask for this, ignore this email.</p>`) }).catch(() => {});   // logged in email.js
  }
  res.json({ ok: true });   // same answer either way, so nobody can test which emails exist
});

r.post('/reset', async (req, res) => {
  const password = V.password(req.body.password);
  const row = await db.one('SELECT owner_id FROM password_resets WHERE token_hash=$1 AND NOT used AND expires_at > now()', [A.sha(String(req.body.token || ''))]);
  if (!row) return res.status(400).json({ error: 'That reset link has expired. Ask for a new one.' });
  await db.tx(async t => {
    await t.q('UPDATE owners SET password_hash=$1 WHERE id=$2', [await A.hashPassword(password), row.owner_id]);
    await t.q('UPDATE password_resets SET used=TRUE WHERE owner_id=$1', [row.owner_id]);
    await t.q('DELETE FROM owner_sessions WHERE owner_id=$1', [row.owner_id]);
  });
  await A.startOwnerSession(res, row.owner_id);
  res.json({ ok: true });
});

module.exports = r;
