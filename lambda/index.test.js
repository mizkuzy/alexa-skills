const { test } = require('node:test');
const assert = require('node:assert');
const Alexa = require('ask-sdk-core');
const {
  plan, isValidEvent, buildReminder, LaunchRequestHandler, MessageReceivedHandler,
} = require('./index');

const MIN = 60 * 1000;
const NOW = Date.parse('2026-10-10T09:00:00Z');

// remindAt must look like local time; minute offset makes each one unique
const ev = (id, offsetMin, now = NOW) => ({
  id,
  title: `Title ${id}`,
  remindAt: `2026-10-10T${String(10 + Math.floor(offsetMin / 60) % 10).padStart(2, '0')}:${String(Math.abs(Math.round(offsetMin)) % 60).padStart(2, '0')}:00`,
  remindAtMs: now + offsetMin * MIN,
});
const key = (e) => `${e.id}|${e.remindAt}`;
const stored = (...pairs) => Object.fromEntries(
  pairs.map(([e, token]) => [key(e), { token, remindAtMs: e.remindAtMs }]),
);

// ---------- plan ----------

test('plan: unchanged event is kept and not recreated', () => {
  const e = ev('a', 30);
  const r = plan(stored([e, 't1']), [e], NOW);
  assert.deepStrictEqual(r.kept, stored([e, 't1']));
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.toCreate, []);
});

test('plan: new event is created', () => {
  const e = ev('a', 30);
  const r = plan({}, [e], NOW);
  assert.deepStrictEqual(r.toCreate, [[key(e), e]]);
  assert.deepStrictEqual(r.kept, {});
});

test('plan: moved event deletes old reminder and creates new one', () => {
  const old = ev('a', 30);
  const moved = ev('a', 90);
  const r = plan(stored([old, 't1']), [moved], NOW);
  assert.deepStrictEqual(r.toDelete, [key(old)]);
  assert.deepStrictEqual(r.toCreate, [[key(moved), moved]]);
  assert.deepStrictEqual(r.kept, {});
});

test('plan: cancelled future event is deleted', () => {
  const e = ev('a', 30);
  const r = plan(stored([e, 't1']), [], NOW);
  assert.deepStrictEqual(r.toDelete, [key(e)]);
});

test('plan: cancelled event with reminder less than 1 minute ahead is still deleted', () => {
  const e = ev('a', 0.5);
  assert.deepStrictEqual(plan(stored([e, 't1']), [], NOW).toDelete, [key(e)]);
});

test('plan: already fired reminder is forgotten, not deleted', () => {
  const e = ev('a', -5);
  const r = plan(stored([e, 't1']), [], NOW);
  assert.deepStrictEqual(r.toDelete, []);
  assert.deepStrictEqual(r.kept, {});
});

test('plan: event less than 1 minute ahead is not created', () => {
  const r = plan({}, [ev('a', 0.5), ev('b', -10)], NOW);
  assert.deepStrictEqual(r.toCreate, []);
});

test('plan: event just over 1 minute ahead is created', () => {
  const e = ev('a', 1.1);
  assert.deepStrictEqual(plan({}, [e], NOW).toCreate, [[key(e), e]]);
});

test('plan: stored reminder less than 1 minute ahead is kept, not deleted', () => {
  const e = ev('a', 0.5);
  const r = plan(stored([e, 't1']), [e], NOW);
  assert.deepStrictEqual(r.kept, stored([e, 't1']));
  assert.deepStrictEqual(r.toDelete, []);
});

test('plan: two instances of a recurring event are separate reminders', () => {
  const first = ev('rec', 30);
  const second = ev('rec', 150);
  const r = plan({}, [first, second], NOW);
  assert.deepStrictEqual(r.toCreate.map(([k]) => k), [key(first), key(second)]);
});

test('plan: does not mutate stored', () => {
  const s = stored([ev('a', 30), 't1']);
  const copy = structuredClone(s);
  plan(s, [], NOW);
  assert.deepStrictEqual(s, copy);
});

// ---------- isValidEvent ----------

test('isValidEvent: accepts a correct event', () => {
  assert.strictEqual(isValidEvent(ev('a', 30)), true);
});

test('isValidEvent: rejects bad events', () => {
  const good = ev('a', 30);
  for (const bad of [
    null,
    { ...good, id: 1 },
    { ...good, title: undefined },
    { ...good, remindAt: '2026-10-10 10:30:00' },
    { ...good, remindAt: '2026-10-10T10:30:00Z' },
    { ...good, remindAt: '2026-10-10T10:30' },
    { ...good, remindAtMs: '123' },
    { ...good, remindAtMs: NaN },
  ]) {
    assert.ok(!isValidEvent(bad), JSON.stringify(bad));
  }
});

