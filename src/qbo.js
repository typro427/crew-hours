// QuickBooks Online connection (read-only use): owners see their balance, invoices and payments in the owner portal.
// The boss connects once (Intuit sign-in). Customers are matched to meters by the QuickBooks customer name.
// Intuit rotates the refresh token: always keep the newest one, and refresh one at a time.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const V = require('./validate');

const Q = () => config.qbo;
const enabled = () => !!(Q().clientId && Q().clientSecret);
const redirectUri = () => `${config.appUrl}/api/admin/quickbooks/callback`;
const MINOR = 75;

/* --------------------------- secrets at rest --------------------------- */
const key = () => crypto.createHash('sha256').update('qbo:' + config.secret).digest();
function seal(text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function unseal(s) {
  const [iv, tag, enc] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv); d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
function makeState(companyId) {
  const body = `${companyId}.${Date.now() + 10 * 60e3}.${crypto.randomBytes(8).toString('hex')}`;
  return body + '.' + crypto.createHmac('sha256', key()).update(body).digest('hex').slice(0, 32);
}
function checkState(state, companyId) {
  const p = String(state || '').split('.');
  if (p.length !== 4) return false;
  const body = p.slice(0, 3).join('.'), sig = crypto.createHmac('sha256', key()).update(body).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(p[3].padEnd(32).slice(0, 32))) && Number(p[0]) === companyId && Number(p[1]) > Date.now();
}

/* ------------------------------ sign-in ------------------------------ */
function authUrl(companyId) {
  return Q().authUrl + '?' + new URLSearchParams({ client_id: Q().clientId, response_type: 'code', scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: redirectUri(), state: makeState(companyId) });
}
const basic = () => 'Basic ' + Buffer.from(Q().clientId + ':' + Q().clientSecret).toString('base64');
async function tokenCall(params) {
  const r = await fetch(Q().tokenUrl, { method: 'POST', headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('QuickBooks sign-in: ' + (j.error_description || j.error || r.statusText)); e.code = j.error; throw e; }
  return j;
}
async function saveTokens(companyId, t, extra = {}) {
  await db.q(`UPDATE companies SET qbo_refresh=$1, qbo_access=$2, qbo_access_exp=now() + ($3 || ' seconds')::interval, qbo_error=NULL
    ${extra.realm ? ', qbo_realm=$5' : ''} WHERE id=$4`, extra.realm ? [seal(t.refresh_token), seal(t.access_token), String(t.expires_in || 3600), companyId, extra.realm]
    : [seal(t.refresh_token), seal(t.access_token), String(t.expires_in || 3600), companyId]);
}

/** Finish connecting: swap the code for tokens, remember which QuickBooks company, then pull customers. */
async function finishConnect(companyId, code, realmId, state) {
  if (!checkState(state, companyId)) throw new Error('That QuickBooks sign-in expired. Tap Connect to QuickBooks again.');
  if (!/^[0-9]{1,30}$/.test(String(realmId || ''))) throw new Error('QuickBooks did not say which company to connect.');
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  await saveTokens(companyId, t, { realm: String(realmId) });
  try {
    const info = await api(companyId, `/companyinfo/${realmId}`);
    await db.q('UPDATE companies SET qbo_company=$1 WHERE id=$2', [String((info.CompanyInfo || {}).CompanyName || '').slice(0, 200), companyId]);
  } catch (e) { /* name is only for show */ }
}

async function disconnect(companyId) {
  const c = await db.one('SELECT qbo_refresh FROM companies WHERE id=$1', [companyId]);
  if (c && c.qbo_refresh && Q().revokeUrl) {
    try { await fetch(Q().revokeUrl, { method: 'POST', headers: { Authorization: basic(), Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: unseal(c.qbo_refresh) }) }); } catch (e) {}
  }
  await db.q('UPDATE companies SET qbo_realm=NULL, qbo_refresh=NULL, qbo_access=NULL, qbo_access_exp=NULL, qbo_company=NULL, qbo_error=NULL, qbo_synced_at=NULL WHERE id=$1', [companyId]);
  await db.q('DELETE FROM qbo_customers WHERE company_id=$1', [companyId]);
  cache.clear();
}

