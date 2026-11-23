// Compliance › Email: reads the water system mail from connected Outlook mailboxes (Microsoft 365, read-only),
// sorts out what needs attention (TDEC asking for something, a deadline, lab results, an invoice, a possible
// violation) from the rest, and sends a phone notification when something new needs attention.
// Nothing is ever sent, moved, deleted or marked read in the mailbox: the app only has Mail.Read.
const crypto = require('crypto');
const db = require('./db');
const config = require('./config');
const V = require('./validate');

const M = () => config.outlook;
const enabled = () => !!(M().clientId && M().clientSecret);
const redirectUri = () => `${config.appUrl}/api/admin/mail/callback`;
const SCOPE = 'offline_access User.Read Mail.Read';
const BACKFILL_DAYS = 30;

/* --------------------------- secrets at rest --------------------------- */
const key = () => crypto.createHash('sha256').update('mail:' + config.secret).digest();
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
  return M().authority + '/authorize?' + new URLSearchParams({ client_id: M().clientId, response_type: 'code', response_mode: 'query',
    redirect_uri: redirectUri(), scope: SCOPE, state: makeState(companyId), prompt: 'select_account' });
}
async function tokenCall(params) {
  const r = await fetch(M().authority + '/token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: M().clientId, client_secret: M().clientSecret, scope: SCOPE, ...params }).toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Outlook sign-in: ' + String(j.error_description || j.error || r.statusText).split('\n')[0].slice(0, 200)); e.code = j.error; throw e; }
  return j;
}
/* ------------------------------ attachments: saved automatically ------------------------------ */
const DOC_MAX = 15 * 1024 * 1024;               // one file
const DOCS_TOTAL = 300 * 1024 * 1024;           // all of a company's saved documents
const docKind = k => ({ 'Lab results': 'Lab report', Lab: 'Lab report', Invoice: 'Invoice', TDEC: 'TDEC letter', 'Customer billing': 'Billing', Operator: 'Operator' })[k] || 'Other';

/**
 * Save the attachments of water system emails that have them (newest first, a few each check), and read lab
 * report PDFs into results that wait on the Results tab. Returns the number of lab reports read.
 */
async function saveDocs(companyId, acct, token) {
  const items = await db.q(`SELECT id, msg_id, kind, subject, sender, sender_name, received_at FROM mail_items
    WHERE account_id=$1 AND has_attach AND NOT docs_done AND status<>'blocked' ORDER BY received_at DESC LIMIT 12`, [acct.id]);
  let read = 0;
  for (const it of items) {
    try {
      const used = Number((await db.one('SELECT COALESCE(sum(size),0)::bigint AS n FROM mail_docs WHERE company_id=$1', [companyId])).n);
      const j = await graph(token, `/me/messages/${encodeURIComponent(it.msg_id)}/attachments`);
      for (const f of j.value || []) {
        if (!/fileAttachment/.test(f['@odata.type'] || '') || f.isInline || !f.contentBytes) continue;
        const mime = String(f.contentType || 'application/octet-stream').toLowerCase().slice(0, 100);
        const size = Number(f.size) || 0;
        if (size > DOC_MAX || used + size > DOCS_TOTAL) continue;
        if (/^image\//.test(mime) && size < 60 * 1024) continue;               // logos and signatures
        const buf = Buffer.from(f.contentBytes, 'base64');
        const name = String(f.name || 'attachment').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 160);
        const d = await db.q('INSERT INTO mail_docs (company_id, item_id, name, mime, size, kind, data) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
          [companyId, it.id, name, mime, buf.length, docKind(it.kind), buf]);
        // a lab report: read it now, so the results wait on the Results tab for one tap
        const isReport = (it.kind === 'Lab results' || it.kind === 'Lab') && (/pdf/.test(mime) || /\.pdf$/i.test(name) || /^image\//.test(mime));
        if (isReport && read < 3) {
          read++;
          try {
            const company = await db.one('SELECT * FROM companies WHERE id=$1', [companyId]);
            const r = await require('./cwresults').read(company, buf);
            await db.q(`INSERT INTO cw_pending (company_id, doc_id, name, sender, received, rows, schedule, how, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready')
              ON CONFLICT (doc_id) DO NOTHING`, [companyId, d[0].id, name, it.sender_name || it.sender, it.received_at, JSON.stringify(r.rows), JSON.stringify(r.schedule || []), r.how]);
          } catch (e) { /* not a results report (or unreadable): it stays saved as a document */ }
        }
      }
      await db.q('UPDATE mail_items SET docs_done=TRUE WHERE id=$1', [it.id]);
    } catch (e) {
      if (e.status === 404) await db.q('UPDATE mail_items SET docs_done=TRUE WHERE id=$1', [it.id]);   // the email was deleted
      else throw e;
    }
  }
  return read;
}

async function graph(token, path) {
  const r = await fetch(M().graph + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', Prefer: 'outlook.body-content-type="text"' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Outlook: ' + ((j.error && j.error.message) || r.statusText)); e.status = r.status; throw e; }
  return j;
}

