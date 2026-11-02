const nodemailer = require('nodemailer');
const config = require('./config');

const transports = {};
/** SMTP connection from SMTP_URL (or another URL), with short timeouts so a blocked or wrong server fails fast instead of hanging. */
function getTransport(url = config.mail.smtpUrl) {
  if (!transports[url]) {
    const u = new URL(url);
    const port = Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587);
    transports[url] = nodemailer.createTransport({
      host: u.hostname, port, secure: u.protocol === 'smtps:' || port === 465,
      auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
    });
  }
  return transports[url];
}
/** The address INVOICE_SMTP_URL signs in as, if it's set. */
function invoiceMailbox() {
  if (!config.mail.invoiceSmtpUrl) return '';
  try { return decodeURIComponent(new URL(config.mail.invoiceSmtpUrl).username || '').toLowerCase(); } catch (e) { return ''; }
}

/** Sends an email, or prints it to the log when no SMTP_URL is set (development). */
async function send({ to, subject, html, text, fromName, replyTo, fromAddress }) {
  const list = (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean);
  if (!list.length) return { skipped: true };
  if (config.mail.logOnly) {
    console.log(`[email] to=${list.join(',')} subject=${subject}`);
    send.outbox.push({ to: list, subject, html, text, fromName, replyTo, fromAddress });
    return { logged: true };
  }
  try {
    // fromName: e.g. an invoice from "Bill Newhaul" (same sending address, his name, replies go to him)
    // fromAddress: only when its own mailbox is connected (INVOICE_SMTP_URL); otherwise the app's address with replies to it
    const own = fromAddress && invoiceMailbox() === String(fromAddress).toLowerCase();
    const addr = own ? fromAddress : (/<([^>]+)>/.exec(config.mail.from) || [null, config.mail.from])[1];
    const from = fromName ? `"${String(fromName).replace(/["\r\n]/g, '')}" <${addr}>` : config.mail.from;
    const reply = replyTo || (fromAddress && !own ? fromAddress : undefined);
    const info = await getTransport(own ? config.mail.invoiceSmtpUrl : undefined).sendMail({ from, to: list.join(','), subject, html, text, ...(reply ? { replyTo: reply } : {}) });
    console.log(`[email] sent "${subject}" to ${list.length} recipient(s)`);
    return info;
  } catch (e) {
    console.error(`[email] FAILED "${subject}": ${e.code || ''} ${e.message}`);
    const err = new Error(e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION' || /timeout/i.test(e.message)
      ? "Couldn't reach the email server. If you're on Render's free plan, it blocks sending email. See LAUNCH.md step 3."
      : e.code === 'EAUTH' ? 'The email server rejected the login. Check the app password in SMTP_URL.' : 'Sending the email failed: ' + e.message);
    err.expose = true;
    throw err;
  }
}
send.outbox = [];   // used by tests and development

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function layout(title, body) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2328;max-width:680px">
  <div style="font-weight:bold;font-size:13px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px">
    <span style="background:#e3a008;padding:2px 6px">Crew</span> Hours</div>
  <h2 style="margin:0 0 6px;font-size:20px">${esc(title)}</h2>${body}
  <p style="margin-top:24px;color:#888;font-size:12px">Sent by ${esc(config.productName)}. Change who gets these emails in Settings.</p></div>`;
}

module.exports = { send, esc, layout, invoiceMailbox };
