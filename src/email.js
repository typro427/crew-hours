const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;
function getTransport() {
  if (!transport && !config.mail.logOnly) transport = nodemailer.createTransport(config.mail.smtpUrl);
  return transport;
}

/** Sends an email, or prints it to the log when no SMTP_URL is set (development). */
async function send({ to, subject, html, text }) {
  const list = (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/)).map(s => s.trim()).filter(Boolean);
  if (!list.length) return { skipped: true };
  if (config.mail.logOnly) {
    console.log(`[email] to=${list.join(',')} subject=${subject}`);
    send.outbox.push({ to: list, subject, html, text });
    return { logged: true };
  }
  return getTransport().sendMail({ from: config.mail.from, to: list.join(','), subject, html, text });
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

module.exports = { send, esc, layout };
