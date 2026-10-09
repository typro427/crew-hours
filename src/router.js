// express.Router whose handlers may be async: thrown errors go to the error handler.
const express = require('express');
module.exports = function makeRouter() {
  const r = express.Router();
  for (const m of ['get', 'post', 'put', 'delete']) {
    const orig = r[m].bind(r);
    r[m] = (path, ...handlers) => orig(path, ...handlers.map(h => (req, res, next) => {
      try { const p = h(req, res, next); if (p && p.catch) p.catch(next); } catch (e) { next(e); }
    }));
  }
  return r;
};