/** Finish connecting a mailbox: swap the code for tokens and remember which mailbox it is. */
async function finishConnect(companyId, code, state) {
  if (!checkState(state, companyId)) throw new Error('That Outlook sign-in expired. Tap Connect Outlook again.');
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  const me = await graph(t.access_token, '/me?$select=mail,userPrincipalName,displayName');
  const email = String(me.mail || me.userPrincipalName || '').toLowerCase().slice(0, 200);
  if (!email) throw new Error('Outlook did not say which mailbox this is.');
  const rows = await db.q(`INSERT INTO mail_accounts (company_id, email, name, refresh, access, access_exp, error)
    VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval, NULL)
    ON CONFLICT (company_id, email) DO UPDATE SET refresh=EXCLUDED.refresh, access=EXCLUDED.access, access_exp=EXCLUDED.access_exp, error=NULL, name=EXCLUDED.name
    RETURNING id`, [companyId, email, String(me.displayName || '').slice(0, 120), seal(t.refresh_token), seal(t.access_token), String(t.expires_in || 3600)]);
  return { id: rows[0].id, email };
}

async function accessToken(acct) {
  if (acct.access && acct.access_exp && new Date(acct.access_exp) - Date.now() > 120e3) return unseal(acct.access);
  try {
    const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(acct.refresh) });
    await db.q(`UPDATE mail_accounts SET access=$1, access_exp=now() + ($2 || ' seconds')::interval, refresh=COALESCE($3, refresh), error=NULL WHERE id=$4`,
      [seal(t.access_token), String(t.expires_in || 3600), t.refresh_token ? seal(t.refresh_token) : null, acct.id]);
    return t.access_token;
  } catch (e) {
    const msg = /invalid_grant|interaction_required/.test(e.code || '') ? 'Outlook needs you to sign in again: tap Reconnect.' : e.message;
    await db.q('UPDATE mail_accounts SET error=$1 WHERE id=$2', [msg.slice(0, 300), acct.id]);
    throw new Error(msg);
  }
}

