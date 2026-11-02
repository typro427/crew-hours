// Parts of the app the boss can turn on or off for each crew member. Missing or null = on.
const FEATURES = {
  tasks:      'Tasks',
  roads:      'Roads mowed',
  w_readings: 'Water: readings',
  w_sites:    'Water: sites',
  w_repairs:  'Water: leaks & repairs'
};
const can = (crew, key) => !crew.features || crew.features[key] !== false;
const forCrew = crew => Object.fromEntries(Object.keys(FEATURES).map(k => [k, can(crew, k)]));
/** Clean a {key: bool} map from the dashboard. */
function clean(f) {
  if (!f || typeof f !== 'object') return null;
  const out = {};
  Object.keys(FEATURES).forEach(k => { out[k] = f[k] !== false; });
  return out;
}
/** Express middleware: 403 unless this crew member has the feature. */
const need = (...keys) => (req, res, next) => keys.some(k => can(req.crew, k)) ? next()
  : res.status(403).json({ error: "The boss hasn't turned this on for you." });
module.exports = { FEATURES, can, forCrew, clean, need };
