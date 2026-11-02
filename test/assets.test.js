// The browser scripts and pages are served, non-empty, and parse (catches a broken or wiped file).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const PUB = path.join(__dirname, '..', 'public');

for (const f of ['crew.js', 'admin.js', 'crew.html', 'admin.html', 'crew.css', 'admin.css', 'app.css', 'index.html']) {
  test(`${f} is present and not empty`, () => {
    const s = fs.readFileSync(path.join(PUB, f), 'utf8');
    assert.ok(s.length > 1000, f + ' looks empty');
    if (f.endsWith('.js')) assert.doesNotThrow(() => new vm.Script(s, { filename: f }));
  });
}
test('every id the scripts look up exists in the page', () => {
  for (const [js, html] of [['crew.js', 'crew.html'], ['admin.js', 'admin.html']]) {
    const s = fs.readFileSync(path.join(PUB, js), 'utf8'), h = fs.readFileSync(path.join(PUB, html), 'utf8');
    const ids = new Set([...h.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    const used = [...new Set([...s.matchAll(/\$\(["']([\w-]+)["']\)/g)].map(m => m[1]))];
    const missing = used.filter(id => !ids.has(id));
    assert.deepStrictEqual(missing, [], `${js} uses ids not in ${html}`);
  }
});