/* ------------------------------ which mail matters ------------------------------ */
const WATER = /\bTN0000912\b|\bPWSID\b|water\s*system|deerfield\s*water|deer\s*hill\s*water|lead\s*(?:and|&)\s*copper|coliform|e\.\s*coli|boil\s*water|consumer\s*confidence|\bCCR\b|chlorine|monthly\s*operat\w*\s*report|\bMOR\b|certificate\s*of\s*analysis|sample\s*results?|sampling|sanitary\s*survey|backflow|cross[-\s]?connection|well\s*house|water\s*(?:main|line|leak|quality|plant|treatment|operator)|drinking\s*water|operator\s*cert|disinfect|\bDWR\b|water\s*resources/i;
const LAB = /minerallabs\.com$|labs?\b/i;
const NEWSLETTER = /newsletter|unsubscribe|the catalyst|webinar|green\.government|e2ma\.net|no-?reply|noreply|do-not-reply|marketing/i;
const ASK = /please\s+(?:submit|send|provide|complete|return|respond|sign|contact|call|schedule)|(?:is|are)\s+(?:due|required)|\brequired\b|\bdeadline\b|\bdue\s+(?:by|on)\b|no\s+later\s+than|\bmust\b|\bfailure\s+to\b|have\s+not\s+(?:yet\s+)?received|missing|overdue|notice\s+of|\bviolation\b|\bNOV\b|\binspection\b|sanitary\s*survey|corrective\s*action|public\s*notice|enforcement/i;
const URGENT = /boil\s*water|\bviolation\b|e\.\s*coli\s*(?:positive|present)|positive\s*(?:total\s*)?coliform|coliform\s*(?:positive|present)|exceed(?:ed|ance)|maximum\s*contaminant\s*level\s*(?:was\s*)?exceeded|\bMCL\s*exceed/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A due date written in the text ("by December 1, 2026", "due 12/1/2026", "no later than Jan 5"). */
function dueDate(text, received) {
  const s = String(text || '');
  const near = /(?:by|before|due(?:\s+(?:by|on))?|no\s+later\s+than|deadline(?:\s+(?:is|of))?|on\s+or\s+before)\s*[:,]?\s*((?:mon|tues|wednes|thurs|fri|satur|sun)day,?\s*)?((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)/i.exec(s);
  if (!near) return null;
  const d = near[2], base = new Date(received || Date.now());
  let y, m, day;
  let x = /^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?$/i.exec(d);
  if (x) { m = MONTHS.indexOf(x[1].slice(0, 3).toLowerCase()) + 1; day = +x[2]; y = x[3] ? +x[3] : null; }
  else { x = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(d); if (!x) return null; m = +x[1]; day = +x[2]; y = x[3] ? (+x[3] < 100 ? 2000 + +x[3] : +x[3]) : null; }
  if (!m || m > 12 || !day || day > 31) return null;
  if (!y) { y = base.getFullYear(); if (new Date(y, m - 1, day) < new Date(base.getFullYear(), base.getMonth(), base.getDate() - 14)) y++; }
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Sort one message. Returns null when it isn't water system mail; otherwise { attention, urgent, kind, reasons, due }.
 * own: the mailbox's own address (its own sent mail is skipped).
 */
/* ------------------------------ your rules: stop these / always let these through ------------------------------ */
// rules: { block: [{ type: 'sender'|'domain'|'subject'|'word', value }], allow: [{ type: 'sender'|'word', value }] }
const subjKey = s => String(s || '').toLowerCase().replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/[0-9]+/g, '#').replace(/[^a-z#&]+/g, ' ').replace(/\s+/g, ' ').trim();
const domainOf = e => String(e || '').toLowerCase().split('@')[1] || '';
function ruleHit(r, m) {
  const from = String(m.from || '').toLowerCase(), v = String(r.value || '').toLowerCase().trim();
  if (!v) return false;
  if (r.type === 'sender') return from === v;
  if (r.type === 'domain') { const d = domainOf(from); return d === v || d.endsWith('.' + v); }
  if (r.type === 'subject') return subjKey(m.subject).includes(v);
  if (r.type === 'word') return (String(m.subject || '') + ' ' + String(m.preview || '') + ' ' + (m.fromName || '')).toLowerCase().includes(v);
  return false;
}
const blockedBy = (m, rules) => ((rules && rules.block) || []).find(r => ruleHit(r, m)) || null;
const allowedBy = (m, rules) => ((rules && rules.allow) || []).find(r => ruleHit(r, m)) || null;

// your own billing: QuickBooks copies of invoices you sent, deposit notices, customers replying to a bill
const OWN_BILLING = /invoice\s*[#\w-]*\s+from\s+deer|payment\s+request\s+from\s+deer|statement\s+from\s+deer|reminder:?\s+invoice|billing\s+for\s+water\s+services|deerfield\s+water\s+system\s+llc\s*-\s*invoice/i;
const BILLING_SYSTEM = /(^|\.)intuit\.com$/i;   // QuickBooks and Intuit payments

function classify(m, own, rules) {
  const from = String(m.from || '').toLowerCase(), subj = String(m.subject || ''), text = subj + '\n' + String(m.preview || '');
  if (!from || from === String(own || '').toLowerCase()) return null;
  if (/@mycrewhours|mycrewhours@/.test(from)) return null;                     // the app's own alerts are already in the app
  if (blockedBy(m, rules)) return { blocked: true, attention: false, urgent: false, kind: 'Stopped', reasons: [], due: null };
  const allow = allowedBy(m, rules);
  if ((BILLING_SYSTEM.test(domainOf(from)) || /quickbooks/i.test(from)) && !allow) return null;                        // QuickBooks copies of your own invoices, deposits
  const tdec = /@tn\.gov$/.test(from), lab = /@minerallabs\.com$/.test(from) || (LAB.test(m.fromName || '') && /analysis|results|invoice/i.test(text));
  const exam = /psiexams\.com$|operator\s*cert/i.test(from + ' ' + text);
  if (!allow && !tdec && !lab && !exam && !WATER.test(text)) return null;
  if (!allow && NEWSLETTER.test(from + ' ' + (m.fromName || '')) && !WATER.test(subj) && !exam) return null;
  const reasons = [];
  let kind = tdec ? 'TDEC' : lab ? 'Lab' : exam ? 'Operator' : 'Water system';
  if (allow) reasons.push(allow.type === 'sender' ? 'From a sender you added' : `Has "${allow.value}"`);
  const ownBilling = OWN_BILLING.test(text) && !lab && !tdec;
  if (ownBilling) {
    kind = 'Customer billing';
    if (/^\s*(re|fw|fwd)\s*:/i.test(subj)) reasons.push('A customer replied about their bill');
    return { attention: reasons.length > 0, urgent: false, kind, reasons, due: null };
  }
  const urgent = URGENT.test(text);
  if (urgent) reasons.push('Possible violation or positive result');
  if (tdec && ASK.test(text)) reasons.push('TDEC is asking for something');
  if (!tdec && ASK.test(text) && WATER.test(text)) reasons.push('Asks for something');
  if (lab && /certificate\s*of\s*analysis|results|data|report/i.test(text) && !/invoice/i.test(subj)) { reasons.push('Lab results: import them on the Results tab'); kind = 'Lab results'; }
  if (/invoice|amount\s*due|balance\s*due|payment\s*due|past\s*due/i.test(text) && (lab || tdec || (WATER.test(text) && !/^\s*(re|fw|fwd)\s*:/i.test(subj)))) { reasons.push('Invoice to pay'); kind = 'Invoice'; }
  const due = dueDate(text, m.received);
  if (due) reasons.push('Due ' + due);
  return { attention: reasons.length > 0, urgent, kind, reasons, due };
}

/* ------------------------------ sync ------------------------------ */
/** Read new mail from every connected mailbox; returns { added, attention: [new items needing attention] }. */
const SORT_VERSION = 2;    // raise when the sorting changes: saved emails are sorted again
async function sync(companyId, { notify = true, rescan = false } = {}) {
  const accts = await db.q('SELECT * FROM mail_accounts WHERE company_id=$1 ORDER BY id', [companyId]);
  const rules = await getRules(companyId);
  const out = { added: 0, attention: [], errors: [] };
  if (accts.some(a => (a.sort_v || 0) < SORT_VERSION)) { await resort(companyId, rules); await db.q('UPDATE mail_accounts SET sort_v=$1 WHERE company_id=$2', [SORT_VERSION, companyId]); }
  for (const a of accts) {
    try {
      const token = await accessToken(a);
      const first = !a.synced_at || rescan;
      const since = new Date(first ? Date.now() - BACKFILL_DAYS * 864e5 : new Date(a.synced_at).getTime() - 30 * 60e3).toISOString();
      const started = new Date();
      let path = `/me/messages?$select=id,subject,from,receivedDateTime,bodyPreview,webLink,hasAttachments,importance&$filter=receivedDateTime ge ${since}&$orderby=receivedDateTime desc&$top=50`;
      for (let page = 0; path && page < 8; page++) {
        const j = await graph(token, path);
        for (const g of j.value || []) {
          const m = { id: g.id, subject: String(g.subject || '(no subject)').slice(0, 300), from: ((g.from || {}).emailAddress || {}).address || '', fromName: ((g.from || {}).emailAddress || {}).name || '',
            preview: String(g.bodyPreview || '').replace(/\s+/g, ' ').slice(0, 600), received: g.receivedDateTime, link: g.webLink || '', attach: !!g.hasAttachments };
          const c = classify(m, a.email, rules);
          if (!c) continue;
          const r = await db.q(`INSERT INTO mail_items (company_id, account_id, msg_id, received_at, sender, sender_name, subject, preview, web_link, has_attach, kind, reasons, due, attention, urgent, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (account_id, msg_id) DO NOTHING RETURNING id`,
            [companyId, a.id, String(m.id).slice(0, 300), m.received, m.from.slice(0, 200), m.fromName.slice(0, 120), m.subject, m.preview, m.link.slice(0, 1000), m.attach, c.kind,
              JSON.stringify(c.reasons), c.due, c.attention, c.urgent, c.blocked ? 'blocked' : c.attention ? 'new' : 'fyi']);
          if (r.length) { out.added++; if (c.attention && !c.blocked && !first) out.attention.push({ id: r[0].id, subject: m.subject, from: m.fromName || m.from, urgent: c.urgent }); }
        }
        path = j['@odata.nextLink'] ? j['@odata.nextLink'].replace(M().graph, '') : null;
      }
      await db.q('UPDATE mail_accounts SET synced_at=$1, error=NULL WHERE id=$2', [started, a.id]);
      await saveDocs(companyId, a, token).catch(e => console.error('[mail] attachments', e.message));
    } catch (e) {
      out.errors.push(`${a.email}: ${e.message}`);
      await db.q('UPDATE mail_accounts SET error=$1 WHERE id=$2', [String(e.message).slice(0, 300), a.id]);
    }
  }
  if (notify && out.attention.length) {
    const c = await db.one('SELECT * FROM companies WHERE id=$1', [companyId]);
    const n = out.attention.length, u = out.attention.some(x => x.urgent);
    await require('./push').notify(c, null, { feature: 'compliance', notGuards: true, path: 'compliance#email', tag: 'water-mail',
      title: `${u ? '⚠️ ' : '📧 '}${n === 1 ? 'Water system email needs attention' : n + ' water system emails need attention'}`,
      body: out.attention.slice(0, 3).map(x => `${x.from}: ${x.subject}`).join(' · ') }).catch(e => console.error('[mail] notify', e.message));
  }
  return out;
}

/** Sort the saved emails again (after your rules change). Emails marked Done stay done. */
async function resort(companyId, rules) {
  const items = await db.q(`SELECT i.id, i.sender, i.sender_name, i.subject, i.preview, i.received_at, i.status, a.email AS own
    FROM mail_items i JOIN mail_accounts a ON a.id=i.account_id WHERE i.company_id=$1`, [companyId]);
  for (const it of items) {
    const c = classify({ from: it.sender, fromName: it.sender_name, subject: it.subject, preview: it.preview, received: it.received_at }, it.own, rules);
    if (!c) { await db.q('DELETE FROM mail_items WHERE id=$1', [it.id]); continue; }
    const status = c.blocked ? 'blocked' : it.status === 'done' ? 'done' : c.attention ? 'new' : 'fyi';
    await db.q('UPDATE mail_items SET kind=$1, reasons=$2, due=$3, attention=$4, urgent=$5, status=$6 WHERE id=$7',
      [c.kind, JSON.stringify(c.reasons), c.due, c.attention, c.urgent, status, it.id]);
  }
}

async function getRules(companyId) {
  const c = await db.one('SELECT mail_rules FROM companies WHERE id=$1', [companyId]);
  const r = (c && c.mail_rules) || {};
  return { block: Array.isArray(r.block) ? r.block : [], allow: Array.isArray(r.allow) ? r.allow : [] };
}
/** Add a rule: list 'block' (stop these) or 'allow' (always let these through). */
async function addRule(companyId, b) {
  const list = b.list === 'allow' ? 'allow' : b.list === 'block' ? 'block' : V.bad('Stop or let through?');
  const types = list === 'allow' ? ['sender', 'word'] : ['sender', 'domain', 'subject', 'word'];
  const type = types.includes(b.type) ? b.type : V.bad('Pick what to match.');
  let value = String(b.value || '').trim().toLowerCase();
  if (type === 'sender') { if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(value)) V.bad('Type a whole email address, like name@tn.gov.'); }
  else if (type === 'domain') { value = value.replace(/^.*@/, ''); if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) V.bad('Type a domain, like intuit.com.'); }
  else if (type === 'subject') { value = subjKey(value); if (value.length < 4) V.bad('That subject is too short to match on.'); }
  else { if (value.length < 3) V.bad('Type a word or phrase of at least 3 letters.'); }
  if (value.length > 200) V.bad('That is too long.');
  const rules = await getRules(companyId);
  if (rules[list].length >= 100) V.bad('That list is full (100).');
  if (!rules[list].some(r => r.type === type && r.value === value)) rules[list].push({ id: crypto.randomBytes(5).toString('hex'), type, value, at: new Date().toISOString() });
  await db.q('UPDATE companies SET mail_rules=$1 WHERE id=$2', [JSON.stringify(rules), companyId]);
  await resort(companyId, rules);
  // a new address or word to let through: look back through the last 30 days for it (no notifications for those)
  if (list === 'allow') await sync(companyId, { notify: false, rescan: true }).catch(e => console.error('[mail] rescan', e.message));
  return list_(companyId);
}
async function removeRule(companyId, id) {
  const rules = await getRules(companyId);
  rules.block = rules.block.filter(r => r.id !== id); rules.allow = rules.allow.filter(r => r.id !== id);
  await db.q('UPDATE companies SET mail_rules=$1 WHERE id=$2', [JSON.stringify(rules), companyId]);
  await resort(companyId, rules);
  return list_(companyId);
}

/* ------------------------------ the tab ------------------------------ */
const list_ = companyId => list(companyId);
async function list(companyId) {
  const items = await db.q(`SELECT i.id, i.received_at AS received, i.sender, i.sender_name AS "senderName", i.subject, i.preview, i.web_link AS link, i.has_attach AS attach,
      i.kind, i.reasons, to_char(i.due,'YYYY-MM-DD') AS due, i.attention, i.urgent, i.status, i.done_by AS "doneBy", i.done_at AS "doneAt", a.email AS mailbox
    FROM mail_items i JOIN mail_accounts a ON a.id=i.account_id
    WHERE i.company_id=$1 AND i.status<>'blocked' AND (i.status='new' OR i.received_at > now() - interval '45 days')
    ORDER BY i.urgent DESC, i.received_at DESC LIMIT 300`, [companyId]);
  const accounts = await db.q('SELECT id, email, name, synced_at AS "syncedAt", error FROM mail_accounts WHERE company_id=$1 ORDER BY id', [companyId]);
  const docs = await db.q(`SELECT d.id, d.item_id AS "itemId", d.name, d.mime, d.size, d.kind, d.created_at AS "savedAt", i.received_at AS received, i.sender_name AS "senderName", i.sender, i.subject
    FROM mail_docs d JOIN mail_items i ON i.id=d.item_id WHERE d.company_id=$1 AND i.status<>'blocked' ORDER BY i.received_at DESC, d.id LIMIT 500`, [companyId]);
  return { enabled: enabled(), accounts, items, docs, rules: await getRules(companyId) };
}
async function setStatus(companyId, id, done, who) {
  const it = await db.one('SELECT id, attention FROM mail_items WHERE id=$1 AND company_id=$2', [Number(id) || 0, companyId]);
  if (!it) V.bad('That email was not found.');
  await db.q(`UPDATE mail_items SET status=$1, done_by=$2, done_at=CASE WHEN $1='done' THEN now() ELSE NULL END WHERE id=$3`,
    [done ? 'done' : (it.attention ? 'new' : 'fyi'), done ? String(who || '').slice(0, 80) : null, it.id]);
  return list(companyId);
}
/** Move an FYI email into Needs attention (or back). */
async function flag(companyId, id, on) {
  const it = await db.one('SELECT id FROM mail_items WHERE id=$1 AND company_id=$2', [Number(id) || 0, companyId]);
  if (!it) V.bad('That email was not found.');
  await db.q(`UPDATE mail_items SET attention=$1, status=CASE WHEN $1 THEN 'new' ELSE 'fyi' END WHERE id=$2`, [!!on, it.id]);
  return list(companyId);
}
async function disconnect(companyId, id) {
  await db.q('DELETE FROM mail_accounts WHERE id=$1 AND company_id=$2', [Number(id) || 0, companyId]);
  return list(companyId);
}
const attentionCount = async companyId => (await db.one("SELECT count(*)::int AS n FROM mail_items WHERE company_id=$1 AND status='new'", [companyId])).n;

/** Routes for the Compliance page (crew managers and the boss). */
function mount(r, prefix, guard, who) {
  const g = guard ? [].concat(guard) : [];
  r.get(prefix + '/mail', ...g, async (req, res) => res.json(await list(req.company.id)));
  r.post(prefix + '/mail/:id/done', ...g, async (req, res) => res.json(await setStatus(req.company.id, req.params.id, true, who(req))));
  r.post(prefix + '/mail/:id/undone', ...g, async (req, res) => res.json(await setStatus(req.company.id, req.params.id, false)));
  r.get(prefix + '/mail/docs/:id', ...g, async (req, res) => {
    const d = await db.one('SELECT name, mime, data FROM mail_docs WHERE id=$1 AND company_id=$2', [Number(req.params.id) || 0, req.company.id]);
    if (!d) return res.status(404).json({ error: 'That document was not found.' });
    const viewable = /^(application\/pdf|image\/(png|jpe?g|gif|webp))$/.test(d.mime);
    res.set({ 'Content-Type': viewable ? d.mime : 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${viewable ? 'inline' : 'attachment'}; filename="${d.name.replace(/[^\w .()-]+/g, '_')}"`, 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" }).send(d.data);
  });
  r.post(prefix + '/mail/rules', ...g, async (req, res) => res.json(await addRule(req.company.id, req.body || {})));
  r.delete(prefix + '/mail/rules/:id', ...g, async (req, res) => res.json(await removeRule(req.company.id, String(req.params.id))));
  r.post(prefix + '/mail/:id/flag', ...g, async (req, res) => res.json(await flag(req.company.id, req.params.id, (req.body || {}).on !== false)));
}

module.exports = { enabled, authUrl, finishConnect, sync, list, addRule, removeRule, getRules, subjKey, setStatus, flag, disconnect, classify, dueDate, attentionCount, mount, redirectUri };
