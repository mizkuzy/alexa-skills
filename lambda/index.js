const Alexa = require('ask-sdk-core');
const { S3PersistenceAdapter } = require('ask-sdk-s3-persistence-adapter');

const REMINDERS_PERMISSION = 'alexa::alerts:reminders:skill:readwrite';
const TIME_ZONE = 'Europe/Athens';
const LOCALES = ['en-GB', 'en-US', 'en-IN', 'en-AU', 'en-CA'];
const MIN_AHEAD_MS = 60 * 1000; // Reminders API rejects times in the past
const LOCAL_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/;

// stored: { key: { token, remindAtMs } }, events: [{ id, title, remindAt, remindAtMs }]
function plan(stored, events, now) {
  const incoming = new Map(events.map((e) => [`${e.id}|${e.remindAt}`, e]));
  const kept = {};
  const toDelete = [];
  for (const [key, r] of Object.entries(stored)) {
    if (incoming.has(key)) {
      kept[key] = r;
      incoming.delete(key);
    } else if (r.remindAtMs > now) {
      toDelete.push(key);
    } // else: already fired, just forget it
  }
  const toCreate = [...incoming].filter(([, e]) => e.remindAtMs > now + MIN_AHEAD_MS);
  return { kept, toDelete, toCreate };
}

function isValidEvent(e) {
  return e && typeof e.id === 'string' && typeof e.title === 'string'
    && LOCAL_TIME.test(e.remindAt) && Number.isFinite(e.remindAtMs);
}

function buildReminder(e, leadMinutes) {
  const text = `In ${leadMinutes} minutes: ${e.title}`.slice(0, 200);
  return {
    requestTime: new Date().toISOString(),
    trigger: { type: 'SCHEDULED_ABSOLUTE', scheduledTime: e.remindAt, timeZoneId: TIME_ZONE },
    alertInfo: { spokenInfo: { content: LOCALES.map((locale) => ({ locale, text })) } },
    pushNotification: { status: 'ENABLED' },
  };
}

const LaunchRequestHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest';
  },
  handle(h) {
    console.log('userId:', Alexa.getUserId(h.requestEnvelope));
    const permissions = h.requestEnvelope.context.System.user.permissions;
    if (!(permissions && permissions.consentToken)) {
      return h.responseBuilder
        .speak('Please allow reminders for Calendar Reminders in the Alexa app.')
        .withAskForPermissionsConsentCard([REMINDERS_PERMISSION])
        .getResponse();
    }
    return h.responseBuilder.speak('Calendar reminders are on.').getResponse();
  },
};

const MessageReceivedHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'Messaging.MessageReceived';
  },
  async handle(h) {
    const msg = h.requestEnvelope.request.message || {};
    if (!Array.isArray(msg.events) || !msg.events.every(isValidEvent)) {
      console.log('Bad message, ignored:', JSON.stringify(msg).slice(0, 500));
      return h.responseBuilder.getResponse();
    }
    const leadMinutes = Number.isInteger(msg.leadMinutes) ? msg.leadMinutes : 10;

    const am = h.attributesManager;
    const attrs = (await am.getPersistentAttributes()) || {};
    const stored = attrs.reminders || {};
    const { kept, toDelete, toCreate } = plan(stored, msg.events, Date.now());
    const client = h.serviceClientFactory.getReminderManagementServiceClient();

    for (const key of toDelete) {
      try {
        await client.deleteReminder(stored[key].token);
      } catch (err) {
        console.log('Delete failed:', key, err.statusCode, err.message);
        if (err.statusCode !== 404) kept[key] = stored[key]; // retry next run
      }
    }
    for (const [key, e] of toCreate) {
      try {
        const r = await client.createReminder(buildReminder(e, leadMinutes));
        kept[key] = { token: r.alertToken, remindAtMs: e.remindAtMs };
      } catch (err) {
        console.log('Create failed:', key, err.statusCode, err.message); // retried next run
      }
    }

    attrs.reminders = kept;
    am.setPersistentAttributes(attrs);
    await am.savePersistentAttributes();
    console.log(`Events: ${msg.events.length}, created: ${toCreate.length}, deleted: ${toDelete.length}`);
    return h.responseBuilder.getResponse();
  },
};

const FallbackHandler = {
  canHandle() {
    return true;
  },
  handle(h) {
    return h.responseBuilder.getResponse();
  },
};

const ErrorHandler = {
  canHandle() {
    return true;
  },
  handle(h, error) {
    console.log('Error:', error.stack || error);
    return h.responseBuilder.getResponse();
  },
};

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(LaunchRequestHandler, MessageReceivedHandler, FallbackHandler)
  .addErrorHandlers(ErrorHandler)
  .withPersistenceAdapter(new S3PersistenceAdapter({ bucketName: process.env.S3_PERSISTENCE_BUCKET }))
  .withApiClient(new Alexa.DefaultApiClient())
  .lambda();

exports.plan = plan;
