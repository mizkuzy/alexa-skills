// Runs Code.js in node with fake Apps Script services: node --test apps-script/
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODE = fs.readFileSync(path.join(__dirname, 'Code.js'), 'utf8');
const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-10T09:00:00Z'); // 12:00 in Athens (UTC+3, summer time)

const GuestStatus = { NO: 'NO', YES: 'YES', OWNER: 'OWNER', INVITED: 'INVITED', MAYBE: 'MAYBE' };
const calEvent = ({ id = 'ev1', title = 'Standup', start = NOW + 60 * MIN, allDay = false, status = 'OWNER' } = {}) => ({
  getId: () => id,
  getTitle: () => title,
  getStartTime: () => new Date(start),
  isAllDayEvent: () => allDay,
  getMyStatus: () => status,
});

const response = (code, body) => ({ getResponseCode: () => code, getContentText: () => body });

const newCalls = () => ({ fetch: [], getEvents: [], deleted: [], created: [] });

function run(fn, { events = [], tokenRes, messageRes, triggers = [], calls = newCalls() } = {}) {
  const props = { ALEXA_CLIENT_ID: 'cid', ALEXA_CLIENT_SECRET: 'secret', ALEXA_USER_ID: 'amzn1.ask.account.A/B+C' };
  const ctx = {
    console: { log: () => {} },
    Date: class extends Date {
      constructor(...a) { super(...(a.length ? a : [NOW])); }
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] }) },
    CalendarApp: {
      GuestStatus,
      getDefaultCalendar: () => ({
        getEvents: (from, to) => { calls.getEvents.push([from.getTime(), to.getTime()]); return events; },
      }),
    },
    Utilities: {
      formatDate(date, tz, pattern) {
        assert.strictEqual(pattern, "yyyy-MM-dd'T'HH:mm:ss");
        return date.toLocaleString('sv-SE', { timeZone: tz }).replace(' ', 'T');
      },
    },
    UrlFetchApp: {
      fetch(url, opts) {
        calls.fetch.push({ url, opts });
        if (url.includes('/auth/o2/token')) return tokenRes || response(200, JSON.stringify({ access_token: 'TOKEN' }));
        return messageRes || response(202, '');
      },
    },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      deleteTrigger: (t) => calls.deleted.push(t),
      newTrigger: (name) => ({
        timeBased: () => ({
          everyMinutes: (n) => ({ create: () => calls.created.push({ name, n }) }),
        }),
      }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${CODE}\nthis.__result = ${fn}();`, ctx);
  return calls;
}

const sentData = (calls) => JSON.parse(calls.fetch[1].opts.payload).data;

test('sync: asks calendar for the next 24 hours', () => {
  const calls = run('sync');
  assert.deepStrictEqual(calls.getEvents, [[NOW, NOW + 24 * 60 * MIN]]);
});

test('sync: reminder is 10 minutes before start, in Athens local time', () => {
  const calls = run('sync', { events: [calEvent({ id: 'x', title: 'Standup', start: NOW + 60 * MIN })] });
  assert.deepStrictEqual(sentData(calls), {
    leadMinutes: 10,
    events: [{ id: 'x', title: 'Standup', remindAt: '2026-10-10T12:50:00', remindAtMs: NOW + 50 * MIN }],
  });
});

test('sync: Athens winter time is UTC+2', () => {
  const start = Date.parse('2026-12-01T10:00:00Z');
  const calls = run('sync', { events: [calEvent({ start })] });
  assert.strictEqual(sentData(calls).events[0].remindAt, '2026-12-01T11:50:00');
});

test('sync: skips all-day and declined events, keeps others', () => {
  const calls = run('sync', {
    events: [
      calEvent({ id: 'allday', allDay: true }),
      calEvent({ id: 'declined', status: 'NO' }),
      calEvent({ id: 'owner', status: 'OWNER' }),
      calEvent({ id: 'yes', status: 'YES' }),
      calEvent({ id: 'invited', status: 'INVITED' }),
      calEvent({ id: 'maybe', status: 'MAYBE' }),
    ],
  });
  assert.deepStrictEqual(sentData(calls).events.map((e) => e.id), ['owner', 'yes', 'invited', 'maybe']);
});

test('sync: empty calendar still sends, so skill deletes cancelled reminders', () => {
  const calls = run('sync');
  assert.deepStrictEqual(sentData(calls), { leadMinutes: 10, events: [] });
});

test('sync: gets LWA token with client credentials', () => {
  const calls = run('sync');
  assert.strictEqual(calls.fetch[0].url, 'https://api.amazon.com/auth/o2/token');
  assert.deepStrictEqual({ ...calls.fetch[0].opts.payload }, {
    grant_type: 'client_credentials', client_id: 'cid', client_secret: 'secret', scope: 'alexa:skill_messaging',
  });
  assert.strictEqual(calls.fetch[0].opts.method, 'post');
});

test('sync: posts skill message to EU endpoint with token', () => {
  const { url, opts } = run('sync').fetch[1];
  assert.strictEqual(url, 'https://api.eu.amazonalexa.com/v1/skillmessages/users/amzn1.ask.account.A%2FB%2BC');
  assert.strictEqual(opts.method, 'post');
  assert.strictEqual(opts.contentType, 'application/json');
  assert.deepStrictEqual({ ...opts.headers }, { Authorization: 'Bearer TOKEN' });
  assert.ok(JSON.parse(opts.payload).expiresAfterSeconds > 0);
});

test('sync: throws when token request fails and sends nothing', () => {
  const calls = newCalls();
  assert.throws(() => run('sync', { tokenRes: response(401, 'bad client'), calls }), /LWA token failed: 401 bad client/);
  assert.strictEqual(calls.fetch.length, 1);
});

test('sync: throws when skill message is not accepted', () => {
  assert.throws(() => run('sync', { messageRes: response(403, 'forbidden') }), /Skill message failed: 403 forbidden/);
});

test('setupTrigger: replaces old sync triggers with one every 15 minutes', () => {
  const syncTrigger = { getHandlerFunction: () => 'sync' };
  const other = { getHandlerFunction: () => 'other' };
  const calls = run('setupTrigger', { triggers: [syncTrigger, other] });
  assert.deepStrictEqual(calls.deleted, [syncTrigger]);
  assert.deepStrictEqual(calls.created, [{ name: 'sync', n: 15 }]);
});
