// Switching jobs during the day: the server applies the same rules as the crew app.
const { test, after } = require('node:test');
const assert = require('node:assert');
const H = require('../src/hours');
const db = require('../src/db');
after(() => db.pool.end());
const run = (w, o) => { H.autoSwitch(w, o); return { w, o }; };

test('clocking in on Water clocks them out of Deerfield', () => {
  const { w, o } = run({ start: '08:00' }, { start: '10:00' });
  assert.deepStrictEqual(w, { start: '08:00', end: '', out: '10:00', back: '' });
  assert.strictEqual(o.end, '');
});
test('Water finished and they never went back: Deerfield ends when they left', () => {
  const { w } = run({ start: '08:00', out: '10:00' }, { start: '10:00', end: '12:00' });
  assert.deepStrictEqual(w, { start: '08:00', end: '10:00', out: '', back: '' });
});
test('back to Deerfield after Water: clocked back in, and Water is closed if still open', () => {
  const { w, o } = run({ start: '08:00', out: '10:00', back: '12:30' }, { start: '10:00' });
  assert.deepStrictEqual(w, { start: '08:00', end: '', out: '10:00', back: '12:30' });
  assert.strictEqual(o.end, '12:30');
});
test('back to Deerfield after Deerfield was already ended at the switch', () => {
  const { w } = run({ start: '08:00', end: '10:00', back: '13:00' }, { start: '10:00', end: '12:00' });
  assert.deepStrictEqual(w, { start: '08:00', end: '', out: '10:00', back: '13:00' });
});
test('Water first thing, then Deerfield: Water ends when Deerfield starts', () => {
  const { w, o } = run({ start: '11:00' }, { start: '07:00' });
  assert.strictEqual(o.end, '11:00'); assert.strictEqual(w.out, '');
});
test('a normal day with no switching is left alone', () => {
  const { w, o } = run({ start: '08:00', end: '16:00' }, {});
  assert.deepStrictEqual(w, { start: '08:00', end: '16:00', out: '', back: '' });
  assert.deepStrictEqual(o, { start: '', end: '', out: '', back: '' });
});
