// Apple push notifications for the iPhone app (APNs, token-based). Needs, in Render:
//   APNS_KEY      the .p8 key's text (from developer.apple.com > Keys, with Apple Push Notifications ticked)
//   APNS_KEY_ID   that key's 10-character ID
//   APNS_TEAM_ID  your Apple developer team ID
//   APNS_TOPIC    the app's bundle ID (e.g. com.deerfieldmanagement.crewhours)
// Phones running a build straight from Xcode use Apple's sandbox; TestFlight and App Store builds use production.
// The app says which it is when it registers, and each phone is sent to the right one.
const http2 = require('http2');
const crypto = require('crypto');

const cfg = () => ({
  key: String(process.env.APNS_KEY || '').replace(/\\n/g, '\n').trim(),
  keyId: String(process.env.APNS_KEY_ID || '').trim(),
  teamId: String(process.env.APNS_TEAM_ID || '').trim(),
  topic: String(process.env.APNS_TOPIC || '').trim()
});
const enabled = () => { const c = cfg(); return !!(c.key && c.keyId && c.teamId && c.topic); };

let jwt = null;   // { token, at }: Apple wants a fresh one at least hourly, and not more than every 20 minutes
function bearer() {
  if (jwt && Date.now() - jwt.at < 40 * 60e3) return jwt.token;
  const c = cfg();
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: c.keyId }), body = b64({ iss: c.teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: c.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  jwt = { token: `${head}.${body}.${sig}`, at: Date.now() };
  return jwt.token;
}

const sessions = {};
function session(sandbox) {
  const host = process.env.APNS_HOST || (sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
  const s = sessions[host];
  if (s && !s.closed && !s.destroyed) return s;
  const n = http2.connect(host);
  n.on('error', () => {}); n.on('goaway', () => n.close());
  n.setTimeout(5 * 60e3, () => n.close());
  sessions[host] = n;
  return n;
}

/**
 * Send one notification. Resolves { ok } or { gone } (the phone uninstalled the app / turned them off), never throws
 * for Apple's answers; throws only if Apple can't be reached.
 */
function send(token, { title, body, url, tag }, sandbox) {
  if (send.sender) return send.sender(token, { title, body, url, tag }, sandbox);   // tests
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default', 'thread-id': tag || undefined }, url });
    const req = session(sandbox).request({
      ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${bearer()}`,
      'apns-topic': cfg().topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 12 * 3600),
      'content-type': 'application/json'
    });
    let status = 0, data = '';
    req.setTimeout(15e3, () => { req.close(); reject(new Error('Apple push timed out')); });
    req.on('response', h => { status = h[':status']; });
    req.on('data', d => { data += d; });
    req.on('end', () => {
      let reason = ''; try { reason = JSON.parse(data || '{}').reason || ''; } catch (e) { /* ignore */ }
      if (status === 200) resolve({ ok: true });
      else if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(reason)) resolve({ gone: true, reason });
      else resolve({ ok: false, status, reason });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { enabled, send };
