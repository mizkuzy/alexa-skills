const assert = require('assert');
const { plan } = require('./index');

const now = Date.parse('2026-10-10T09:00:00Z');
const min = 60 * 1000;
const ev = (id, offsetMin) => ({ id, title: id, remindAt: `t${offsetMin}`, remindAtMs: now + offsetMin * min });
const key = (e) => `${e.id}|${e.remindAt}`;

const same = ev('same', 30);
const moved = ev('moved', 60);
const movedOld = ev('moved', 45);
const cancelled = ev('cancelled', 90);
const fired = ev('fired', -5);
const tooSoon = ev('soon', 0.5);
const fresh = ev('fresh', 120);

const stored = {
  [key(same)]: { token: 'a', remindAtMs: same.remindAtMs },
  [key(movedOld)]: { token: 'b', remindAtMs: movedOld.remindAtMs },
  [key(cancelled)]: { token: 'c', remindAtMs: cancelled.remindAtMs },
  [key(fired)]: { token: 'd', remindAtMs: fired.remindAtMs },
};
const r = plan(stored, [same, moved, tooSoon, fresh], now);

assert.deepStrictEqual(Object.keys(r.kept), [key(same)]);
assert.deepStrictEqual(r.toDelete.sort(), [key(cancelled), key(movedOld)].sort());
assert.deepStrictEqual(r.toCreate.map(([k]) => k), [key(moved), key(fresh)]);
console.log('ok');
