// Parts of the app the boss can turn on or off for each crew member.
// Most are on unless switched off; the members list holds private contact details, so it is off unless switched on.
const FEATURES = {
  tasks:      'Tasks',
  roads:      'Roads mowed',
  w_readings: 'Water: readings',
  w_sites:    'Water: sites',
  w_repairs:  'Water: leaks & repairs',
  members:    'Members list (private contact info)'
};
const OFF_BY_DEFAULT = new Set(['members']);
const can = (crew, key) => OFF_BY_DEFAULT.has(key) ? !!(crew.features && crew.features[key] === true)
  : !crew.features || crew.features[key] !== false;
const forCrew = crew => Object.fromEntries(Object.keys(FEATURES).map(k => [k, can(crew, k)]));
/** Clean a {key: bool} map from the dashboard. */
function clean(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  Object.keys(FEATURES).forEach(k => { out[k] = OFF_BY_DEFAULT.has(k) ? f[k] === true : f[k] !== false; });
  return out;
}
/** Express middleware: 403 unless this crew member has the feature. */
const need = (...keys) => (req, res, next) => keys.some(k => can(req.crew, k)) ? next()
  : res.status(403).json({ error: "The boss hasn't turned this on for you." });
module.exports = { FEATURES, OFF_BY_DEFAULT, can, forCrew, clean, need };