// ---------- buildReminder ----------

test('buildReminder: absolute local time in Europe/Athens with push', () => {
  const e = ev('a', 30);
  const r = buildReminder(e, 10);
  assert.deepStrictEqual(r.trigger, {
    type: 'SCHEDULED_ABSOLUTE', scheduledTime: e.remindAt, timeZoneId: 'Europe/Athens',
  });
  assert.deepStrictEqual(r.pushNotification, { status: 'ENABLED' });
  assert.ok(!Number.isNaN(Date.parse(r.requestTime)));
});

test('buildReminder: same text for all English locales', () => {
  const r = buildReminder({ ...ev('a', 30), title: 'Standup' }, 10);
  assert.deepStrictEqual(r.alertInfo.spokenInfo.content, [
    { locale: 'en-GB', text: 'In 10 minutes: Standup' },
    { locale: 'en-US', text: 'In 10 minutes: Standup' },
    { locale: 'en-IN', text: 'In 10 minutes: Standup' },
    { locale: 'en-AU', text: 'In 10 minutes: Standup' },
    { locale: 'en-CA', text: 'In 10 minutes: Standup' },
  ]);
});

test('buildReminder: uses leadMinutes in text', () => {
  const r = buildReminder({ ...ev('a', 30), title: 'X' }, 5);
  assert.strictEqual(r.alertInfo.spokenInfo.content[0].text, 'In 5 minutes: X');
});

test('buildReminder: text is cut to 200 characters', () => {
  const r = buildReminder({ ...ev('a', 30), title: 'x'.repeat(500) }, 10);
  assert.strictEqual(r.alertInfo.spokenInfo.content[0].text.length, 200);
});

// ---------- handlers ----------

function fakeInput({ type, message, reminders, permissions, client }) {
  const db = { attrs: reminders === undefined ? undefined : { reminders }, saved: false };
  return {
    db,
    input: {
      requestEnvelope: {
        context: { System: { user: { userId: 'amzn1.ask.account.TEST', permissions } } },
        request: { type, message },
      },
      responseBuilder: Alexa.ResponseFactory.init(),
      attributesManager: {
        getPersistentAttributes: async () => db.attrs,
        setPersistentAttributes: (a) => { db.pending = a; },
        savePersistentAttributes: async () => { db.attrs = db.pending; db.saved = true; },
      },
      serviceClientFactory: { getReminderManagementServiceClient: () => client },
    },
  };
}

function fakeClient({ deleteErrors = {}, createError } = {}) {
  const calls = { created: [], deleted: [] };
  let n = 0;
  return {
    calls,
    async createReminder(r) {
      if (createError) throw createError;
      calls.created.push(r);
      n += 1;
      return { alertToken: `new-${n}` };
    },
    async deleteReminder(token) {
      calls.deleted.push(token);
      if (deleteErrors[token]) throw deleteErrors[token];
    },
  };
}

const httpError = (statusCode) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
const quiet = (fn) => async () => {
  const log = console.log;
  console.log = () => {};
  try { await fn(); } finally { console.log = log; }
};

test('Launch: without permission asks for reminders consent card', quiet(() => {
  const { input } = fakeInput({ type: 'LaunchRequest' });
  assert.ok(LaunchRequestHandler.canHandle(input));
  const res = LaunchRequestHandler.handle(input);
  assert.deepStrictEqual(res.card, {
    type: 'AskForPermissionsConsent',
    permissions: ['alexa::alerts:reminders:skill:readwrite'],
  });
  assert.match(res.outputSpeech.ssml, /allow reminders/);
}));

test('Launch: permissions without consentToken asks for consent card', quiet(() => {
  const { input } = fakeInput({ type: 'LaunchRequest', permissions: {} });
  assert.strictEqual(LaunchRequestHandler.handle(input).card.type, 'AskForPermissionsConsent');
}));

test('Launch: with permission gives no card', quiet(() => {
  const { input } = fakeInput({ type: 'LaunchRequest', permissions: { consentToken: 'tok' } });
  const res = LaunchRequestHandler.handle(input);
  assert.strictEqual(res.card, undefined);
  assert.match(res.outputSpeech.ssml, /Calendar reminders are on/);
}));

test('Launch: logs userId', () => {
  const { input } = fakeInput({ type: 'LaunchRequest' });
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { LaunchRequestHandler.handle(input); } finally { console.log = log; }
  assert.ok(lines.some((l) => l.includes('amzn1.ask.account.TEST')));
});

test('MessageReceived: canHandle only messaging requests', () => {
  assert.ok(MessageReceivedHandler.canHandle(fakeInput({ type: 'Messaging.MessageReceived' }).input));
  for (const type of ['LaunchRequest', 'IntentRequest', 'SessionEndedRequest']) {
    assert.ok(!MessageReceivedHandler.canHandle(fakeInput({ type }).input), type);
  }
});