/* ------------------------------ API calls ------------------------------ */
const refreshing = new Map();   // one refresh at a time per company (Intuit rotates the token)
async function accessToken(companyId, force) {
  const c = await db.one('SELECT qbo_access, qbo_refresh, qbo_realm, (qbo_access_exp > now() + interval \'60 seconds\') AS fresh FROM companies WHERE id=$1', [companyId]);
  if (!c || !c.qbo_refresh || !c.qbo_realm) { const e = new Error('QuickBooks is not connected.'); e.code = 'NOT_CONNECTED'; throw e; }
  if (c.fresh && c.qbo_access && !force) return { token: unseal(c.qbo_access), realm: c.qbo_realm };
  if (!refreshing.has(companyId)) {
    refreshing.set(companyId, (async () => {
      try {
        const cur = await db.one('SELECT qbo_refresh FROM companies WHERE id=$1', [companyId]);
        const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(cur.qbo_refresh) });
        await saveTokens(companyId, t);
      } catch (e) {
        if (e.code === 'invalid_grant') await db.q("UPDATE companies SET qbo_error='QuickBooks needs to be connected again (the sign-in expired or was removed).' WHERE id=$1", [companyId]);
        throw e;
      } finally { refreshing.delete(companyId); }
    })());
  }
  await refreshing.get(companyId);
  const n = await db.one('SELECT qbo_access, qbo_realm FROM companies WHERE id=$1', [companyId]);
  return { token: unseal(n.qbo_access), realm: n.qbo_realm };
}

async function api(companyId, path, opts = {}, retried) {
  const { token, realm } = await accessToken(companyId);
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(`${Q().apiBase}/v3/company/${realm}${path}${sep}minorversion=${MINOR}`, {
    headers: { Authorization: 'Bearer ' + token, Accept: opts.pdf ? 'application/pdf' : 'application/json' } });
  if (r.status === 401 && !retried) { await accessToken(companyId, true); return api(companyId, path, opts, true); }
  if (!r.ok) { const txt = await r.text().catch(() => ''); const e = new Error(`QuickBooks said ${r.status}: ${txt.slice(0, 200)}`); e.status = r.status; throw e; }
  return opts.pdf ? Buffer.from(await r.arrayBuffer()) : r.json();
}
const query = (companyId, sql) => api(companyId, '/query?query=' + encodeURIComponent(sql)).then(j => j.QueryResponse || {});
const qs = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");   // QuickBooks query strings

