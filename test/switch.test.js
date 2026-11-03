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

// Both tabs filled in with overlapping times: the overlap only counts once.
const co = { main_label: 'Deerfield Time', other_label: 'Other time' };
const trim = (w, o) => { const note = H.trimOverlap(w, o, co); return { w, note }; };
test('Other time inside Deerfield Time: clocked out of Deerfield for it (6 hours, not 8)', () => {
  const { w, note } = trim({ start: '12:26', end: '18:26', out: '', back: '' }, { start: '14:26', end: '16:26' });
  assert.deepStrictEqual(w, { start: '12:26', end: '18:26', out: '14:26', back: '16:26' });
  assert.match(note, /clocked out 2:26 PM–4:26 PM for Other time/);
  const T = require('../src/time');
  assert.strictEqual(T.timeBlock(w, 'x').hours + T.timeBlock({ start: '14:26', end: '16:26' }, 'y').hours, 6);
});
test('Other time over the start or end of Deerfield Time: Deerfield is trimmed', () => {
  assert.strictEqual(trim({ start: '08:00', end: '16:00' }, { start: '07:00', end: '09:00' }).w.start, '09:00');
  assert.strictEqual(trim({ start: '08:00', end: '16:00' }, { start: '15:00', end: '17:00' }).w.end, '15:00');
});
test('no overlap, or already clocked out for it: left alone; all inside: refused', () => {
  assert.strictEqual(trim({ start: '08:00', end: '12:00' }, { start: '13:00', end: '15:00' }).note, '');
  assert.strictEqual(trim({ start: '08:00', end: '16:00', out: '10:00', back: '12:00' }, { start: '10:00', end: '12:00' }).note, '');
  assert.throws(() => trim({ start: '10:00', end: '11:00' }, { start: '09:00', end: '12:00' }), /inside/);
  assert.throws(() => trim({ start: '08:00', end: '16:00', out: '09:00', back: '09:30' }, { start: '12:00', end: '13:00' }), /overlap/);
});
test('days saved before the fix: the overlap is counted once in the total', () => {
  const e = H.shape({ start_t: '12:26', end_t: '18:26', out_t: '', back_t: '', hours: 6, o_start: '14:26', o_end: '16:26', o_out: '', o_back: '', o_hours: 2 });
  assert.strictEqual(e.total, 6);
  const n = H.shape({ start_t: '08:00', end_t: '12:00', out_t: '', back_t: '', hours: 4, o_start: '13:00', o_end: '15:00', o_out: '', o_back: '', o_hours: 2 });
  assert.strictEqual(n.total, 6);
});

test("Bill's time is billed in 15-minute steps, rounded up (or to the nearest, or exact)", () => {
  const JB = require('../src/jobbilling');
  const v = (a, b) => ({ timeIn: a, timeOut: b });
  assert.strictEqual(JB.billedHours(v('08:00', '09:05'), { billStep: 15, billRound: 'up' }), 1.25);
  assert.strictEqual(JB.billedHours(v('08:00', '09:00'), { billStep: 15, billRound: 'up' }), 1);
  assert.strictEqual(JB.billedHours(v('08:00', '08:01'), { billStep: 15, billRound: 'up' }), 0.25);
  assert.strictEqual(JB.billedHours(v('08:00', '09:05'), { billStep: 15, billRound: 'nearest' }), 1);
  assert.strictEqual(JB.billedHours(v('08:00', '09:08'), { billStep: 15, billRound: 'nearest' }), 1.25);
  assert.strictEqual(JB.billedHours(v('08:00', '09:05'), { billStep: 0 }), 1.08);
  assert.strictEqual(JB.billedHours(v('08:00', ''), { billStep: 15 }), null, 'no time out yet');
});
