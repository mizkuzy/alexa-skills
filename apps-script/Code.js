// Sends upcoming Google Calendar events to the Calendar Reminders Alexa skill.
// Script Properties: ALEXA_CLIENT_ID, ALEXA_CLIENT_SECRET (skill Permissions tab), ALEXA_USER_ID.
// Run setupTrigger() once; it runs sync() every 15 minutes.

const LEAD_MINUTES = 10;
const LOOKAHEAD_HOURS = 24;
const TIME_ZONE = 'Europe/Athens';
const ALEXA_API = 'https://api.eu.amazonalexa.com';
const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

function sync() {
  const props = PropertiesService.getScriptProperties();
  const now = new Date();
  const until = new Date(now.getTime() + LOOKAHEAD_HOURS * 3600 * 1000);
  const events = CalendarApp.getDefaultCalendar().getEvents(now, until)
    .filter((e) => !e.isAllDayEvent() && e.getMyStatus() !== CalendarApp.GuestStatus.NO)
    .map((e) => toMessageEvent(e.getId(), e.getTitle(), e.getStartTime().getTime()));

  const res = UrlFetchApp.fetch(
    `${ALEXA_API}/v1/skillmessages/users/${encodeURIComponent(props.getProperty('ALEXA_USER_ID'))}`,
    {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: `Bearer ${getToken(props)}` },
      payload: JSON.stringify({ data: { leadMinutes: LEAD_MINUTES, events }, expiresAfterSeconds: 600 }),
      muteHttpExceptions: true,
    },
  );
  if (res.getResponseCode() !== 202) {
    throw new Error(`Skill message failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  console.log(`Sent ${events.length} events`);
}

function toMessageEvent(id, title, startMs) {
  const remindAtMs = startMs - LEAD_MINUTES * 60 * 1000;
  return {
    id,
    title,
    remindAt: Utilities.formatDate(new Date(remindAtMs), TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ss"),
    remindAtMs,
  };
}

function getToken(props) {
  const res = UrlFetchApp.fetch(LWA_TOKEN_URL, {
    method: 'post',
    payload: {
      grant_type: 'client_credentials',
      client_id: props.getProperty('ALEXA_CLIENT_ID'),
      client_secret: props.getProperty('ALEXA_CLIENT_SECRET'),
      scope: 'alexa:skill_messaging',
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(`LWA token failed: ${res.getResponseCode()} ${res.getContentText()}`);
  }
  return JSON.parse(res.getContentText()).access_token;
}

function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'sync')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(15).create();
}
