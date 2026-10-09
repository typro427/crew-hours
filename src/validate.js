const T = require('./time');
const bad = msg => { throw new T.InputError(msg); };

const str = (v, name, min, max) => {
  const s = String(v == null ? '' : v).trim();
  if (s.length < min) bad(min === 1 ? `Enter ${name}.` : `${name[0].toUpperCase() + name.slice(1)} must be at least ${min} characters.`);
  if (s.length > max) bad(`${name[0].toUpperCase() + name.slice(1)} is too long (max ${max} characters).`);
  return s;
};
const int = (v, name, min, max) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
};
const num = (v, name, min, max) => {
  const n = Number(v);
  if (!isFinite(n) || n < min || n > max) bad(`${name} must be between ${min} and ${max}.`);
  return n;
};
const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const email = v => { const s = String(v || '').trim().toLowerCase(); if (!EMAIL.test(s) || s.length > 200) bad('Enter a valid email address.'); return s; };
const emailList = v => {
  const list = String(v || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  if (list.length > 5) bad('Up to 5 report emails.');
  list.forEach(e => { if (!EMAIL.test(e)) bad(`"${e}" isn't a valid email address.`); });
  return list.join(', ');
};
const pin = v => { const s = String(v == null ? '' : v).trim(); if (!/^\d{4}$/.test(s)) bad('PIN must be exactly 4 digits.'); return s; };
const password = v => {
  const s = String(v || '');
  if (s.length > 200) bad('Password is too long.');
  const missing = [];
  if (s.length < 8) missing.push('at least 8 characters');
  if (!/[A-Z]/.test(s)) missing.push('1 capital letter');
  if (!/[^A-Za-z0-9]/.test(s)) missing.push('1 special character (like ! @ # $)');
  if (missing.length) bad('Password needs ' + missing.join(', ').replace(/, ([^,]*)$/, ' and $1') + '.');
  return s;
};

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 40) || 'crew';
}

module.exports = { bad, str, int, num, email, emailList, pin, password, slugify };