/* ------------------------------ customers ------------------------------ */
const norm = s => String(s || '').toLowerCase().replace(/^\(inactive\)\s*/, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** "Tail, Wendy" -> "wendy tail", so last-first and first-last names match. */
const swapped = s => { const m = /^([^,]+),\s*(.+)$/.exec(String(s || '')); return m ? norm(m[2] + ' ' + m[1]) : ''; };

/** Pull every customer (name, balance) and link meters to them by the QuickBooks customer name on the meter. */
async function sync(companyId) {
  const all = [];
  for (let start = 1; start < 50000; start += 1000) {
    const r = await query(companyId, `SELECT Id, DisplayName, FullyQualifiedName, Balance, Active FROM Customer STARTPOSITION ${start} MAXRESULTS 1000`);
    const list = r.Customer || [];
    all.push(...list);
    if (list.length < 1000) break;
  }
  await db.tx(async t => {
    await t.q('DELETE FROM qbo_customers WHERE company_id=$1', [companyId]);
    for (let i = 0; i < all.length; i += 500) {
      const chunk = all.slice(i, i + 500), vals = [], args = [];
      chunk.forEach(c => { args.push(companyId, String(c.Id), c.DisplayName || c.FullyQualifiedName || '', Number(c.Balance) || 0, c.Active !== false); const n = args.length; vals.push(`($${n - 4},$${n - 3},$${n - 2},$${n - 1},$${n})`); });
      if (vals.length) await t.q(`INSERT INTO qbo_customers (company_id, qb_id, name, balance, active) VALUES ${vals.join(',')}`, args);
    }
  });
  // link: the meter's QuickBooks customer name (set from your customer file), else its customer name; a hand-picked link is kept
  const byName = new Map();
  all.forEach(c => { [c.DisplayName, c.FullyQualifiedName].forEach(n => { const k = norm(n); if (k && !byName.has(k)) byName.set(k, String(c.Id)); }); });
  const ids = new Set(all.map(c => String(c.Id)));
  const meters = await db.q('SELECT id, name, qb_customer, qbo_id, qbo_manual FROM meters WHERE company_id=$1 AND active', [companyId]);
  for (const m of meters) {
    if (m.qbo_manual && m.qbo_id && ids.has(m.qbo_id)) continue;
    const id = byName.get(norm(m.qb_customer)) || byName.get(norm(m.name)) || byName.get(swapped(m.qb_customer)) || byName.get(swapped(m.name)) || null;
    if (id !== m.qbo_id) await db.q('UPDATE meters SET qbo_id=$1, qbo_manual=FALSE WHERE id=$2', [id, m.id]);
  }
  await db.q('UPDATE companies SET qbo_synced_at=now(), qbo_error=NULL WHERE id=$1', [companyId]);
  cache.clear();
  return status(companyId);
}

/** Pick the QuickBooks customer for one meter by hand (or clear it). */
async function link(companyId, meterId, qbId) {
  const m = await db.one('SELECT id FROM meters WHERE id=$1 AND company_id=$2', [meterId, companyId]);
  if (!m) V.bad('That meter was not found.');
  if (qbId && !(await db.one('SELECT 1 FROM qbo_customers WHERE company_id=$1 AND qb_id=$2', [companyId, String(qbId)]))) V.bad('Pick a QuickBooks customer from the list.');
  await db.q('UPDATE meters SET qbo_id=$1, qbo_manual=$2 WHERE id=$3', [qbId ? String(qbId) : null, !!qbId, meterId]);
}

async function status(companyId) {
  const c = await db.one('SELECT qbo_realm, qbo_company, qbo_synced_at, qbo_error FROM companies WHERE id=$1', [companyId]);
  const meters = await db.q(`SELECT m.id, m.seq, m.name, m.address, m.qb_customer AS "qbCustomer", m.qbo_id AS "qboId", m.qbo_manual AS manual, q.name AS "qboName"
    FROM meters m LEFT JOIN qbo_customers q ON q.company_id=m.company_id AND q.qb_id=m.qbo_id WHERE m.company_id=$1 AND m.active AND m.meter_no<>'' ORDER BY m.seq`, [companyId]);
  const customers = await db.q('SELECT qb_id AS id, name FROM qbo_customers WHERE company_id=$1 AND active ORDER BY lower(name)', [companyId]);
  return { setUp: enabled(), connected: !!(c && c.qbo_realm), company: c && c.qbo_company, syncedAt: c && c.qbo_synced_at, error: c && c.qbo_error,
    linked: meters.filter(m => m.qboName).length, total: meters.length, unlinked: meters.filter(m => !m.qboName), customers,
    redirectUri: redirectUri() };
}

/* ------------------------------ for owners ------------------------------ */
const cache = new Map();   // company:customer -> { at, data }, so a busy portal doesn't use up Intuit's monthly reads
const CACHE_MS = 10 * 60e3;
async function account(companyId, qbId) {
  const k = companyId + ':' + qbId, hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const id = qs(qbId);
  const cust = ((await query(companyId, `SELECT Id, DisplayName, Balance FROM Customer WHERE Id = '${id}'`)).Customer || [])[0];
  if (!cust) return null;
  const inv = (await query(companyId, `SELECT Id, DocNumber, TxnDate, DueDate, TotalAmt, Balance FROM Invoice WHERE CustomerRef = '${id}' ORDERBY TxnDate DESC MAXRESULTS 24`)).Invoice || [];
  const pay = (await query(companyId, `SELECT Id, TxnDate, TotalAmt FROM Payment WHERE CustomerRef = '${id}' ORDERBY TxnDate DESC MAXRESULTS 12`)).Payment || [];
  const today = new Date().toISOString().slice(0, 10);
  const data = { name: cust.DisplayName, balance: Number(cust.Balance) || 0,
    invoices: inv.map(i => ({ id: String(i.Id), number: i.DocNumber || '', date: i.TxnDate, due: i.DueDate || '', total: Number(i.TotalAmt) || 0, balance: Number(i.Balance) || 0,
      status: !(Number(i.Balance) > 0) ? 'paid' : (i.DueDate && i.DueDate < today ? 'overdue' : 'open') })),
    payments: pay.map(p => ({ date: p.TxnDate, amount: Number(p.TotalAmt) || 0 })), asOf: new Date().toISOString() };
  cache.set(k, { at: Date.now(), data });
  return data;
}

/** The owner's view for one meter, or null (not connected / not linked). Never throws: the portal still works without it. */
async function forMeter(companyId, meterId) {
  try {
    const m = await db.one("SELECT m.qbo_id FROM meters m JOIN companies c ON c.id=m.company_id WHERE m.id=$1 AND m.company_id=$2 AND c.qbo_realm IS NOT NULL", [meterId, companyId]);
    if (!m || !m.qbo_id) return null;
    return await account(companyId, m.qbo_id);
  } catch (e) {
    console.error('[qbo]', companyId, e.message);
    return { error: true };
  }
}

/** An invoice PDF, only if it belongs to that meter's customer. */
async function invoicePdf(companyId, meterId, invoiceId) {
  const m = await db.one('SELECT qbo_id FROM meters WHERE id=$1 AND company_id=$2', [meterId, companyId]);
  if (!m || !m.qbo_id || !/^[0-9]{1,20}$/.test(String(invoiceId))) return null;
  const inv = ((await query(companyId, `SELECT Id, CustomerRef FROM Invoice WHERE Id = '${qs(invoiceId)}'`)).Invoice || [])[0];
  if (!inv || String((inv.CustomerRef || {}).value) !== String(m.qbo_id)) return null;
  return api(companyId, `/invoice/${invoiceId}/pdf`, { pdf: true });
}

module.exports = { enabled, authUrl, finishConnect, disconnect, sync, link, status, forMeter, invoicePdf, account, redirectUri };