test('MessageReceived: bad message changes nothing', quiet(async () => {
  for (const message of [undefined, {}, { events: 'x' }, { events: [ev('a', 30), { id: 'b' }] }]) {
    const client = fakeClient();
    const { input, db } = fakeInput({ type: 'Messaging.MessageReceived', message, reminders: {}, client });
    const res = await MessageReceivedHandler.handle(input);
    assert.deepStrictEqual(client.calls, { created: [], deleted: [] });
    assert.strictEqual(db.saved, false);
    assert.strictEqual(res.outputSpeech, undefined);
  }
}));

test('MessageReceived: first run with no saved data creates and saves', quiet(async () => {
  const e = ev('a', 30, Date.now());
  const client = fakeClient();
  const { input, db } = fakeInput({ type: 'Messaging.MessageReceived', message: { events: [e] }, client });
  await MessageReceivedHandler.handle(input);
  assert.strictEqual(client.calls.created.length, 1);
  assert.deepStrictEqual(db.attrs.reminders, { [key(e)]: { token: 'new-1', remindAtMs: e.remindAtMs } });
}));

test('MessageReceived: syncs create, delete, keep and saves tokens', quiet(async () => {
  const now = Date.now();
  const keep = ev('keep', 30, now);
  const gone = ev('gone', 40, now);
  const fresh = ev('fresh', 50, now);
  const client = fakeClient();
  const { input, db } = fakeInput({
    type: 'Messaging.MessageReceived',
    message: { leadMinutes: 10, events: [keep, fresh] },
    reminders: stored([keep, 't-keep'], [gone, 't-gone']),
    client,
  });
  const res = await MessageReceivedHandler.handle(input);

  assert.deepStrictEqual(client.calls.deleted, ['t-gone']);
  assert.strictEqual(client.calls.created.length, 1);
  assert.strictEqual(client.calls.created[0].trigger.scheduledTime, fresh.remindAt);
  assert.strictEqual(client.calls.created[0].alertInfo.spokenInfo.content[0].text, 'In 10 minutes: Title fresh');
  assert.strictEqual(db.saved, true);
  assert.deepStrictEqual(db.attrs.reminders, {
    [key(keep)]: { token: 't-keep', remindAtMs: keep.remindAtMs },
    [key(fresh)]: { token: 'new-1', remindAtMs: fresh.remindAtMs },
  });
  assert.strictEqual(res.outputSpeech, undefined);
}));

test('MessageReceived: leadMinutes defaults to 10 and accepts other values', quiet(async () => {
  for (const [leadMinutes, expected] of [[undefined, 10], ['5', 10], [15, 15]]) {
    const client = fakeClient();
    const { input } = fakeInput({
      type: 'Messaging.MessageReceived',
      message: { leadMinutes, events: [{ ...ev('a', 30, Date.now()), title: 'X' }] },
      reminders: {},
      client,
    });
    await MessageReceivedHandler.handle(input);
    assert.strictEqual(client.calls.created[0].alertInfo.spokenInfo.content[0].text, `In ${expected} minutes: X`);
  }
}));

test('MessageReceived: delete 404 forgets reminder, other errors keep it for retry', quiet(async () => {
  const now = Date.now();
  const missing = ev('missing', 30, now);
  const failing = ev('failing', 40, now);
  const client = fakeClient({ deleteErrors: { 't-missing': httpError(404), 't-failing': httpError(500) } });
  const { input, db } = fakeInput({
    type: 'Messaging.MessageReceived',
    message: { events: [] },
    reminders: stored([missing, 't-missing'], [failing, 't-failing']),
    client,
  });
  await MessageReceivedHandler.handle(input);
  assert.deepStrictEqual(db.attrs.reminders, { [key(failing)]: { token: 't-failing', remindAtMs: failing.remindAtMs } });
}));

test('MessageReceived: failed create is not saved, so next run retries', quiet(async () => {
  const client = fakeClient({ createError: httpError(401) });
  const { input, db } = fakeInput({
    type: 'Messaging.MessageReceived',
    message: { events: [ev('a', 30, Date.now())] },
    reminders: {},
    client,
  });
  await MessageReceivedHandler.handle(input);
  assert.strictEqual(db.saved, true);
  assert.deepStrictEqual(db.attrs.reminders, {});
}));

test('MessageReceived: keeps other saved attributes', quiet(async () => {
  const client = fakeClient();
  const { input, db } = fakeInput({ type: 'Messaging.MessageReceived', message: { events: [] }, reminders: {}, client });
  db.attrs.other = 'x';
  await MessageReceivedHandler.handle(input);
  assert.strictEqual(db.attrs.other, 'x');
}));
